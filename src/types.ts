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
  roofRafers: "roof-rafers",
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
  roofRafers: "roof-rafers",
  windowsDoors: "windows-doors",
  interiorFinishing: "interior-finishing",
  exteriorFinishing: "exterior-finishing",
  stovesChimneysFireSafety: "stoves-chimneys-fire-safety",
  heating: "heating",
  waterSupply: "water-supply",
  sewerage: "sewerage",
  electrical: "electrical",
  ventilation: "ventilation",
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

export interface SourceQuestion {
  file: string;
  question?: string;
}

/** Результат извлечения из расшифровки. */
export interface ExtractedQaItem {
  sourceQuestion: string;
  question: string;
  answer: string;
  evidence: string;
}

/** Результат редактуры и классификации. */
export interface ExtractedFaqItem {
  sourceQuestion: string;

  /** Оригинальные данные после извлечения. */
  originalQuestion: string;
  originalAnswer: string;

  /** Фрагмент исходной расшифровки, подтверждающий ответ. */
  evidence: string;

  /** Версия после редакторской обработки. */
  editedQuestion: string;
  editedAnswer: string;

  /** Совместимость со старым кодом. */
  question: string;
  answer: string;

  title: string;
  sections: string[];
  tags: string[];
  comment: string;

  /** Требуется ли ручная проверка. */
  reviewStatus: "pending" | "review" | "ready";
  reviewReasons: string[];
}

export interface FaqItem {
  id: string;

  title: string;

  /** Рабочая версия для отображения в FAQ. */
  question: string;
  answer: string;

  /** Исходные данные — не перезаписываются редактурой. */
  originalQuestion?: string;
  originalAnswer?: string;

  /** Отредактированная версия. */
  editedQuestion?: string;
  editedAnswer?: string;

  /** Подтверждающий фрагмент расшифровки. */
  evidence?: string;

  /** Статус проверки и причины сомнений. */
  reviewStatus?: "pending" | "review" | "ready";
  reviewReasons?: string[];

  comment: string;

  sourceQuestions: SourceQuestion[];

  sections: string[];

  tags: string[];

  sources: FaqSource[];

  updatedAt: string;
}

export interface FaqFile {
  version: number;
  updatedAt: string | null;
  items: FaqItem[];
}

export interface ProcessedFile {
  hash: string;
  processedAt: string;
  itemCount: number;
}

export interface ProcessedFileStore {
  version: number;
  files: Record<string, ProcessedFile>;
}
