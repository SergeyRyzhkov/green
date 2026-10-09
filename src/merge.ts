import type {
  ExtractedFaqItem,
  FaqFile,
  FaqItem,
  FaqSource,
  SectionsFile,
  TagsFile,
} from "./types";

const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[«»"'`]/g, "")
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

const tokens = (text: string): Set<string> =>
  new Set(
    normalize(text)
      .split(" ")
      .filter((value) => value.length > 2),
  );

const similarity = (a: string, b: string): number => {
  const aa = tokens(a);
  const bb = tokens(b);

  if (!aa.size || !bb.size) return 0;

  let common = 0;

  for (const token of aa) {
    if (bb.has(token)) common++;
  }

  return common / (aa.size + bb.size - common);
};

const makeId = (question: string): string => {
  const slug =
    normalize(question)
      .split(" ")
      .filter(Boolean)
      .slice(0, 6)
      .join("-")
      .replace(/[^a-zа-я0-9-]/gi, "") || "faq";

  let hash = 0;

  for (const char of question) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }

  return `${slug}-${Math.abs(hash).toString(36)}`;
};

const createSourceQuestion = (source: FaqSource, question: string) => ({
  file: source.file,
  question: question.trim(),
});

const hasSourceQuestion = (
  item: FaqItem,
  source: FaqSource,
  question: string,
): boolean =>
  item.sourceQuestions.some(
    (entry) => entry.file === source.file && entry.question === question.trim(),
  );

const hasSource = (item: FaqItem, source: FaqSource): boolean =>
  item.sources.some(
    (entry) => entry.file === source.file && entry.url === source.url,
  );

const unique = (values: string[]): string[] => [...new Set(values)];

export const mergeFaq = (
  faq: FaqFile,
  extracted: ExtractedFaqItem[],
  source: FaqSource,
  sections: SectionsFile,
  tagsFile: TagsFile,
): {
  faq: FaqFile;
  tags: TagsFile;
  added: number;
  updated: number;
} => {
  const validSections = new Set(sections.sections.map((section) => section.id));

  const knownTags = new Set(tagsFile.tags);

  let added = 0;
  let updated = 0;

  for (const item of extracted) {
    const question = item.editedQuestion.trim();
    const answer = item.editedAnswer.trim();

    if (!question || !answer) {
      console.warn(
        `Пропущен FAQ с пустым вопросом или ответом: ${item.sourceQuestion}`,
      );
      continue;
    }

    const sectionIds = item.sections.filter((id) => validSections.has(id));

    // Не создаём новые теги автоматически.
    // Используем только уже существующие значения из tags.json.
    const allowedTags = new Set(
      tagsFile.tags.map((tag) => tag.toLocaleLowerCase("ru")),
    );

    const tags = item.tags
      .map((tag) => tag.trim())
      .filter((tag) => tag && allowedTags.has(tag.toLocaleLowerCase("ru")));

    for (const tag of tags) {
      knownTags.add(tag);
    }

    const existing = faq.items.find(
      (faqItem) =>
        similarity(faqItem.question, question) >= 0.82 ||
        faqItem.sourceQuestions.some(
          (sourceQuestion) =>
            sourceQuestion.question &&
            similarity(sourceQuestion.question, item.sourceQuestion) >= 0.88,
        ),
    );

    if (!existing) {
      const newItem: FaqItem = {
        id: makeId(question),

        title: item.title.trim() || question,
        question,
        answer,

        originalQuestion: item.originalQuestion,
        originalAnswer: item.originalAnswer,
        editedQuestion: item.editedQuestion,
        editedAnswer: item.editedAnswer,
        evidence: item.evidence,

        reviewStatus: item.reviewStatus,
        reviewReasons: [...item.reviewReasons],

        comment: item.comment.trim(),

        sourceQuestions: [createSourceQuestion(source, item.sourceQuestion)],

        sections: unique(sectionIds),
        tags: unique(tags),
        sources: [source],
        updatedAt: new Date().toISOString(),
      };

      faq.items.push(newItem);
      added++;
      continue;
    }

    let changed = false;

    if (!hasSourceQuestion(existing, source, item.sourceQuestion)) {
      existing.sourceQuestions.push(
        createSourceQuestion(source, item.sourceQuestion),
      );
      changed = true;
    }

    if (!hasSource(existing, source)) {
      existing.sources.push(source);
      changed = true;
    }

    const mergedSections = unique([...existing.sections, ...sectionIds]);

    if (mergedSections.length !== existing.sections.length) {
      existing.sections = mergedSections;
      changed = true;
    }

    const mergedTags = unique([...existing.tags, ...tags]);

    if (mergedTags.length !== existing.tags.length) {
      existing.tags = mergedTags;
      changed = true;
    }

    // Не перезаписываем существующие question, answer,
    // originalQuestion и originalAnswer.
    // Новый вариант не присоединяется к старому ответу.
    //
    // Если найденный ответ отличается от существующего,
    // фиксируем необходимость ручной проверки.
    if (normalize(existing.answer) !== normalize(answer)) {
      const reason = `Обнаружен другой вариант ответа в источнике «${source.file}»`;

      existing.reviewReasons = unique([
        ...(existing.reviewReasons ?? []),
        reason,
      ]);

      existing.reviewStatus = "review";
      changed = true;
    }

    // Если у старой записи ещё нет исходных полей,
    // заполняем их из текущего результата, не трогая ответ.
    if (!existing.originalQuestion && item.originalQuestion) {
      existing.originalQuestion = item.originalQuestion;
      changed = true;
    }

    if (!existing.originalAnswer && item.originalAnswer) {
      existing.originalAnswer = item.originalAnswer;
      changed = true;
    }

    if (!existing.editedQuestion && item.editedQuestion) {
      existing.editedQuestion = item.editedQuestion;
      changed = true;
    }

    if (!existing.editedAnswer && item.editedAnswer) {
      existing.editedAnswer = item.editedAnswer;
      changed = true;
    }

    if (!existing.evidence && item.evidence) {
      existing.evidence = item.evidence;
      changed = true;
    }

    if (!existing.reviewStatus) {
      existing.reviewStatus = item.reviewStatus;
      changed = true;
    }

    if (!existing.reviewReasons) {
      existing.reviewReasons = [...item.reviewReasons];
      changed = true;
    }

    // Сохраняем комментарий только при отсутствии старого.
    // Не заменяем комментарий новой генерацией автоматически.
    if (!existing.comment.trim() && item.comment.trim()) {
      existing.comment = item.comment.trim();
      changed = true;
    }

    if (changed) {
      existing.updatedAt = new Date().toISOString();
      updated++;
    }
  }

  faq.updatedAt = new Date().toISOString();

  tagsFile.tags = [...knownTags].sort((a, b) => a.localeCompare(b, "ru"));

  tagsFile.updatedAt = new Date().toISOString();

  return {
    faq,
    tags: tagsFile,
    added,
    updated,
  };
};

/**
 * Добавляет сгенерированные теги в словарь и возвращает
 * канонические названия для конкретного FAQ.
 *
 * Совпадения определяются по нормализованному написанию.
 * Смысловые синонимы модель должна сопоставлять на этапе генерации.
 */
export const mergeTagsIntoDictionary = (
  generatedTags: string[],
  tagsFile: TagsFile,
): string[] => {
  const normalizeTag = (value: string): string =>
    value
      .toLocaleLowerCase("ru")
      .replace(/ё/g, "е")
      .replace(/^#+/, "")
      .replace(/\s+/g, " ")
      .trim();

  const dictionary = new Map<string, string>();

  for (const existingTag of tagsFile.tags) {
    const tag = existingTag.trim().replace(/\s+/g, " ");

    if (!tag) continue;

    const key = normalizeTag(tag);

    if (!dictionary.has(key)) {
      dictionary.set(key, tag);
    }
  }

  const result: string[] = [];

  for (const candidate of generatedTags) {
    if (typeof candidate !== "string") continue;

    const tag = candidate.trim().replace(/^#+/, "").replace(/\s+/g, " ");

    if (tag.length < 2 || tag.length > 40) continue;

    const key = normalizeTag(tag);

    if (!key) continue;

    let canonical = dictionary.get(key);

    if (!canonical) {
      canonical = tag;
      dictionary.set(key, canonical);
      console.log(`  Новый тег: ${canonical}`);
    }

    if (!result.some((item) => normalizeTag(item) === key)) {
      result.push(canonical);
    }
  }

  tagsFile.tags = [...dictionary.values()].sort((a, b) =>
    a.localeCompare(b, "ru"),
  );

  return result;
};
