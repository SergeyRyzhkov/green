import { enrichmentPrompt, qaExtractionPrompt } from "./prompts.js";
import type {
  Enrichment,
  ExtractedQaPair,
  FaqComparison,
  Section,
} from "./types.js";

const OLLAMA_URL = (process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(
  /\/$/,
  "",
);
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3.5:4b";
const REQUEST_TIMEOUT_MS = Math.max(
  30000,
  Number(process.env.REQUEST_TIMEOUT_MS ?? 300000),
);
const OLLAMA_NUM_CTX = Math.max(
  4096,
  Number(process.env.OLLAMA_NUM_CTX ?? 8192),
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const extractJson = (raw: string): unknown => {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start)
      return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error(
      `Не удалось разобрать JSON модели: ${trimmed.slice(0, 300)}`,
    );
  }
};

const chat = async (prompt: string): Promise<string> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          stream: false,
          think: false,
          format: "json",
          messages: [{ role: "user", content: prompt }],
          options: { temperature: 0, num_ctx: OLLAMA_NUM_CTX },
        }),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Ollama HTTP ${response.status}: ${body.slice(0, 500)}`,
        );
      }
      const payload = (await response.json()) as {
        message?: {
          content?: string | null;
          thinking?: string;
          reasoning?: string;
        };
        error?: string;
      };
      const content = payload.message?.content;
      if (!content?.trim())
        throw new Error(
          `Пустой ответ Ollama: ${JSON.stringify(payload).slice(0, 500)}`,
        );
      return content;
    } catch (error) {
      lastError = error;
      console.warn(
        `  Запрос к Ollama: попытка ${attempt}/3 не удалась: ${String(error)}`,
      );
      if (attempt < 3) await sleep(attempt * 2500);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

export const extractQaPairs = async (
  text: string,
): Promise<ExtractedQaPair[]> => {
  const parsed = extractJson(await chat(qaExtractionPrompt(text))) as {
    pairs?: unknown;
  };
  if (!Array.isArray(parsed?.pairs))
    throw new Error("Модель не вернула массив pairs");
  return parsed.pairs.flatMap((entry): ExtractedQaPair[] => {
    if (!entry || typeof entry !== "object") return [];
    const pair = entry as Record<string, unknown>;
    if (
      typeof pair.questionQuote !== "string" ||
      typeof pair.answerQuote !== "string"
    )
      return [];
    const questionQuote = pair.questionQuote.trim();
    const answerQuote = pair.answerQuote.trim();
    if (questionQuote.length < 8 || answerQuote.length < 15) return [];
    return [{ questionQuote, answerQuote }];
  });
};

export const enrichFaq = async (
  question: string,
  authorAnswer: string,
  sections: Section[],
): Promise<Enrichment> => {
  const parsed = extractJson(
    await chat(enrichmentPrompt(question, authorAnswer, sections)),
  ) as Record<string, unknown>;
  const allowedIds = new Set(sections.map((section) => section.id));
  const selectedSections = Array.isArray(parsed.sections)
    ? [
        ...new Set(
          parsed.sections.filter(
            (id): id is string => typeof id === "string" && allowedIds.has(id),
          ),
        ),
      ]
    : [];
  const aiAnswer =
    typeof parsed.aiAnswer === "string" && parsed.aiAnswer.trim()
      ? parsed.aiAnswer.trim()
      : null;
  let comparison: FaqComparison | null = null;
  if (aiAnswer && parsed.comparison && typeof parsed.comparison === "object") {
    const raw = parsed.comparison as Record<string, unknown>;
    const statuses = new Set([
      "agree",
      "partially_agree",
      "disagree",
      "not_comparable",
    ]);
    const status =
      typeof raw.status === "string" && statuses.has(raw.status)
        ? (raw.status as FaqComparison["status"])
        : "not_comparable";
    const percent = Number(raw.agreementPercent);
    comparison = {
      status,
      agreementPercent: Number.isFinite(percent)
        ? Math.max(0, Math.min(100, Math.round(percent)))
        : 0,
      summary: typeof raw.summary === "string" ? raw.summary.trim() : "",
    };
  }
  return { sections: selectedSections, aiAnswer, comparison };
};
