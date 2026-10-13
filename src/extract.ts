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
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const chunkText = (text: string): Chunk[] => {
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + CHUNK_CHARS);
    if (end < text.length) {
      const boundary = text.lastIndexOf("\n", end);
      if (boundary > start + CHUNK_CHARS * 0.65) end = boundary;
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

const looksLikeAnswerAsQuestion = (question: string): boolean => {
  const q = normalizeForSearch(question);
  if (!q) return true;
  const answerOpeners = [
    "ну они",
    "ну это",
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
  return answerOpeners.some((prefix) => q.startsWith(prefix));
};

const processTranscript = async (
  file: string,
  source: string,
  sections: Section[],
) => {
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
      rejected.push({
        file,
        chunkIndex: chunk.index,
        questionQuote: "",
        answerQuote: "",
        reason: `chunk_request_failed: ${String(error)}`,
      });
      console.error(
        `    Фрагмент не обработан, но процесс продолжается: ${String(error)}`,
      );
      continue;
    }

    let accepted = 0;
    for (const pair of pairs) {
      if (looksLikeAnswerAsQuestion(pair.questionQuote)) {
        rejected.push({
          ...pair,
          file,
          chunkIndex: chunk.index,
          reason: "question_looks_like_author_answer",
        });
        continue;
      }
      const checked = validatePair(
        chunk.text,
        pair.questionQuote,
        pair.answerQuote,
        {
          questionSimilarity: QUESTION_SIMILARITY,
          answerSimilarity: ANSWER_SIMILARITY,
          maxGap: MAX_GAP,
        },
      );
      if (!checked.ok || !checked.question || !checked.answer) {
        rejected.push({
          ...pair,
          file,
          chunkIndex: chunk.index,
          reason: checked.reason ?? "unknown_validation_error",
        });
        console.log(
          `    Отклонено [${checked.reason}]: ${pair.questionQuote.slice(0, 130)}`,
        );
        continue;
      }
      candidates.push({
        file,
        chunkIndex: chunk.index,
        pair,
        questionStart: chunk.start + checked.question.start,
        answerStart: chunk.start + checked.answer.start,
        questionQuote: checked.question.quote,
        answerQuote: checked.answer.quote,
      });
      accepted += 1;
    }
    console.log(
      `    Подтверждено: ${accepted}; отклонено: ${pairs.length - accepted}`,
    );
  }

  // De-duplicate by normalized wording and nearby source position. Keep the more complete question.
  candidates.sort((a, b) => a.questionStart - b.questionStart);
  const unique: Candidate[] = [];
  for (const candidate of candidates) {
    const duplicateIndex = unique.findIndex(
      (existing) =>
        existing.file === candidate.file &&
        areNearDuplicates(
          existing.pair.questionQuote,
          candidate.pair.questionQuote,
        ) &&
        Math.abs(existing.questionStart - candidate.questionStart) <
          CHUNK_CHARS,
    );
    if (duplicateIndex < 0) {
      unique.push(candidate);
      continue;
    }
    const existing = unique[duplicateIndex];
    const candidateLength = normalizeForSearch(
      candidate.pair.questionQuote,
    ).length;
    const existingLength = normalizeForSearch(
      existing.pair.questionQuote,
    ).length;
    if (candidateLength > existingLength) unique[duplicateIndex] = candidate;
  }

  console.log(`  Подтверждено до удаления дублей: ${candidates.length}`);
  console.log(`  Уникальных пар: ${unique.length}`);

  const items: FaqItem[] = [];
  for (let i = 0; i < unique.length; i += 1) {
    const candidate = unique[i];
    const question = makeQuestionLabel(candidate.questionQuote);
    console.log(
      `  Обработка ${i + 1}/${unique.length}: ${question.slice(0, 150)}`,
    );
    let enrichment: Enrichment = {
      sections: [],
      aiAnswer: null,
      comparison: null,
    };
    try {
      enrichment = await enrichFaq(question, candidate.answerQuote, sections);
    } catch (error) {
      console.warn(
        `    Обогащение пропущено, исходная пара сохранена: ${String(error)}`,
      );
    }
    items.push({
      id: makeStableId(file, candidate.pair.questionQuote),
      question,
      answer: candidate.answerQuote,
      source: {
        file,
        questionQuote: candidate.questionQuote,
        answerQuote: candidate.answerQuote,
        questionStart: candidate.questionStart,
        answerStart: candidate.answerStart,
        chunkIndex: candidate.chunkIndex,
      },
      sections: enrichment.sections,
      aiAnswer: enrichment.aiAnswer,
      comparison: enrichment.comparison,
    });
    if (ENRICH_DELAY_MS) await pause(ENRICH_DELAY_MS);
  }

  return { items, rejected };
};

const main = async () => {
  await mkdir(DATA_DIR, { recursive: true });
  const sectionsData = JSON.parse(
    await readFile(SECTIONS_FILE, "utf8"),
  ) as SectionsFile;
  const sections = sectionsData.sections;
  const files = (await readdir(TRANSCRIPTS_DIR))
    .filter((name) => name.toLowerCase().endsWith(".txt"))
    .sort();
  if (files.length === 0)
    throw new Error(`В ${TRANSCRIPTS_DIR} не найдено .txt-файлов`);

  console.log(`Модель: ${process.env.OLLAMA_MODEL ?? "qwen3.5:4b"}`);
  console.log(`Файлов расшифровок: ${files.length}`);
  console.log(`Разделов: ${sections.length}`);

  const allItems: FaqItem[] = [];
  const allRejected: Rejected[] = [];
  for (const file of files) {
    const source = await readFile(path.join(TRANSCRIPTS_DIR, file), "utf8");
    const result = await processTranscript(file, source, sections);
    allItems.push(...result.items);
    allRejected.push(...result.rejected);
  }

  // Cross-file de-duplication too; retain the item with the longer, more informative question.
  const finalItems: FaqItem[] = [];
  for (const item of allItems) {
    const duplicateIndex = finalItems.findIndex((existing) =>
      areNearDuplicates(existing.question, item.question),
    );
    if (duplicateIndex < 0) finalItems.push(item);
    else if (
      normalizeForSearch(item.question).length >
      normalizeForSearch(finalItems[duplicateIndex].question).length
    ) {
      finalItems[duplicateIndex] = item;
    }
  }

  const faq: FaqFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    items: finalItems,
  };
  await writeFile(FAQ_FILE, `${JSON.stringify(faq, null, 2)}\n`, "utf8");
  await writeFile(
    REJECTED_FILE,
    `${JSON.stringify({ updatedAt: new Date().toISOString(), rejected: allRejected }, null, 2)}\n`,
    "utf8",
  );

  console.log("\nГотово.");
  console.log(`FAQ записей создано: ${finalItems.length}`);
  console.log(`Отклонённых кандидатов записано в отчёт: ${allRejected.length}`);
  console.log(`FAQ: ${FAQ_FILE}`);
  console.log(`Отчёт: ${REJECTED_FILE}`);
};

main().catch((error: unknown) => {
  console.error("Критическая ошибка:", error);
  process.exitCode = 1;
});
