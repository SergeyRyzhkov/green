export type ComparisonStatus =
  | "agree"
  | "partially_agree"
  | "disagree"
  | "not_comparable";

export interface AiComparison {
  status: ComparisonStatus;
  agreementPercent: number;
  summary: string;
}

export interface FaqItem {
  id: string;
  question: string;
  answer: string;
  source: string;
  context: string;
  needsContext: boolean;
  sections: string[];
  tags: string[];
  relatedIds: string[];
  aiAnswer: string;
  aiComparison: AiComparison;
}

export interface FaqFile {
  version: 1;
  updatedAt: string;
  items: FaqItem[];
}

export interface Section {
  id: string;
  name: string;
  description?: string;
}

export interface SectionsFile {
  version: number;
  updatedAt?: string | null;
  sections: Section[];
}

export interface TagsFile {
  version: number;
  updatedAt?: string | null;
  tags: string[];
}

export interface ModelQa {
  question: string;
  answer: string;
  context: string;
}

export interface EnrichedQa {
  sections: string[];
  tags: string[];
  needsContext: boolean;
  aiAnswer: string;
  aiComparison: AiComparison;
}

export interface ExtractionResult {
  items: ModelQa[];
  rejected: number;
  modelCount: number;
}
