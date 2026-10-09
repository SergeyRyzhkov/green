import fs from "node:fs";
import path from "node:path";

import type { FaqFile, FaqItem, SectionsFile, TagsFile } from "./types";

const DATA_DIR = path.resolve("data");
const FAQ_FILE = path.join(DATA_DIR, "faq.json");
const SECTIONS_FILE = path.join(DATA_DIR, "sections.json");
const TAGS_FILE = path.join(DATA_DIR, "tags.json");

export function validateFaq(
  faq: FaqFile,
  sectionsFile?: SectionsFile,
  tagsFile?: TagsFile,
): void {
  console.log("=== Проверка FAQ ===\n");

  if (!faq || typeof faq !== "object") {
    throw new Error("FAQ должен быть объектом");
  }

  if (!Array.isArray(faq.items)) {
    throw new Error("faq.items должен быть массивом");
  }

  console.log(`Всего вопросов: ${faq.items.length}`);

  checkItems(faq.items);
  checkDuplicates(faq.items);
  checkSections(faq.items, sectionsFile);
  checkTags(faq.items, tagsFile);
  checkSources(faq.items);
  checkEvidenceAndReview(faq.items);

  console.log("\n✓ Проверка FAQ завершена");
}

function checkItems(items: FaqItem[]): void {
  const requiredFields: (keyof FaqItem)[] = [
    "id",
    "question",
    "answer",
    "sourceQuestions",
    "sections",
    "tags",
  ];

  for (const [index, item] of items.entries()) {
    const number = index + 1;

    if (!item || typeof item !== "object") {
      throw new Error(`FAQ #${number} не является объектом`);
    }

    for (const field of requiredFields) {
      if (item[field] === undefined || item[field] === null) {
        throw new Error(`FAQ #${number}: отсутствует поле "${field}"`);
      }
    }

    if (typeof item.id !== "string" || !item.id.trim()) {
      throw new Error(`FAQ #${number}: пустой или некорректный id`);
    }

    if (typeof item.question !== "string" || !item.question.trim()) {
      throw new Error(`FAQ #${number}: пустой question`);
    }

    if (typeof item.answer !== "string" || !item.answer.trim()) {
      throw new Error(`FAQ #${number}: пустой answer`);
    }

    if (!Array.isArray(item.sourceQuestions)) {
      throw new Error(`FAQ #${number}: sourceQuestions не массив`);
    }

    if (!Array.isArray(item.sections)) {
      throw new Error(`FAQ #${number}: sections не массив`);
    }

    if (!Array.isArray(item.tags)) {
      throw new Error(`FAQ #${number}: tags не массив`);
    }

    if (item.sourceQuestions.length === 0) {
      console.warn(`⚠️ FAQ #${number}: нет источников`);
    }

    if (item.sections.length === 0) {
      console.warn(`⚠️ FAQ #${number}: нет разделов`);
    }

    if (item.tags.length === 0) {
      console.warn(`⚠️ FAQ #${number}: нет тегов`);
    }
  }

  console.log("✓ Структура записей корректна");
}

function normalize(value: string): string {
  return value
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[«»"'`]/g, "")
    .replace(/[^a-zа-я0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function checkDuplicates(items: FaqItem[]): void {
  const ids = new Map<string, number[]>();
  const questions = new Map<string, number[]>();

  for (const [index, item] of items.entries()) {
    const idIndexes = ids.get(item.id) ?? [];
    idIndexes.push(index + 1);
    ids.set(item.id, idIndexes);

    const question = normalize(item.question);
    const questionIndexes = questions.get(question) ?? [];
    questionIndexes.push(index + 1);
    questions.set(question, questionIndexes);
  }

  const duplicateIds = [...ids.entries()].filter(
    ([, indexes]) => indexes.length > 1,
  );

  const duplicateQuestions = [...questions.entries()].filter(
    ([, indexes]) => indexes.length > 1,
  );

  if (duplicateIds.length > 0) {
    for (const [id, indexes] of duplicateIds) {
      console.error(`❌ Дублирующийся ID "${id}": FAQ #${indexes.join(", #")}`);
    }

    throw new Error("Обнаружены дублирующиеся ID");
  }

  console.log("✓ Дублирующихся ID нет");

  if (duplicateQuestions.length > 0) {
    console.warn(
      `⚠️ Одинаковых нормализованных вопросов: ${duplicateQuestions.length}`,
    );

    for (const [question, indexes] of duplicateQuestions) {
      console.warn(`  FAQ #${indexes.join(", #")}: ${question}`);
    }
  } else {
    console.log("✓ Полностью совпадающих вопросов нет");
  }
}

function checkSections(items: FaqItem[], sectionsFile?: SectionsFile): void {
  const counts = new Map<string, number>();
  const allowed = new Set(
    sectionsFile?.sections.map((section) => section.id) ?? [],
  );

  let unknown = 0;

  console.log("\nРазделы:");

  for (const [index, item] of items.entries()) {
    for (const section of item.sections) {
      counts.set(section, (counts.get(section) ?? 0) + 1);

      if (sectionsFile && !allowed.has(section)) {
        console.warn(`⚠️ FAQ #${index + 1}: неизвестный раздел "${section}"`);
        unknown++;
      }
    }
  }

  for (const [section, count] of [...counts.entries()].sort()) {
    console.log(`  ${section}: ${count}`);
  }

  if (!sectionsFile) {
    console.warn("⚠️ Словарь разделов не передан");
  } else if (unknown === 0) {
    console.log("✓ Все ID разделов существуют");
  }
}

function checkTags(items: FaqItem[], tagsFile?: TagsFile): void {
  const counts = new Map<string, number>();
  const allowed = new Map(
    (tagsFile?.tags ?? []).map((tag) => [normalize(tag), tag]),
  );

  let unknown = 0;
  let withoutTags = 0;

  console.log("\nТеги:");

  for (const [index, item] of items.entries()) {
    if (item.tags.length === 0) {
      withoutTags++;
    }

    for (const tag of item.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);

      if (tagsFile && !allowed.has(normalize(tag))) {
        console.warn(
          `⚠️ FAQ #${index + 1}: тег "${tag}" отсутствует в tags.json`,
        );
        unknown++;
      }
    }
  }

  if (counts.size === 0) {
    console.warn("⚠️ Ни одного тега не назначено");
  } else {
    for (const [tag, count] of [...counts.entries()].sort()) {
      console.log(`  ${tag}: ${count}`);
    }
  }

  if (!tagsFile) {
    console.warn("⚠️ Словарь тегов не передан");
  } else {
    console.log(`Тегов в словаре: ${tagsFile.tags.length}`);

    if (tagsFile.tags.length === 0) {
      console.warn(
        "⚠️ tags.json пуст: после классификации он должен пополняться",
      );
    }

    if (unknown === 0) {
      console.log("✓ Все назначенные теги присутствуют в словаре");
    }
  }

  if (withoutTags > 0) {
    console.warn(`⚠️ FAQ без тегов: ${withoutTags} из ${items.length}`);
  }
}

function checkSources(items: FaqItem[]): void {
  let withoutSources = 0;

  for (const [index, item] of items.entries()) {
    if (item.sourceQuestions.length === 0) {
      withoutSources++;
    }

    for (const source of item.sourceQuestions) {
      if (!source.file?.trim()) {
        throw new Error(`FAQ #${index + 1}: у источника отсутствует file`);
      }
    }
  }

  if (withoutSources > 0) {
    console.warn(`⚠️ Записей без источников: ${withoutSources}`);
  } else {
    console.log("✓ У всех записей есть источники");
  }
}

function checkEvidenceAndReview(items: FaqItem[]): void {
  let missingEvidence = 0;
  let needsReview = 0;
  let missingOriginal = 0;

  const noAnswerPattern =
    /^(нет ответа|ответ отсутствует|текста нет|не указано|не дано|не могу определить|автор не ответил|ответ не прозвучал|спикер не указал|спикер не дал)\b/i;

  for (const [index, item] of items.entries()) {
    const number = index + 1;

    if (!item.evidence?.trim()) {
      missingEvidence++;
      console.warn(`⚠️ FAQ #${number}: нет подтверждающей цитаты`);
    }

    if (item.reviewStatus === "review" || item.reviewStatus === "pending") {
      needsReview++;
    }

    if (!item.originalQuestion || !item.originalAnswer) {
      missingOriginal++;
    }

    if (noAnswerPattern.test(item.answer.trim())) {
      console.warn(
        `⚠️ FAQ #${number}: ответ похож на заглушку, а не на ответ автора`,
      );
    }
  }

  console.log("\nКонтроль качества:");
  console.log(`  Без подтверждающей цитаты: ${missingEvidence}`);
  console.log(`  Требуют ручной проверки: ${needsReview}`);
  console.log(`  Без исходных вопроса/ответа: ${missingOriginal}`);
}

function main(): void {
  const readJson = <T>(file: string): T => {
    if (!fs.existsSync(file)) {
      throw new Error(`Файл не найден: ${file}`);
    }

    const raw = fs.readFileSync(file, "utf8");

    if (!raw.trim()) {
      throw new Error(`Файл пустой: ${file}`);
    }

    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error(`Некорректный JSON: ${file}`);
    }
  };

  const faq = readJson<FaqFile>(FAQ_FILE);
  const sections = readJson<SectionsFile>(SECTIONS_FILE);
  const tags = readJson<TagsFile>(TAGS_FILE);

  if (!Array.isArray(sections.sections)) {
    throw new Error("sections.json: поле sections должно быть массивом");
  }

  if (!Array.isArray(tags.tags)) {
    throw new Error("tags.json: поле tags должно быть массивом");
  }

  validateFaq(faq, sections, tags);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname)
) {
  main();
}
