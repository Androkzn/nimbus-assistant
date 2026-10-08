import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { neon } from "@neondatabase/serverless";
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
const DB_FILE = process.env.NIMBUS_KB_DB_PATH ?? process.env.NIMBUS_DEV_DB_PATH ?? path.join(DB_ROOT, "nimbus-kb.sqlite");
const KB_DIR = path.join(process.cwd(), "knowledge-base");
type Row = Record<string, unknown>;
let database: DatabaseSync | null = null;
const SHARED_DATABASE_URL = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.NEON_DATABASE_URL ?? "";
const sharedSql = SHARED_DATABASE_URL ? neon(SHARED_DATABASE_URL) : null;
let sharedDatabaseReady: Promise<void> | null = null;

export function sharedDatabaseEnabled(): boolean {
  return Boolean(sharedSql);
}

export function devPortalEnabled(): boolean {
  return process.env.NODE_ENV === "development" || process.env.VERCEL_ENV === "preview" || process.env.NIMBUS_DEV_PORTAL === "1";
}

function db(): DatabaseSync {
  if (database) return database;
  mkdirSync(path.dirname(DB_FILE), { recursive: true });
  database = new DatabaseSync(DB_FILE);
  database.exec(`
    PRAGMA busy_timeout = 5000;
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

export function createFindingReport(input: {
  key: string;
  observedAt: string;
  category: "out_of_scope" | "documentation_gap" | "clarification_needed";
  severity: "low" | "medium";
  proposedAction: string;
  question?: string | null;
  analysis?: string | null;
  evidence: Record<string, unknown>;
}): KnowledgeReport | null {
  const sourceKey = `finding:${input.observedAt.slice(0, 10)}:${input.key}`;
  const existing = db().prepare("SELECT * FROM reports WHERE source_key = ?").get(sourceKey) as Row | undefined;
  const label = input.category === "out_of_scope" ? "Irrelevant" : input.category === "clarification_needed" ? "Clarification needed" : "Knowledge gap";
  const summaryBase = `${label}: ${input.proposedAction}`;
  if (existing) {
    const previous = String(existing.summary).match(/Observed (\d+) time/)?.[1];
    const occurrences = Number(previous ?? 1) + 1;
    db().prepare("UPDATE reports SET summary = ?, question = ?, analysis = ?, detected_at = ? WHERE source_key = ?").run(
      `${summaryBase} Observed ${occurrences} times today.`, input.question?.trim() || null, input.analysis?.trim() || JSON.stringify(input.evidence), input.observedAt, sourceKey,
    );
    return reportFromRow(db().prepare("SELECT * FROM reports WHERE source_key = ?").get(sourceKey) as Row);
  }
  return createReport({
    title: `${label} detected`,
    product: null,
    severity: input.severity,
    category: input.category === "out_of_scope" ? "irrelevant" : "knowledge-gap",
    summary: `${summaryBase} Observed 1 time today.`,
    question: input.question,
    analysis: input.analysis?.trim() || JSON.stringify(input.evidence),
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

type SharedRow = Record<string, unknown>;

function sharedDate(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function sharedDocumentFromRow(row: SharedRow): KnowledgeDocument {
  return {
    id: String(row.id), file: String(row.file), title: String(row.title), product: row.product ? String(row.product) : null,
    content: String(row.content), status: String(row.status) as KnowledgeDocumentStatus, updatedAt: sharedDate(row.updated_at),
  };
}

function sharedReportFromRow(row: SharedRow): KnowledgeReport {
  return {
    id: String(row.id), title: String(row.title), product: row.product ? String(row.product) : null,
    severity: String(row.severity) as KnowledgeReportSeverity, category: String(row.category ?? "manual") as KnowledgeReportCategory, status: String(row.status) as KnowledgeReportStatus,
    summary: String(row.summary), question: row.question ? String(row.question) : null, analysis: row.analysis ? String(row.analysis) : null,
    detectedAt: sharedDate(row.detected_at),
  };
}

async function ensureSharedDatabase(): Promise<void> {
  const sql = sharedSql;
  if (!sql) return;
  if (!sharedDatabaseReady) {
    sharedDatabaseReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS documents (
          id TEXT PRIMARY KEY,
          file TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          product TEXT,
          content TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'published',
          updated_at TIMESTAMPTZ NOT NULL
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS reports (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          product TEXT,
          severity TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'manual',
          status TEXT NOT NULL DEFAULT 'new',
          summary TEXT NOT NULL,
          question TEXT,
          analysis TEXT,
          detected_at TIMESTAMPTZ NOT NULL,
          source_key TEXT UNIQUE
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS documents_status_file_idx ON documents(status, file)`;
      await sql`CREATE INDEX IF NOT EXISTS reports_detected_at_idx ON reports(detected_at DESC)`;

      const countRows = await sql`SELECT COUNT(*)::int AS count FROM documents` as SharedRow[];
      if (Number(countRows[0]?.count ?? 0) === 0) {
        const now = new Date().toISOString();
        for (const file of readdirSync(KB_DIR).filter((name) => name.endsWith(".md")).sort()) {
          const content = readFileSync(path.join(KB_DIR, file), "utf8");
          const title = content.match(/^# (.+)$/m)?.[1]?.trim() ?? file;
          const prefix = file.split(/[-.]/)[0];
          const product = ["relay", "vault", "pulse", "ledger"].includes(prefix) ? prefix : null;
          await sql`
            INSERT INTO documents (id, file, title, product, content, status, updated_at)
            VALUES (${file}, ${file}, ${title}, ${product}, ${content}, 'published', ${now})
            ON CONFLICT (file) DO NOTHING
          `;
        }
      }
    })().catch((error) => {
      sharedDatabaseReady = null;
      throw error;
    });
  }
  await sharedDatabaseReady;
}

export async function listPublishedDocumentsAsync(): Promise<KnowledgeDocument[]> {
  if (!sharedSql) return listPublishedDocuments();
  await ensureSharedDatabase();
  const rows = await sharedSql`SELECT * FROM documents WHERE status = 'published' ORDER BY file` as SharedRow[];
  return rows.map(sharedDocumentFromRow);
}

export async function getKnowledgeBaseAsync(): Promise<KnowledgeBasePayload> {
  if (!sharedSql) return getKnowledgeBase();
  await ensureSharedDatabase();
  const [documentRows, reportRows] = await Promise.all([
    sharedSql`SELECT * FROM documents ORDER BY title` as Promise<SharedRow[]>,
    sharedSql`SELECT * FROM reports ORDER BY detected_at DESC` as Promise<SharedRow[]>,
  ]);
  const documents = documentRows.map(sharedDocumentFromRow);
  const reports = reportRows.map(sharedReportFromRow);
  const today = new Date().toISOString().slice(0, 10);
  const newIssuesToday = reports.filter((report) => report.detectedAt.startsWith(today) && report.status !== "resolved").length;
  return { documents, reports, stats: { documentCount: documents.length, publishedCount: documents.filter((document) => document.status === "published").length, newIssuesToday } };
}

async function sharedDocumentFileName(title: string): Promise<string> {
  const sql = sharedSql;
  if (!sql) return documentFileName(title);
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72) || "document";
  let file = `${base}.md`;
  let suffix = 2;
  while ((await sql`SELECT 1 FROM documents WHERE file = ${file}`).length > 0) file = `${base}-${suffix++}.md`;
  return file;
}

export async function createDocumentAsync(input: { title: string; product: string | null; content: string; status: KnowledgeDocumentStatus }): Promise<KnowledgeDocument | null> {
  if (!sharedSql) return createDocument(input);
  const title = input.title.trim();
  const content = input.content.trim();
  if (!title || !content || !["draft", "published"].includes(input.status)) return null;
  await ensureSharedDatabase();
  const id = crypto.randomUUID();
  const row = (await sharedSql`
    INSERT INTO documents (id, file, title, product, content, status, updated_at)
    VALUES (${id}, ${await sharedDocumentFileName(title)}, ${title}, ${input.product?.trim() || null}, ${content}, ${input.status}, ${new Date().toISOString()})
    RETURNING *
  `) as SharedRow[];
  return row[0] ? sharedDocumentFromRow(row[0]) : null;
}

export async function updateDocumentAsync(id: string, input: { title: string; product: string | null; content: string; status: KnowledgeDocumentStatus }): Promise<KnowledgeDocument | null> {
  if (!sharedSql) return updateDocument(id, input);
  const title = input.title.trim();
  const content = input.content.trim();
  if (!title || !content || !["draft", "published"].includes(input.status)) return null;
  await ensureSharedDatabase();
  const rows = await sharedSql`
    UPDATE documents SET title = ${title}, product = ${input.product?.trim() || null}, content = ${content}, status = ${input.status}, updated_at = ${new Date().toISOString()}
    WHERE id = ${id} RETURNING *
  ` as SharedRow[];
  return rows[0] ? sharedDocumentFromRow(rows[0]) : null;
}

export async function deleteDocumentAsync(id: string): Promise<boolean> {
  if (!sharedSql) return deleteDocument(id);
  await ensureSharedDatabase();
  const rows = await sharedSql`DELETE FROM documents WHERE id = ${id} RETURNING id` as SharedRow[];
  return rows.length > 0;
}

export async function createReportAsync(input: { title: string; product: string | null; severity: KnowledgeReportSeverity; category?: KnowledgeReportCategory; summary: string; question?: string | null; analysis?: string | null; sourceKey?: string }): Promise<KnowledgeReport | null> {
  if (!sharedSql) return createReport(input);
  const title = input.title.trim();
  const summary = input.summary.trim();
  if (!title || !summary || !["low", "medium", "high"].includes(input.severity)) return null;
  await ensureSharedDatabase();
  const rows = await sharedSql`
    INSERT INTO reports (id, title, product, severity, category, status, summary, question, analysis, detected_at, source_key)
    VALUES (${crypto.randomUUID()}, ${title}, ${input.product || null}, ${input.severity}, ${input.category ?? "manual"}, 'new', ${summary}, ${input.question?.trim() || null}, ${input.analysis?.trim() || null}, ${new Date().toISOString()}, ${input.sourceKey ?? null})
    ON CONFLICT (source_key) DO NOTHING
    RETURNING *
  ` as SharedRow[];
  if (rows[0]) return sharedReportFromRow(rows[0]);
  if (!input.sourceKey) return null;
  const existing = await sharedSql`SELECT * FROM reports WHERE source_key = ${input.sourceKey}` as SharedRow[];
  return existing[0] ? sharedReportFromRow(existing[0]) : null;
}

export async function createReadinessReportAsync(input: { runId: string; failedChecks: string[]; failedStages: string[] }): Promise<KnowledgeReport | null> {
  if (!sharedSql) return createReadinessReport(input);
  const runId = input.runId.trim();
  const failedChecks = [...new Set(input.failedChecks.map(safeEvidenceId).filter(Boolean))].slice(0, 40);
  const failedStages = [...new Set(input.failedStages.map(safeEvidenceId).filter(Boolean))].slice(0, 20);
  if (!runId || (failedChecks.length === 0 && failedStages.length === 0)) return null;
  const sourceKey = `readiness:${safeEvidenceId(runId)}`;
  const evidence = [...failedStages.map((stage) => `stage ${stage}`), ...failedChecks.map((check) => `check ${check}`)].join(", ");
  return createReportAsync({
    title: "Readiness test failed", product: null, severity: "high", category: "readiness",
    summary: `Live Readiness evidence reported ${evidence}. Review the Readiness test run ${safeEvidenceId(runId)}.`, sourceKey,
  });
}

export async function createQuestionReportAsync(input: { question: string; analysis: string; category: "knowledge-gap" | "irrelevant" }): Promise<KnowledgeReport | null> {
  if (!sharedSql) return createQuestionReport(input);
  const normalized = input.question.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 2000) return null;
  await ensureSharedDatabase();
  const analysis = input.analysis.trim().slice(0, 1000);
  const today = new Date().toISOString().slice(0, 10);
  const fingerprint = createHash("sha256").update(normalized.toLowerCase()).digest("hex").slice(0, 20);
  const sourceKey = `question:${input.category}:${today}:${fingerprint}`;
  const existing = await sharedSql`SELECT * FROM reports WHERE source_key = ${sourceKey}` as SharedRow[];
  if (existing[0]) {
    if (!existing[0].question || !existing[0].analysis) {
      await sharedSql`UPDATE reports SET question = COALESCE(question, ${normalized}), analysis = COALESCE(analysis, ${analysis || null}) WHERE source_key = ${sourceKey}`;
      const updated = await sharedSql`SELECT * FROM reports WHERE source_key = ${sourceKey}` as SharedRow[];
      return updated[0] ? sharedReportFromRow(updated[0]) : null;
    }
    return sharedReportFromRow(existing[0]);
  }
  return createReportAsync({
    title: input.category === "irrelevant" ? "Irrelevant question detected" : "Knowledge-base gap detected", product: null,
    severity: input.category === "irrelevant" ? "low" : "medium", category: input.category,
    summary: input.category === "irrelevant" ? "The question is outside the NimbusStack product knowledge-base scope. Keep it for review, but do not add it to the approved corpus unless the scope changes." : "A product-related question was not covered by the published knowledge base. Add or update an approved support or troubleshooting entry.",
    question: normalized, analysis, sourceKey,
  });
}

export async function createFindingReportAsync(input: {
  key: string; observedAt: string; category: "out_of_scope" | "documentation_gap" | "clarification_needed"; severity: "low" | "medium"; proposedAction: string; question?: string | null; analysis?: string | null; evidence: Record<string, unknown>;
}): Promise<KnowledgeReport | null> {
  if (!sharedSql) return createFindingReport(input);
  await ensureSharedDatabase();
  const sourceKey = `finding:${input.observedAt.slice(0, 10)}:${input.key}`;
  const existing = await sharedSql`SELECT * FROM reports WHERE source_key = ${sourceKey}` as SharedRow[];
  const label = input.category === "out_of_scope" ? "Irrelevant" : input.category === "clarification_needed" ? "Clarification needed" : "Knowledge gap";
  const summaryBase = `${label}: ${input.proposedAction}`;
  if (existing[0]) {
    const previous = String(existing[0].summary).match(/Observed (\d+) time/)?.[1];
    const occurrences = Number(previous ?? 1) + 1;
    const rows = await sharedSql`UPDATE reports SET summary = ${`${summaryBase} Observed ${occurrences} times today.`}, question = ${input.question?.trim() || null}, analysis = ${input.analysis?.trim() || JSON.stringify(input.evidence)}, detected_at = ${input.observedAt} WHERE source_key = ${sourceKey} RETURNING *` as SharedRow[];
    return rows[0] ? sharedReportFromRow(rows[0]) : null;
  }
  return createReportAsync({
    title: `${label} detected`, product: null, severity: input.severity,
    category: input.category === "out_of_scope" ? "irrelevant" : "knowledge-gap",
    summary: `${summaryBase} Observed 1 time today.`, question: input.question, analysis: input.analysis?.trim() || JSON.stringify(input.evidence), sourceKey,
  });
}

export async function updateReportAsync(id: string, input: { status: KnowledgeReportStatus; severity: KnowledgeReportSeverity; category: KnowledgeReportCategory; product: string | null }): Promise<KnowledgeReport | null> {
  if (!sharedSql) return updateReport(id, input);
  if (!["new", "investigating", "resolved"].includes(input.status)) return null;
  if (!["low", "medium", "high"].includes(input.severity)) return null;
  if (!["manual", "readiness", "knowledge-gap", "irrelevant"].includes(input.category)) return null;
  await ensureSharedDatabase();
  const rows = await sharedSql`UPDATE reports SET status = ${input.status}, severity = ${input.severity}, category = ${input.category}, product = ${input.product?.trim() || null} WHERE id = ${id} RETURNING *` as SharedRow[];
  return rows[0] ? sharedReportFromRow(rows[0]) : null;
}
