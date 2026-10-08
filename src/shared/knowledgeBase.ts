export type KnowledgeDocumentStatus = "draft" | "published";
export type KnowledgeReportStatus = "new" | "investigating" | "resolved";
export type KnowledgeReportSeverity = "low" | "medium" | "high";
export type KnowledgeReportCategory = "manual" | "readiness" | "knowledge-gap" | "irrelevant";

export interface KnowledgeDocument {
  id: string;
  file: string;
  title: string;
  product: string | null;
  content: string;
  status: KnowledgeDocumentStatus;
  updatedAt: string;
}

export interface KnowledgeReport {
  id: string;
  title: string;
  product: string | null;
  severity: KnowledgeReportSeverity;
  category: KnowledgeReportCategory;
  status: KnowledgeReportStatus;
  summary: string;
  question: string | null;
  analysis: string | null;
  detectedAt: string;
}

export interface KnowledgeBasePayload {
  documents: KnowledgeDocument[];
  reports: KnowledgeReport[];
  stats: {
    documentCount: number;
    publishedCount: number;
    newIssuesToday: number;
    observationsToday: number;
  };
}
