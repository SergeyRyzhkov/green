export type ComparisonStatus =
  | "agree"
  | "partially_agree"
  | "disagree"
  | "not_comparable";

export interface Section {
  id: string;
  name: string;
  description?: string;
}

export interface SectionsFile {
  sections: Section[];
}

export interface FaqComparison {
  status: ComparisonStatus;
  agreementPercent: number;
  summary: string;
}

export interface FaqSource {
  file: string;
  questionQuote: string;
  answerQuote: string;
  questionStart?: number;
  answerStart?: number;
  chunkIndex?: number;
}

export interface FaqItem {
  id: string;
  question: string;
  answer: string;
  source: FaqSource;
  sections: string[];
  aiAnswer: string | null;
  comparison: FaqComparison | null;
}

export interface FaqFile {
  version: 1;
  updatedAt: string;
  items: FaqItem[];
}

export interface ExtractedQaPair {
  questionQuote: string;
  answerQuote: string;
}

export interface Enrichment {
  sections: string[];
  aiAnswer: string | null;
  comparison: FaqComparison | null;
}
