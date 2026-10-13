import "dotenv/config";

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { enrichFaq, extractQaPairs } from "./ai.js";
import type {
  Enrichment,
  FaqFile,
  FaqItem,
  Section,
  SectionsFile,
} from "./types.js";
import {
  findQuoteMatches,
  makeQuestionLabel,
  makeStableId,
  normalizeForSearch,
} from "./validate.js";

const ROOT = process.cwd();
const TRANSCRIPTS_DIR = path.join(ROOT, "transcripts");
const DATA_DIR = path.join(ROOT, "data");
const FAQ_PATH = path.join(DATA_DIR, "faq.json");
const SECTIONS_PATH = path.join(DATA_DIR, "sections.json");

const CHUNK_CHARS = Math.max(6000, Number(process.env.CHUNK_CHARS ?? 10000));

const CHUNK_OVERLAP = Math.max(
  500,
  Math.min(CHUNK_CHARS - 1000, Number(process.env.CHUNK_OVERLAP ?? 2000)),
);

interface TextChunk {
  text: string;
  start: number;
}

interface VerifiedPair {
  question: string;
  answer: string;
  questionStart: number;
  answerStart: number;
}

function chunkText(text: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  const step = Math.max(1000, CHUNK_CHARS - CHUNK_OVERLAP);

  for (let start = 0; start < text.length; start += step) {
    const end = Math.min(text.length, start + CHUNK_CHARS);

    chunks.push({
      text: text.slice(start, end),
      start,
    });

    if (end === text.length) {
      break;
    }
  }

  return chunks;
}

async function readSections(): Promise<Section[]> {
  const raw = JSON.parse(await readFile(SECTIONS_PATH, "utf8")) as SectionsFile;

  if (!Array.isArray(raw.sections)) {
    throw new Error(`${SECTIONS_PATH} должен содержать массив sections`);
  }

  return raw.sections.filter(
    (section) =>
      typeof section.id === "string" && typeof section.name === "string",
  );
}

async function getTranscriptFiles(): Promise<string[]> {
  const entries = await readdir(TRANSCRIPTS_DIR, {
    withFileTypes: true,
  });

  return entries
    .filter(
      (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".txt"),
    )
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "ru"));
}

function findVerifiedPair(
  chunk: TextChunk,
  questionQuote: string,
  answerQuote: string,
): VerifiedPair | null {
  const questionMatches = findQuoteMatches(chunk.text, questionQuote);

  const answerMatches = findQuoteMatches(chunk.text, answerQuote);

  if (questionMatches.length === 0 || answerMatches.length === 0) {
    return null;
  }

  // Если цитата повторяется, выбираем ближайший ответ,
  // который расположен после соответствующего вопроса.
  for (const questionMatch of questionMatches) {
    const answerMatch = answerMatches.find(
      (candidate) =>
        candidate.start >= questionMatch.end &&
        candidate.start - questionMatch.end <= 18000,
    );

    if (!answerMatch) {
      continue;
    }

    return {
      question: questionMatch.quote,
      answer: answerMatch.quote,
      questionStart: chunk.start + questionMatch.start,
      answerStart: chunk.start + answerMatch.start,
    };
  }

  return null;
}

function deduplicatePairs(pairs: VerifiedPair[]): VerifiedPair[] {
  const sorted = [...pairs].sort((a, b) => a.questionStart - b.questionStart);

  const result: VerifiedPair[] = [];

  for (const pair of sorted) {
    const normalizedQuestion = normalizeForSearch(pair.question);

    const duplicate = result.some((existing) => {
      const existingQuestion = normalizeForSearch(existing.question);

      // Точное совпадение вопроса, даже если пара найдена
      // в двух перекрывающихся фрагментах.
      if (normalizedQuestion === existingQuestion) {
        return true;
      }

      // Если две версии вопроса начинаются почти в одном месте,
      // модель могла по-разному обрезать вопрос на границе чанка.
      if (Math.abs(pair.questionStart - existing.questionStart) <= 100) {
        return true;
      }

      return false;
    });

    if (!duplicate) {
      result.push(pair);
    }
  }

  return result;
}

async function processTranscript(
  filename: string,
  sections: Section[],
): Promise<FaqItem[]> {
  const fullPath = path.join(TRANSCRIPTS_DIR, filename);

  const transcript = (await readFile(fullPath, "utf8"))
    .replace(/^\uFEFF/, "")
    .trim();

  if (!transcript) {
    console.warn(`Пустая расшифровка: ${filename}`);
    return [];
  }

  console.log(`\nФайл: ${filename} (${transcript.length} символов)`);

  const chunks = chunkText(transcript);
  const candidates: VerifiedPair[] = [];

  // Этап 1. Извлекаем связанные пары из каждого фрагмента.
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];

    console.log(`  Извлечение пар ${i + 1}/${chunks.length}`);

    try {
      const extractedPairs = await extractQaPairs(chunk.text);

      console.log(`    Модель вернула пар: ${extractedPairs.length}`);

      let accepted = 0;

      for (const pair of extractedPairs) {
        const verified = findVerifiedPair(
          chunk,
          pair.questionQuote,
          pair.answerQuote,
        );

        if (!verified) {
          console.warn(
            "    Пара отклонена: цитаты не найдены " +
              "или ответ не следует за вопросом:",
            pair.questionQuote.slice(0, 100).replace(/\s+/g, " "),
          );

          continue;
        }

        candidates.push(verified);
        accepted += 1;
      }

      console.log(`    Подтверждено цитатами: ${accepted}`);
    } catch (error) {
      console.warn(
        "    Ошибка извлечения фрагмента:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const pairs = deduplicatePairs(candidates);

  console.log(`  Подтверждённых пар до удаления дублей: ${candidates.length}`);
  console.log(`  Уникальных пар: ${pairs.length}`);

  const items: FaqItem[] = [];

  // Этап 2. Классификация и независимый ответ ИИ.
  for (let i = 0; i < pairs.length; i += 1) {
    const pair = pairs[i];

    const question = makeQuestionLabel(pair.question);

    console.log(
      `  Обработка ${i + 1}/${pairs.length}: ` +
        question.slice(0, 100).replace(/\s+/g, " "),
    );

    let enrichment: Enrichment = {
      sections: [],
      aiAnswer: null,
      comparison: null,
    };

    try {
      enrichment = await enrichFaq(question, pair.answer, sections);
    } catch (error) {
      console.warn(
        "    Ошибка классификации; сохраняем пару:",
        error instanceof Error ? error.message : String(error),
      );
    }

    items.push({
      id: makeStableId(filename, pair.question),
      question,
      answer: pair.answer,
      source: {
        file: filename,
        questionQuote: pair.question,
        answerQuote: pair.answer,
      },
      sections: enrichment.sections,
      aiAnswer: enrichment.aiAnswer,
      comparison: enrichment.comparison,
    });
  }

  return items;
}

async function main(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });

  const sections = await readSections();
  const files = await getTranscriptFiles();

  if (files.length === 0) {
    throw new Error(`В ${TRANSCRIPTS_DIR} нет TXT-файлов`);
  }

  console.log("Полная пересборка FAQ");
  console.log(`Модель: ${process.env.OLLAMA_MODEL ?? "qwen3.5:4b"}`);
  console.log(`Файлов расшифровок: ${files.length}`);
  console.log(`Разделов: ${sections.length}`);
  console.log(`Размер фрагмента: ${CHUNK_CHARS}`);
  console.log(`Перекрытие фрагментов: ${CHUNK_OVERLAP}`);

  const items: FaqItem[] = [];

  for (const filename of files) {
    const transcriptItems = await processTranscript(filename, sections);

    items.push(...transcriptItems);
  }

  if (items.length === 0) {
    throw new Error(
      "Не найдено ни одной подтверждённой пары. " +
        "Существующий faq.json не перезаписан.",
    );
  }

  const uniqueItems: FaqItem[] = [];
  const seenIds = new Set<string>();

  for (const item of items) {
    if (seenIds.has(item.id)) {
      continue;
    }

    seenIds.add(item.id);
    uniqueItems.push(item);
  }

  const faq: FaqFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    items: uniqueItems,
  };

  await writeFile(FAQ_PATH, `${JSON.stringify(faq, null, 2)}\n`, "utf8");

  console.log("\nГотово.");
  console.log(`FAQ записей создано: ${uniqueItems.length}`);
  console.log(`Записано: ${FAQ_PATH}`);
}

main().catch((error: unknown) => {
  console.error(
    "\nОшибка обработки:",
    error instanceof Error ? error.message : String(error),
  );

  process.exitCode = 1;
});
