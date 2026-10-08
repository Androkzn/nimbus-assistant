import type { Env } from "../config/models";
import type { GuardReason, RetrievalResult } from "../retrieval/retrieve";

const DEFAULT_FINDINGS_FOLDER_ID = "1iVRPfxJB5lHc6TorqWnmC5IeW5kY_a0s";
const DEFAULT_API_BASE = "https://www.googleapis.com/drive/v3";
const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";

export type FindingCategory = "out_of_scope" | "documentation_gap" | "clarification_needed";

export interface FindingRecord {
  schemaVersion: 1;
  observedAt: string;
  requestId: string;
  category: FindingCategory;
  reason: GuardReason;
  key: string;
  affectedProducts: string[];
  affectedArea: "answerability";
  severity: "low" | "medium";
  status: "new";
  proposedAction: string;
  evidence: {
    retrievalBestScore: number;
    retrievalFocusScore: number;
    passageCount: number;
    modelOutcome: string;
    unverifiedFigureCount: number;
    troubleshootingStatus: string | null;
  };
}

export interface DailyFindingEntry {
  key: string;
  category: FindingCategory;
  reason: GuardReason;
  affectedProducts: string[];
  affectedArea: "answerability";
  severity: "low" | "medium";
  status: "new";
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  sampleRequestId: string;
  proposedAction: string;
  evidence: FindingRecord["evidence"];
}

export interface DailyFindingReport {
  schemaVersion: 1;
  reportDate: string;
  source: "nimbus-assistant-production" | "nimbus-assistant-dev";
  createdAt: string;
  updatedAt: string;
  totals: {
    observations: number;
    outOfScope: number;
    documentationGaps: number;
    clarificationNeeded: number;
  };
  findings: DailyFindingEntry[];
}

export type FindingSink = (record: FindingRecord, env: Env) => Promise<void>;

export function isFindingWriteEnabled(env: Env): boolean {
  return env.GOOGLE_DRIVE_FINDINGS_ENABLED === "1";
}

export function findingCategory(reason: GuardReason): FindingCategory {
  if (reason === "out_of_scope") return "out_of_scope";
  if (reason === "incomplete" || reason === "ambiguous_release") return "clarification_needed";
  return "documentation_gap";
}

function proposedAction(category: FindingCategory, reason: GuardReason): string {
  if (category === "out_of_scope") return "Track as an out-of-scope usage statistic; do not add unsupported content to the knowledge base.";
  if (category === "clarification_needed") return "Review the user journey and add clearer product/topic guidance; do not change the knowledge base until the intended scope is confirmed.";
  if (reason === "unsupported_troubleshooting_status") return "Review approved troubleshooting material for this HTTP status and add a grounded checklist if the product team confirms it.";
  if (reason === "unsupported_pricing_tier") return "Review the approved pricing terminology and add a documented tier only after product confirmation.";
  if (reason === "unsupported_priority") return "Review the approved support-priority matrix and document the missing priority only after confirmation.";
  return "Review the affected product/topic and add an approved knowledge-base section if the missing evidence is confirmed.";
}

function stableKey(retrieval: RetrievalResult, category: FindingCategory): string {
  const products = [...retrieval.products].sort().join(",") || "none";
  const status = retrieval.troubleshootingStatus ?? "none";
  return [category, retrieval.guardReason ?? "unknown", products, status].join("|");
}

export function buildFinding(input: {
  requestId: string;
  observedAt: string;
  retrieval: RetrievalResult;
  modelOutcome: string;
  unverifiedFigureCount: number;
}): FindingRecord | null {
  const reason = input.retrieval.guardReason;
  if (!reason) return null;
  const category = findingCategory(reason);
  return {
    schemaVersion: 1,
    observedAt: input.observedAt,
    requestId: input.requestId,
    category,
    reason,
    key: stableKey(input.retrieval, category),
    affectedProducts: [...input.retrieval.products].sort(),
    affectedArea: "answerability",
    severity: category === "documentation_gap" ? "medium" : "low",
    status: "new",
    proposedAction: proposedAction(category, reason),
    evidence: {
      retrievalBestScore: input.retrieval.retrievalBestScore,
      retrievalFocusScore: input.retrieval.retrievalFocusScore,
      passageCount: input.retrieval.passages.length,
      modelOutcome: input.modelOutcome,
      unverifiedFigureCount: input.unverifiedFigureCount,
      troubleshootingStatus: input.retrieval.troubleshootingStatus,
    },
  };
}

export function mergeFinding(report: DailyFindingReport | null, finding: FindingRecord, reportDate: string, source: DailyFindingReport["source"], now: string): DailyFindingReport {
  const next: DailyFindingReport = report ?? {
    schemaVersion: 1,
    reportDate,
    source,
    createdAt: now,
    updatedAt: now,
    totals: { observations: 0, outOfScope: 0, documentationGaps: 0, clarificationNeeded: 0 },
    findings: [],
  };
  const existing = next.findings.find((entry) => entry.key === finding.key);
  if (existing) {
    existing.occurrences += 1;
    existing.lastSeenAt = finding.observedAt;
    existing.sampleRequestId = finding.requestId;
    existing.evidence = finding.evidence;
  } else {
    next.findings.push({
      key: finding.key,
      category: finding.category,
      reason: finding.reason,
      affectedProducts: finding.affectedProducts,
      affectedArea: finding.affectedArea,
      severity: finding.severity,
      status: finding.status,
      occurrences: 1,
      firstSeenAt: finding.observedAt,
      lastSeenAt: finding.observedAt,
      sampleRequestId: finding.requestId,
      proposedAction: finding.proposedAction,
      evidence: finding.evidence,
    });
  }
  next.totals.observations += 1;
  if (finding.category === "out_of_scope") next.totals.outOfScope += 1;
  if (finding.category === "documentation_gap") next.totals.documentationGaps += 1;
  if (finding.category === "clarification_needed") next.totals.clarificationNeeded += 1;
  next.updatedAt = now;
  next.findings.sort((a, b) => `${a.category}:${a.key}`.localeCompare(`${b.category}:${b.key}`));
  return next;
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function authToken(env: Env): Promise<string> {
  const direct = env.GOOGLE_DRIVE_FINDINGS_ACCESS_TOKEN?.trim();
  if (direct) return direct;
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.value;
  const refreshToken = env.GOOGLE_DRIVE_FINDINGS_REFRESH_TOKEN?.trim();
  const clientId = (env.GOOGLE_DRIVE_FINDINGS_CLIENT_ID ?? env.GOOGLE_DRIVE_CLIENT_ID)?.trim();
  const clientSecret = (env.GOOGLE_DRIVE_FINDINGS_CLIENT_SECRET ?? env.GOOGLE_DRIVE_CLIENT_SECRET)?.trim();
  if (!refreshToken || !clientId || !clientSecret) throw new Error("Google Drive findings write is enabled but OAuth credentials are incomplete.");
  const response = await fetch(env.GOOGLE_DRIVE_TOKEN_URL ?? DEFAULT_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  if (!response.ok) throw new Error(`Google Drive token exchange failed (${response.status}).`);
  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("Google Drive token exchange returned no access token.");
  cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return body.access_token;
}

function driveUrl(env: Env, resource: string, params: Record<string, string> = {}, upload = false): string {
  const root = (env.GOOGLE_DRIVE_API_BASE_URL ?? DEFAULT_API_BASE).replace(/\/$/, "");
  const base = upload ? root.replace(/\/drive\/v3$/, "/upload/drive/v3") : root;
  const url = new URL(`${base}/${resource.replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

async function driveFetch(env: Env, token: string, resource: string, init: RequestInit = {}, params: Record<string, string> = {}, upload = false): Promise<Response> {
  const response = await fetch(driveUrl(env, resource, params, upload), {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 160).replace(/\s+/g, " ");
    throw new Error(`Google Drive API ${response.status}: ${detail}`);
  }
  return response;
}

async function readDailyReport(env: Env, token: string, fileName: string): Promise<{ id: string; report: DailyFindingReport } | null> {
  const folderId = env.GOOGLE_DRIVE_FINDINGS_FOLDER_ID ?? DEFAULT_FINDINGS_FOLDER_ID;
  const q = `'${folderId}' in parents and name = '${fileName.replace(/'/g, "\\'")}' and trashed = false`;
  const listed = await driveFetch(env, token, "files", {}, { q, pageSize: "10", fields: "files(id,name,mimeType)", spaces: "drive", includeItemsFromAllDrives: "true", supportsAllDrives: "true" });
  const file = ((await listed.json()) as { files?: Array<{ id: string; mimeType: string }> }).files?.find((item) => item.mimeType !== GOOGLE_FOLDER_MIME);
  if (!file) return null;
  const downloaded = await driveFetch(env, token, `files/${file.id}`, {}, { alt: "media" });
  const text = await downloaded.text();
  try {
    return { id: file.id, report: JSON.parse(text) as DailyFindingReport };
  } catch {
    throw new Error(`Daily findings file ${fileName} is not valid JSON.`);
  }
}

async function writeDailyReport(env: Env, token: string, fileName: string, existing: { id: string; report: DailyFindingReport } | null, report: DailyFindingReport): Promise<void> {
  const body = JSON.stringify(report, null, 2) + "\n";
  if (existing) {
    await driveFetch(env, token, `files/${existing.id}`, { method: "PATCH", body, headers: { "content-type": "application/json" } }, { uploadType: "media", fields: "id,name,webViewLink" }, true);
    return;
  }
  const boundary = `nimbus-findings-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name: fileName, parents: [env.GOOGLE_DRIVE_FINDINGS_FOLDER_ID ?? DEFAULT_FINDINGS_FOLDER_ID], mimeType: "application/json" });
  const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  await driveFetch(env, token, "files", { method: "POST", body: multipart, headers: { "content-type": `multipart/related; boundary=${boundary}` } }, { uploadType: "multipart", fields: "id,name,webViewLink", supportsAllDrives: "true" }, true);
}

export async function persistFinding(finding: FindingRecord, env: Env): Promise<void> {
  if (!isFindingWriteEnabled(env)) return;
  const token = await authToken(env);
  const reportDate = finding.observedAt.slice(0, 10);
  const fileName = `${reportDate}-findings.json`;
  const existing = await readDailyReport(env, token, fileName);
  const source = env.NODE_ENV === "production" ? "nimbus-assistant-production" : "nimbus-assistant-dev";
  const report = mergeFinding(existing?.report ?? null, finding, reportDate, source, new Date().toISOString());
  await writeDailyReport(env, token, fileName, existing, report);
}
