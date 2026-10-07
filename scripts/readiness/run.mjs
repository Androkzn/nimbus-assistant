#!/usr/bin/env node
/**
 * Readiness runner (docs/requirements/06_Readiness_Report.md §3): runs the CI gates live and streams them as
 * ReadinessEvents (src/readiness/schema.ts), then adds the latest committed live-eval report as recorded evidence.
 *
 *   npm run readiness                                   # every stage, readable live summary
 *   npm run readiness -- --stages typecheck,lint,unit   # a subset (always run in canonical order)
 *   node scripts/readiness/run.mjs --stream             # NDJSON events only on stdout (/api/readiness/run uses this)
 *   npm run readiness -- --publish                      # also refresh public/readiness/latest.ndjson
 *
 * Every run writes readiness/reports/<runId>/events.ndjson (appended live) and summary.json.
 *
 * Isolation (spec §2): typecheck, build and E2E use NEXT_DIST_DIR=.next-readiness and port 3199, never .next/;
 * tsconfig.json and next-env.d.ts (rewritten by Next for a custom distDir) are restored byte-for-byte after each
 * stage and on exit, including Ctrl-C / SIGTERM / a failed child; one run at a time (lock file); every string
 * that leaves a child process is redacted before it reaches an event.
 */
import { spawn } from "node:child_process";
import { appendFileSync, copyFileSync, createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";
import {
  addSecrets,
  DIST_DIR,
  E2E_PORT,
  EVENT_TAG_ENV,
  PUBLISH_PATH,
  REPORTS_DIR,
  ROOT,
  STAGE_INFO,
  TMP_DIR,
  acquireLock,
  childEnv,
  decodeTagged,
  emptyCounts,
  eslintCounts,
  gateError,
  gateIdentity,
  latestEvalReport,
  logEvent,
  newEventTag,
  newRunId,
  portInUse,
  pruneTmp,
  readBuildId,
  recordedEval,
  redact,
  restoreFiles,
  sanitizeError,
  secretValues,
  runEndEvent,
  runMeta,
  runStartEvent,
  selectStages,
  snapshotFiles,
  stageEndEvent,
  stageStartEvent,
  testResultEvent,
  testStartEvent,
  withEnvFiles,
} from "./lib.mjs";

const USAGE = `usage: node scripts/readiness/run.mjs [--stream] [--stages a,b] [--publish]
  --stream    print only NDJSON events on stdout; progress goes to stderr
  --stages    comma-separated subset of: ${Object.keys(STAGE_INFO).join(", ")}
  --publish   copy the finished run to ${PUBLISH_PATH}`;

let opts;
try {
  const { values } = parseArgs({
    options: { stream: { type: "boolean" }, stages: { type: "string" }, publish: { type: "boolean" }, help: { type: "boolean", short: "h" } },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  opts = { stream: Boolean(values.stream), publish: Boolean(values.publish), stages: selectStages(values.stages) };
} catch (err) {
  console.error(`${err instanceof Error ? err.message : err}\n${USAGE}`);
  process.exit(2);
}

/** How many runs keep their scratch dir (raw logs, Playwright report with traces); older ones are pruned at start. */
const KEEP_SCRATCH_RUNS = 3;
const EXIT_LOCKED = 75; // EX_TEMPFAIL: another run holds the lock
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

// ── Run state (module-level so signal / exit handlers can always clean up) ────────────────────────
const state = {
  /** @type {ReturnType<typeof acquireLock> | null} */ lock: null,
  /** @type {Record<string, string | null> | null} */ snapshot: null,
  /** @type {import("node:child_process").ChildProcess | null} */ child: null,
  /** @type {string | null} */ abortReason: null,
  /** @type {Set<string>} */ restored: new Set(),
  runId: "",
  eventsPath: "",
};

// ── Output ────────────────────────────────────────────────────────────────────────────────────────
const human = opts.stream ? process.stderr : process.stdout;
const paint = (code) => (/** @type {string} */ s) => (human.isTTY ? `\u001b[${code}m${s}\u001b[0m` : s);
const [green, red, yellow, dim, bold] = [paint(32), paint(31), paint(33), paint(2), paint(1)];
const ICON = { passed: green("✓"), failed: red("✗"), skipped: yellow("○"), running: "…", pending: "·" };
const fmtMs = (ms) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} m ${Math.round((ms % 60_000) / 1000)} s`);
const say = (line = "") => human.write(`${line}\n`);
const indent = (text, pad) => text.split("\n").map((l) => `${pad}${l}`).join("\n");

let stdoutOpen = true;
process.stdout.on("error", () => {
  // The reader of --stream went away (window closed): nobody is watching, so stop and clean up.
  stdoutOpen = false;
  if (opts.stream) abort("output stream closed");
});

/** @param {import("./lib.mjs").ReadinessEvent} event */
function emit(event) {
  const line = `${JSON.stringify(event)}\n`;
  appendFileSync(state.eventsPath, line);
  if (opts.stream && stdoutOpen) process.stdout.write(line);
  print(event);
}

/** Readable live view. In --stream mode it goes to stderr and leaves out passing tests. */
function print(event) {
  switch (event.type) {
    case "run-start": {
      const m = event.meta;
      say(`${bold("Readiness run")} ${m.runId} ${dim(`· ${m.platform} · build ${m.build}${m.branch ? ` (${m.branch})` : ""}`)}`);
      say(dim(`golden ${m.goldenVersion ?? "–"} · pricing ${m.pricingVersion ?? "–"} · corpus ${m.corpusHash} · prompt ${m.promptHash}`));
      break;
    }
    case "stage-start":
      say(`\n${bold(`▶ ${STAGE_INFO[event.stage].title}`)}`);
      break;
    case "test-result": {
      const r = event.result;
      if (opts.stream && r.status === "passed") break;
      say(`  ${ICON[r.status]} ${r.fullName} ${dim(`${r.file} · ${fmtMs(r.durationMs)}`)}`);
      if (r.error) say(red(indent(r.error, "      ")));
      break;
    }
    case "log":
      say(dim(`  · ${event.line}`));
      break;
    case "stage-end": {
      const c = event.counts;
      const tally = [c.passed && `${c.passed} passed`, c.failed && red(`${c.failed} failed`), c.skipped && `${c.skipped} skipped`].filter(Boolean).join(" · ");
      say(`  ${ICON[event.status]} ${bold(`${STAGE_INFO[event.stage].title} ${event.status}`)}${tally ? ` — ${tally}` : ""} ${dim(`· ${fmtMs(event.durationMs)}`)}`);
      if (event.note) say(dim(`    ${event.note}`));
      break;
    }
    default:
      break;
  }
}

// ── Child processes ───────────────────────────────────────────────────────────────────────────────
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True while any process of the child's group is alive. */
function groupAlive(pid) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop a child and everything it started: SIGINT first (Playwright and Next shut their servers down on it), then
 * SIGTERM, then SIGKILL. Every child runs in its own process group (detached) so the whole tree can be signalled
 * — and only processes this runner started are ever signalled.
 * @param {import("node:child_process").ChildProcess | null} child
 */
async function stopGroup(child) {
  if (!child?.pid) return;
  for (const [signal, waitMs] of /** @type {const} */ ([["SIGINT", 5000], ["SIGTERM", 3000], ["SIGKILL", 2000]])) {
    if (!groupAlive(child.pid)) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      return;
    }
    for (let waited = 0; waited < waitMs && groupAlive(child.pid); waited += 100) await delay(100);
  }
}

/**
 * Run one command to completion. Raw output goes to readiness/tmp/<runId>/<stage>.log (redacted); lines that
 * `onLine` consumes (tagged reporter events) are not logged. The last 400 lines are kept for the failure reason.
 * @param {string} stage
 * @param {string} command
 * @param {string[]} args
 * @param {{ env: Record<string, string>, onLine?: (line: string) => boolean }} o
 */
async function runProcess(stage, command, args, { env, onLine }) {
  const log = createWriteStream(path.join(ROOT, TMP_DIR, state.runId, `${stage}.log`), { flags: "a" });
  log.write(`$ ${command} ${args.join(" ")}\n`);
  const tail = [];
  const child = spawn(command, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  state.child = child;
  const drained = Promise.all(
    [child.stdout, child.stderr].map((input) => {
      const rl = readline.createInterface({ input, crlfDelay: Infinity });
      rl.on("line", (line) => {
        if (onLine?.(line)) return;
        log.write(`${redact(line)}\n`);
        tail.push(line);
        if (tail.length > 400) tail.shift();
      });
      return new Promise((resolve) => rl.once("close", resolve));
    }),
  );
  const [code, signal] = await new Promise((resolve) => {
    child.once("error", (err) => {
      tail.push(String(err));
      resolve([127, null]);
    });
    child.once("exit", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
  });
  // A grandchild that outlives the command (e.g. a server) can hold the pipes open: don't wait on it forever,
  // and don't leave it running either.
  await Promise.race([drained, delay(2000)]);
  if (groupAlive(child.pid ?? 0)) {
    log.write("[stopping processes left behind by this command]\n");
    await stopGroup(child);
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  state.child = null;
  log.end(`[exit ${code ?? signal}]\n`);
  return { ok: code === 0, code, signal, output: tail.join("\n") };
}

// ── Stages ────────────────────────────────────────────────────────────────────────────────────────
const summary = { stages: /** @type {any[]} */ ([]), failures: /** @type {any[]} */ ([]), artifacts: /** @type {Record<string, string>} */ ({}) };
const buildIdBefore = readBuildId(ROOT);
const eventTag = newEventTag();
/** null = the build stage did not run in this invocation. */
let buildOk = /** @type {boolean | null} */ (null);

/** Put back the files Next rewrote; one log line per stage that needed it. */
function restoreRewritten(stage) {
  if (!state.snapshot) return;
  const restored = restoreFiles(ROOT, state.snapshot);
  if (!restored.length) return;
  restored.forEach((f) => state.restored.add(f));
  emit(logEvent(stage, `restored ${restored.join(", ")} byte-for-byte (rewritten by Next for ${DIST_DIR})`));
}

/** `.next/` may be serving another server (I4): any stage that runs Next must leave its BUILD_ID alone. */
function nextUntouchedNote() {
  return readBuildId(ROOT) === buildIdBefore ? ".next/ untouched (BUILD_ID unchanged)" : `WARNING: .next/BUILD_ID changed during this stage — .next/ was rebuilt (I4)`;
}

class StageRun {
  /** @param {import("./lib.mjs").StageId} stage */
  constructor(stage) {
    this.stage = stage;
    this.started = Date.now();
    this.counts = emptyCounts();
    emit(stageStartEvent(stage));
  }

  /** @param {{ id: string, file: string, fullName: string }} identity */
  start(identity) {
    emit(testStartEvent(this.stage, identity));
  }

  /** @param {Omit<Parameters<typeof testResultEvent>[0], "stage">} fields */
  result(fields) {
    this.record(testResultEvent({ stage: this.stage, ...fields }));
  }

  /** Count and emit a test-result (built here or by a reporter). */
  record(event) {
    const r = event.result;
    this.counts[r.status] += 1;
    if (r.status === "failed") summary.failures.push({ stage: this.stage, id: r.id, error: r.error ?? "" });
    emit(event);
  }

  /**
   * Forward one tagged reporter line; returns true when the line was an event. Reporters already redact, but in a
   * child that may not know every secret (offline env), so failure text is redacted again here; a malformed event
   * is dropped rather than published.
   * @param {string} line
   */
  forward(line) {
    const event = decodeTagged(line, eventTag);
    if (!event) return false;
    if (event.type === "test-result" && isResult(event.result)) {
      const result = { ...event.result, stage: this.stage };
      if (result.error) result.error = sanitizeError(result.error);
      this.record({ type: "test-result", result });
    } else if (event.type === "test-start" && typeof event.id === "string") {
      emit({ ...event, stage: this.stage });
    } else if (event.type === "log") {
      emit(logEvent(this.stage, event.line));
    }
    return true;
  }

  /** @param {{ status?: import("./lib.mjs").Status, note?: string, source?: "live" | "recorded", durationMs?: number }} [o] */
  end({ status, note, source = "live", durationMs } = {}) {
    restoreRewritten(this.stage);
    const final = status ?? (this.counts.failed ? "failed" : "passed");
    const event = stageEndEvent(this.stage, { status: final, durationMs: durationMs ?? Date.now() - this.started, counts: this.counts, source, note });
    emit(event);
    summary.stages.push({ id: this.stage, title: STAGE_INFO[this.stage].title, status: final, durationMs: event.durationMs, counts: this.counts, source, note: event.note });
    return final;
  }
}

/** @param {any} r */
const isResult = (r) =>
  r && ["id", "file", "fullName"].every((k) => typeof r[k] === "string") && ["passed", "failed", "skipped"].includes(r.status) && Number.isFinite(r.durationMs);

/** A stage that cannot run: still announced, so the page shows why instead of a stage stuck on "pending". */
function skipStage(stage, note) {
  return new StageRun(stage).end({ status: "skipped", note });
}

const interruptedNote = () => `interrupted (${state.abortReason}) — partial results`;

/**
 * Typecheck, lint, build: one result for the whole command.
 * @param {import("./lib.mjs").StageId} stage
 * @param {{ command: string, args: string[], display: string, env: Record<string, string>, after?: (r: Awaited<ReturnType<typeof runProcess>>) => { note?: string, detail?: Record<string, unknown> } }} o
 */
async function gateStage(stage, { command, args, display, env, after }) {
  const run = new StageRun(stage);
  const identity = gateIdentity(stage, display);
  run.start(identity);
  const r = await runProcess(stage, command, args, { env });
  const extra = after?.(r) ?? {};
  if (state.abortReason) return run.end({ status: "skipped", note: interruptedNote() });
  run.result({ ...identity, status: r.ok ? "passed" : "failed", durationMs: Date.now() - run.started, error: r.ok ? undefined : gateError(r.output), detail: extra.detail });
  return run.end({ note: extra.note });
}

/**
 * Unit and E2E: per-test results streamed by our reporter. A non-zero exit with no failing test (config error,
 * crash, web server that never started) becomes one failing `gate::<stage>` result carrying the tool's last lines.
 * @param {import("./lib.mjs").StageId} stage
 * @param {{ command: string, args: string[], display: string, env: Record<string, string>, note?: () => string | undefined }} o
 */
async function reporterStage(stage, { command, args, display, env, note }) {
  const run = new StageRun(stage);
  const r = await runProcess(stage, command, args, { env, onLine: (line) => run.forward(line) });
  if (state.abortReason) return run.end({ status: "skipped", note: interruptedNote() });
  const reported = run.counts.passed + run.counts.failed + run.counts.skipped;
  if ((!r.ok && run.counts.failed === 0) || reported === 0) {
    const error = r.ok ? "the run reported no tests" : gateError(r.output);
    run.result({ ...gateIdentity(stage, display), status: "failed", durationMs: Date.now() - run.started, error });
  }
  return run.end({ status: r.ok && !run.counts.failed ? "passed" : "failed", note: note?.() });
}

const tagEnv = { [EVENT_TAG_ENV]: eventTag };
const distEnv = { NEXT_DIST_DIR: DIST_DIR };
const hasReadinessBuild = () => existsSync(path.join(ROOT, DIST_DIR, "BUILD_ID"));

/** Build-dependent stages need this run's build, or (when the build stage was not selected) an earlier one. */
function buildPrerequisite() {
  if (buildOk === false) return { skip: "skipped: the build failed" };
  if (buildOk === null && !hasReadinessBuild()) return { skip: `skipped: no build in ${DIST_DIR}/ — include the build stage` };
  return { reused: buildOk === null ? `using an earlier ${DIST_DIR} build (BUILD_ID ${readBuildId(ROOT, DIST_DIR)})` : undefined };
}

/** @type {Record<import("./lib.mjs").StageId, () => Promise<unknown>>} */
const STAGES = {
  // Route types are generated into .next-readiness too, so not even .next/types is touched (I4).
  typecheck: () =>
    gateStage("typecheck", {
      command: "npm",
      args: ["run", "typecheck"],
      display: `NEXT_DIST_DIR=${DIST_DIR} npm run typecheck`,
      env: childEnv(process.env, { offline: true, extra: distEnv }),
    }),

  lint: () =>
    gateStage("lint", {
      command: "npm",
      args: ["run", "lint"],
      display: "npm run lint",
      env: childEnv(process.env, { offline: true }),
      after: (r) => {
        const { warnings } = eslintCounts(r.output);
        return warnings ? { detail: { warnings }, note: `${warnings} warning(s), no errors` } : {};
      },
    }),

  unit: () =>
    reporterStage("unit", {
      command: "npx",
      args: ["vitest", "run", "--reporter=./scripts/readiness/vitest-reporter.mjs"],
      display: "npx vitest run",
      env: childEnv(process.env, { offline: true, extra: tagEnv }),
    }),

  build: async () => {
    const status = await gateStage("build", {
      command: "npx",
      args: ["next", "build"],
      display: `NEXT_DIST_DIR=${DIST_DIR} npx next build`,
      env: childEnv(process.env, { extra: distEnv }),
      after: (r) => ({ note: `${r.ok ? `→ ${DIST_DIR}/ (BUILD_ID ${readBuildId(ROOT, DIST_DIR)})` : "build failed"} · ${nextUntouchedNote()}` }),
    });
    buildOk = status === "passed";
  },

  // The scanner proves it still catches planted keys (--self-test) before it scans the build.
  "bundle-scan": async () => {
    const pre = buildPrerequisite();
    if (pre.skip) return skipStage("bundle-scan", pre.skip);
    const scanner = path.join("scripts", "scan-client-bundle.mjs");
    const display = `NEXT_DIST_DIR=${DIST_DIR} node ${scanner}`;
    const run = new StageRun("bundle-scan");
    const identity = gateIdentity("bundle-scan", display);
    run.start(identity);
    // The scan also looks for the real key values literally: those in the environment plus the .env files the
    // build loaded. They are never printed — the scanner names variables only, and output is redacted against them.
    const { env, files } = withEnvFiles(ROOT, childEnv(process.env, { extra: distEnv }));
    addSecrets(secretValues(env));
    const selfTest = await runProcess("bundle-scan", process.execPath, [scanner, "--self-test"], { env });
    const scan = selfTest.ok && !state.abortReason ? await runProcess("bundle-scan", process.execPath, [scanner], { env }) : null;
    if (state.abortReason) return run.end({ status: "skipped", note: interruptedNote() });
    const ok = selfTest.ok && Boolean(scan?.ok);
    const error = !selfTest.ok ? `scanner self-test failed:\n${gateError(selfTest.output)}` : scan && !scan.ok ? gateError(scan.output) : undefined;
    run.result({ ...identity, status: ok ? "passed" : "failed", durationMs: Date.now() - run.started, error, detail: { selfTest: selfTest.ok ? "passed" : "failed", scanned: `${DIST_DIR}/static` } });
    const keySource = files.length ? `key values from the environment and ${files.join(", ")}` : "key values from the environment";
    return run.end({ note: [pre.reused, `scanned ${DIST_DIR}/static for key shapes and ${keySource}`].filter(Boolean).join(" · ") });
  },

  e2e: async () => {
    const pre = buildPrerequisite();
    if (pre.skip) return skipStage("e2e", pre.skip);
    const display = `E2E_PORT=${E2E_PORT} NEXT_DIST_DIR=${DIST_DIR} npx playwright test`;
    if (await portInUse(E2E_PORT)) {
      const reason = `port ${E2E_PORT} is already in use — refusing to run: Playwright (reuseExistingServer) would test that server, not this build`;
      const run = new StageRun("e2e");
      run.result({ ...gateIdentity("e2e", display), status: "failed", error: reason });
      return run.end({ note: reason });
    }
    const scratch = path.join(TMP_DIR, state.runId);
    summary.artifacts.playwrightReport = `${scratch}/playwright-report`;
    const status = await reporterStage("e2e", {
      command: "npx",
      args: ["playwright", "test", "--reporter=./scripts/readiness/playwright-reporter.mjs,html", "--output", path.join(scratch, "test-results")],
      display,
      env: childEnv(process.env, {
        extra: {
          ...distEnv,
          ...tagEnv,
          E2E_PORT: String(E2E_PORT),
          PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(ROOT, scratch, "playwright-report"),
          PLAYWRIGHT_HTML_OPEN: "never",
        },
      }),
      note: () =>
        [pre.reused, `next start :${E2E_PORT} on ${DIST_DIR}/ with the mock model`, `HTML report ${scratch}/playwright-report`, nextUntouchedNote()].filter(Boolean).join(" · "),
    });
    if (await portInUse(E2E_PORT)) emit(logEvent("e2e", `port ${E2E_PORT} is still in use after Playwright exited`));
    return status;
  },

  "live-eval": async () => {
    const report = latestEvalReport(ROOT);
    if (!report) return skipStage("live-eval", "skipped: no committed live-eval report under evals/reports/");
    const run = new StageRun("live-eval");
    const recorded = recordedEval(report.json, report.path);
    recorded.events.forEach((event) => run.record(event));
    return run.end({ status: recorded.status, source: "recorded", durationMs: recorded.durationMs, note: recorded.note });
  },
};

// ── Lifecycle ─────────────────────────────────────────────────────────────────────────────────────
/** @param {string} reason */
function abort(reason) {
  if (state.abortReason) return;
  state.abortReason = reason;
  say(yellow(`\nStopping (${reason}): ending the current stage, then restoring files…`));
  void stopGroup(state.child);
}

/** Last-resort cleanup, synchronous: runs on every exit path, including a second Ctrl-C and uncaught errors. */
function cleanupSync() {
  if (state.snapshot) restoreFiles(ROOT, state.snapshot).forEach((f) => state.restored.add(f));
  if (state.lock?.ok) state.lock.release();
}

for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
  process.on(signal, () => {
    if (!state.abortReason) return abort(signal);
    // Second signal: stop waiting for a graceful shutdown.
    if (state.child?.pid && groupAlive(state.child.pid)) {
      try {
        process.kill(process.platform === "win32" ? state.child.pid : -state.child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    cleanupSync();
    process.exit(SIGNAL_EXIT[signal]);
  });
}
process.on("exit", cleanupSync);

function uniqueRunId() {
  const base = newRunId();
  let id = base;
  for (let n = 2; existsSync(path.join(ROOT, REPORTS_DIR, id)); n += 1) id = `${base}-${n}`;
  return id;
}

function printSummary(status, durationMs) {
  say(`\n${bold("Summary")} ${dim(`run ${state.runId} · ${fmtMs(durationMs)}`)}`);
  for (const s of summary.stages) {
    const c = s.counts;
    say(`  ${ICON[s.status]} ${s.title.padEnd(38)} ${dim(`${String(c.passed).padStart(4)} ✓ ${String(c.failed).padStart(3)} ✗ ${String(c.skipped).padStart(3)} ○  ${fmtMs(s.durationMs)}`)}`);
  }
  if (summary.failures.length) {
    say(`\n${red(`${summary.failures.length} failure(s):`)}`);
    for (const f of summary.failures.slice(0, 20)) say(`  ${red("✗")} ${f.id}\n${dim(indent(f.error.split("\n").slice(0, 3).join("\n"), "      "))}`);
  }
  if (state.restored.size) say(dim(`\nrestored byte-for-byte: ${[...state.restored].join(", ")}`));
  say(`\n${status === "passed" ? green(bold("PASSED")) : red(bold(state.abortReason ? "STOPPED" : "FAILED"))} ${dim(`events: ${path.relative(ROOT, state.eventsPath)}`)}`);
}

async function main() {
  const runId = uniqueRunId();
  const lock = acquireLock(ROOT, { runId });
  if (!lock.ok) {
    console.error(`Another readiness run is in progress (pid ${lock.holder.pid}, run ${lock.holder.runId}). Wait for it to finish.`);
    process.exitCode = EXIT_LOCKED;
    return;
  }
  state.lock = lock;
  state.runId = runId;
  if (lock.recovered.length) say(yellow(`A previous run was killed before cleanup; restored ${lock.recovered.join(", ")}.`));
  state.snapshot = snapshotFiles(ROOT);
  lock.saveSnapshot(state.snapshot);

  const reportDir = path.join(ROOT, REPORTS_DIR, runId);
  mkdirSync(reportDir, { recursive: true });
  pruneTmp(ROOT, KEEP_SCRATCH_RUNS - 1);
  mkdirSync(path.join(ROOT, TMP_DIR, runId), { recursive: true });
  state.eventsPath = path.join(reportDir, "events.ndjson");
  summary.artifacts.events = path.relative(ROOT, state.eventsPath);
  summary.artifacts.scratch = `${TMP_DIR}/${runId}`;

  const startedAt = new Date().toISOString();
  const started = Date.now();
  const meta = runMeta({ root: ROOT, runId, startedAt });
  let status = /** @type {"passed" | "failed"} */ ("failed");
  try {
    emit(runStartEvent(meta, opts.stages));
    for (const stage of opts.stages) {
      if (state.abortReason) skipStage(stage, `skipped: the run was stopped (${state.abortReason})`);
      else await STAGES[stage]();
    }
    status = !state.abortReason && summary.stages.every((s) => s.status !== "failed") ? "passed" : "failed";
  } catch (err) {
    say(red(`runner error: ${redact(err instanceof Error ? err.stack ?? err.message : err)}`));
  } finally {
    await stopGroup(state.child);
    cleanupRestore();
    const buildIdAfter = readBuildId(ROOT);
    const durationMs = Date.now() - started;
    if (buildIdAfter !== buildIdBefore) emit(logEvent(lastStage(), "WARNING: .next/BUILD_ID changed during the run — .next/ was rebuilt (I4)"));
    emit(runEndEvent(status, durationMs));
    const published = opts.publish && !state.abortReason;
    if (published) {
      mkdirSync(path.dirname(path.join(ROOT, PUBLISH_PATH)), { recursive: true });
      copyFileSync(state.eventsPath, path.join(ROOT, PUBLISH_PATH));
    }
    writeFileSync(
      path.join(reportDir, "summary.json"),
      `${JSON.stringify(
        {
          runId,
          status,
          interrupted: state.abortReason,
          startedAt,
          endedAt: new Date().toISOString(),
          durationMs,
          meta,
          stages: summary.stages,
          failures: summary.failures,
          isolation: {
            distDir: DIST_DIR,
            e2ePort: E2E_PORT,
            restoredFiles: [...state.restored],
            nextBuildIdBefore: buildIdBefore,
            nextBuildIdAfter: buildIdAfter,
            nextBuildIdUnchanged: buildIdAfter === buildIdBefore,
          },
          artifacts: { ...summary.artifacts, summary: path.relative(ROOT, path.join(reportDir, "summary.json")), ...(published ? { published: PUBLISH_PATH } : {}) },
        },
        null,
        2,
      )}\n`,
    );
    state.snapshot = null;
    lock.release();
    printSummary(status, durationMs);
    if (published) say(dim(`published → ${PUBLISH_PATH}`));
    process.exitCode = state.abortReason ? (SIGNAL_EXIT[/** @type {keyof typeof SIGNAL_EXIT} */ (state.abortReason)] ?? 1) : status === "passed" ? 0 : 1;
  }
}

/** The stage a run-level log line is attached to (log events always name a stage). */
const lastStage = () => summary.stages.at(-1)?.id ?? opts.stages[0];

/** Final restore before run-end; anything restored here is logged on the last stage. */
function cleanupRestore() {
  if (!state.snapshot) return;
  const restored = restoreFiles(ROOT, state.snapshot);
  restored.forEach((f) => state.restored.add(f));
  if (restored.length) emit(logEvent(lastStage(), `restored ${restored.join(", ")} byte-for-byte`));
}

await main();
