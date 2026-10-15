import "dotenv/config";

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { enrichFaq, extractQaPairs } from "./ai.js";
import type {
  Enrichment,
  ExtractedQaPair,
  FaqFile,
  FaqItem,
  Section,
  SectionsFile,
} from "./types.js";
import {
  areNearDuplicates,
  makeQuestionLabel,
  makeStableId,
  normalizeForSearch,
  validatePair,
} from "./validate.js";

const ROOT = process.cwd();
const TRANSCRIPTS_DIR = path.join(ROOT, "transcripts");
const DATA_DIR = path.join(ROOT, "data");
const SECTIONS_FILE = path.join(DATA_DIR, "sections.json");
const FAQ_FILE = path.join(DATA_DIR, "faq.json");
const REJECTED_FILE = path.join(DATA_DIR, "extract-rejected.json");

const CHUNK_CHARS = Math.max(4000, Number(process.env.CHUNK_CHARS ?? 8500));

const CHUNK_OVERLAP = Math.max(
  500,
  Math.min(CHUNK_CHARS - 1000, Number(process.env.CHUNK_OVERLAP ?? 1500)),
);

const QUESTION_SIMILARITY = Number(process.env.MIN_QUESTION_SIMILARITY ?? 0.78);

const ANSWER_SIMILARITY = Number(process.env.MIN_ANSWER_SIMILARITY ?? 0.78);

const MAX_GAP = Number(process.env.MAX_QUESTION_TO_ANSWER_GAP ?? 12000);

const ENRICH_DELAY_MS = Math.max(0, Number(process.env.ENRICH_DELAY_MS ?? 500));

interface Chunk {
  index: number;
  start: number;
  end: number;
  text: string;
}

interface Candidate {
  file: string;
  chunkIndex: number;
  pair: ExtractedQaPair;
  questionStart: number;
  answerStart: number;
  questionQuote: string;
  answerQuote: string;
}

interface Rejected {
  file: string;
  chunkIndex: number;
  questionQuote: string;
  answerQuote: string;
  reason: string;
  diagnostic?: string;
}

interface ValidationAttempt {
  ok: boolean;
  reason?: string;
  questionStart?: number;
  answerStart?: number;
  questionSimilarity?: number;
  answerSimilarity?: number;
  questionFound?: string;
  answerFound?: string;
  method: "chunk" | "source_window" | "none";
}

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const chunkText = (text: string): Chunk[] => {
  const chunks: Chunk[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(text.length, start + CHUNK_CHARS);

    if (end < text.length) {
      const boundary = text.lastIndexOf("\n", end);

      if (boundary > start + CHUNK_CHARS * 0.65) {
        end = boundary;
      }
    }

    chunks.push({
      index: chunks.length + 1,
      start,
      end,
      text: text.slice(start, end),
    });

    if (end >= text.length) break;

    start = Math.max(start + 1, end - CHUNK_OVERLAP);
  }

  return chunks;
};

/**
 * Отсекает явные фрагменты авторского ответа, которые модель
 * иногда ошибочно возвращает в поле вопроса.
 */
const looksLikeAnswerAsQuestion = (question: string): boolean => {
  const q = normalizeForSearch(question);

  const answerOpeners = [
    "ну они",
    "ну это",
    "ну вот",
    "а так вот",
    "я не знаю",
    "а я не знаю",
    "то есть",
    "собственно",
    "да и последующее",
    "но то что",
    "граница рациональности",
    "не насколько они хуже",
  ];

  return answerOpeners.some(
    (prefix) => q === prefix || q.startsWith(`${prefix} `),
  );
};

const validationOptions = {
  questionSimilarity: QUESTION_SIMILARITY,
  answerSimilarity: ANSWER_SIMILARITY,
  maxGap: MAX_GAP,
};

/**
 * Сначала ищет вопрос и ответ внутри текущего фрагмента.
 *
 * Если не получилось найти цитаты, повторяет проверку в полном тексте,
 * но в окне, начинающемся с начала текущего фрагмента. Найденный вопрос
 * должен находиться внутри исходного фрагмента; ответ должен идти после
 * него и не дальше MAX_GAP.
 *
 * Возвращаемые позиции всегда относятся к исходному source.
 */
const validateCandidate = (
  source: string,
  chunk: Chunk,
  pair: ExtractedQaPair,
): {
  checked: ReturnType<typeof validatePair>;
  attempt: ValidationAttempt;
} => {
  const chunkResult = validatePair(
    chunk.text,
    pair.questionQuote,
    pair.answerQuote,
    validationOptions,
  );

  if (chunkResult.ok && chunkResult.question && chunkResult.answer) {
    return {
      checked: {
        ...chunkResult,
        question: {
          ...chunkResult.question,
          start: chunkResult.question.start + chunk.start,
          end: chunkResult.question.end + chunk.start,
        },
        answer: {
          ...chunkResult.answer,
          start: chunkResult.answer.start + chunk.start,
          end: chunkResult.answer.end + chunk.start,
        },
      },
      attempt: {
        ok: true,
        method: "chunk",
        questionStart: chunkResult.question.start + chunk.start,
        answerStart: chunkResult.answer.start + chunk.start,
        questionSimilarity: chunkResult.question.similarity,
        answerSimilarity: chunkResult.answer.similarity,
        questionFound: chunkResult.question.quote,
        answerFound: chunkResult.answer.quote,
      },
    };
  }

  // Если сама формулировка не похожа на вопрос, повторный поиск цитат
  // ничего не исправит. Остальные ошибки поиска проверяем по source.
  const retryableReasons = new Set([
    "question_quote_not_found",
    "answer_quote_not_found_after_question",
    "answer_before_question",
    "question_answer_gap_too_large",
  ]);

  if (!chunkResult.reason || !retryableReasons.has(chunkResult.reason)) {
    return {
      checked: chunkResult,
      attempt: {
        ok: false,
        method: "none",
        reason: chunkResult.reason,
      },
    };
  }

  const windowStart = chunk.start;
  const windowEnd = Math.min(source.length, chunk.end + MAX_GAP);
  const sourceWindow = source.slice(windowStart, windowEnd);

  const sourceResult = validatePair(
    sourceWindow,
    pair.questionQuote,
    pair.answerQuote,
    validationOptions,
  );

  if (!sourceResult.ok || !sourceResult.question || !sourceResult.answer) {
    return {
      checked: sourceResult,
      attempt: {
        ok: false,
        method: "source_window",
        reason: sourceResult.reason,
        questionStart: sourceResult.question
          ? sourceResult.question.start + windowStart
          : undefined,
        answerStart: sourceResult.answer
          ? sourceResult.answer.start + windowStart
          : undefined,
        questionSimilarity: sourceResult.question?.similarity,
        answerSimilarity: sourceResult.answer?.similarity,
        questionFound: sourceResult.question?.quote,
        answerFound: sourceResult.answer?.quote,
      },
    };
  }

  const questionStart = sourceResult.question.start + windowStart;
  const questionEnd = sourceResult.question.end + windowStart;
  const answerStart = sourceResult.answer.start + windowStart;
  const answerEnd = sourceResult.answer.end + windowStart;

  // Не позволяем резервному поиску привязать кандидата к вопросу,
  // который находится в другой части расшифровки.
  if (questionStart < chunk.start || questionStart >= chunk.end) {
    return {
      checked: {
        ok: false,
        reason: "question_found_outside_chunk",
        question: {
          ...sourceResult.question,
          start: questionStart,
          end: questionEnd,
        },
        answer: {
          ...sourceResult.answer,
          start: answerStart,
          end: answerEnd,
        },
      },
      attempt: {
        ok: false,
        method: "source_window",
        reason: "question_found_outside_chunk",
        questionStart,
        answerStart,
        questionSimilarity: sourceResult.question.similarity,
        answerSimilarity: sourceResult.answer.similarity,
        questionFound: sourceResult.question.quote,
        answerFound: sourceResult.answer.quote,
      },
    };
  }

  return {
    checked: {
      ...sourceResult,
      question: {
        ...sourceResult.question,
        start: questionStart,
        end: questionEnd,
      },
      answer: {
        ...sourceResult.answer,
        start: answerStart,
        end: answerEnd,
      },
    },
    attempt: {
      ok: true,
      method: "source_window",
      questionStart,
      answerStart,
      questionSimilarity: sourceResult.question.similarity,
      answerSimilarity: sourceResult.answer.similarity,
      questionFound: sourceResult.question.quote,
      answerFound: sourceResult.answer.quote,
    },
  };
};

const shortText = (value: string | undefined, max = 180): string => {
  if (!value) return "";
  const clean = value.replace(/\s+/g, " ").trim();

  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
};

const logRejected = (
  file: string,
  chunk: Chunk,
  pair: ExtractedQaPair,
  reason: string,
  attempt?: ValidationAttempt,
): void => {
  console.log(
    `    Отклонено [${reason}]: ${shortText(pair.questionQuote, 130)}`,
  );

  if (!attempt) return;

  console.log(
    `      Диагностика: метод=${attempt.method}` +
      (attempt.questionStart !== undefined
        ? `; позиция вопроса=${attempt.questionStart}`
        : "") +
      (attempt.answerStart !== undefined
        ? `; позиция ответа=${attempt.answerStart}`
        : ""),
  );

  if (attempt.questionSimilarity !== undefined) {
    console.log(
      `      Сходство вопроса: ${attempt.questionSimilarity.toFixed(3)}`,
    );
  }

  if (attempt.answerSimilarity !== undefined) {
    console.log(
      `      Сходство ответа: ${attempt.answerSimilarity.toFixed(3)}`,
    );
  }

  if (attempt.questionFound) {
    console.log(`      Найденный вопрос: ${shortText(attempt.questionFound)}`);
  }

  if (attempt.answerFound) {
    console.log(`      Найденный ответ: ${shortText(attempt.answerFound)}`);
  }

  console.log(
    `      Фрагмент ${chunk.index}: символы ${chunk.start}–${chunk.end}; файл=${file}`,
  );
};

const processTranscript = async (
  file: string,
  source: string,
  sections: Section[],
): Promise<{ items: FaqItem[]; rejected: Rejected[] }> => {
  const chunks = chunkText(source);
  const candidates: Candidate[] = [];
  const rejected: Rejected[] = [];

  console.log(`\nФайл: ${file} (${source.length} символов)`);
  console.log(
    `Фрагментов: ${chunks.length}; размер: ${CHUNK_CHARS}; перекрытие: ${CHUNK_OVERLAP}`,
  );

  for (const chunk of chunks) {
    console.log(`  Извлечение пар ${chunk.index}/${chunks.length}`);

    let pairs: ExtractedQaPair[];

    try {
      pairs = await extractQaPairs(chunk.text);
      console.log(`    Модель вернула пар: ${pairs.length}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      console.error(`    Ошибка извлечения: ${message}`);

      rejected.push({
        file,
        chunkIndex: chunk.index,
        questionQuote: "",
        answerQuote: "",
        reason: "extraction_error",
        diagnostic: message,
      });

      continue;
    }

    let accepted = 0;

    for (const pair of pairs) {
      if (looksLikeAnswerAsQuestion(pair.questionQuote)) {
        const reason = "question_looks_like_author_answer";

        rejected.push({
          file,
          chunkIndex: chunk.index,
          questionQuote: pair.questionQuote,
          answerQuote: pair.answerQuote,
          reason,
        });

        logRejected(file, chunk, pair, reason);
        continue;
      }

      const { checked, attempt } = validateCandidate(source, chunk, pair);

      if (!checked.ok || !checked.question || !checked.answer) {
        const reason = checked.reason ?? "unknown_validation_error";

        rejected.push({
          file,
          chunkIndex: chunk.index,
          questionQuote: pair.questionQuote,
          answerQuote: pair.answerQuote,
          reason,
          diagnostic: JSON.stringify(attempt),
        });

        logRejected(file, chunk, pair, reason, attempt);
        continue;
      }

      candidates.push({
        file,
        chunkIndex: chunk.index,
        pair,
        questionStart: checked.question.start,
        answerStart: checked.answer.start,
        questionQuote: checked.question.quote,
        answerQuote: checked.answer.quote,
      });

      if (attempt.method === "source_window") {
        console.log(
          `    Найдена пара резервным поиском по source: ${shortText(checked.question.quote, 120)}`,
        );
      }

      accepted += 1;
    }

    console.log(
      `    Подтверждено: ${accepted}; отклонено: ${pairs.length - accepted}`,
    );
  }

  console.log(`  Подтверждено до удаления дублей: ${candidates.length}`);

  // Соседние фрагменты перекрываются, поэтому одна пара может встретиться
  // несколько раз. Сохраняем наиболее полную формулировку вопроса.
  candidates.sort((a, b) => a.questionStart - b.questionStart);

  const uniqueCandidates: Candidate[] = [];

  for (const candidate of candidates) {
    const duplicateIndex = uniqueCandidates.findIndex((existing) => {
      const nearInSource =
        Math.abs(existing.questionStart - candidate.questionStart) <
        CHUNK_CHARS;

      return (
        nearInSource &&
        areNearDuplicates(existing.questionQuote, candidate.questionQuote)
      );
    });

    if (duplicateIndex < 0) {
      uniqueCandidates.push(candidate);
      continue;
    }

    const existing = uniqueCandidates[duplicateIndex];

    if (candidate.questionQuote.length > existing.questionQuote.length) {
      uniqueCandidates[duplicateIndex] = candidate;
    }
  }

  console.log(`  Уникальных пар: ${uniqueCandidates.length}`);

  const items: FaqItem[] = [];

  for (let index = 0; index < uniqueCandidates.length; index += 1) {
    const candidate = uniqueCandidates[index];

    const question = makeQuestionLabel(candidate.questionQuote);
    const answer = candidate.answerQuote.trim();

    let enrichment: Enrichment;

    try {
      enrichment = await enrichFaq(question, answer, sections);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      console.error(`    Ошибка обогащения FAQ ${index + 1}: ${message}`);

      rejected.push({
        file,
        chunkIndex: candidate.chunkIndex,
        questionQuote: candidate.questionQuote,
        answerQuote: candidate.answerQuote,
        reason: "enrichment_error",
        diagnostic: message,
      });

      // Не теряем подтверждённую пару, если упал этап обогащения.
      enrichment = {
        sections: [],
        aiAnswer: null,
        comparison: null,
      } as Enrichment;
    }

    items.push({
      id: makeStableId(file, candidate.questionQuote),
      question,
      answer,
      source: {
        file,
        questionQuote: candidate.questionQuote,
        answerQuote: candidate.answerQuote,
      },
      sections: enrichment.sections,
      aiAnswer: enrichment.aiAnswer,
      comparison: enrichment.comparison,
    });

    if (ENRICH_DELAY_MS > 0 && index < uniqueCandidates.length - 1) {
      await pause(ENRICH_DELAY_MS);
    }
  }

  return { items, rejected };
};

const main = async (): Promise<void> => {
  await mkdir(DATA_DIR, { recursive: true });

  const sectionsData = JSON.parse(
    await readFile(SECTIONS_FILE, "utf8"),
  ) as SectionsFile;

  const sections = sectionsData.sections;

  const transcriptFiles = (await readdir(TRANSCRIPTS_DIR))
    .filter((file) => file.toLowerCase().endsWith(".txt"))
    .sort((a, b) => a.localeCompare(b, "ru"));

  if (transcriptFiles.length === 0) {
    throw new Error(`В каталоге ${TRANSCRIPTS_DIR} нет файлов .txt`);
  }

  const allItems: FaqItem[] = [];
  const allRejected: Rejected[] = [];

  for (const file of transcriptFiles) {
    const source = await readFile(path.join(TRANSCRIPTS_DIR, file), "utf8");

    const result = await processTranscript(file, source, sections);

    allItems.push(...result.items);
    allRejected.push(...result.rejected);
  }

  // Убираем дубли между разными файлами, оставляя первую запись.
  const deduplicated: FaqItem[] = [];

  for (const item of allItems) {
    const duplicateIndex = deduplicated.findIndex((existing) =>
      areNearDuplicates(existing.question, item.question),
    );

    if (duplicateIndex < 0) {
      deduplicated.push(item);
      continue;
    }

    const existing = deduplicated[duplicateIndex];

    if (item.question.length > existing.question.length) {
      deduplicated[duplicateIndex] = item;
    }
  }

  const faq: FaqFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    items: deduplicated,
  };

  await writeFile(FAQ_FILE, `${JSON.stringify(faq, null, 2)}\n`, "utf8");

  await writeFile(
    REJECTED_FILE,
    `${JSON.stringify(allRejected, null, 2)}\n`,
    "utf8",
  );

  console.log("\nПолная пересборка завершена");
  console.log(`Файлов расшифровок: ${transcriptFiles.length}`);
  console.log(`FAQ до межфайловой дедупликации: ${allItems.length}`);
  console.log(`FAQ после дедупликации: ${deduplicated.length}`);
  console.log(`Отклонённых кандидатов: ${allRejected.length}`);
  console.log(`FAQ записан: ${FAQ_FILE}`);
  console.log(`Отчёт записан: ${REJECTED_FILE}`);
};

main().catch((error: unknown) => {
  console.error(
    "Ошибка обработки:",
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exitCode = 1;
});
