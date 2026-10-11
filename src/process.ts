import "dotenv/config";

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { classifyFaqTags, compareAnswers, generateAiAnswer } from "./ai";
import { sha256 } from "./hash";
import { backup, readJson, writeJson } from "./io";
import { mergeFaq, mergeTagsIntoDictionary } from "./merge";
import type {
  FaqFile,
  ProcessedFileStore,
  SectionsFile,
  TagsFile,
} from "./types";
import { validateFaq } from "./validate";

const ROOT = process.cwd();
const transcriptsDir = path.join(ROOT, "transcripts");
const dataDir = path.join(ROOT, "data");

const main = async (): Promise<void> => {
  const faqPath = path.join(dataDir, "faq.json");
  const tagsPath = path.join(dataDir, "tags.json");
  const sectionsPath = path.join(dataDir, "sections.json");
  const processedPath = path.join(dataDir, "processed.json");

  const faq = await readJson<FaqFile>(faqPath, {
    version: 1,
    updatedAt: null,
    items: [],
  });

  const tags = await readJson<TagsFile>(tagsPath, {
    version: 1,
    updatedAt: null,
    tags: [],
  });

  const sections = await readJson<SectionsFile>(sectionsPath, {
    version: 1,
    updatedAt: null,
    sections: [],
  });

  const processed = await readJson<ProcessedFileStore>(processedPath, {
    version: 1,
    files: {},
  });

  // Генерация независимого AI-ответа для уже сохранённых FAQ, где его ещё нет.
  if (process.argv.includes("--ai-answers")) {
    const missing = faq.items.filter((item) => !item.aiAnswer?.trim());
    console.log(`Генерация независимых AI-ответов: ${missing.length} из ${faq.items.length}`);

    for (let index = 0; index < missing.length; index++) {
      const item = missing[index];
      console.log(`[${index + 1}/${missing.length}] ${item.question}`);
      item.aiAnswer = await generateAiAnswer(item.question, item.answer);
      item.aiComparison = await compareAnswers(item.question, item.answer, item.aiAnswer);
      console.log(`  ${item.aiComparison.status}: ${item.aiComparison.agreementPercent}%`);
    }

    faq.updatedAt = new Date().toISOString();
    validateFaq(faq, sections, tags);
    await backup(faqPath);
    await writeJson(faqPath, faq);
    console.log(`Готово. AI-ответов добавлено: ${missing.length}`);
    return;
  }

  // Повторный расчёт смыслового совпадения для сохранённых ответов.
  if (process.argv.includes("--ai-compare")) {
    const comparable = faq.items.filter((item) => item.answer?.trim() && item.aiAnswer?.trim());
    console.log(`Сравнение ответов автора и ИИ: ${comparable.length} FAQ`);

    for (let index = 0; index < comparable.length; index++) {
      const item = comparable[index];
      console.log(`[${index + 1}/${comparable.length}] ${item.question}`);
      item.aiComparison = await compareAnswers(item.question, item.answer, item.aiAnswer!);
      console.log(`  ${item.aiComparison.status}: ${item.aiComparison.agreementPercent}% — ${item.aiComparison.summary}`);
    }

    faq.updatedAt = new Date().toISOString();
    validateFaq(faq, sections, tags);
    await backup(faqPath);
    await writeJson(faqPath, faq);
    console.log(`Готово. Сравнено ответов: ${comparable.length}`);
    return;
  }

  // Режим повторной классификации уже сохранённых FAQ.
  if (process.argv.includes("--retag")) {
    console.log(`Повторная классификация: ${faq.items.length} FAQ`);
    console.log(`Тегов в словаре до запуска: ${tags.tags.length}`);

    for (let index = 0; index < faq.items.length; index++) {
      const item = faq.items[index];

      console.log(`[${index + 1}/${faq.items.length}] ${item.question}`);

      const generatedTags = await classifyFaqTags(
        item.question,
        item.answer,
        sections.sections,
        tags.tags,
      );

      item.tags = mergeTagsIntoDictionary(generatedTags, tags);

      console.log(`  Теги: ${item.tags.join(", ") || "—"}`);
    }

    faq.updatedAt = new Date().toISOString();
    tags.updatedAt = new Date().toISOString();

    validateFaq(faq, sections, tags);

    await backup(faqPath);
    await writeJson(faqPath, faq);
    await writeJson(tagsPath, tags);

    console.log(`Готово. FAQ: ${faq.items.length}`);
    console.log(`Всего тегов в словаре: ${tags.tags.length}`);
    return;
  }

  const promptFile = path.join(ROOT, "prompts", "extract-faq.md");
  const prompt = await readFile(promptFile, "utf8");

  const files = (await readdir(transcriptsDir))
    .filter((file) => file.toLowerCase().endsWith(".txt"))
    .sort();

  if (files.length === 0) {
    console.log("Нет .txt файлов в transcripts/");
    return;
  }

  for (const file of files) {
    const fullPath = path.join(transcriptsDir, file);
    const text = await readFile(fullPath, "utf8");
    const hash = sha256(text);
    const processedFile = processed.files[file];

    if (processedFile && processedFile.hash === hash) {
      console.log("SKIP:", file);
      continue;
    }

    console.log(`\nPROCESS: ${file}`);

    const extracted = await (await import("./ai")).extractFaq(
      text,
      prompt,
      sections,
      tags,
    );

    console.log(`AI извлёк: ${extracted.length} FAQ`);

    const result = mergeFaq(faq, extracted, { file }, sections, tags);

    console.log(
      `extracted=${extracted.length} added=${result.added} updated=${result.updated}`,
    );

    validateFaq(result.faq, sections, result.tags);

    processed.files[file] = {
      hash,
      processedAt: new Date().toISOString(),
      itemCount: extracted.length,
    };

    await backup(faqPath);
    await writeJson(faqPath, result.faq);
    await writeJson(tagsPath, result.tags);
    await writeJson(processedPath, processed);
  }

  console.log(`\nГотово. FAQ: ${faq.items.length} записей.`);
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
