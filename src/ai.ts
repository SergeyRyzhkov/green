import type { ExtractedFaqItem, ExtractedQaItem, Section } from "./types";

const MODEL = process.env.OPENAI_MODEL ?? "qwen3.5:4b";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434/api/chat";

const MAX_CHUNK_CHARS = 3500;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

interface OllamaResponse {
  message?: {
    content?: string;
  };
  done?: boolean;
  done_reason?: string;
}

interface EditedQa {
  question: string;
  answer: string;
}

interface Classification {
  title: string;
  sections: string[];
  tags: string[];
  comment: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const splitText = (text: string, maxChars: number): string[] => {
  const chunks: string[] = [];
  let current = "";

  const blocks = text.split(/\n(?=\[\d{2}:\d{2}\])/);

  for (const block of blocks) {
    if (!block.trim()) continue;

    if (current.length > 0 && current.length + block.length + 1 > maxChars) {
      chunks.push(current.trim());
      current = "";
    }

    current += `${block}\n`;
  }

  if (current.trim()) chunks.push(current.trim());

  return chunks;
};

const normalizeWhitespace = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

const extractJson = (content: string): unknown => {
  const cleaned = content
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");

    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }

    throw new Error("Не удалось найти JSON в ответе Ollama");
  }
};

const parseModelJson = (content: string, stage: string): unknown => {
  try {
    return extractJson(content);
  } catch (error) {
    console.error(
      `    ${stage}: некорректный JSON. Ответ модели (первые 1000 символов):`,
    );
    console.error(content.slice(0, 1000));
    throw error;
  }
};

const ollamaChat = async (
  system: string,
  user: string,
  maxTokens: number,
): Promise<string> => {
  const controller = new AbortController();

  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        think: false,
        stream: false,
        format: "json",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        options: {
          num_ctx: 4096,
          temperature: 0,
          num_predict: maxTokens,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Ollama HTTP ${response.status}: ${await response.text()}`,
      );
    }

    const data = (await response.json()) as OllamaResponse;
    const content = data.message?.content?.trim();

    if (!content) {
      throw new Error(
        `Пустой ответ Ollama (done_reason=${data.done_reason ?? "unknown"})`,
      );
    }

    if (data.done === false || data.done_reason === "length") {
      console.warn(
        `    Ollama: ответ мог быть обрезан лимитом ${maxTokens} токенов`,
      );
    }

    return content;
  } finally {
    clearTimeout(timeout);
  }
};

const isRealQuestion = (question: string): boolean => {
  const value = question.trim();

  return (
    value.length >= 8 &&
    (value.includes("?") ||
      /^(как|почему|зачем|можно ли|нужно ли|стоит ли|какой|какая|какое|какие|сколько|чем|что|где|когда|нужен ли|нужна ли|нужны ли)\b/i.test(
        value,
      ))
  );
};

const isBadAnswer = (answer: string): boolean => {
  const value = answer.trim();

  if (value.length < 20) {
    return true;
  }

  return /^(нет ответа|ответ отсутствует|текста нет|не указано|не дано|не могу определить|спикер не указал|спикер не дал|вопрос не реш[её]н|автор не ответил|ответ не прозвучал)/i.test(
    value,
  );
};

const parseQaItems = (data: unknown, chunk: string): ExtractedQaItem[] => {
  if (!data || typeof data !== "object") return [];

  const items = (data as { items?: unknown }).items;

  if (!Array.isArray(items)) return [];

  const result: ExtractedQaItem[] = [];

  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;

    const item = raw as {
      sourceQuestion?: unknown;
      question?: unknown;
      answer?: unknown;
      evidence?: unknown;
    };

    const sourceQuestion =
      typeof item.sourceQuestion === "string" ? item.sourceQuestion.trim() : "";

    const question =
      typeof item.question === "string" ? item.question.trim() : "";

    const answer = typeof item.answer === "string" ? item.answer.trim() : "";

    const proposedEvidence =
      typeof item.evidence === "string" ? item.evidence.trim() : "";

    if (
      !sourceQuestion ||
      !question ||
      !answer ||
      !isRealQuestion(question) ||
      isBadAnswer(answer)
    ) {
      continue;
    }

    // Цитата считается подтверждённой только при совпадении
    // с реальным фрагментом текущей расшифровки.
    const evidenceMatches =
      proposedEvidence.length >= 20 &&
      normalizeWhitespace(chunk).includes(
        normalizeWhitespace(proposedEvidence),
      );

    result.push({
      sourceQuestion,
      question,
      answer,
      // Не сохраняем неподтверждённую цитату как доказательство.
      evidence: evidenceMatches ? proposedEvidence : "",
    });
  }

  return result;
};

/**
 * ЭТАП 1. Извлечение вопроса, ответа и точной цитаты.
 */
const extractQaChunk = async (chunk: string): Promise<ExtractedQaItem[]> => {
  const system = `
Извлеки из расшифровки только реальные вопросы и ответы автора.

Правила:
- Не превращай обычные утверждения в вопросы.
- Не придумывай вопрос, если его нет в расшифровке.
- Ответ должен опираться только на данный текст.
- Не используй внешние знания.
- Если автор не ответил на вопрос, не включай его.
- sourceQuestion — формулировка вопроса в расшифровке.
- question — вопрос для FAQ без изменения смысла.
- answer — ответ автора без дополнений и выводов от себя.
- evidence — дословный непрерывный фрагмент исходной расшифровки,
  который подтверждает ответ. Не исправляй в нём ошибки распознавания.
- evidence должен быть скопирован из текста, а не пересказан.
- Не включай комментарии, догадки и советы от себя.

Верни JSON:
{
  "items": [
    {
      "sourceQuestion": "исходный вопрос",
      "question": "вопрос FAQ",
      "answer": "ответ автора",
      "evidence": "дословная цитата из расшифровки"
    }
  ]
}

Если подходящих пар нет: {"items":[]}
`.trim();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`    Извлечение: попытка ${attempt}/${MAX_RETRIES}`);

    try {
      const content = await ollamaChat(system, chunk, 2500);
      return parseQaItems(parseModelJson(content, "Извлечение"), chunk);
    } catch (error) {
      console.error(
        `    Ошибка извлечения: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  throw new Error("Извлечение: все попытки завершились ошибкой");
};

/**
 * ЭТАП 2. Редактура.
 * Исходные question и answer никогда не перезаписываются.
 */
const editQa = async (item: ExtractedQaItem): Promise<EditedQa> => {
  const system = `
Ты редактор расшифровки строительного видео.

Исправь только очевидные ошибки распознавания речи,
опечатки и пунктуацию.

Критически важные правила:
- Не добавляй новые факты, цифры, материалы и рекомендации.
- Не делай ответ технически более подробным.
- Не угадывай неразборчивые слова.
- Если смысл слова или фразы неясен, оставь исходную формулировку.
- Не превращай вопрос в утверждение и наоборот.
- Не меняй смысл и степень уверенности автора.
- Если исправление спорное, предпочти исходный текст.
- Не добавляй объяснения от себя.

Верни только JSON:
{
  "question": "отредактированный вопрос",
  "answer": "отредактированный ответ"
}
`.trim();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const content = await ollamaChat(
        system,
        `ВОПРОС:\n${item.question}\n\nОТВЕТ:\n${item.answer}`,
        1200,
      );

      const data = parseModelJson(content, "Редактура");

      if (!data || typeof data !== "object") {
        throw new Error("Некорректный результат редактуры");
      }

      const value = data as {
        question?: unknown;
        answer?: unknown;
      };

      const question =
        typeof value.question === "string" ? value.question.trim() : "";

      const answer =
        typeof value.answer === "string" ? value.answer.trim() : "";

      if (!question || !answer) {
        throw new Error("Редактура вернула пустой вопрос или ответ");
      }

      return { question, answer };
    } catch (error) {
      console.error(
        `      Ошибка редактуры (${attempt}/${MAX_RETRIES}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  // При ошибке редактуры безопаснее оставить исходный текст.
  return {
    question: item.question,
    answer: item.answer,
  };
};

/**
 * ЭТАП 3. Заголовок, классификация и отдельный комментарий.
 */
const classifyQa = async (
  question: string,
  answer: string,
  sections: Section[],
  allowedTags: string[],
): Promise<Classification> => {
  const sectionList = sections
    .map((section) => `${section.id}: ${section.name}`)
    .join("\n");

  const tagList = allowedTags.join("\n");

  const system = `
Ты классификатор строительной базы знаний.

Создай короткий заголовок, выбери разделы и существующие теги,
а также напиши отдельный комментарий ChatGPT, если он действительно
полезен и не требует неподтверждённых предположений.

РАЗДЕЛЫ — используй только эти ID:
${sectionList}

РАЗРЕШЁННЫЕ ТЕГИ — используй только значения из списка:
${tagList || "(список пуст)"}

Правила:
- Не придумывай новые ID разделов и новые теги.
- Не выбирай раздел только потому, что он в целом относится к строительству.
- Выбирай только действительно относящиеся к содержанию разделы.
- Заголовок должен кратко передавать суть вопроса.
- Комментарий не должен повторять ответ.
- Не добавляй новые технические факты, расчёты или нормативы.
- Если полезный комментарий невозможен без догадок, верни пустую строку.
- Если подходящего раздела или тега нет, верни пустой массив.
- Комментарий — мнение/пояснение ИИ, а не слова автора.

Верни только JSON:
{
  "title": "Краткий заголовок",
  "sections": ["section-id"],
  "tags": ["существующий тег"],
  "comment": ""
}
`.trim();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const content = await ollamaChat(
        system,
        `ВОПРОС:\n${question}\n\nОТВЕТ:\n${answer}`,
        1200,
      );

      const data = parseModelJson(content, "Классификация");

      if (!data || typeof data !== "object") {
        throw new Error("Некорректный результат классификации");
      }

      const value = data as {
        title?: unknown;
        sections?: unknown;
        tags?: unknown;
        comment?: unknown;
      };

      const validSectionIds = new Set(sections.map((section) => section.id));

      const validTags = new Set(
        allowedTags.map((tag) => tag.toLocaleLowerCase("ru")),
      );

      const resultSections = Array.isArray(value.sections)
        ? value.sections.filter(
            (id): id is string =>
              typeof id === "string" && validSectionIds.has(id),
          )
        : [];

      const resultTags = Array.isArray(value.tags)
        ? value.tags.filter(
            (tag): tag is string =>
              typeof tag === "string" &&
              validTags.has(tag.toLocaleLowerCase("ru")),
          )
        : [];

      return {
        title:
          typeof value.title === "string" && value.title.trim()
            ? value.title.trim()
            : question,
        sections: [...new Set(resultSections)],
        tags: [...new Set(resultTags)],
        comment: typeof value.comment === "string" ? value.comment.trim() : "",
      };
    } catch (error) {
      console.error(
        `      Ошибка классификации (${attempt}/${MAX_RETRIES}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  // Ошибка классификации не должна уничтожать найденный ответ.
  return {
    title: question,
    sections: [],
    tags: [],
    comment: "",
  };
};

export const extractFaq = async (
  text: string,
  _prompt: string,
  sectionsFile: { sections: Section[] },
  tagsFile: { tags: string[] },
): Promise<ExtractedFaqItem[]> => {
  const chunks = splitText(text, MAX_CHUNK_CHARS);

  console.log(`  Этап 1 — извлечение: ${chunks.length} фрагментов`);

  const extracted: ExtractedQaItem[] = [];

  for (let index = 0; index < chunks.length; index++) {
    console.log(
      `  Извлечение: ${index + 1}/${chunks.length} (${chunks[index].length} символов)`,
    );

    const items = await extractQaChunk(chunks[index]);

    console.log(`  Найдено Q&A: ${items.length}`);

    extracted.push(...items);
  }

  console.log(`  Всего извлечено: ${extracted.length}`);

  const result: ExtractedFaqItem[] = [];

  for (let index = 0; index < extracted.length; index++) {
    const item = extracted[index];

    console.log(`  Этапы 2–3: ${index + 1}/${extracted.length}`);

    const edited = await editQa(item);

    const classification = await classifyQa(
      edited.question,
      edited.answer,
      sectionsFile.sections,
      tagsFile.tags,
    );

    const reviewReasons: string[] = [];

    if (!item.evidence) {
      reviewReasons.push(
        "Не удалось подтвердить цитату точным фрагментом расшифровки",
      );
    }

    // Любое изменение ответа требует проверки человеком.
    // Это консервативная проверка: она не доказывает ошибку,
    // а помогает не принять редактуру за слова автора.
    if (
      normalizeWhitespace(edited.answer) !== normalizeWhitespace(item.answer)
    ) {
      reviewReasons.push("Ответ изменён при редактуре — сравнить с оригиналом");
    }

    if (
      normalizeWhitespace(edited.question) !==
      normalizeWhitespace(item.question)
    ) {
      reviewReasons.push(
        "Вопрос изменён при редактуре — проверить формулировку",
      );
    }

    if (!classification.sections.length) {
      reviewReasons.push("Не назначен раздел");
    }

    result.push({
      sourceQuestion: item.sourceQuestion,

      originalQuestion: item.question,
      originalAnswer: item.answer,
      evidence: item.evidence,

      editedQuestion: edited.question,
      editedAnswer: edited.answer,

      // Для существующего кода отображения и merge.
      question: edited.question,
      answer: edited.answer,

      title: classification.title,
      sections: classification.sections,
      tags: classification.tags,
      comment: classification.comment,

      reviewStatus: reviewReasons.length ? "review" : "ready",
      reviewReasons,
    });
  }

  return result;
};

/**
 * Генерирует тематические теги для одного FAQ.
 * Существующие теги служат словарём предпочтительных названий,
 * но не ограничивают появление новых тегов.
 */
export const classifyFaqTags = async (
  question: string,
  answer: string,
  sections: Section[],
  existingTags: string[],
): Promise<string[]> => {
  const sectionList = sections
    .map((section) => `${section.id}: ${section.name}`)
    .join("\n");

  const tagList = existingTags.length
    ? existingTags.join("\n")
    : "(словарь пока пуст)";

  const system = `
Ты редактор тегов для строительной базы знаний.

Подбери от 2 до 5 коротких тематических тегов для FAQ.

СУЩЕСТВУЮЩИЕ ТЕГИ:
${tagList}

РАЗДЕЛЫ БАЗЫ:
${sectionList || "(список разделов пуст)"}

Правила:
- Теги описывают конкретную тему вопроса и ответа.
- Предпочитай существующий тег, если он точно подходит по смыслу.
- Не создавай новый вариант существующего тега только из-за другой формулировки.
- Если подходящего существующего тега нет, предложи новый.
- Используй короткие именные формулировки на русском языке.
- Не используй целые предложения и вопросы.
- Не добавляй теги, которые не подтверждаются ответом.
- Не дублируй синонимы в одном массиве.
- Не используй слишком общие теги вроде «вопрос», «ответ», «строительство».
- Не путай разделы с тегами: тег должен обозначать тему, материал,
  конструкцию, оборудование или технологию.
- Не добавляй пояснений.

Верни только JSON:
{"tags":["тег 1","тег 2"]}
`.trim();

  const content = await ollamaChat(
    system,
    `ВОПРОС:\n${question}\n\nОТВЕТ:\n${answer}`,
    500,
  );

  const data = parseModelJson(content, "Генерация тегов");

  if (!data || typeof data !== "object") {
    throw new Error("Генерация тегов вернула некорректный объект");
  }

  const value = data as { tags?: unknown };

  if (!Array.isArray(value.tags)) {
    throw new Error("Генерация тегов не вернула массив tags");
  }

  const result = value.tags
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim().replace(/^#+/, "").replace(/\s+/g, " "))
    .filter((tag) => tag.length >= 2 && tag.length <= 40)
    .filter(
      (tag) => !/^(вопрос|ответ|прочее|разное|строительство)$/i.test(tag),
    );

  return [...new Set(result)];
};

export const recoverEvidenceQuote = async (
  question: string,
  answer: string,
  excerpts: string[],
): Promise<string> => {
  const system = `
Ты редактор строительной базы знаний.
Найди в предоставленных фрагментах дословную цитату,
которая подтверждает ответ на вопрос.

Правила:
- Используй только текст предоставленных фрагментов.
- Не придумывай факты и не исправляй исходный текст.
- Цитата должна быть короткой и содержать конкретное подтверждение ответа.
- Если подтверждения нет, верни пустую строку.
- Верни только JSON: {"evidence":"дословная цитата"}
`.trim();

  const content = await ollamaChat(
    system,
    [
      `ВОПРОС:\n${question}`,
      `ОТВЕТ:\n${answer}`,
      ...excerpts.map((excerpt, index) => `ФРАГМЕНТ ${index + 1}:\n${excerpt}`),
    ].join("\n\n"),
    500,
  );

  const data = parseModelJson(content, "Восстановление цитаты");

  if (!data || typeof data !== "object") {
    throw new Error("Восстановление цитаты вернуло некорректный объект");
  }

  const evidence = (data as { evidence?: unknown }).evidence;

  if (typeof evidence !== "string") {
    throw new Error("Модель не вернула строковое поле evidence");
  }

  return evidence.trim();
};
