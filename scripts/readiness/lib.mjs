/**
 * Readiness runner helpers (docs/requirements/06_Readiness_Report.md §3–§4, isolation rules I4–I6).
 * Shared by scripts/readiness/run.mjs and the Vitest / Playwright reporters it plugs into.
 *
 * Event builders here are the only place runner events are shaped; lib.test.ts proves every one of them
 * parses with ReadinessEventSchema (src/readiness/schema.ts). This file is plain .mjs because the runner and
 * the reporters run under bare Node, so it cannot import the TypeScript contract at runtime.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

/** @typedef {import("../../src/readiness/schema").ReadinessEvent} ReadinessEvent */
/** @typedef {import("../../src/readiness/schema").TestResult} TestResult */
/** @typedef {import("../../src/readiness/schema").RunMeta} RunMeta */
/** @typedef {import("../../src/readiness/schema").StageId} StageId */
/** @typedef {import("../../src/readiness/schema").Status} Status */
/** @typedef {import("../../src/readiness/schema").Counts} Counts */

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── Isolation constants (I4, I5) ──────────────────────────────────────────────────────────────────
/** Build output of a readiness run; `.next/` belongs to whatever server is already running. */
export const DIST_DIR = ".next-readiness";
export const E2E_PORT = 3199;
/** Ports from E2E_PORT a run may use when another checkout's run, or a server one left behind, holds E2E_PORT. */
export const E2E_PORT_SPAN = 100;

/**
 * Verbatim copy of READINESS_TOOLING_PATHS (src/readiness/manifest.ts); lib.test.ts proves they match. A run
 * verifies the product only, so the report's own tests stay out of it; they run in CI.
 */
export const READINESS_TOOLING_PATHS = ["src/readiness/", "src/components/readiness/", "src/app/readiness/", "src/app/api/readiness/", "scripts/readiness/", "e2e/readiness"];

/** Product E2E spec files: everything under e2e/ except the report's own. @param {string} root */
export function productE2eFiles(root) {
  return readdirSync(path.join(root, "e2e"))
    .filter((f) => /\.(spec|test)\.ts$/.test(f))
    .map((f) => `e2e/${f}`)
    .filter((file) => !READINESS_TOOLING_PATHS.some((prefix) => file.startsWith(prefix)))
    .sort();
}
/** Must equal RUN_LOCK_FILE in src/readiness/runner-gate.ts (the route reads it; lib.test.ts checks). */
export const LOCK_FILE = "readiness/.run.lock";
/** A lock older than this is stale even if its pid is alive again (pid reuse). Same value in runner-gate.ts. */
export const LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;
export const REPORTS_DIR = "readiness/reports";
/** Per-run scratch: raw stage logs, Playwright HTML report and test-results. Git-ignored, pruned to the last few runs. */
export const TMP_DIR = "readiness/tmp";
export const PUBLISH_PATH = "public/readiness/latest.ndjson";
/**
 * Files Next rewrites when it type-generates or builds into a custom distDir. Found empirically by hashing
 * the whole tree before and after `NEXT_DIST_DIR=.next-readiness next build`: only these two change
 * (tsconfig.json gains `.next-readiness/**` includes and is re-formatted; next-env.d.ts re-points its imports).
 */
export const REWRITTEN_FILES = ["tsconfig.json", "next-env.d.ts"];

export const ERROR_MAX = 500;
export const LOG_MAX = 300;
/** Joins describe chain + title (spec §4). */
export const NAME_SEP = " › ";

// ── Stages ────────────────────────────────────────────────────────────────────────────────────────
/** Stages the runner owns, in run order. "probes" is run by the page itself, against a live server. */
export const RUNNER_STAGE_IDS = /** @type {const} */ (["typecheck", "lint", "unit", "build", "bundle-scan", "e2e", "live-eval"]);

/** Verbatim copy of STAGE_INFO (src/readiness/schema.ts) for the runner stages; lib.test.ts proves they match. */
export const STAGE_INFO = {
  typecheck: {
    id: "typecheck",
    title: "Typecheck",
    command: "npm run typecheck",
    layer: "static",
    description: "TypeScript strict across server, browser and the shared wire contract, with route types generated first as on a fresh clone.",
  },
  lint: { id: "lint", title: "Lint", command: "npm run lint", layer: "static", description: "ESLint with the React hooks and purity rules." },
  unit: {
    id: "unit",
    title: "Unit · integration · retrieval eval",
    command: "npm test",
    layer: "unit",
    description: "Vitest: pure logic, the /api/chat handler driven by mock models, the wire contract, and the offline retrieval eval.",
  },
  build: { id: "build", title: "Production build", command: "next build", layer: "static", description: "The app compiles for production exactly as it is deployed." },
  "bundle-scan": {
    id: "bundle-scan",
    title: "Client bundle secret scan",
    command: "npm run scan:bundle",
    layer: "security",
    description: "Every JavaScript file a browser can download is scanned for API-key patterns and for the real key values.",
  },
  e2e: {
    id: "e2e",
    title: "Browser E2E",
    command: "npm run e2e",
    layer: "e2e",
    description: "Playwright drives the production build with the deterministic mock model: streaming, sources, fallback, usage, export.",
  },
  "live-eval": {
    id: "live-eval",
    title: "Live answer eval",
    command: "npm run eval:live",
    layer: "live-eval",
    description: "Golden questions answered by the real providers and graded by deterministic checks. Runs live against this build when 'Include live answers' is ticked (off by default), so it spends real tokens.",
  },
};

/**
 * Parse `--stages a,b` into run order. Unknown ids throw (a typo must not silently skip a gate).
 * @param {string | undefined} list
 * @returns {StageId[]}
 */
export function selectStages(list) {
  if (!list) return [...RUNNER_STAGE_IDS];
  const wanted = list.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((s) => !RUNNER_STAGE_IDS.includes(/** @type {any} */ (s)));
  if (unknown.length) throw new Error(`unknown stage(s): ${unknown.join(", ")} — valid: ${RUNNER_STAGE_IDS.join(", ")}`);
  return RUNNER_STAGE_IDS.filter((s) => wanted.includes(s));
}

// ── Redaction (I6) ────────────────────────────────────────────────────────────────────────────────
// Same key shapes as redactSecrets (src/server/observability/report.ts): sk-… (Anthropic/OpenAI), AIza… (Google),
// sntrys_… (Sentry auth token). Plus JWTs — e.g. VERCEL_OIDC_TOKEN, which `vercel env pull` writes to .env.local.
const KEY_SHAPE = /\b(sk-[A-Za-z0-9_*.-]{6,}|AIza[0-9A-Za-z_*.-]{6,}|sntrys_[A-Za-z0-9_*.-]{6,})/g;
const JWT_SHAPE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
/** Env var names whose values are treated as secrets: redacted literally from output, withheld from offline gates. */
export const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|DSN/i;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

/**
 * Literal values of secret-named env vars (longest first, so a value containing another is replaced whole).
 * @param {Record<string, string | undefined>} env
 */
export function secretValues(env) {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && typeof value === "string" && value.trim().length >= 8)
    .map(([, value]) => /** @type {string} */ (value).trim())
    .sort((a, b) => b.length - a.length);
}

/** @type {string[] | undefined} */
let processSecrets;
const defaultSecrets = () => (processSecrets ??= secretValues(process.env));

/**
 * Also redact these values from now on (secrets the runner loaded itself, e.g. from .env files).
 * @param {string[]} values
 */
export function addSecrets(values) {
  processSecrets = [...new Set([...defaultSecrets(), ...values])].sort((a, b) => b.length - a.length);
}

/** @param {string} text */
export const stripAnsi = (text) => text.replace(ANSI, "");

/**
 * Strip ANSI, make local paths repo-relative (no home directory in published events), and redact key-shaped
 * strings and the literal values of secret env vars.
 * @param {unknown} text
 * @param {string[]} [secrets]
 */
export function redact(text, secrets = defaultSecrets()) {
  let out = stripAnsi(String(text ?? ""));
  out = out.split(`${ROOT}${path.sep}`).join("").split(ROOT).join(".");
  const home = os.homedir();
  if (home && home.length > 1) out = out.split(home).join("~");
  for (const value of secrets) out = out.split(value).join("[redacted-env]");
  return out.replace(KEY_SHAPE, "[redacted-key]").replace(JWT_SHAPE, "[redacted-token]");
}

/**
 * Cap a string at `max` chars with an ellipsis; `keep: "tail"` keeps the end (the last lines of a tool's output).
 * @param {string} text
 * @param {number} max
 * @param {"head" | "tail"} [keep]
 */
export function cap(text, max, keep = "head") {
  if (text.length <= max) return text;
  return keep === "head" ? `${text.slice(0, max - 1).trimEnd()}…` : `…${text.slice(text.length - (max - 1)).trimStart()}`;
}

/**
 * A test failure, safe to publish: redacted, ≤ 500 chars, and without the parts of assertion output that echo
 * what the app rendered ("Received: …" lines, Playwright's call log) — those can carry answer text (I6).
 * @param {unknown} text
 * @param {{ max?: number, secrets?: string[] }} [opts]
 */
export function sanitizeError(text, { max = ERROR_MAX, secrets } = {}) {
  const lines = redact(text, secrets).split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    if (/^\s*Call log:/.test(line)) break;
    if (/^\s*[-+]?\s*Received\b/i.test(line)) continue;
    kept.push(line.trimEnd());
  }
  const joined = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return cap(joined, max);
}

/**
 * A log line for a `log` event: one line, redacted, ≤ 300 chars.
 * @param {unknown} text
 */
export const logLine = (text) => cap(redact(text).replace(/\s*\r?\n\s*/g, " ").trim(), LOG_MAX);

const ERROR_LINE = /\berror\b|\bfailed\b|failure|✗|✖|×|❌|cannot find|not found|unexpected|exception/i;
const NOISE_LINE = /^(npm (error|ERR!|warn)|> |\s*at\s)/;
const ESLINT_PROBLEM = /^\s+(\d+:\d+)\s+(error|warning)\s+(.*)$/;
const LIST_ITEM = /^\s*[-•*]\s+\S/;
const FILE_HEADER = /^(\.?[\w@~.-]+\/)*[\w.@-]+\.(c|m)?[jt]sx?$/;

/**
 * The last relevant error lines of a failed gate (tsc, ESLint, next build, the bundle scan), ≤ 500 chars.
 * ESLint prints the file on its own line above its problems; it is folded into each problem line. A list under an
 * error line (the bundle scan's "- file: pattern" hits) is kept with it.
 * @param {string} output
 * @param {string[]} [secrets]
 */
export function gateError(output, secrets) {
  const lines = redact(output, secrets)
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !NOISE_LINE.test(l));
  const relevant = [];
  let file = "";
  let inErrorList = false;
  for (const line of lines) {
    if (FILE_HEADER.test(line.trim())) {
      file = line.trim();
      continue;
    }
    const problem = ESLINT_PROBLEM.exec(line);
    if (problem) {
      if (problem[2] === "error") relevant.push(`${file}:${problem[1]} ${problem[3].replace(/\s{2,}/g, "  ")}`);
      continue;
    }
    if (ERROR_LINE.test(line)) {
      relevant.push(line.trim());
      inErrorList = true;
    } else if (inErrorList && LIST_ITEM.test(line)) {
      relevant.push(`  ${line.trim()}`);
    } else {
      inErrorList = false;
    }
  }
  const picked = (relevant.length ? relevant : lines.map((l) => l.trim())).slice(-8);
  return cap(picked.join("\n"), ERROR_MAX, "tail") || "exited with a non-zero status (no output)";
}

/**
 * ESLint's summary line, e.g. "✖ 3 problems (0 errors, 3 warnings)" → { errors: 0, warnings: 3 }.
 * @param {string} output
 */
export function eslintCounts(output) {
  const m = /(\d+) errors?, (\d+) warnings?/.exec(stripAnsi(output));
  return m ? { errors: Number(m[1]), warnings: Number(m[2]) } : { errors: 0, warnings: 0 };
}

// ── Result identity (spec §4 id table) ────────────────────────────────────────────────────────────
/** @param {string} file @param {string} fullName */
export const resultId = (file, fullName) => `${file}::${fullName}`;

/**
 * Repo-relative POSIX path.
 * @param {string} root
 * @param {string} file
 */
export const repoPath = (root, file) => path.relative(root, file).split(path.sep).join("/");

/**
 * Vitest TestCase → { id, file, fullName }. Walks the parent chain itself rather than using
 * `testCase.fullName`, which joins with ">" — a character test titles may contain.
 * @param {{ name: string, type?: string, parent?: any, module: { moduleId: string } }} testCase
 * @param {string} root
 */
export function vitestIdentity(testCase, root) {
  const titles = [];
  for (let node = /** @type {any} */ (testCase); node && node.type !== "module"; node = node.parent) titles.unshift(node.name);
  const file = repoPath(root, testCase.module.moduleId);
  const fullName = titles.join(NAME_SEP);
  return { id: resultId(file, fullName), file, fullName };
}

/**
 * Playwright TestCase → { id, file, fullName }: describe chain + title, without the root, project and file suites.
 * @param {{ title: string, parent?: any, location: { file: string } }} test
 * @param {string} root
 */
export function playwrightIdentity(test, root) {
  const titles = [test.title];
  for (let suite = test.parent; suite && suite.type === "describe"; suite = suite.parent) titles.unshift(suite.title);
  const file = repoPath(root, test.location.file);
  const fullName = titles.join(NAME_SEP);
  return { id: resultId(file, fullName), file, fullName };
}

/**
 * Gate stages report one result each (spec §4): id `gate::<stage>`, file = the command, fullName = stage title.
 * @param {StageId} stage
 * @param {string} command
 */
export const gateIdentity = (stage, command) => ({ id: `gate::${stage}`, file: command, fullName: STAGE_INFO[/** @type {keyof typeof STAGE_INFO} */ (stage)].title });

// ── Event builders ────────────────────────────────────────────────────────────────────────────────
const iso = () => new Date().toISOString();
const ms = (n) => Math.max(0, Math.round(Number.isFinite(n) ? n : 0));

/**
 * Keep only values the schema's detail record accepts (string | number | boolean); drop null/undefined.
 * @param {Record<string, unknown> | undefined} detail
 */
function compactDetail(detail) {
  if (!detail) return undefined;
  /** @type {Record<string, string | number | boolean>} */
  const out = {};
  for (const [k, v] of Object.entries(detail)) {
    if (typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) out[k] = typeof v === "string" ? cap(redact(v), LOG_MAX) : v;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * @param {RunMeta} meta
 * @param {readonly StageId[]} stages
 * @returns {ReadinessEvent}
 */
export const runStartEvent = (meta, stages) => ({ type: "run-start", meta, stages: stages.map((id) => STAGE_INFO[/** @type {keyof typeof STAGE_INFO} */ (id)]) });

/** @param {StageId} stage @returns {ReadinessEvent} */
export const stageStartEvent = (stage) => ({ type: "stage-start", stage, at: iso() });

/** @param {StageId} stage @param {number} total results the stage expects @returns {ReadinessEvent} */
export const stageTotalEvent = (stage, total) => ({ type: "stage-total", stage, total });

/**
 * @param {StageId} stage
 * @param {{ id: string, file: string, fullName: string }} identity
 * @returns {ReadinessEvent}
 */
export const testStartEvent = (stage, { id, file, fullName }) => ({ type: "test-start", stage, id, file, fullName });

/**
 * @param {{ stage: StageId, id: string, file: string, fullName: string, status: "passed" | "failed" | "skipped",
 *   durationMs?: number, source?: "live" | "recorded", error?: unknown, detail?: Record<string, unknown> }} r
 * @returns {ReadinessEvent}
 */
export function testResultEvent({ stage, id, file, fullName, status, durationMs, source = "live", error, detail }) {
  /** @type {TestResult} */
  const result = { id, stage, file, fullName, status, durationMs: ms(durationMs ?? 0), source };
  const message = error == null || error === "" ? "" : sanitizeError(error);
  if (message) result.error = message;
  const d = compactDetail(detail);
  if (d) result.detail = d;
  return { type: "test-result", result };
}

/** @param {StageId} stage @param {unknown} line @returns {ReadinessEvent} */
export const logEvent = (stage, line) => ({ type: "log", stage, line: logLine(line) });

/**
 * @param {StageId} stage
 * @param {{ status: Status, durationMs: number, counts: Counts, source?: "live" | "recorded", note?: string }} s
 * @returns {ReadinessEvent}
 */
export function stageEndEvent(stage, { status, durationMs, counts, source = "live", note }) {
  /** @type {ReadinessEvent} */
  const event = { type: "stage-end", stage, status, durationMs: ms(durationMs), counts, source, at: iso() };
  if (note) event.note = cap(redact(note), ERROR_MAX);
  return event;
}

/** @param {"passed" | "failed"} status @param {number} durationMs @returns {ReadinessEvent} */
export const runEndEvent = (status, durationMs) => ({ type: "run-end", status, durationMs: ms(durationMs), at: iso() });

/** @returns {Counts} */
export const emptyCounts = () => ({ passed: 0, failed: 0, skipped: 0 });

// ── Wire protocol between reporters and the runner ─────────────────────────────────────────────────
// Reporters print each event on the child's stdout behind a per-run tag, so ordinary console output from tests
// or tools can never be mistaken for (or corrupt) an event. The runner passes the tag in READINESS_EVENT_TAG.
export const EVENT_TAG_ENV = "READINESS_EVENT_TAG";
const DEFAULT_TAG = "@@readiness-event@@";

/** @param {Record<string, string | undefined>} [env] */
export const eventTag = (env = process.env) => env[EVENT_TAG_ENV] || DEFAULT_TAG;
export const newEventTag = () => `@@readiness-${createHash("sha256").update(`${process.pid}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 12)}@@`;

/** @param {ReadinessEvent} event @param {string} tag */
export const encodeTagged = (event, tag) => `${tag}${JSON.stringify(event)}\n`;

/**
 * The event carried by one output line, or null. Searches anywhere in the line: a tool that left a partial line
 * unterminated must not hide the event that follows it.
 * @param {string} line
 * @param {string} tag
 * @returns {ReadinessEvent | null}
 */
export function decodeTagged(line, tag) {
  const at = line.indexOf(tag);
  if (at < 0) return null;
  try {
    return JSON.parse(line.slice(at + tag.length));
  } catch {
    return null;
  }
}

const SLEEP = new Int32Array(new SharedArrayBuffer(4));

/**
 * Write all of `text` to `fd` synchronously, so an event is on the pipe before the tool can exit. On macOS a
 * piped stdout is non-blocking: a full pipe throws EAGAIN, so wait a moment and retry the rest.
 * @param {number} fd
 * @param {string} text
 */
export function writeAllSync(fd, text) {
  let buf = Buffer.from(text);
  while (buf.length) {
    try {
      buf = buf.subarray(writeSync(fd, buf));
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EAGAIN") throw err;
      Atomics.wait(SLEEP, 0, 0, 2);
    }
  }
}

/**
 * Writer used by the reporters (tests inject their own `write`).
 * @param {(chunk: string) => void} [write]
 */
export function taggedEmitter(write = (chunk) => writeAllSync(1, chunk)) {
  const tag = eventTag();
  /** @param {ReadinessEvent} event */
  return (event) => write(encodeTagged(event, tag));
}

// ── Recorded live eval (I7: source "recorded", labelled with date and build) ──────────────────────
/** A report is complete when at least this many models each answered every golden case (per-vendor checks need it). */
export const MIN_COMPLETE_MODELS = 2;

/**
 * @typedef {{ complete: boolean, casesCovered: number, casesTotal: number, models: string[], fullModels: string[], graded: number }} EvalCoverage
 */

/**
 * How much of the current golden set one eval report covers.
 * @param {any} report parsed results.json
 * @param {string[]} caseIds case ids of the current evals/golden-set.json
 * @returns {EvalCoverage}
 */
export function evalCoverage(report, caseIds) {
  const rows = Array.isArray(report?.results) ? report.results : [];
  /** @type {Map<string, Set<string>>} */
  const byModel = new Map();
  for (const r of rows) byModel.set(r.model, (byModel.get(r.model) ?? new Set()).add(r.caseId));
  const fullModels = [...byModel].filter(([, cases]) => caseIds.every((id) => cases.has(id))).map(([model]) => model);
  const casesCovered = new Set(rows.map((/** @type {any} */ r) => r.caseId).filter((id) => caseIds.includes(id))).size;
  return {
    complete: caseIds.length > 0 && fullModels.length >= MIN_COMPLETE_MODELS,
    casesCovered,
    casesTotal: caseIds.length,
    models: [...byModel.keys()],
    fullModels,
    graded: rows.length,
  };
}

/**
 * The report the live-eval stage shows: the newest COMPLETE one (every current golden case, for at least two
 * models). A newer partial run — one model, a few cases — must not hide the evidence of the last full one. If none
 * is complete: the one with the most graded answers (newest on a tie), labelled partial by recordedEval.
 * @template {{ path: string, json: any }} R
 * @param {R[]} reports oldest first
 * @param {string[]} caseIds
 * @returns {(R & { coverage: EvalCoverage }) | null}
 */
export function chooseEvalReport(reports, caseIds) {
  const scored = reports.map((report) => ({ ...report, coverage: evalCoverage(report.json, caseIds) }));
  const complete = scored.filter((r) => r.coverage.complete).at(-1);
  if (complete) return complete;
  /** @type {(R & { coverage: EvalCoverage }) | null} */
  let best = null;
  for (const r of scored) if (!best || r.coverage.graded >= best.coverage.graded) best = r;
  return best;
}

/**
 * The committed live-eval report to show (see chooseEvalReport), or null when there is none.
 * @param {string} root
 */
export function latestEvalReport(root) {
  const dir = path.join(root, "evals", "reports");
  if (!existsSync(dir)) return null;
  const reports = readdirSync(dir)
    .sort() // stamps sort chronologically
    .map((stamp) => `evals/reports/${stamp}/results.json`)
    .filter((rel) => existsSync(path.join(root, rel)))
    .flatMap((rel) => {
      try {
        return [{ path: rel, json: JSON.parse(readFileSync(path.join(root, rel), "utf8")) }];
      } catch {
        return []; // a report being written right now, or a broken file: not evidence
      }
    });
  return chooseEvalReport(reports, goldenCaseIds(root));
}

/**
 * The current golden-set case ids; empty when there is no golden set, so no report can be complete.
 * @param {string} root
 * @returns {string[]}
 */
export function goldenCaseIds(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, "evals", "golden-set.json"), "utf8")).cases.map((/** @type {any} */ c) => c.id);
  } catch {
    return [];
  }
}

/**
 * Verdict → status. "fallback" means a backup model answered, so the model under evaluation was not evaluated:
 * skipped (with a note), never passed — the per-vendor checks rely on these results.
 */
const VERDICT_STATUS = /** @type {const} */ ({ pass: "passed", fallback: "skipped", fail: "failed" });

/**
 * A grading reason, safe to publish. "figures not in sources: 59, 12" lists numbers from the answer itself
 * (answer content — see reportUnverifiedFigures), so only the count is kept.
 * @param {string} reason
 */
const publishableReason = (reason) => reason.replace(/^figures not in sources: (.*)$/, (_, list) => `figures not in sources (${String(list).split(",").length})`);

/** "2026-10-07T21:16:33.164Z" → "2026-10-07 21:16 UTC" */
const utcMinute = (isoString) => `${String(isoString).slice(0, 10)} ${String(isoString).slice(11, 16)} UTC`;

/**
 * One graded eval-live answer (a results.json row) as a readiness result. The answer text is never carried over.
 * @param {any} r
 * @param {{ reportPath: string, environment?: string, source?: "live" | "recorded" }} o
 */
export function evalResultEvent(r, { reportPath, environment, source = "live" }) {
  const status = VERDICT_STATUS[/** @type {keyof typeof VERDICT_STATUS} */ (r.verdict)] ?? "failed";
  const reasons = Array.isArray(r.failed) ? r.failed.map((f) => publishableReason(String(f))) : [];
  if (!(r.verdict in VERDICT_STATUS)) reasons.unshift(`unknown verdict "${r.verdict}"`);
  return testResultEvent({
    stage: "live-eval",
    id: `eval::${r.caseId}::${r.model}`,
    file: reportPath,
    fullName: `${r.caseId} — ${r.question}`,
    status,
    durationMs: r.totalMs,
    source,
    error: status === "failed" ? reasons.join("; ") : undefined,
    detail: {
      model: r.model,
      brief: r.brief,
      ttftMs: r.ttftMs,
      inputTokens: r.usage?.inputTokens,
      outputTokens: r.usage?.outputTokens,
      costUSD: r.costUSD,
      reportPath,
      environment,
      verdict: r.verdict === "pass" ? undefined : r.verdict,
      answeredBy: r.answeredBy && r.answeredBy !== r.model ? r.answeredBy : undefined,
      note: r.verdict === "fallback" ? `answered by ${r.answeredBy ?? "a backup"}, so ${r.model} was not evaluated on this case` : undefined,
      warnings: Array.isArray(r.warnings) && r.warnings.length ? r.warnings.length : undefined,
    },
  });
}

/** "30 cases × 3 models", or the partial coverage; empty without a coverage. @param {EvalCoverage} [coverage] */
export function evalScope(coverage) {
  if (!coverage) return [];
  return coverage.complete
    ? [`${coverage.casesTotal} cases × ${coverage.fullModels.length} models`]
    : [`partial: ${coverage.casesCovered}/${coverage.casesTotal} cases, ${coverage.models.length} model${coverage.models.length === 1 ? "" : "s"}`];
}

/**
 * Events for a committed eval-live results.json: one result per case × model, never relabelled as live (I7).
 * The stage note carries the recording date, build and environment, and the report's golden-set coverage.
 * @param {any} report parsed results.json
 * @param {string} reportPath repo-relative path of that file
 * @param {EvalCoverage} [coverage] from evalCoverage / chooseEvalReport
 */
export function recordedEval(report, reportPath, coverage) {
  const meta = report?.meta ?? {};
  const rows = Array.isArray(report?.results) ? report.results : [];
  const counts = emptyCounts();
  let durationMs = 0;
  /** @type {ReadinessEvent[]} */
  const events = rows.map((/** @type {any} */ r) => {
    const event = evalResultEvent(r, { reportPath, environment: meta.environment, source: "recorded" });
    counts[event.result.status] += 1;
    durationMs += ms(r.totalMs ?? 0);
    return event;
  });
  const note = [`recorded ${utcMinute(meta.startedAt)}`, `build ${meta.build ?? "unknown"}`, meta.environment ?? "unknown environment", ...evalScope(coverage)].join(" · ");
  const status = /** @type {Status} */ (counts.failed ? "failed" : counts.passed ? "passed" : "skipped");
  return { events, counts, durationMs, note, status };
}

// ── Run metadata ──────────────────────────────────────────────────────────────────────────────────
/** "2026-10-07-21-30-00" (UTC), the same stamp format as evals/reports. */
export const newRunId = (date = new Date()) => date.toISOString().replace(/[:T]/g, "-").slice(0, 19);

/** Exactly eval-live's corpusHash, so a run and a live-eval report can be matched to the same corpus. */
export function corpusHash(root) {
  const kb = path.join(root, "knowledge-base");
  return createHash("sha256")
    .update(readdirSync(kb).sort().map((f) => readFileSync(path.join(kb, f), "utf8")).join("\n"))
    .digest("hex")
    .slice(0, 10);
}

/** Exactly eval-live's promptHash. */
export const promptHash = (root) => createHash("sha256").update(readFileSync(path.join(root, "src/server/prompt/build.ts"), "utf8")).digest("hex").slice(0, 10);

/** @param {string} root @param {string[]} args */
function git(root, args) {
  try {
    return execFileSync("git", ["--no-optional-locks", ...args], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

/** Git short SHA with "+dirty" when the working tree has changes, and the branch. Read-only git calls. */
export function gitInfo(root) {
  const sha = git(root, ["rev-parse", "--short", "HEAD"]);
  if (!sha) return { build: "local" };
  const dirty = Boolean(git(root, ["status", "--porcelain"]));
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? undefined;
  return { build: `${sha}${dirty ? "+dirty" : ""}`, branch };
}

export const platformLabel = () => `node ${process.version} · ${process.platform} ${process.arch}`;

/**
 * @param {{ root: string, runId: string, startedAt: string }} o
 * @returns {RunMeta}
 */
export function runMeta({ root, runId, startedAt }) {
  const readJson = (rel) => {
    try {
      return JSON.parse(readFileSync(path.join(root, rel), "utf8"));
    } catch {
      return {};
    }
  };
  const { build, branch } = gitInfo(root);
  /** @type {RunMeta} */
  const meta = { runId, mode: "local", startedAt, platform: platformLabel(), environment: "local working tree", build };
  if (branch) meta.branch = branch;
  const golden = readJson("evals/golden-set.json").version;
  const pricing = readJson("config/models.json").pricingVersion;
  if (golden) meta.goldenVersion = String(golden);
  if (pricing) meta.pricingVersion = String(pricing);
  meta.corpusHash = corpusHash(root);
  meta.promptHash = promptHash(root);
  return meta;
}

// ── Child environment ─────────────────────────────────────────────────────────────────────────────
// Set by a `next dev` parent; leaking them changes how child builds/tests behave (e.g. __NEXT_PROCESSED_ENV makes
// `next build` skip loading .env files, NODE_ENV=development breaks a production build).
const PARENT_ONLY = /^(NODE_ENV|NEXT_RUNTIME|__NEXT.*|NEXT_PRIVATE.*|__NEXT_PRIVATE.*|TURBOPACK.*)$/;

/**
 * Environment for a gate's child process.
 * `offline`: also withhold secret-named vars (provider keys, tokens, DSN), so typecheck, lint and unit tests run
 * with what CI has — and a unit test can never reach a real provider and spend tokens.
 * @param {Record<string, string | undefined>} env
 * @param {{ offline?: boolean, extra?: Record<string, string> }} [opts]
 * @returns {Record<string, string>}
 */
export function childEnv(env, { offline = false, extra = {} } = {}) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || PARENT_ONLY.test(name)) continue;
    if (offline && SECRET_NAME.test(name)) continue;
    out[name] = value;
  }
  return { ...out, ...extra };
}

/** The .env files `next build` loads, highest precedence first (Next's production order). */
export const PRODUCTION_ENV_FILES = [".env.production.local", ".env.local", ".env.production", ".env"];

/**
 * `env` plus the variables of the .env files a production build loads; `env` wins, as in Next. Gives the bundle
 * scan the real key values from a terminal run too, not only when a `next dev` parent has already loaded them.
 * @param {string} root
 * @param {Record<string, string>} env
 * @returns {{ env: Record<string, string>, files: string[] }}
 */
export function withEnvFiles(root, env) {
  /** @type {Record<string, string>} */
  const fromFiles = {};
  const files = PRODUCTION_ENV_FILES.filter((file) => existsSync(path.join(root, file)));
  for (const file of [...files].reverse()) Object.assign(fromFiles, parseEnv(readFileSync(path.join(root, file), "utf8")));
  return { env: { ...fromFiles, ...env }, files };
}

// ── Isolation: snapshot / restore, .next/BUILD_ID, port check ─────────────────────────────────────
/**
 * @param {string} root
 * @param {string[]} [files]
 * @returns {Record<string, string | null>} base64 contents (null = file did not exist)
 */
export function snapshotFiles(root, files = REWRITTEN_FILES) {
  return Object.fromEntries(files.map((rel) => [rel, existsSync(path.join(root, rel)) ? readFileSync(path.join(root, rel)).toString("base64") : null]));
}

/**
 * Put every snapshotted file back byte-for-byte; only touches files that differ. Returns the files it restored.
 * @param {string} root
 * @param {Record<string, string | null>} snapshot
 * @param {(rel: string, current: Buffer) => boolean} [shouldRestore] extra guard (used by stale-lock recovery)
 */
export function restoreFiles(root, snapshot, shouldRestore = () => true) {
  const restored = [];
  for (const [rel, base64] of Object.entries(snapshot)) {
    const abs = path.join(root, rel);
    const exists = existsSync(abs);
    const current = exists ? readFileSync(abs) : null;
    if (base64 === null) {
      if (current && shouldRestore(rel, current)) {
        unlinkSync(abs);
        restored.push(rel);
      }
      continue;
    }
    const original = Buffer.from(base64, "base64");
    if (current && current.equals(original)) continue;
    if (current && !shouldRestore(rel, current)) continue;
    writeFileSync(abs, original);
    restored.push(rel);
  }
  return restored;
}

/** @param {string} root @param {string} [distDir] */
export function readBuildId(root, distDir = ".next") {
  try {
    return readFileSync(path.join(root, distDir, "BUILD_ID"), "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * True when something already answers on the port (or holds it). Playwright's reuseExistingServer would
 * otherwise silently test that server instead of the build under test.
 * @param {number} port
 */
export async function portInUse(port) {
  const connects = (host) =>
    new Promise((resolve) => {
      const socket = net.connect({ port, host });
      const done = (inUse) => {
        socket.destroy();
        resolve(inUse);
      };
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.setTimeout(750, () => done(false));
    });
  const bindFails = () =>
    new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", (err) => resolve(/** @type {NodeJS.ErrnoException} */ (err).code === "EADDRINUSE"));
      server.listen(port, () => server.close(() => resolve(false)));
    });
  const [v4, v6] = await Promise.all([connects("127.0.0.1"), connects("::1")]);
  return v4 || v6 || (await bindFails());
}

/**
 * First port from `start` that nothing holds, or null when all `span` ports are held. A held port is skipped,
 * never reused, so a busy E2E_PORT no longer blocks the run.
 * @param {number} start
 * @param {number} [span]
 */
export async function freePort(start, span = E2E_PORT_SPAN) {
  for (let port = start; port < start + span; port += 1) if (!(await portInUse(port))) return port;
  return null;
}

// ── Run lock (I5) ─────────────────────────────────────────────────────────────────────────────────
/** @param {number} pid */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === "EPERM";
  }
}

/**
 * @typedef {{ pid: number, runId: string, startedAt: string, snapshot?: Record<string, string | null> }} LockInfo
 * @typedef {{ ok: true, recovered: string[], saveSnapshot: (s: Record<string, string | null>) => void, release: () => void }
 *   | { ok: false, holder: LockInfo }} LockResult
 */

/**
 * Take the one-run-at-a-time lock. A lock whose pid is gone (or that is older than LOCK_MAX_AGE_MS) is stale:
 * its run was killed before its cleanup ran, so the files it snapshotted are restored first — but only files
 * that still carry the readiness dist dir, so a later deliberate edit is never overwritten.
 * @param {string} root
 * @param {{ runId: string, now?: number, alive?: (pid: number) => boolean }} o
 * @returns {LockResult}
 */
export function acquireLock(root, { runId, now = Date.now(), alive = isAlive }) {
  const file = path.join(root, LOCK_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  /** @type {LockInfo} */
  const info = { pid: process.pid, runId, startedAt: new Date(now).toISOString() };
  const recovered = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, JSON.stringify(info));
      closeSync(fd);
      const write = (/** @type {LockInfo} */ next) => writeFileSync(file, JSON.stringify(next));
      return {
        ok: true,
        recovered,
        saveSnapshot: (snapshot) => write({ ...info, snapshot }),
        release: () => {
          try {
            const held = JSON.parse(readFileSync(file, "utf8"));
            if (held.pid === process.pid) unlinkSync(file);
          } catch {
            /* already gone */
          }
        },
      };
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EEXIST") throw err;
    }
    /** @type {LockInfo | null} */
    let holder = null;
    try {
      holder = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      /* unreadable or half-written: treat as stale */
    }
    const fresh = holder && now - Date.parse(holder.startedAt) < LOCK_MAX_AGE_MS;
    if (holder && fresh && holder.pid !== process.pid && alive(holder.pid)) return { ok: false, holder };
    if (holder?.snapshot) recovered.push(...restoreFiles(root, holder.snapshot, (_rel, current) => current.includes(DIST_DIR)));
    rmSync(file, { force: true });
  }
  throw new Error(`could not take the run lock at ${LOCK_FILE}`);
}

// ── Scratch housekeeping ──────────────────────────────────────────────────────────────────────────
/**
 * Keep only the newest `keep` run scratch dirs (Playwright reports with traces grow without bound otherwise).
 * @param {string} root
 * @param {number} keep
 */
export function pruneTmp(root, keep) {
  const dir = path.join(root, TMP_DIR);
  if (!existsSync(dir)) return [];
  const old = readdirSync(dir).sort().slice(0, -keep || undefined);
  for (const name of old) rmSync(path.join(dir, name), { recursive: true, force: true });
  return old;
}
