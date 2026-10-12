import "dotenv/config";
import path from "node:path";
import { readJson } from "./io.js";
import type { FaqFile, SectionsFile, TagsFile } from "./types.js";

export const validateFaq = (faq: FaqFile, sections: SectionsFile, tags: TagsFile): string[] => {
  const errors: string[] = [];
  const ids = new Set<string>();
  const sectionIds = new Set(sections.sections.map((s) => s.id));
  for (const [index, item] of faq.items.entries()) {
    const label = `FAQ #${index + 1}`;
    if (!item.id || ids.has(item.id)) errors.push(`${label}: пустой или повторяющийся id`);
    ids.add(item.id);
    if (!item.question?.trim()) errors.push(`${label}: пустой question`);
    if (typeof item.answer !== "string") errors.push(`${label}: answer должен быть строкой`);
    if (!Array.isArray(item.sections)) errors.push(`${label}: sections должен быть массивом`);
    else for (const id of item.sections) if (!sectionIds.has(id)) errors.push(`${label}: неизвестный раздел ${id}`);
    if (!Array.isArray(item.tags) || item.tags.some((tag) => typeof tag !== "string")) errors.push(`${label}: некорректные tags`);
    if (!Array.isArray(item.relatedIds)) errors.push(`${label}: relatedIds должен быть массивом`);
    if (item.aiComparison && (item.aiComparison.agreementPercent < 0 || item.aiComparison.agreementPercent > 100)) errors.push(`${label}: agreementPercent вне диапазона 0..100`);
  }
  for (const item of faq.items) for (const relatedId of item.relatedIds) if (!ids.has(relatedId)) errors.push(`${item.id}: relatedIds ссылается на отсутствующий ${relatedId}`);
  for (const tag of faq.items.flatMap((item) => item.tags)) if (!tags.tags.includes(tag)) tags.tags.push(tag);
  return errors;
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve("src/validate.ts")) {
  const root = process.cwd();
  const faq = await readJson<FaqFile>(path.join(root, "data/faq.json"), { version: 1, updatedAt: new Date().toISOString(), items: [] });
  const sections = await readJson<SectionsFile>(path.join(root, "data/sections.json"), { version: 1, sections: [] });
  const tags = await readJson<TagsFile>(path.join(root, "data/tags.json"), { version: 1, tags: [] });
  const errors = validateFaq(faq, sections, tags);
  if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
  else console.log(`FAQ корректен: ${faq.items.length} записей`);
}
