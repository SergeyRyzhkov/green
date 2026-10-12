import "dotenv/config";

import { enrichmentPrompt, extractionPrompt } from "./prompts";
import type {
  AiComparison,
  ComparisonStatus,
  EnrichedQa,
  ExtractionResult,
  ModelQa,
  Section,
} from "./types";

const configuredUrl =
  process.env.OLLAMA_URL ??
  process.env.OLLAMA_BASE_URL ??
  process.env.OPENAI_BASE_URL ??
  "http://localhost:11434/api/chat";

function resolveChatUrl(value: string): string {
  const url = value.trim().replace(/\/+$/, "");

  if (/\/api\/chat$/i.test(url)) return url;
  if (/\/api$/i.test(url)) return `${url}/chat`;

  return `${url.replace(/\/v1$/i, "")}/api/chat`;
}

const CHAT_URL = resolveChatUrl(configuredUrl);
const MODEL =
  process.env.OLLAMA_MODEL ?? process.env.OPENAI_MODEL ?? "qwen3.5:4b";

interface ChatResponse {
  message?: {
    content?: string | null;
    thinking?: string;
  };
  error?: string;
}

interface SourceMatch {
  text: string;
  start: number;
  end: number;
}

type RejectionReason =
  | "invalid_shape"
  | "invalid_question"
  | "question_not_found"
  | "answer_not_found"
  | "invalid_order_or_distance"
  | "ambiguous_pair"
  | "duplicate";

const normalizeWhitespace = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

const normalize = (value: string): string =>
  normalizeWhitespace(value).toLowerCase();

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const parseJson = <T>(content: string): T => {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");

    if (start < 0 || end <= start) {
      throw new Error("В ответе модели не найден JSON-объект");
    }

    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  }
};

async function chatJson<T>(prompt: string): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          stream: false,
          format: "json",
          think: false,
          messages: [
            {
              role: "system",
              content:
                "Следуй инструкции буквально. Возвращай только корректный JSON. Не выдумывай исходные данные.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          options: {
            temperature: 0,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(
          `Ollama HTTP ${response.status}: ${await response.text()}`,
        );
      }

      const payload = (await response.json()) as ChatResponse;

      if (payload.error) {
        throw new Error(payload.error);
      }

      const content = payload.message?.content;

      if (!content?.trim()) {
        throw new Error("Модель вернула пустой ответ");
      }

      return parseJson<T>(content);
    } catch (error) {
      lastError = error;

      if (attempt < 3) {
        const delayMs = attempt * 1500;

        console.warn(
          `  Повторный запрос к модели (${attempt + 1}/3) через ${delayMs} мс: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );

        await sleep(delayMs);
      }
    }
  }

  throw new Error(
    `Не удалось получить корректный JSON: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/**
 * Нормализует пробелы, сохраняя соответствие позиций
 * символов исходной расшифровке.
 */
function normalizeWithOffsets(source: string): {
  text: string;
  offsets: number[];
} {
  let text = "";
  const offsets: number[] = [];
  let previousWasWhitespace = true;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];

    if (/\s/.test(char)) {
      if (!previousWasWhitespace) {
        text += " ";
        offsets.push(i);
      }

      previousWasWhitespace = true;
      continue;
    }

    text += char;
    offsets.push(i);
    previousWasWhitespace = false;
  }

  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    offsets.pop();
  }

  return { text, offsets };
}

function findExactSourceMatches(
  source: string,
  candidate: string,
): SourceMatch[] {
  const wanted = normalizeWhitespace(candidate);

  if (!wanted) return [];

  const normalized = normalizeWithOffsets(source);
  const matches: SourceMatch[] = [];
  let fromIndex = 0;

  while (fromIndex < normalized.text.length) {
    const index = normalized.text.indexOf(wanted, fromIndex);

    if (index < 0) break;

    const start = normalized.offsets[index];
    const lastIndex = index + wanted.length - 1;
    const end = normalized.offsets[lastIndex] + 1;

    matches.push({
      text: source.slice(start, end),
      start,
      end,
    });

    fromIndex = index + 1;
  }

  return matches;
}

export function findExactSourceMatch(
  source: string,
  candidate: string,
): SourceMatch | null {
  return findExactSourceMatches(source, candidate)[0] ?? null;
}

export function findExactSourceText(
  source: string,
  candidate: string,
): string | null {
  return findExactSourceMatch(source, candidate)?.text ?? null;
}

/**
 * Формальная проверка вопроса.
 * Она не определяет, задан ли вопрос зрителем, — это задача промпта.
 */
function isPlausibleQuestion(value: string): boolean {
  const text = normalizeWhitespace(value);

  if (!text || !/[?？]["'»”)]*$/.test(text)) {
    return false;
  }

  if (text.length > 700) {
    return false;
  }

  const questionMarks = (text.match(/[?？]/g) ?? []).length;

  if (questionMarks > 4) {
    return false;
  }

  const withoutFinalQuestionMark = text.replace(/[?？]["'»”)]*$/, "");

  if (/[.!…]\s+\p{Lu}/u.test(withoutFinalQuestionMark)) {
    return false;
  }

  return true;
}

type MatchResult =
  | {
      ok: true;
      question: SourceMatch;
      answer: SourceMatch;
    }
  | {
      ok: false;
      reason: RejectionReason;
    };

function selectOrderedMatches(
  source: string,
  question: string,
  answer: string,
): MatchResult {
  if (!isPlausibleQuestion(question)) {
    return { ok: false, reason: "invalid_question" };
  }

  const questions = findExactSourceMatches(source, question);

  if (questions.length === 0) {
    return { ok: false, reason: "question_not_found" };
  }

  const answers = findExactSourceMatches(source, answer);

  if (answers.length === 0) {
    return { ok: false, reason: "answer_not_found" };
  }

  let foundOrderedPair = false;
  let foundPairWithinDistance = false;
  let best:
    | {
        question: SourceMatch;
        answer: SourceMatch;
        distance: number;
      }
    | undefined;

  for (const questionMatch of questions) {
    for (const answerMatch of answers) {
      const distance = answerMatch.start - questionMatch.end;

      if (distance < 0) continue;

      foundOrderedPair = true;

      // Пока оставляем прежний предел: сначала измеряем причины отказов.
      if (distance > 1800) continue;

      foundPairWithinDistance = true;

      const between = source.slice(questionMatch.end, answerMatch.start);

      if (/[?？]/.test(between)) continue;
      if (isPlausibleQuestion(answerMatch.text)) continue;

      if (!best || distance < best.distance) {
        best = {
          question: questionMatch,
          answer: answerMatch,
          distance,
        };
      }
    }
  }

  if (best) {
    return {
      ok: true,
      question: best.question,
      answer: best.answer,
    };
  }

  if (!foundOrderedPair || !foundPairWithinDistance) {
    return { ok: false, reason: "invalid_order_or_distance" };
  }

  return { ok: false, reason: "ambiguous_pair" };
}

export async function extractQa(text: string): Promise<ExtractionResult> {
  const payload = await chatJson<{
    items?: Array<{
      question?: unknown;
      answer?: unknown;
      context?: unknown;
    }>;
  }>(extractionPrompt(text));

  const candidates = Array.isArray(payload.items) ? payload.items : [];
  const items: ModelQa[] = [];
  const seen = new Set<string>();

  const rejectionReasons: Record<RejectionReason, number> = {
    invalid_shape: 0,
    invalid_question: 0,
    question_not_found: 0,
    answer_not_found: 0,
    invalid_order_or_distance: 0,
    ambiguous_pair: 0,
    duplicate: 0,
  };

  const reject = (reason: RejectionReason): void => {
    rejectionReasons[reason] += 1;
  };

  for (const candidate of candidates) {
    if (
      typeof candidate?.question !== "string" ||
      typeof candidate?.answer !== "string"
    ) {
      reject("invalid_shape");
      continue;
    }

    const question = candidate.question.trim();
    const answer = candidate.answer.trim();

    if (!question || !answer) {
      reject("invalid_shape");
      continue;
    }

    const matchResult = selectOrderedMatches(text, question, answer);

    if (!matchResult.ok) {
      reject(matchResult.reason);
      continue;
    }

    const questionText = matchResult.question.text;
    const answerText = matchResult.answer.text;
    const key = `${normalize(questionText)}\n${normalize(answerText)}`;

    if (seen.has(key)) {
      reject("duplicate");
      continue;
    }

    seen.add(key);

    const context =
      typeof candidate.context === "string"
        ? (findExactSourceText(text, candidate.context) ?? "")
        : "";

    items.push({
      question: questionText,
      answer: answerText,
      context,
    });
  }

  const rejected = Object.values(rejectionReasons).reduce(
    (total, count) => total + count,
    0,
  );

  console.log(
    `    Причины отказа: ${
      Object.entries(rejectionReasons)
        .filter(([, count]) => count > 0)
        .map(([reason, count]) => `${reason}=${count}`)
        .join(", ") || "нет"
    }`,
  );

  return {
    items,
    rejected,
    modelCount: candidates.length,
  };
}

const validStatuses = new Set<ComparisonStatus>([
  "agree",
  "partially_agree",
  "disagree",
  "not_comparable",
]);

export async function enrichQa(
  qa: ModelQa,
  sections: Section[],
  existingTags: string[] = [],
): Promise<EnrichedQa> {
  const payload = await chatJson<Partial<EnrichedQa>>(
    enrichmentPrompt(qa, sections, existingTags),
  );

  const validSectionIds = new Set(sections.map((section) => section.id));

  const selectedSections = Array.isArray(payload.sections)
    ? payload.sections.filter(
        (value): value is string =>
          typeof value === "string" && validSectionIds.has(value),
      )
    : [];

  const selectedTags = Array.isArray(payload.tags)
    ? payload.tags.filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      )
    : [];

  const rawComparison = payload.aiComparison;
  const rawStatus = rawComparison?.status;

  const status: ComparisonStatus =
    typeof rawStatus === "string" &&
    validStatuses.has(rawStatus as ComparisonStatus)
      ? (rawStatus as ComparisonStatus)
      : "not_comparable";

  const rawPercent = Number(rawComparison?.agreementPercent);

  const agreementPercent =
    status === "not_comparable"
      ? 0
      : Number.isFinite(rawPercent)
        ? Math.max(0, Math.min(100, Math.round(rawPercent)))
        : 0;

  const needsContext = payload.needsContext === true;

  const aiAnswer =
    needsContext || typeof payload.aiAnswer !== "string"
      ? ""
      : payload.aiAnswer.trim();

  const comparisonStatus: ComparisonStatus =
    needsContext || !aiAnswer ? "not_comparable" : status;

  const aiComparison: AiComparison = {
    status: comparisonStatus,
    agreementPercent:
      comparisonStatus === "not_comparable" ? 0 : agreementPercent,
    summary:
      typeof rawComparison?.summary === "string" && rawComparison.summary.trim()
        ? rawComparison.summary.trim()
        : "Сравнение не удалось выполнить.",
  };

  return {
    sections: [...new Set(selectedSections)],
    tags: [...new Set(selectedTags.map((tag) => tag.trim()))],
    needsContext,
    aiAnswer,
    aiComparison,
  };
}
