import "dotenv/config";

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { classifyFaqTags, recoverEvidenceQuote } from "./ai";
import { backup, readJson, writeJson } from "./io";
import type { FaqFile, SectionsFile, TagsFile } from "./types";
import { validateFaq } from "./validate";

const DATA = path.resolve("data");
const FAQ_PATH = path.join(DATA, "faq.json");
const TAGS_PATH = path.join(DATA, "tags.json");
const SECTIONS_PATH = path.join(DATA, "sections.json");
const TRANSCRIPTS = path.resolve("transcripts");

async function loadData() {
  const [faq, tags, sections] = await Promise.all([
    readJson<FaqFile>(FAQ_PATH, {
      version: 1,
      updatedAt: null,
      items: [],
    }),
    readJson<TagsFile>(TAGS_PATH, {
      version: 1,
      updatedAt: null,
      tags: [],
    }),
    readJson<SectionsFile>(SECTIONS_PATH, {
      version: 1,
      updatedAt: null,
      sections: [],
    }),
  ]);

  return { faq, tags, sections };
}

async function stats(): Promise<void> {
  const { faq, tags, sections } = await loadData();
  const items = faq.items;

  console.log("=== Статистика FAQ ===");
  console.log("Всего FAQ:", items.length);
  console.log("Тегов в словаре:", tags.tags.length);
  console.log("Разделов:", sections.sections.length);
  console.log(
    "Без цитаты:",
    items.filter((item) => !item.evidence?.trim()).length,
  );
  console.log(
    "Без тегов:",
    items.filter((item) => item.tags.length === 0).length,
  );
  console.log(
    "Без раздела:",
    items.filter((item) => item.sections.length === 0).length,
  );
  console.log(
    "Требуют проверки:",
    items.filter((item) => item.reviewStatus !== "ready").length,
  );
  console.log(
    "Готовы:",
    items.filter((item) => item.reviewStatus === "ready").length,
  );
}

async function check(): Promise<void> {
  const { faq, tags, sections } = await loadData();

  try {
    validateFaq(faq, sections, tags);
  } catch (error) {
    console.error(
      "Проверка не пройдена:",
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  }
}

async function checkTags(): Promise<void> {
  const { faq, tags } = await loadData();
  const dictionary = new Set(tags.tags);
  const unknown = new Set<string>();

  for (const item of faq.items) {
    for (const tag of item.tags) {
      if (!dictionary.has(tag)) unknown.add(tag);
    }
  }

  const duplicates = tags.tags.filter(
    (tag, index) => tags.tags.indexOf(tag) !== index,
  );
  const unused = tags.tags.filter(
    (tag) => !faq.items.some((item) => item.tags.includes(tag)),
  );

  console.log("Тегов в словаре:", tags.tags.length);
  console.log("Дубли в словаре:", [...new Set(duplicates)]);
  console.log("Теги FAQ вне словаря:", [...unknown]);
  console.log("Неиспользуемые теги:", unused);
  console.log(
    "FAQ без тегов:",
    faq.items.filter((item) => item.tags.length === 0).length,
  );

  if (unknown.size || duplicates.length) process.exitCode = 1;
}

async function checkEvidence(): Promise<void> {
  const { faq } = await loadData();
  const missing = faq.items.filter((item) => !item.evidence?.trim());

  console.log(`FAQ без цитаты: ${missing.length} из ${faq.items.length}`);

  for (const item of missing) {
    console.log(`- ${item.id}: ${item.editedQuestion || item.question}`);
  }
}

async function retag(): Promise<void> {
  const { faq, tags, sections } = await loadData();
  let updated = 0;
  let failed = 0;

  await backup(FAQ_PATH);

  for (let i = 0; i < faq.items.length; i++) {
    const item = faq.items[i];

    try {
      const result = await classifyFaqTags(
        item.editedQuestion || item.question,
        item.editedAnswer || item.answer,
        sections.sections,
        tags.tags,
      );

      if (result.length > 0) {
        item.tags = [...new Set(result)];
        updated++;
      }
    } catch (error) {
      failed++;
      console.error(
        `Ошибка для ${item.id}:`,
        error instanceof Error ? error.message : error,
      );
    }

    console.log(`${i + 1}/${faq.items.length}`);
  }

  if (updated > 0) {
    faq.updatedAt = new Date().toISOString();
    await writeJson(FAQ_PATH, faq);
  }

  console.log("Обновлено:", updated);
  console.log("Ошибок:", failed);
}

function splitTranscript(text: string): string[] {
  const chunks: string[] = [];
  const size = 2200;
  const step = 1900;

  for (let i = 0; i < text.length; i += step) {
    const chunk = text.slice(i, i + size).trim();
    if (chunk) chunks.push(chunk);
  }

  return chunks;
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLocaleLowerCase("ru")
      .replace(/ё/g, "е")
      .split(/[^a-zа-я0-9]+/i)
      .filter((word) => word.length >= 4),
  );
}

function selectExcerpts(
  question: string,
  answer: string,
  chunks: string[],
): string[] {
  const keywords = words(`${question} ${answer}`);

  return chunks
    .map((text, index) => {
      const chunkWords = words(text);
      let score = 0;

      for (const word of keywords) {
        if (chunkWords.has(word)) score++;
      }

      return { text, index, score };
    })
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3)
    .map((chunk) => chunk.text);
}

async function recoverEvidence(): Promise<void> {
  const { faq } = await loadData();
  const missing = faq.items.filter((item) => !item.evidence?.trim());

  if (missing.length === 0) {
    console.log("Все FAQ уже содержат цитаты.");
    return;
  }

  const transcriptFiles = new Set(await readdir(TRANSCRIPTS));
  const cache = new Map<string, string>();

  let restored = 0;
  let notFound = 0;
  let noSource = 0;
  let errors = 0;

  await backup(FAQ_PATH);

  for (let i = 0; i < missing.length; i++) {
    const item = missing[i];
    const question = item.editedQuestion || item.question;
    const answer = item.editedAnswer || item.answer;

    console.log(`\n${i + 1}/${missing.length}: ${item.id}`);

    const sources = [
      ...item.sources.map((source) => path.basename(source.file)),
      ...item.sourceQuestions.map((source) => path.basename(source.file)),
    ];

    const files = [...new Set(sources)].filter((file) =>
      transcriptFiles.has(file),
    );

    if (files.length === 0) {
      console.log("Исходная расшифровка не найдена.");
      noSource++;
      continue;
    }

    let found = false;

    for (const file of files) {
      try {
        let transcript = cache.get(file);

        if (transcript === undefined) {
          transcript = await readFile(path.join(TRANSCRIPTS, file), "utf8");
          cache.set(file, transcript);
        }

        const excerpts = selectExcerpts(
          question,
          answer,
          splitTranscript(transcript),
        );

        if (excerpts.length === 0) continue;

        const quote = await recoverEvidenceQuote(question, answer, excerpts);

        if (quote && transcript.includes(quote)) {
          item.evidence = quote;
          restored++;
          found = true;
          console.log("Цитата восстановлена:", file);
          break;
        }
      } catch (error) {
        errors++;
        console.error(
          `Ошибка ${file}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    if (!found) {
      notFound++;
      console.log("Подтверждающая цитата не найдена.");
    }
  }

  if (restored > 0) {
    faq.updatedAt = new Date().toISOString();
    await writeJson(FAQ_PATH, faq);
  }

  console.log("\n=== Итог ===");
  console.log("Восстановлено:", restored);
  console.log("Не найдено:", notFound);
  console.log("Нет исходника:", noSource);
  console.log("Ошибок:", errors);
  console.log("Осталось без цитаты:", missing.length - restored);
}

async function cleanTags(): Promise<void> {
  const { faq, tags } = await loadData();
  const cleaned = [
    ...new Set(tags.tags.map((tag) => tag.trim()).filter(Boolean)),
  ];

  const allowed = new Set(cleaned);
  for (const item of faq.items) {
    item.tags = [
      ...new Set(
        item.tags.map((tag) => tag.trim()).filter((tag) => allowed.has(tag)),
      ),
    ];
  }

  await backup(TAGS_PATH);
  await backup(FAQ_PATH);

  tags.tags = cleaned;
  tags.updatedAt = new Date().toISOString();
  faq.updatedAt = new Date().toISOString();

  await writeJson(TAGS_PATH, tags);
  await writeJson(FAQ_PATH, faq);

  console.log("Очистка завершена. Тегов:", cleaned.length);
}

async function backupAll(): Promise<void> {
  for (const file of [FAQ_PATH, TAGS_PATH, SECTIONS_PATH]) {
    await backup(file);
    console.log("Резервная копия:", path.basename(file));
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];

  switch (command) {
    case "stats":
      await stats();
      break;
    case "check":
      await check();
      break;
    case "check-tags":
      await checkTags();
      break;
    case "check-evidence":
      await checkEvidence();
      break;
    case "retag":
      await retag();
      break;
    case "clean-tags":
      await cleanTags();
      break;
    case "backup":
      await backupAll();
      break;
    case "evidence":
      await recoverEvidence();
      break;
    default:
      console.log(
        "Команды: stats, check, check-tags, check-evidence, retag, clean-tags, backup, evidence",
      );
  }
}

main().catch((error: unknown) => {
  console.error("Ошибка:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
