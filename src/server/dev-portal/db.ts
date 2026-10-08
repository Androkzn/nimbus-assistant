import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  KnowledgeBasePayload,
  KnowledgeDocument,
  KnowledgeDocumentStatus,
  KnowledgeReport,
  KnowledgeReportCategory,
  KnowledgeReportSeverity,
  KnowledgeReportStatus,
} from "@/shared/knowledgeBase";

const DB_ROOT = process.env.VERCEL ? "/tmp" : path.join(process.cwd(), ".data");
const DB_FILE = process.env.NIMBUS_DEV_DB_PATH ?? path.join(DB_ROOT, "nimbus-dev.sqlite");
const KB_DIR = path.join(process.cwd(), "knowledge-base");
type Row = Record<string, unknown>;
let database: DatabaseSync | null = null;

export function devPortalEnabled(): boolean {
  return process.env.NODE_ENV === "development" || process.env.VERCEL_ENV === "preview" || process.env.NIMBUS_DEV_PORTAL === "1";
}

function requireDevelopment(): void {
  if (!devPortalEnabled()) throw new Error("The knowledge portal is available in development only.");
}

function db(): DatabaseSync {
  requireDevelopment();
  if (database) return database;
  mkdirSync(path.dirname(DB_FILE), { recursive: true });
  database = new DatabaseSync(DB_FILE);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      file TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      product TEXT,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published')),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      product TEXT,
      severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
      category TEXT NOT NULL DEFAULT 'manual' CHECK (category IN ('manual', 'readiness', 'knowledge-gap', 'irrelevant')),
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'investigating', 'resolved')),
      summary TEXT NOT NULL,
      question TEXT,
      analysis TEXT,
      detected_at TEXT NOT NULL,
      source_key TEXT UNIQUE
    );
  `);
  const reportColumns = database.prepare("PRAGMA table_info(reports)").all() as Row[];
  if (!reportColumns.some((column) => column.name === "category")) database.exec("ALTER TABLE reports ADD COLUMN category TEXT NOT NULL DEFAULT 'manual'");
  if (!reportColumns.some((column) => column.name === "question")) database.exec("ALTER TABLE reports ADD COLUMN question TEXT");
  if (!reportColumns.some((column) => column.name === "analysis")) database.exec("ALTER TABLE reports ADD COLUMN analysis TEXT");
  if (!reportColumns.some((column) => column.name === "source_key")) database.exec("ALTER TABLE reports ADD COLUMN source_key TEXT");
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS reports_source_key_unique ON reports(source_key) WHERE source_key IS NOT NULL");
  seedDocuments(database);
  return database;
}

function seedDocuments(target: DatabaseSync): void {
  const count = (target.prepare("SELECT COUNT(*) AS count FROM documents").get() as Row).count;
  if (Number(count) > 0) return;
  const insert = target.prepare(
    "INSERT INTO documents (id, file, title, product, content, status, updated_at) VALUES (?, ?, ?, ?, ?, 'published', ?)",
  );
  const now = new Date().toISOString();
  for (const file of readdirSync(KB_DIR).filter((name) => name.endsWith(".md")).sort()) {
    const content = readFileSync(path.join(KB_DIR, file), "utf8");
    const title = content.match(/^# (.+)$/m)?.[1]?.trim() ?? file;
    const prefix = file.split(/[-.]/)[0];
    const product = ["relay", "vault", "pulse", "ledger"].includes(prefix) ? prefix : null;
    insert.run(file, file, title, product, content, now);
  }
}

function documentFromRow(row: Row): KnowledgeDocument {
  return {
    id: String(row.id), file: String(row.file), title: String(row.title), product: row.product ? String(row.product) : null,
    content: String(row.content), status: String(row.status) as KnowledgeDocumentStatus, updatedAt: String(row.updated_at),
  };
}

function reportFromRow(row: Row): KnowledgeReport {
  return {
    id: String(row.id), title: String(row.title), product: row.product ? String(row.product) : null,
    severity: String(row.severity) as KnowledgeReportSeverity, category: String(row.category ?? "manual") as KnowledgeReportCategory, status: String(row.status) as KnowledgeReportStatus,
    summary: String(row.summary), question: row.question ? String(row.question) : null, analysis: row.analysis ? String(row.analysis) : null,
    detectedAt: String(row.detected_at),
  };
}

export function listPublishedDocuments(): KnowledgeDocument[] {
  return (db().prepare("SELECT * FROM documents WHERE status = 'published' ORDER BY file").all() as Row[]).map(documentFromRow);
}

export function getKnowledgeBase(): KnowledgeBasePayload {
  const target = db();
  const documents = (target.prepare("SELECT * FROM documents ORDER BY title").all() as Row[]).map(documentFromRow);
  const reports = (target.prepare("SELECT * FROM reports ORDER BY detected_at DESC").all() as Row[]).map(reportFromRow);
  const today = new Date().toISOString().slice(0, 10);
  const newIssuesToday = reports.filter((report) => report.detectedAt.startsWith(today) && report.status !== "resolved").length;
  return { documents, reports, stats: { documentCount: documents.length, publishedCount: documents.filter((document) => document.status === "published").length, newIssuesToday } };
}

function documentFileName(title: string): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72) || "document";
  let file = `${base}.md`;
  let suffix = 2;
  while (db().prepare("SELECT 1 FROM documents WHERE file = ?").get(file)) file = `${base}-${suffix++}.md`;
  return file;
}

export function createDocument(input: { title: string; product: string | null; content: string; status: KnowledgeDocumentStatus }): KnowledgeDocument | null {
  const title = input.title.trim();
  const content = input.content.trim();
  if (!title || !content || !["draft", "published"].includes(input.status)) return null;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db().prepare("INSERT INTO documents (id, file, title, product, content, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    id, documentFileName(title), title, input.product?.trim() || null, content, input.status, now,
  );
  return documentFromRow(db().prepare("SELECT * FROM documents WHERE id = ?").get(id) as Row);
}

export function updateDocument(id: string, input: { title: string; product: string | null; content: string; status: KnowledgeDocumentStatus }): KnowledgeDocument | null {
  const title = input.title.trim();
  const content = input.content.trim();
  if (!title || !content || !["draft", "published"].includes(input.status)) return null;
  const result = db().prepare("UPDATE documents SET title = ?, product = ?, content = ?, status = ?, updated_at = ? WHERE id = ?").run(title, input.product?.trim() || null, content, input.status, new Date().toISOString(), id);
  if (Number(result.changes) === 0) return null;
  return documentFromRow(db().prepare("SELECT * FROM documents WHERE id = ?").get(id) as Row);
}

export function deleteDocument(id: string): boolean {
  const result = db().prepare("DELETE FROM documents WHERE id = ?").run(id);
  return Number(result.changes) > 0;
}

export function createReport(input: { title: string; product: string | null; severity: KnowledgeReportSeverity; category?: KnowledgeReportCategory; summary: string; question?: string | null; analysis?: string | null; sourceKey?: string }): KnowledgeReport | null {
  const title = input.title.trim();
  const summary = input.summary.trim();
  if (!title || !summary || !["low", "medium", "high"].includes(input.severity)) return null;
  const id = crypto.randomUUID();
  const detectedAt = new Date().toISOString();
  db().prepare("INSERT INTO reports (id, title, product, severity, category, status, summary, question, analysis, detected_at, source_key) VALUES (?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?)").run(id, title, input.product || null, input.severity, input.category ?? "manual", summary, input.question?.trim() || null, input.analysis?.trim() || null, detectedAt, input.sourceKey ?? null);
  return reportFromRow(db().prepare("SELECT * FROM reports WHERE id = ?").get(id) as Row);
}

function safeEvidenceId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120);
}

export function createReadinessReport(input: { runId: string; failedChecks: string[]; failedStages: string[] }): KnowledgeReport | null {
  const runId = input.runId.trim();
  const failedChecks = [...new Set(input.failedChecks.map(safeEvidenceId).filter(Boolean))].slice(0, 40);
  const failedStages = [...new Set(input.failedStages.map(safeEvidenceId).filter(Boolean))].slice(0, 20);
  if (!runId || (failedChecks.length === 0 && failedStages.length === 0)) return null;

  const sourceKey = `readiness:${safeEvidenceId(runId)}`;
  const existing = db().prepare("SELECT * FROM reports WHERE source_key = ?").get(sourceKey) as Row | undefined;
  if (existing) return reportFromRow(existing);

  const evidence = [...failedStages.map((stage) => `stage ${stage}`), ...failedChecks.map((check) => `check ${check}`)].join(", ");
  return createReport({
    title: "Readiness test failed",
    product: null,
    severity: "high",
    category: "readiness",
    summary: `Live Readiness evidence reported ${evidence}. Review the Readiness test run ${safeEvidenceId(runId)}.`,
    sourceKey,
  });
}

export function likelyKnowledgeGap(question: string): boolean {
  return /\b(?:relay|vault|pulse|ledger|nimbus|api|endpoint|integration|sso|saml|sla|status|error|403|404|429|500|auth|token|webhook|secret|pricing|version)\b/i.test(question);
}

export function createQuestionReport(input: { question: string; analysis: string; category: "knowledge-gap" | "irrelevant" }): KnowledgeReport | null {
  const question = input.question;
  const normalized = question.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 2000) return null;
  const analysis = input.analysis.trim().slice(0, 1000);
  const today = new Date().toISOString().slice(0, 10);
  const fingerprint = createHash("sha256").update(normalized.toLowerCase()).digest("hex").slice(0, 20);
  const sourceKey = `question:${input.category}:${today}:${fingerprint}`;
  const existing = db().prepare("SELECT * FROM reports WHERE source_key = ?").get(sourceKey) as Row | undefined;
  if (existing) {
    if (!existing.question || !existing.analysis) {
      db().prepare("UPDATE reports SET question = COALESCE(question, ?), analysis = COALESCE(analysis, ?) WHERE source_key = ?").run(normalized, analysis || null, sourceKey);
      return reportFromRow(db().prepare("SELECT * FROM reports WHERE source_key = ?").get(sourceKey) as Row);
    }
    return reportFromRow(existing);
  }
  return createReport({
    title: input.category === "irrelevant" ? "Irrelevant question detected" : "Knowledge-base gap detected",
    product: null,
    severity: input.category === "irrelevant" ? "low" : "medium",
    category: input.category,
    summary: input.category === "irrelevant" ? "The question is outside the NimbusStack product knowledge-base scope. Keep it for review, but do not add it to the approved corpus unless the scope changes." : "A product-related question was not covered by the published knowledge base. Add or update an approved support or troubleshooting entry.",
    question: normalized,
    analysis,
    sourceKey,
  });
}

export function createKnowledgeGapReport(input: { question: string; analysis: string }): KnowledgeReport | null {
  return createQuestionReport({ ...input, category: "knowledge-gap" });
}

export function updateReport(id: string, input: { status: KnowledgeReportStatus; severity: KnowledgeReportSeverity; category: KnowledgeReportCategory; product: string | null }): KnowledgeReport | null {
  if (!["new", "investigating", "resolved"].includes(input.status)) return null;
  if (!["low", "medium", "high"].includes(input.severity)) return null;
  if (!["manual", "readiness", "knowledge-gap", "irrelevant"].includes(input.category)) return null;
  const result = db().prepare("UPDATE reports SET status = ?, severity = ?, category = ?, product = ? WHERE id = ?").run(input.status, input.severity, input.category, input.product?.trim() || null, id);
  if (Number(result.changes) === 0) return null;
  return reportFromRow(db().prepare("SELECT * FROM reports WHERE id = ?").get(id) as Row);
}

export function closeDevDatabaseForTests(): void {
  database?.close();
  database = null;
}
