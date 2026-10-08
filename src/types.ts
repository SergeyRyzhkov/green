export interface Section {
  id: string;
  name: string;
  description?: string;
}

export interface SectionsFile {
  version: number;
  updatedAt: string | null;
  sections: Section[];
}

export const SectionsKeys = {
  foundationSoils: "foundation-soils",
  buildingEnvelope: "building-envelope",
  reinforcement: "reinforcement",
  thermalInsulation: "thermal-insulation",
  floorsUnderfloorHeating: "floors-underfloor-heating",
  roofRafers: "roof-rafters",
  windowsDoors: "windows-doors",
  interiorFinishing: "interior-finishing",
  exteriorFinishing: "exterior-finishing",
  stovesChimneysFireSafety: "stoves-chimneys-fire-safety",
  heating: "heating",
  waterSupply: "water-supply",
  sewerage: "sewerage",
  electrical: "electrical",
  ventilation: "ventilation",
  winterOperation: "winter-operation",
  engineeringThinking: "engineering-thinking",
} as const;

export type SectionId = (typeof SectionsKeys)[keyof typeof SectionsKeys];

export type SectionName = SectionId;

export interface Tag {
  id: string;
  name: string;
  projects?: string[];
  priority?: "high" | "medium" | "low";
}

export const TagsKeys = {
  foundationSoils: "foundation-soils",
  buildingEnvelope: "building-envelope",
  reinforcement: "reinforcement",
  thermalInsulation: "thermal-insulation",
  floorsUnderfloorHeating: "floors-underfloor-heating",
  roofRafers: "roof-rafters",
  windowsDoors: "windows-doors",
  interiorFinishing: "interior-finishing",
  exteriorFinishing: "exterior-finishing",
  stovesChimneysFireSafety: "stoves-chimneys-fire-safety",
  heating: "heating",
  waterSupply: "water-supply",
  sewerage: "sewerage",
  electrical: "electrical",
  ventilation: "ventilation",
  winterOperation: "winter-operation",
  engineeringThinking: "engineering-thinking",
} as const;

export type TagId = (typeof TagsKeys)[keyof typeof TagsKeys];

export interface TagsFile {
  version: number;
  updatedAt: string | null;
  tags: string[];
}

export interface SectionsWithMetadata extends Section {
  projectCount?: number;
}

export type SectionIdWithMetadata = SectionId;

export type ProcessMode = "production" | "dry" | "validation";

export interface FaqSource {
  file: string;
  title?: string;
  url?: string;
}

/**
 * Исходная формулировка вопроса,
 * из которой был сформирован FAQ-вопрос.
 */
export interface SourceQuestion {
  file: string;
  question?: string;
}

/**
 * FAQ-элемент после обработки и объединения
 * похожих вопросов.
 */
export interface FaqItem {
  id: string;
  question: string;
  answer: string;
  sourceQuestions: SourceQuestion[];
  sections: string[];
  tags: string[];
  sources: FaqSource[];
  updatedAt: string;
}

/**
 * Результат обработки одной расшифровки
 * до объединения с существующим FAQ.
 */
export interface ExtractedFaqItem {
  sourceQuestion: string;
  question: string;
  answer: string;
  sections: string[];
  tags: string[];
}

/**
 * Основной JSON-файл FAQ.
 */
export interface FaqFile {
  version: number;
  updatedAt: string | null;
  items: FaqItem[];
}

/**
 * Информация об уже обработанной расшифровке.
 */
export interface ProcessedFile {
  hash: string;
  processedAt: string;
  itemCount: number;
}

/**
 * Хранилище информации об обработанных файлах.
 */
export interface ProcessedFileStore {
  version: number;
  files: Record<string, ProcessedFile>;
}
