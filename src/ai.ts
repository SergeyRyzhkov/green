import { enrichmentPrompt, qaExtractionPrompt } from "./prompts.js";
import type {
  ComparisonStatus,
  Enrichment,
  ExtractedQaPair,
  Section,
} from "./types.js";

const OLLAMA_URL = (process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(
  /\/$/,
  "",
);

const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3.5:4b";

const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 240_000);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function extractJson(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");

    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }

    throw new Error("Модель вернула некорректный JSON");
  }
}

async function chat(prompt: string): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();

    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          stream: false,
          think: false,
          format: "json",
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
          options: {
            temperature: 0,
            num_ctx: Number(process.env.OLLAMA_NUM_CTX ?? 8192),
          },
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
        };
        error?: string;
      };

      if (payload.error) {
        throw new Error(payload.error);
      }

      const content = payload.message?.content;

      if (!content?.trim()) {
        throw new Error("Ollama вернула пустой ответ");
      }

      return content;
    } catch (error) {
      lastError = error;

      if (attempt < 3) {
        const waitMs = attempt * 2000;

        console.warn(
          `  Повтор запроса к Ollama (${attempt + 1}/3) ` +
            `через ${waitMs} мс`,
        );

        await sleep(waitMs);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(
    `Не удалось получить ответ от Ollama: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

export async function extractQaPairs(text: string): Promise<ExtractedQaPair[]> {
  const raw = extractJson(await chat(qaExtractionPrompt(text))) as {
    pairs?: unknown;
  };

  if (!Array.isArray(raw.pairs)) {
    throw new Error("В ответе модели нет массива pairs");
  }

  const result: ExtractedQaPair[] = [];

  for (const item of raw.pairs) {
    if (typeof item !== "object" || item === null) {
      continue;
    }

    const pair = item as Record<string, unknown>;

    if (
      typeof pair.questionQuote !== "string" ||
      typeof pair.answerQuote !== "string"
    ) {
      continue;
    }

    const questionQuote = pair.questionQuote.trim();
    const answerQuote = pair.answerQuote.trim();

    if (!questionQuote || !answerQuote) {
      continue;
    }

    result.push({
      questionQuote,
      answerQuote,
    });
  }

  return result;
}

export async function enrichFaq(
  question: string,
  authorAnswer: string,
  sections: Section[],
): Promise<Enrichment> {
  const parsed = extractJson(
    await chat(enrichmentPrompt(question, authorAnswer, sections)),
  ) as Record<string, unknown>;

  const validSectionIds = new Set(sections.map((section) => section.id));

  const sectionIds = Array.isArray(parsed.sections)
    ? parsed.sections.filter(
        (id): id is string => typeof id === "string" && validSectionIds.has(id),
      )
    : [];

  const aiAnswer =
    typeof parsed.aiAnswer === "string" && parsed.aiAnswer.trim().length > 0
      ? parsed.aiAnswer.trim()
      : null;

  let comparison: Enrichment["comparison"] = null;

  if (
    aiAnswer &&
    typeof parsed.comparison === "object" &&
    parsed.comparison !== null
  ) {
    const raw = parsed.comparison as Record<string, unknown>;

    const statuses: ComparisonStatus[] = [
      "agree",
      "partially_agree",
      "disagree",
      "not_comparable",
    ];

    if (
      typeof raw.status === "string" &&
      statuses.includes(raw.status as ComparisonStatus)
    ) {
      const percent = Number(raw.agreementPercent);

      comparison = {
        status: raw.status as ComparisonStatus,
        agreementPercent: Number.isFinite(percent)
          ? Math.max(0, Math.min(100, Math.round(percent)))
          : 0,
        summary: typeof raw.summary === "string" ? raw.summary.trim() : "",
      };
    }
  }

  return {
    sections: [...new Set(sectionIds)],
    aiAnswer,
    comparison,
  };
}
