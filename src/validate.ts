import { createHash } from "node:crypto";

export interface TextMatch {
  start: number;
  end: number;
  quote: string;
  similarity: number;
}

export interface PairValidation {
  ok: boolean;
  reason?: string;
  question?: TextMatch;
  answer?: TextMatch;
}

type Token = {
  value: string;
  start: number;
  end: number;
};

export const normalizeForSearch = (value: string): string =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[«»„“”]/g, '"')
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");

const tokensWithOffsets = (text: string): Token[] => {
  const tokens: Token[] = [];
  const regex = /[\p{L}\p{N}]+/gu;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    tokens.push({
      value: match[0]
        .normalize("NFKC")
        .toLocaleLowerCase("ru-RU")
        .replace(/ё/g, "е"),
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return tokens;
};

const editDistance = (a: string, b: string): number => {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];

    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }

    previous = current;
  }

  return previous[b.length];
};

const editSimilarity = (a: string, b: string): number => {
  if (a === b) return 1;
  if (!a || !b) return 0;

  const longest = Math.max(a.length, b.length);

  if (Math.abs(a.length - b.length) > Math.max(2, Math.floor(longest * 0.25))) {
    return 0;
  }

  return 1 - editDistance(a, b) / longest;
};

const tokenSimilarity = (a: string, b: string): number => {
  if (a === b) return 1;
  if (Math.min(a.length, b.length) < 4) return 0;

  return editSimilarity(a, b);
};

/**
 * Ищет цитату в исходном тексте.
 * Учитывает пунктуацию, пробелы и небольшие ошибки распознавания речи.
 * Возвращает позиции найденного фрагмента в исходной строке.
 */
export const findQuoteInSource = (
  source: string,
  quote: string,
  minSimilarity = 0.82,
  fromIndex = 0,
): TextMatch | null => {
  const trimmedQuote = quote.trim();

  if (!trimmedQuote || !source) return null;

  const safeFromIndex = Math.max(0, fromIndex);
  const target = tokensWithOffsets(trimmedQuote);
  const sourceTokens = tokensWithOffsets(source).filter(
    (token) => token.start >= safeFromIndex,
  );

  if (target.length < 2 || sourceTokens.length < 2) return null;

  // 1. Точное совпадение исходного текста.
  const exactIndex = source.indexOf(trimmedQuote, safeFromIndex);

  if (exactIndex >= 0) {
    return {
      start: exactIndex,
      end: exactIndex + trimmedQuote.length,
      quote: source.slice(exactIndex, exactIndex + trimmedQuote.length),
      similarity: 1,
    };
  }

  const targetValues = target.map((token) => token.value);
  const sourceValues = sourceTokens.map((token) => token.value);

  // 2. Совпадение слов без учёта пунктуации и пробелов.
  for (let i = 0; i <= sourceValues.length - targetValues.length; i += 1) {
    let exact = true;

    for (let j = 0; j < targetValues.length; j += 1) {
      if (sourceValues[i + j] !== targetValues[j]) {
        exact = false;
        break;
      }
    }

    if (exact) {
      const first = sourceTokens[i];
      const last = sourceTokens[i + targetValues.length - 1];

      return {
        start: first.start,
        end: last.end,
        quote: source.slice(first.start, last.end),
        similarity: 1,
      };
    }
  }

  // 3. Приблизительное совпадение с учётом ошибок транскрибации.
  const targetLength = targetValues.length;
  const minWindowLength = Math.max(2, Math.floor(targetLength * 0.72));
  const maxWindowLength = Math.min(
    Math.ceil(targetLength * 1.35) + 3,
    targetLength + 12,
  );

  let best: TextMatch | null = null;

  for (let start = 0; start < sourceTokens.length; start += 1) {
    const anchorEnd = Math.min(targetLength, 4);
    let anchorMatches = 0;

    for (let targetIndex = 0; targetIndex < anchorEnd; targetIndex += 1) {
      const candidateIndex = start + targetIndex;

      if (candidateIndex >= sourceTokens.length) break;

      if (
        tokenSimilarity(
          targetValues[targetIndex],
          sourceTokens[candidateIndex].value,
        ) >= 0.65
      ) {
        anchorMatches += 1;
      }
    }

    if (anchorMatches === 0 && targetLength >= 5) {
      let foundNearbyAnchor = false;

      for (
        let targetIndex = 0;
        targetIndex < Math.min(targetLength, 5) && !foundNearbyAnchor;
        targetIndex += 1
      ) {
        for (
          let sourceOffset = 0;
          sourceOffset <= 2 && start + sourceOffset < sourceTokens.length;
          sourceOffset += 1
        ) {
          if (
            tokenSimilarity(
              targetValues[targetIndex],
              sourceTokens[start + sourceOffset].value,
            ) >= 0.65
          ) {
            foundNearbyAnchor = true;
            break;
          }
        }
      }

      if (!foundNearbyAnchor) continue;
    }

    for (
      let windowLength = minWindowLength;
      windowLength <= maxWindowLength;
      windowLength += 1
    ) {
      const endIndex = start + windowLength - 1;

      if (endIndex >= sourceTokens.length) break;

      const window = sourceTokens
        .slice(start, endIndex + 1)
        .map((token) => token.value);

      let cursor = 0;
      let matchedWeight = 0;
      let matchedTokens = 0;

      for (const targetToken of targetValues) {
        let localBest = 0;
        let localIndex = -1;
        const upper = Math.min(window.length, cursor + 4);

        for (let j = cursor; j < upper; j += 1) {
          const similarity = tokenSimilarity(targetToken, window[j]);

          if (similarity > localBest) {
            localBest = similarity;
            localIndex = j;
          }
        }

        if (localIndex >= 0 && localBest >= 0.65) {
          matchedTokens += 1;
          matchedWeight += localBest;
          cursor = localIndex + 1;
        }
      }

      const coverage = matchedTokens / targetLength;
      const precision = matchedWeight / window.length;
      const similarity =
        (matchedWeight / targetLength) * Math.min(1, precision + 0.15);

      if (
        coverage < 0.72 ||
        matchedTokens < Math.max(2, Math.floor(targetLength * 0.65))
      ) {
        continue;
      }

      if (similarity < minSimilarity) continue;

      const first = sourceTokens[start];
      const last = sourceTokens[endIndex];

      const candidate: TextMatch = {
        start: first.start,
        end: last.end,
        quote: source.slice(first.start, last.end),
        similarity,
      };

      if (
        !best ||
        candidate.similarity > best.similarity ||
        (candidate.similarity === best.similarity &&
          candidate.quote.length < best.quote.length)
      ) {
        best = candidate;
      }
    }
  }

  return best;
};

export const findApproximateQuoteInSource = (
  source: string,
  quote: string,
  minSimilarity = 0.82,
  _extendSentence = false,
): TextMatch | null => findQuoteInSource(source, quote, minSimilarity);

/**
 * Проверяет, похож ли текст на вопрос зрителя.
 *
 * Помимо вопросов со знаком вопроса принимаются типичные формулировки
 * из комментариев к строительным видео: просьбы объяснить, описания
 * ситуации, обращения к автору и вопросы в форме утверждения.
 */

const looksLikeQuestion = (question: string): boolean => {
  const value = normalizeForSearch(question);

  if (!value || value.length < 14) return false;

  const tokens = value.split(/\s+/).filter(Boolean);
  if (tokens.length < 4) return false;

  // 1. Отсекаем очевидные начала авторского ответа.
  // Проверяем начало фразы, а не отдельные слова внутри неё.
  const answerOpeners = [
    /^вижу\b/,
    /^давайте\b/,
    /^дальше\b/,
    /^далее\b/,
    /^итак\b/,
    /^собственно\b/,
    /^то есть\b/,
    /^другими словами\b/,
    /^дело в том\b/,
    /^суть в том\b/,
    /^причина в том\b/,
    /^проблема в том\b/,
    /^получается\b/,
    /^соответственно\b/,
    /^поэтому\b/,
    /^следовательно\b/,
    /^однако\b/,
    /^тем не менее\b/,
    /^ну они\b/,
    /^ну это\b/,
    /^ну вот\b/,
    /^а так вот\b/,
    /^я не знаю\b/,
    /^а я не знаю\b/,
    /^я считаю\b/,
    /^я думаю\b/,
    /^я полагаю\b/,
    /^на мой взгляд\b/,
    /^обратите внимание\b/,
    /^запомните\b/,
    /^представьте себе\b/,
    /^допустим\b/,
    /^предположим\b/,
  ];

  if (answerOpeners.some((pattern) => pattern.test(value))) {
    // Исключение: после вводной фразы может идти настоящий вопрос.
    const questionAfterOpener =
      /\b(как|почему|зачем|кто|что|где|куда|когда|сколько|какой|какая|какие|какое|чем|ли)\b/.test(
        value,
      ) && /[?？]/.test(question);

    if (!questionAfterOpener) return false;
  }

  // 2. Вопросительный знак — сильный признак вопроса.
  if (/[?？]/.test(question)) return true;

  // 3. Явные вопросы и просьбы, даже если знак вопроса отсутствует.
  const directOpeners =
    /^(как|почему|зачем|кто|что|где|куда|откуда|когда|сколько|насколько|какой|какая|какие|какое|чей|чья|чьи|чьё|чьего|чему|чем|кому|кого|отчего|для чего|в чем|в чём|на что|с чем|при каких условиях|в каких случаях|назовите|подскажите|расскажите|объясните|поясните|уточните|посоветуйте|порекомендуйте|сравните|перечислите|помогите|интересует|можно ли|нужно ли|надо ли|стоит ли|должен ли|должна ли|должны ли|будет ли|есть ли|бывает ли|возможно ли|допустимо ли|правильно ли|достаточно ли|имеет ли смысл|в чем разница|в чём разница|что лучше|как лучше|как правильно|как понять|как определить|как выбрать|как рассчитать|как проверить|как узнать|как сделать|что делать|что выбрать|что использовать|что учитывать|что предусмотреть)\b/;

  if (directOpeners.test(value)) return true;

  // 4. Косвенный вопрос может начинаться с описания ситуации.
  // Эти конструкции не привязаны к предметной области.
  const indirectQuestionPatterns = [
    /\bу меня (возник|появился|есть) вопрос\b/,
    /\bу нас (возник|появился|есть) вопрос\b/,
    /\bвозник вопрос\b/,
    /\bпоявился вопрос\b/,
    /\bхотел спросить\b/,
    /\bхотела спросить\b/,
    /\bхотелось бы спросить\b/,
    /\bхотелось бы узнать\b/,
    /\bхотел бы узнать\b/,
    /\bхотела бы узнать\b/,
    /\bхочу узнать\b/,
    /\bхочу понять\b/,
    /\bхотелось бы понять\b/,
    /\bинтересно узнать\b/,
    /\bмне интересно\b/,
    /\bинтересует вопрос\b/,
    /\bподскажите пожалуйста\b/,
    /\bподскажите, пожалуйста\b/,
    /\bне могу понять\b/,
    /\bнепонятно,?\s+(как|почему|зачем|что|где|когда|какой|какая|какие|сколько)\b/,
    /\bесть ли смысл\b/,
    /\bимеет ли смысл\b/,
    /\bвозникает вопрос\b/,
    /\bхочется разобраться\b/,
    /\bхочется понять\b/,
    /\bхотелось бы разобраться\b/,
  ];

  if (indirectQuestionPatterns.some((pattern) => pattern.test(value))) {
    return true;
  }

  // 5. Контекстное описание с явным намерением что-то выяснить.
  // Словарь общий: не содержит строительных терминов.
  const hasInquiryIntent =
    /\b(узнать|понять|разобраться|выяснить|уточнить|спросить|интересует|интересно|непонятно|не понимаю|не могу понять|хочется понять|хотелось бы понять|хочу понять|хочу узнать|хотел узнать|хотела узнать|планирую|собираюсь|рассматриваю|выбираю|сомневаюсь|затрудняюсь|нужен совет|нужна рекомендация|прошу совета)\b/.test(
      value,
    );

  const hasQuestionForm =
    /\b(как|почему|зачем|кто|что|где|куда|откуда|когда|сколько|насколько|какой|какая|какие|какое|чем|кому|кого|чему|ли|лучше ли|можно ли|нужно ли|надо ли|стоит ли|должен ли|должна ли|должны ли|будет ли|есть ли|правильно ли|достаточно ли|возможно ли|допустимо ли)\b/.test(
      value,
    );

  if (hasInquiryIntent && hasQuestionForm) return true;

  // 6. Описание личной ситуации и намерение получить рекомендацию.
  const hasPersonalOrSituationalContext =
    /\b(у меня|у нас|в моем случае|в моём случае|в нашем случае|для меня|для нас|я планирую|мы планируем|я собираюсь|мы собираемся|я хочу|мы хотим|я рассматриваю|мы рассматриваем|столкнулся с|столкнулась с|столкнулись с|возникла проблема|возникла ситуация|есть проблема|есть сомнения|не знаю, как|не знаю, что|не уверен, что|не уверена, что|не уверены, что)\b/.test(
      value,
    );

  const hasAdviceIntent =
    /\b(посоветуйте|порекомендуйте|подскажите|помогите|что лучше|как лучше|как правильно|какой вариант|какой способ|каким образом|что выбрать|что делать|как поступить|как быть|стоит ли|имеет ли смысл|можно ли|нужно ли|надо ли|достаточно ли|правильно ли|возможно ли)\b/.test(
      value,
    );

  if (hasPersonalOrSituationalContext && hasAdviceIntent) {
    return true;
  }

  // 7. Сообщение о намерении что-то сделать само по себе не вопрос.
  // Без дополнительных признаков запроса возвращаем false.
  return false;
};

export const validatePair = (
  source: string,
  questionQuote: string,
  answerQuote: string,
  options: {
    questionSimilarity?: number;
    answerSimilarity?: number;
    maxGap?: number;
  } = {},
): PairValidation => {
  const qMin = options.questionSimilarity ?? 0.78;
  const aMin = options.answerSimilarity ?? 0.78;
  const maxGap = options.maxGap ?? 12000;

  if (!questionQuote?.trim()) {
    return { ok: false, reason: "empty_question" };
  }

  if (!answerQuote?.trim()) {
    return { ok: false, reason: "empty_answer" };
  }

  if (!looksLikeQuestion(questionQuote)) {
    return { ok: false, reason: "question_not_question_like" };
  }

  const question = findQuoteInSource(source, questionQuote, qMin);

  if (!question) {
    return { ok: false, reason: "question_quote_not_found" };
  }

  const answer = findQuoteInSource(source, answerQuote, aMin, question.end);

  if (!answer) {
    return {
      ok: false,
      reason: "answer_quote_not_found_after_question",
      question,
    };
  }

  if (answer.start < question.end) {
    return { ok: false, reason: "answer_before_question", question, answer };
  }

  if (answer.start - question.end > maxGap) {
    return {
      ok: false,
      reason: "question_answer_gap_too_large",
      question,
      answer,
    };
  }

  if (normalizeForSearch(question.quote) === normalizeForSearch(answer.quote)) {
    return { ok: false, reason: "question_equals_answer", question, answer };
  }

  return { ok: true, question, answer };
};

export const makeQuestionLabel = (question: string): string => {
  const clean = question.replace(/\s+/g, " ").trim();

  if (!clean) return clean;
  if (/[?!…]$/.test(clean)) return clean;

  return clean.replace(/[.,;:]+$/, "") + "?";
};

export const makeStableId = (file: string, question: string): string => {
  const hash = createHash("sha256")
    .update(`${file}\n${normalizeForSearch(question)}`)
    .digest("hex")
    .slice(0, 12);

  return `faq-${hash}`;
};

export const areNearDuplicates = (a: string, b: string): boolean => {
  const na = normalizeForSearch(a);
  const nb = normalizeForSearch(b);

  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;

  const aw = na.split(" ");
  const bw = nb.split(" ");
  const short = aw.length <= bw.length ? aw : bw;
  const long = aw.length > bw.length ? aw : bw;

  if (short.length < 4 || short.length / long.length < 0.65) {
    return false;
  }

  let same = 0;
  const counts = new Map<string, number>();

  for (const word of long) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  for (const word of short) {
    const count = counts.get(word) ?? 0;

    if (count > 0) {
      same += 1;
      counts.set(word, count - 1);
    }
  }

  return same / short.length >= 0.82;
};
