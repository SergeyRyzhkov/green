import fs from "node:fs";
import path from "node:path";
import type { FaqFile, FaqItem } from "./types";

const DATA_DIR = path.resolve("data");
const FAQ_FILE = path.join(DATA_DIR, "faq.json");

export function validateFaq(faq: FaqFile): void {
  console.log("=== Проверка FAQ ===\n");

  if (!faq || typeof faq !== "object") {
    throw new Error("FAQ должен быть объектом");
  }

  if (!Array.isArray(faq.items)) {
    throw new Error("faq.items должен быть массивом");
  }

  console.log(`✓ Всего вопросов: ${faq.items.length}`);

  checkItems(faq.items);
  checkDuplicates(faq.items);
  checkSections(faq.items);
  checkTags(faq.items);
  checkSources(faq.items);

  console.log("\n✓ Проверка FAQ завершена");
}

function checkItems(items: FaqItem[]) {
  const requiredFields: (keyof FaqItem)[] = [
    "id",
    "question",
    "sourceQuestions",
    "answer",
    "sections",
    "tags",
  ];

  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== "object") {
      throw new Error(`FAQ item #${index + 1} не является объектом`);
    }

    for (const field of requiredFields) {
      if (item[field] === undefined || item[field] === null) {
        throw new Error(`FAQ item #${index + 1}: отсутствует поле "${field}"`);
      }
    }

    if (!item.id.trim()) {
      throw new Error(`FAQ item #${index + 1}: пустой id`);
    }

    if (!item.question.trim()) {
      throw new Error(`FAQ item #${index + 1}: пустой question`);
    }

    if (!item.answer.trim()) {
      throw new Error(`FAQ item #${index + 1}: пустой answer`);
    }

    if (!Array.isArray(item.sourceQuestions)) {
      throw new Error(
        `FAQ item #${index + 1}: sourceQuestions должен быть массивом`,
      );
    }

    if (!Array.isArray(item.sections)) {
      throw new Error(`FAQ item #${index + 1}: sections должен быть массивом`);
    }

    if (!Array.isArray(item.tags)) {
      throw new Error(`FAQ item #${index + 1}: tags должен быть массивом`);
    }

    if (item.sourceQuestions.length === 0) {
      console.warn(`⚠️ FAQ item #${index + 1}: нет sourceQuestions`);
    }

    if (item.sections.length === 0) {
      console.warn(`⚠️ FAQ item #${index + 1}: нет sections`);
    }

    if (item.tags.length === 0) {
      console.warn(`⚠️ FAQ item #${index + 1}: нет tags`);
    }
  }

  console.log("✓ Структура FAQ корректна");
}

function checkDuplicates(items: FaqItem[]) {
  const ids = new Map<string, number>();
  const questions = new Map<string, number>();

  for (const item of items) {
    ids.set(item.id, (ids.get(item.id) ?? 0) + 1);

    const normalizedQuestion = normalize(item.question);

    questions.set(
      normalizedQuestion,
      (questions.get(normalizedQuestion) ?? 0) + 1,
    );
  }

  const duplicateIds = [...ids.entries()].filter(([, count]) => count > 1);

  const duplicateQuestions = [...questions.entries()].filter(
    ([, count]) => count > 1,
  );

  if (duplicateIds.length) {
    throw new Error(
      `Найдены дублирующиеся ID: ${duplicateIds.map(([id]) => id).join(", ")}`,
    );
  }

  console.log("✓ Дублирующихся ID нет");

  if (duplicateQuestions.length) {
    console.warn(`⚠️ Найдено одинаковых вопросов: ${duplicateQuestions.length}`);

    for (const [question, count] of duplicateQuestions) {
      console.warn(`   ${count}× ${question}`);
    }
  } else {
    console.log("✓ Одинаковых вопросов нет");
  }
}

function checkSections(items: FaqItem[]) {
  const sections = new Map<string, number>();

  for (const item of items) {
    for (const section of item.sections) {
      sections.set(section, (sections.get(section) ?? 0) + 1);
    }
  }

  console.log("\nРазделы:");

  for (const [section, count] of sections) {
    console.log(`  ${section}: ${count}`);
  }
}

function checkTags(items: FaqItem[]) {
  const tags = new Map<string, number>();

  for (const item of items) {
    for (const tag of item.tags) {
      tags.set(tag, (tags.get(tag) ?? 0) + 1);
    }
  }

  console.log("\nТеги:");

  for (const [tag, count] of tags) {
    console.log(`  ${tag}: ${count}`);
  }
}

function checkSources(items: FaqItem[]) {
  let withoutSources = 0;

  for (const item of items) {
    if (!item.sourceQuestions.length) {
      withoutSources++;
    }

    for (const source of item.sourceQuestions) {
      if (!source.file?.trim()) {
        throw new Error(`Вопрос "${item.question}" содержит source без file`);
      }
    }
  }

  if (withoutSources) {
    console.warn(`⚠️ Вопросов без источника: ${withoutSources}`);
  } else {
    console.log("✓ У всех вопросов есть источник");
  }
}

function normalize(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Ручная проверка существующего data/faq.json
 */
function main() {
  if (!fs.existsSync(FAQ_FILE)) {
    throw new Error(`Файл не найден: ${FAQ_FILE}`);
  }

  const raw = fs.readFileSync(FAQ_FILE, "utf8");

  if (!raw.trim()) {
    throw new Error(`Файл пустой: ${FAQ_FILE}`);
  }

  let faq: FaqFile;

  try {
    faq = JSON.parse(raw);
  } catch {
    throw new Error(`Некорректный JSON: ${FAQ_FILE}`);
  }

  validateFaq(faq);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main();
}
