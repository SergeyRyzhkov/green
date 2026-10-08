import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { extractFaq } from "./ai";
import { sha256 } from "./hash";
import { backup, readJson, writeJson } from "./io";
import { mergeFaq } from "./merge";
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
const promptFile = path.join(ROOT, "prompts", "extract-faq.md");

const main = async () => {
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
  const prompt = await readFile(promptFile, "utf8");

  const files = (await readdir(transcriptsDir))
    .filter((f) => f.toLowerCase().endsWith(".txt"))
    .sort();

  if (!files.length) {
    console.log("Нет .txt файлов в transcripts/");
    return;
  }

  for (const file of files) {
    const fullPath = path.join(transcriptsDir, file);
    const text = await readFile(fullPath, "utf8");
    const hash = sha256(text);

    if (processed.files[file]?.hash === hash) {
      console.log(`SKIP: ${file}`);
      continue;
    }

    console.log(`PROCESS: ${file}`);
    const extracted = await extractFaq(text, prompt);
    const result = mergeFaq(faq, extracted, { file }, sections, tags);

    console.log(
      `  extracted=${extracted.length} added=${result.added} updated=${result.updated}`,
    );

    validateFaq(result.faq);

    console.log(
      `  extracted=${extracted.length} added=${result.added} updated=${result.updated}`,
    );

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

  console.log(`Готово. FAQ: ${faq.items.length} записей.`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
