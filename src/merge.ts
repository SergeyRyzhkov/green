import type {
  ExtractedFaqItem,
  FaqFile,
  FaqItem,
  FaqSource,
  SectionsFile,
  TagsFile,
} from "./types.ts";

const normalize = (text: string): string => {
  return text
    .toLowerCase()
    .replace(/[«»"'`]/g, "")
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const tokens = (text: string): Set<string> => {
  return new Set(
    normalize(text)
      .split(" ")
      .filter((x) => x.length > 2),
  );
};

const similarity = (a: string, b: string): number => {
  const aa = tokens(a);
  const bb = tokens(b);

  if (!aa.size || !bb.size) {
    return 0;
  }

  let common = 0;

  for (const token of aa) {
    if (bb.has(token)) {
      common++;
    }
  }

  return common / (aa.size + bb.size - common);
};

const makeId = (question: string): string => {
  return (
    normalize(question)
      .split(" ")
      .filter(Boolean)
      .slice(0, 5)
      .join("-")
      .replace(/[^a-zа-я0-9-]/gi, "") || `faq-${Date.now()}`
  );
};

const createSourceQuestion = (source: FaqSource, question: string) => {
  return {
    file: source.file,
    question: question.trim(),
  };
};

const hasSourceQuestion = (
  item: FaqItem,
  source: FaqSource,
  question: string,
): boolean => {
  const normalizedQuestion = question.trim();

  return item.sourceQuestions.some(
    (sourceQuestion) =>
      sourceQuestion.file === source.file &&
      sourceQuestion.question === normalizedQuestion,
  );
};

const hasSource = (item: FaqItem, source: FaqSource): boolean => {
  return item.sources.some(
    (existingSource) =>
      existingSource.file === source.file && existingSource.url === source.url,
  );
};

export const mergeFaq = (
  faq: FaqFile,
  extracted: ExtractedFaqItem[],
  source: FaqSource,
  sections: SectionsFile,
  tagsFile: TagsFile,
): {
  faq: FaqFile;
  tags: TagsFile;
  added: number;
  updated: number;
} => {
  const validSections = new Set(sections.sections.map((section) => section.id));

  const knownTags = new Set(tagsFile.tags);

  let added = 0;
  let updated = 0;

  for (const item of extracted) {
    const sectionIds = item.sections.filter((id) => validSections.has(id));

    const tags = item.tags.map((tag) => tag.trim()).filter(Boolean);

    for (const tag of tags) {
      knownTags.add(tag);
    }

    const existing = faq.items.find(
      (faqItem) =>
        similarity(faqItem.question, item.question) >= 0.72 ||
        faqItem.sourceQuestions.some(
          (sourceQuestion) =>
            sourceQuestion.question &&
            similarity(sourceQuestion.question, item.sourceQuestion) >= 0.82,
        ),
    );

    /*
     * Новый FAQ-вопрос
     */
    if (!existing) {
      const newItem: FaqItem = {
        id: makeId(item.question),
        question: item.question.trim(),

        sourceQuestions: [createSourceQuestion(source, item.sourceQuestion)],

        answer: item.answer.trim(),

        sections: [...new Set(sectionIds)],

        tags: [...new Set(tags)],

        sources: [source],

        updatedAt: new Date().toISOString(),
      };

      faq.items.push(newItem);
      added++;

      continue;
    }

    /*
     * Добавляем исходную формулировку,
     * если такой источник ещё не записан.
     */
    if (!hasSourceQuestion(existing, source, item.sourceQuestion)) {
      existing.sourceQuestions.push(
        createSourceQuestion(source, item.sourceQuestion),
      );
    }

    /*
     * Объединяем разделы.
     */
    existing.sections = [...new Set([...existing.sections, ...sectionIds])];

    /*
     * Объединяем теги.
     */
    existing.tags = [...new Set([...existing.tags, ...tags])];

    /*
     * Добавляем источник, если его ещё нет.
     */
    if (!hasSource(existing, source)) {
      existing.sources.push(source);
    }

    /*
     * Если ответ отличается от существующего,
     * добавляем его как дополнение.
     */
    const newAnswer = item.answer.trim();

    if (newAnswer && !existing.answer.includes(newAnswer)) {
      existing.answer =
        `${existing.answer}\n\n` +
        `Дополнение из источника «${source.file}»:\n` +
        newAnswer;
    }

    existing.updatedAt = new Date().toISOString();

    updated++;
  }

  /*
   * Обновляем метаданные основного FAQ.
   */
  faq.updatedAt = new Date().toISOString();

  /*
   * Сохраняем все обнаруженные теги.
   */
  tagsFile.tags = [...knownTags].sort((a, b) => a.localeCompare(b, "ru"));

  tagsFile.updatedAt = new Date().toISOString();

  return {
    faq,
    tags: tagsFile,
    added,
    updated,
  };
};
