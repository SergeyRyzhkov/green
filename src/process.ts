import "dotenv/config";

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { enrichQa, extractQa, findExactSourceMatch } from "./ai";
import type {
  EnrichedQa,
  FaqFile,
  FaqItem,
  ModelQa,
  Section,
  SectionsFile,
  TagsFile,
} from "./types.js";

const ROOT = process.cwd();
const TRANSCRIPTS_DIR = path.join(ROOT, "transcripts");
const DATA_DIR = path.join(ROOT, "data");

const FAQ_PATH = path.join(DATA_DIR, "faq.json");
const SECTIONS_PATH = path.join(DATA_DIR, "sections.json");
const TAGS_PATH = path.join(DATA_DIR, "tags.json");

const configuredChunkSize = Number(process.env.CHUNK_CHARS ?? 6000);
const CHUNK_SIZE =
  Number.isFinite(configuredChunkSize) && configuredChunkSize >= 1000
    ? Math.floor(configuredChunkSize)
    : 6000;

const configuredOverlap = Number(process.env.CHUNK_OVERLAP ?? 1200);
const CHUNK_OVERLAP =
  Number.isFinite(configuredOverlap) && configuredOverlap >= 0
    ? Math.min(Math.floor(configuredOverlap), Math.floor(CHUNK_SIZE / 2))
    : 1200;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson<T>(filePath: string, fallback?: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (fallback !== undefined) {
      return fallback;
    }

    throw error;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function findChunkBoundary(
  text: string,
  start: number,
  desiredEnd: number,
): number {
  const minimumBoundary = start + Math.floor(CHUNK_SIZE * 0.65);
  const window = text.slice(minimumBoundary, desiredEnd);

  const paragraphIndex = window.lastIndexOf("\n\n");

  if (paragraphIndex >= 0) {
    return minimumBoundary + paragraphIndex + 2;
  }

  const sentenceRegex = /[.!?…]+["'»”)]*\s+/g;
  let sentenceBoundary = -1;

  for (const match of window.matchAll(sentenceRegex)) {
    sentenceBoundary = minimumBoundary + match.index! + match[0].length;
  }

  if (sentenceBoundary > minimumBoundary) {
    return sentenceBoundary;
  }

  const whitespaceIndex = text.lastIndexOf(" ", desiredEnd);

  if (whitespaceIndex > minimumBoundary) {
    return whitespaceIndex + 1;
  }

  return desiredEnd;
}

function splitText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const desiredEnd = Math.min(start + CHUNK_SIZE, text.length);

    let end =
      desiredEnd < text.length
        ? findChunkBoundary(text, start, desiredEnd)
        : desiredEnd;

    if (end <= start) {
      end = desiredEnd;
    }

    chunks.push(text.slice(start, end));

    if (end >= text.length) {
      break;
    }

    start = Math.max(start + 1, end - CHUNK_OVERLAP);
  }

  return chunks;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function createId(question: string, answer: string): string {
  return `faq-${hash(`${normalize(question)}\n${normalize(answer)}`).slice(
    0,
    12,
  )}`;
}

function buildContext(transcript: string, qa: ModelQa): string {
  const questionMatch = findExactSourceMatch(transcript, qa.question);

  if (!questionMatch) {
    return qa.context;
  }

  const afterQuestion = transcript.slice(questionMatch.end);
  const answerMatch = findExactSourceMatch(afterQuestion, qa.answer);

  const answerEnd = answerMatch
    ? questionMatch.end + answerMatch.end
    : questionMatch.end;

  const start = Math.max(0, questionMatch.start - 500);

  const end =
    answerMatch && answerMatch.start <= 1800
      ? Math.min(transcript.length, answerEnd + 500)
      : Math.min(transcript.length, questionMatch.end + 1200);

  return transcript.slice(start, end).trim() || qa.context;
}

function getQaKey(qa: ModelQa): string {
  return `${normalize(qa.question)}\n${normalize(qa.answer)}`;
}

function fallbackEnrichment(): EnrichedQa {
  return {
    sections: [],
    tags: [],
    needsContext: true,
    aiAnswer: "",
    aiComparison: {
      status: "not_comparable",
      agreementPercent: 0,
      summary: "Обогащение не удалось выполнить.",
    },
  };
}

async function main(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });

  const sectionsFile = await readJson<SectionsFile>(SECTIONS_PATH);
  const sections: Section[] = sectionsFile.sections;

  const existingTagsFile = await readJson<TagsFile>(TAGS_PATH, {
    version: 1,
    tags: [],
  });

  const existingTags = Array.isArray(existingTagsFile.tags)
    ? existingTagsFile.tags
    : [];

  const transcriptFiles = (await readdir(TRANSCRIPTS_DIR))
    .filter((file) => file.toLowerCase().endsWith(".txt"))
    .sort((a, b) => a.localeCompare(b, "ru"));

  if (transcriptFiles.length === 0) {
    throw new Error(`В ${TRANSCRIPTS_DIR} не найдено ни одного .txt файла.`);
  }

  console.log("Полная пересборка FAQ");
  console.log(
    `Модель: ${process.env.OLLAMA_MODEL ?? process.env.OPENAI_MODEL ?? "qwen3.5:4b"}`,
  );
  console.log(`Файлов расшифровок: ${transcriptFiles.length}`);
  console.log(`Разделов: ${sections.length}`);
  console.log(`Размер фрагмента: ${CHUNK_SIZE}`);
  console.log(`Перекрытие фрагментов: ${CHUNK_OVERLAP}\n`);

  const allItems: FaqItem[] = [];
  const seen = new Set<string>();

  let proposedTotal = 0;
  let rejectedTotal = 0;
  let extractionErrors = 0;
  let enrichmentErrors = 0;

  for (const file of transcriptFiles) {
    const transcript = await readFile(path.join(TRANSCRIPTS_DIR, file), "utf8");

    const chunks = splitText(transcript);

    console.log(`PROCESS: ${file}`);
    console.log(`  Фрагментов: ${chunks.length}`);

    const extracted: ModelQa[] = [];

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];

      console.log(
        `  Извлечение ${i + 1}/${chunks.length} (${chunk.length} символов)`,
      );

      try {
        const result = await extractQa(chunk);

        proposedTotal += result.modelCount;
        rejectedTotal += result.rejected;

        console.log(
          `    Модель предложила: ${result.modelCount}; ` +
            `принято: ${result.items.length}; ` +
            `отклонено: ${result.rejected}`,
        );

        extracted.push(...result.items);
      } catch (error) {
        extractionErrors += 1;

        console.error(
          `    Ошибка извлечения: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const uniqueFromFile: ModelQa[] = [];
    const localSeen = new Set<string>();

    for (const qa of extracted) {
      const key = getQaKey(qa);

      if (localSeen.has(key)) {
        continue;
      }

      localSeen.add(key);
      uniqueFromFile.push(qa);
    }

    console.log(`  Уникальных подтверждённых пар: ${uniqueFromFile.length}`);

    for (const qa of uniqueFromFile) {
      const key = getQaKey(qa);

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);

      const context = buildContext(transcript, qa);

      console.log(`  Обогащение: ${normalize(qa.question).slice(0, 120)}`);

      let enrichment: EnrichedQa;

      try {
        enrichment = await enrichQa(
          {
            ...qa,
            context,
          },
          sections,
          existingTags,
        );
      } catch (error) {
        enrichmentErrors += 1;

        console.error(
          `    Ошибка обогащения: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );

        enrichment = fallbackEnrichment();
      }

      allItems.push({
        id: createId(qa.question, qa.answer),
        question: qa.question,
        answer: qa.answer,
        source: file,
        context,
        needsContext: enrichment.needsContext,
        sections: enrichment.sections,
        tags: enrichment.tags,
        relatedIds: [],
        aiAnswer: enrichment.aiAnswer,
        aiComparison: enrichment.aiComparison,
      });
    }

    console.log("");
  }

  console.log("Промежуточная статистика:");
  console.log(`  Предложено моделью пар: ${proposedTotal}`);
  console.log(`  Отклонено при проверке: ${rejectedTotal}`);
  console.log(`  Подтверждённых уникальных FAQ: ${allItems.length}`);
  console.log(`  Ошибок извлечения: ${extractionErrors}`);
  console.log(`  Ошибок обогащения: ${enrichmentErrors}`);

  // Не заменяем прежний FAQ неполным результатом.
  if (extractionErrors > 0) {
    throw new Error(
      `Пересборка отменена: не обработано фрагментов из-за ошибок извлечения: ${extractionErrors}. ` +
        "Существующий faq.json и tags.json не перезаписаны. Проверь Ollama и повтори запуск.",
    );
  }

  // Связываем записи только при наличии общего раздела и тега.
  const finalItems = allItems.map((item) => {
    const itemTags = new Set(item.tags.map(normalize));

    const relatedIds = allItems
      .filter((other) => {
        if (other.id === item.id) {
          return false;
        }

        const sharedSection = item.sections.some((id) =>
          other.sections.includes(id),
        );

        const sharedTag = other.tags.some((tag) =>
          itemTags.has(normalize(tag)),
        );

        return sharedSection && sharedTag;
      })
      .map((other) => other.id);

    return {
      ...item,
      relatedIds,
    };
  });

  const now = new Date().toISOString();

  const faqFile: FaqFile = {
    version: 1,
    updatedAt: now,
    items: finalItems,
  };

  await writeJson(FAQ_PATH, faqFile);

  const mergedTags = new Set(existingTags);

  for (const item of finalItems) {
    for (const tag of item.tags) {
      mergedTags.add(tag);
    }
  }

  const tagsFile: TagsFile = {
    version: 1,
    updatedAt: now,
    tags: [...mergedTags].sort((a, b) => a.localeCompare(b, "ru")),
  };

  await writeJson(TAGS_PATH, tagsFile);

  console.log("\nГотово.");
  console.log(`Файлов обработано: ${transcriptFiles.length}`);
  console.log(`Предложено моделью пар: ${proposedTotal}`);
  console.log(`Отклонено при проверке: ${rejectedTotal}`);
  console.log(`FAQ записей создано: ${finalItems.length}`);
  console.log(
    `Требуют контекста: ${
      finalItems.filter((item) => item.needsContext).length
    }`,
  );
  console.log(
    `Без сравнения ответов: ${
      finalItems.filter((item) => item.aiComparison.status === "not_comparable")
        .length
    }`,
  );
  console.log(`Ошибок извлечения: ${extractionErrors}`);
  console.log(`Ошибок обогащения: ${enrichmentErrors}`);
  console.log(`Результат: ${FAQ_PATH}`);
}

main().catch((error: unknown) => {
  console.error(
    "Критическая ошибка:",
    error instanceof Error ? error.message : error,
  );

  process.exitCode = 1;
});
