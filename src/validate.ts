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

const tokensWithOffsets = (text: string) => {
  const tokens: Array<{ value: string; start: number; end: number }> = [];
  const regex = /[\p{L}\p{N}]+/gu;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    tokens.push({
      value: match[0].normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/ё/g, "е"),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return tokens;
};

const editSimilarity = (a: string, b: string): number => {
  if (a === b) return 1;
  if (!a || !b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 0;
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
  return 1 - previous[b.length] / Math.max(a.length, b.length);
};

const tokenSimilarity = (a: string, b: string): number => {
  if (a === b) return 1;
  if (Math.min(a.length, b.length) >= 4) return editSimilarity(a, b);
  return 0;
};

/** Finds the best contiguous source window without extending it to sentence boundaries. */
export const findQuoteInSource = (
  source: string,
  quote: string,
  minSimilarity = 0.82,
  fromIndex = 0,
): TextMatch | null => {
  const target = tokensWithOffsets(quote);
  const sourceTokens = tokensWithOffsets(source);
  if (target.length < 2 || sourceTokens.length < target.length * 0.55) return null;

  const targetValues = target.map((token) => token.value);
  const startTokenIndex = sourceTokens.findIndex((token) => token.start >= fromIndex);
  if (startTokenIndex < 0) return null;

  // Fast path: exact raw text, but never silently extend the quote.
  const exactIndex = source.indexOf(quote.trim(), fromIndex);
  if (exactIndex >= 0) {
    return {
      start: exactIndex,
      end: exactIndex + quote.trim().length,
      quote: source.slice(exactIndex, exactIndex + quote.trim().length),
      similarity: 1,
    };
  }

  const minLen = Math.max(2, Math.floor(targetValues.length * 0.72));
  const maxLen = Math.min(
    Math.ceil(targetValues.length * 1.32) + 2,
    targetValues.length + 10,
  );
  let best: TextMatch | null = null;

  for (let i = startTokenIndex; i < sourceTokens.length; i += 1) {
    // Candidate starts are anchored on a reasonably distinctive initial token.
    const firstScore = tokenSimilarity(targetValues[0], sourceTokens[i].value);
    if (firstScore < 0.65) continue;
    for (let length = minLen; length <= maxLen; length += 1) {
      const lastIndex = i + length - 1;
      if (lastIndex >= sourceTokens.length) break;
      const window = sourceTokens.slice(i, lastIndex + 1).map((token) => token.value);
      let matches = 0;
      let score = 0;
      const denominator = Math.max(targetValues.length, window.length);
      // Ordered token alignment, with a small tolerance for ASR token differences.
      let cursor = 0;
      for (const targetToken of targetValues) {
        let localBest = 0;
        let localIndex = -1;
        const upper = Math.min(window.length, cursor + 3);
        for (let j = cursor; j < upper; j += 1) {
          const similarity = tokenSimilarity(targetToken, window[j]);
          if (similarity > localBest) {
            localBest = similarity;
            localIndex = j;
          }
        }
        if (localIndex >= 0 && localBest >= 0.65) {
          matches += 1;
          score += localBest;
          cursor = localIndex + 1;
        }
      }
      const similarity = score / denominator;
      if (matches < Math.max(2, Math.floor(targetValues.length * 0.65))) continue;
      if (similarity < minSimilarity) continue;
      const candidate: TextMatch = {
        start: sourceTokens[i].start,
        end: sourceTokens[lastIndex].end,
        quote: source.slice(sourceTokens[i].start, sourceTokens[lastIndex].end),
        similarity,
      };
      if (!best || candidate.similarity > best.similarity) best = candidate;
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

const looksLikeQuestion = (question: string): boolean => {
  const value = question.trim();
  if (value.length < 14 || tokensWithOffsets(value).length < 4) return false;
  if (/^(ну|вот|то есть|а я не знаю|я не знаю|да и|но это)\b/i.test(value)) return false;
  if (/\?/.test(value)) return true;
  return /^(подскажите|расскажите|объясните|интересует|можно ли|нужно ли|стоит ли|как |почему |зачем |какой |какая |какие |какое |сколько |насколько |в каких случаях|будет ли|есть ли|чем |куда |где |когда |планирую|хотелось бы|хочется )/i.test(value);
};

export const validatePair = (
  source: string,
  questionQuote: string,
  answerQuote: string,
  options: { questionSimilarity?: number; answerSimilarity?: number; maxGap?: number } = {},
): PairValidation => {
  const qMin = options.questionSimilarity ?? 0.78;
  const aMin = options.answerSimilarity ?? 0.78;
  const maxGap = options.maxGap ?? 12000;

  if (!questionQuote?.trim()) return { ok: false, reason: "empty_question" };
  if (!answerQuote?.trim()) return { ok: false, reason: "empty_answer" };
  if (!looksLikeQuestion(questionQuote)) return { ok: false, reason: "question_not_question_like" };

  const question = findQuoteInSource(source, questionQuote, qMin);
  if (!question) return { ok: false, reason: "question_quote_not_found" };
  const answer = findQuoteInSource(source, answerQuote, aMin, question.end);
  if (!answer) return { ok: false, reason: "answer_quote_not_found_after_question", question };
  if (answer.start < question.end) return { ok: false, reason: "answer_before_question", question, answer };
  if (answer.start - question.end > maxGap) {
    return { ok: false, reason: "question_answer_gap_too_large", question, answer };
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
  if (short.length < 4 || short.length / long.length < 0.65) return false;
  let same = 0;
  const counts = new Map<string, number>();
  for (const word of long) counts.set(word, (counts.get(word) ?? 0) + 1);
  for (const word of short) {
    const count = counts.get(word) ?? 0;
    if (count > 0) {
      same += 1;
      counts.set(word, count - 1);
    }
  }
  return same / short.length >= 0.82;
};
