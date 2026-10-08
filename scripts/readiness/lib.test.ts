import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReadinessEventSchema, STAGE_IDS, STAGE_INFO } from "@/readiness/schema";
import { RUN_LOCK_FILE, RUN_LOCK_MAX_AGE_MS } from "@/readiness/runner-gate";
import * as lib from "./lib.mjs";

/**
 * Readiness runner helpers (spec 06 §4 ids, I4–I6). Every event these helpers can produce must parse with the
 * shared contract — the page rejects a stream that doesn't.
 */

// Key-shaped fixtures are assembled at runtime, like scan-client-bundle's self-test, so this file never holds one.
const KEYS = {
  anthropic: `sk-ant-${"api03-"}${"a".repeat(40)}`,
  openai: `sk-${"proj-"}${"b".repeat(40)}`,
  google: `AIza${"c".repeat(35)}`,
  sentry: `sntrys_${"d".repeat(40)}`,
  jwt: `eyJ${"e".repeat(20)}.${"f".repeat(20)}.${"g".repeat(20)}`,
};

const parse = (event: unknown) => ReadinessEventSchema.parse(event);

describe("stage copy", () => {
  it("runner stages are STAGE_IDS minus the page's own probes, in the same order", () => {
    expect([...lib.RUNNER_STAGE_IDS]).toEqual(STAGE_IDS.filter((s) => s !== "probes"));
  });

  it("the runner's STAGE_INFO copy matches the shared contract exactly", () => {
    for (const id of lib.RUNNER_STAGE_IDS) expect(lib.STAGE_INFO[id]).toEqual(STAGE_INFO[id]);
  });

  it("--stages keeps canonical order and rejects unknown ids", () => {
    expect(lib.selectStages("unit, lint,typecheck")).toEqual(["typecheck", "lint", "unit"]);
    expect(lib.selectStages(undefined)).toEqual([...lib.RUNNER_STAGE_IDS]);
    expect(() => lib.selectStages("lint,probes")).toThrow(/unknown stage\(s\): probes/);
  });
});

describe("redaction (I6)", () => {
  it.each(Object.entries(KEYS))("redacts a %s-shaped secret", (_vendor, key) => {
    const out = lib.redact(`401 Incorrect API key provided: ${key} (see docs)`, []);
    expect(out).not.toContain(key);
    expect(out).toMatch(/\[redacted-(key|token)\]/);
    expect(out).toContain("(see docs)");
  });

  it("matches redactSecrets on partly masked vendor echoes", () => {
    expect(lib.redact("Incorrect API key provided: sk-proj-****abcd", [])).toBe("Incorrect API key provided: [redacted-key]");
  });

  it("redacts the literal values of secret-named env vars, and only those", () => {
    const env = { MY_SERVICE_TOKEN: "plain-value-1234", PATH: "/usr/bin:/bin", NEXT_PUBLIC_SENTRY_DSN: "https://abc@o1.ingest.sentry.io/1", SHORT_KEY: "abc" };
    const secrets = lib.secretValues(env);
    expect(secrets).toEqual(["https://abc@o1.ingest.sentry.io/1", "plain-value-1234"]);
    expect(lib.redact("token plain-value-1234 in /usr/bin:/bin", secrets)).toBe("token [redacted-env] in /usr/bin:/bin");
  });

  it("redacts by default the secrets the runner loaded itself (e.g. from .env files)", () => {
    lib.addSecrets(["loaded-from-dotenv-123"]);
    expect(lib.redact("value loaded-from-dotenv-123 here")).toBe("value [redacted-env] here");
  });

  it("makes paths repo-relative so no home directory is published", () => {
    const out = lib.redact(`${path.join(lib.ROOT, "src", "a.ts")}:3 and ${os.homedir()}/other`, []);
    expect(out).toBe("src/a.ts:3 and ~/other");
  });

  it("caps failure reasons at 500 chars and log lines at 300, on one line", () => {
    const error = lib.sanitizeError("x".repeat(2000));
    expect(error.length).toBe(lib.ERROR_MAX);
    expect(error.endsWith("…")).toBe(true);
    const line = lib.logLine(`first\nsecond ${"y".repeat(1000)}`);
    expect(line.length).toBeLessThanOrEqual(lib.LOG_MAX);
    expect(line).not.toContain("\n");
    expect(lib.cap("abcdef", 4, "tail")).toBe("…def");
  });

  it("drops assertion output that echoes what the app rendered (Received lines, Playwright call log)", () => {
    const raw = [
      "Error: expect(locator).toHaveText(expected) failed",
      "",
      "Locator:  getByTestId('answer')",
      'Expected: "Relay Pro costs $49"',
      'Received: "an answer the app rendered"',
      "Timeout:  5000ms",
      "",
      "Call log:",
      "  - waiting for getByTestId('answer')",
    ].join("\n");
    const out = lib.sanitizeError(raw);
    expect(out).toContain("toHaveText(expected) failed");
    expect(out).toContain('Expected: "Relay Pro costs $49"');
    expect(out).not.toMatch(/rendered|Call log|waiting for/);
  });
});

describe("gate failure reasons", () => {
  it("keeps the last tsc errors, without npm's wrap-up noise", () => {
    const output = [
      "> nimbus-assistant@0.1.0 typecheck",
      "> next typegen && tsc --noEmit",
      "✓ Types generated successfully",
      "src/a.ts(4,59): error TS2307: Cannot find module './coverage' or its corresponding type declarations.",
      "src/b.ts(301,41): error TS7006: Parameter 's' implicitly has an 'any' type.",
      "npm error Lifecycle script `typecheck` failed with error:",
      "npm error code 2",
    ].join("\n");
    expect(lib.gateError(output, [])).toBe(
      "src/a.ts(4,59): error TS2307: Cannot find module './coverage' or its corresponding type declarations.\nsrc/b.ts(301,41): error TS7006: Parameter 's' implicitly has an 'any' type.",
    );
  });

  it("folds ESLint's file header into each error line and skips warnings", () => {
    const output = [
      `${path.join(lib.ROOT, "src", "x.tsx")}`,
      "  12:5  error    'y' is assigned a value but never used  @typescript-eslint/no-unused-vars",
      "  20:1  warning  Unexpected console statement             no-console",
      "",
      "✖ 2 problems (1 error, 1 warning)",
    ].join("\n");
    const reason = lib.gateError(output, []);
    expect(reason).toContain("src/x.tsx:12:5 'y' is assigned a value but never used  @typescript-eslint/no-unused-vars");
    expect(reason).not.toContain("no-console");
    expect(lib.eslintCounts(output)).toEqual({ errors: 1, warnings: 1 });
  });

  it("keeps the bundle scan's list of hits under its error line", () => {
    const output = "❌ API key material found in client bundle:\n  - chunks/a.js: OpenAI key pattern\n  - chunks/a.js: value of OPENAI_API_KEY\n";
    expect(lib.gateError(output, [])).toBe("❌ API key material found in client bundle:\n  - chunks/a.js: OpenAI key pattern\n  - chunks/a.js: value of OPENAI_API_KEY");
  });

  it("is redacted, capped from the end, and never empty", () => {
    const output = `${`Error: ${"n".repeat(100)}\n`.repeat(20)}Error: provider said ${KEYS.anthropic}`;
    const reason = lib.gateError(output, []);
    expect(reason.length).toBeLessThanOrEqual(lib.ERROR_MAX);
    expect(reason.startsWith("…")).toBe(true);
    expect(reason).toContain("provider said [redacted-key]");
    expect(lib.gateError("", [])).toMatch(/non-zero/);
  });
});

describe("result ids (spec §4)", () => {
  it("Vitest: <file>::<describe chain › title>, file repo-relative, even when titles contain '>'", () => {
    const mod = { type: "module", moduleId: path.join(lib.ROOT, "src", "server", "a.test.ts") };
    const outer = { type: "suite", name: "outer", parent: mod, module: mod };
    const inner = { type: "suite", name: "a > b", parent: outer, module: mod };
    const test = { type: "test", name: "does x", parent: inner, module: mod };
    expect(lib.vitestIdentity(test, lib.ROOT)).toEqual({
      id: "src/server/a.test.ts::outer › a > b › does x",
      file: "src/server/a.test.ts",
      fullName: "outer › a > b › does x",
    });
    expect(lib.vitestIdentity({ type: "test", name: "top", parent: mod, module: mod }, lib.ROOT).fullName).toBe("top");
  });

  it("Playwright: <file>::<describe chain › title>, without the root, project and file suites", () => {
    const root = { type: "root", title: "" };
    const project = { type: "project", title: "chromium", parent: root };
    const file = { type: "file", title: "chat.spec.ts", parent: project };
    const group = { type: "describe", title: "fallback", parent: file };
    const location = { file: path.join(lib.ROOT, "e2e", "chat.spec.ts") };
    expect(lib.playwrightIdentity({ title: "NKA-MDL-004: backup answers", parent: group, location }, lib.ROOT)).toEqual({
      id: "e2e/chat.spec.ts::fallback › NKA-MDL-004: backup answers",
      file: "e2e/chat.spec.ts",
      fullName: "fallback › NKA-MDL-004: backup answers",
    });
    expect(lib.playwrightIdentity({ title: "NKA-CHAT-004: blank", parent: file, location }, lib.ROOT).id).toBe("e2e/chat.spec.ts::NKA-CHAT-004: blank");
  });

  it("gates: gate::<stage>, file = the command, fullName = the stage title", () => {
    expect(lib.gateIdentity("bundle-scan", "npm run scan:bundle")).toEqual({ id: "gate::bundle-scan", file: "npm run scan:bundle", fullName: "Client bundle secret scan" });
  });
});

describe("recorded live eval (I7)", () => {
  const golden = JSON.parse(readFileSync(path.join(lib.ROOT, "evals/golden-set.json"), "utf8"));
  const caseIds: string[] = golden.cases.map((c: { id: string }) => c.id);
  const latest = lib.latestEvalReport(lib.ROOT);

  // Synthetic reports: `models` answer `cases` (rows only carry what the selection reads).
  const report = (stamp: string, models: string[], cases: string[]) => ({
    path: `evals/reports/${stamp}/results.json`,
    json: { results: models.flatMap((model) => cases.map((caseId) => ({ caseId, model, verdict: "pass" }))) },
  });
  const ids = ["C-1", "C-2", "C-3"];

  it("shows the newest COMPLETE committed report: every current golden case, for at least two models", () => {
    const all = readdirSync(path.join(lib.ROOT, "evals", "reports"))
      .sort()
      .filter((d) => existsSync(path.join(lib.ROOT, "evals", "reports", d, "results.json")))
      .map((d) => ({ path: `evals/reports/${d}/results.json`, json: JSON.parse(readFileSync(path.join(lib.ROOT, "evals", "reports", d, "results.json"), "utf8")) }));
    const complete = all.filter((r) => lib.evalCoverage(r.json, caseIds).complete);
    if (!latest) {
      expect(complete).toHaveLength(0);
      return;
    }
    if (complete.length) {
      expect(latest!.path).toBe(complete.at(-1)!.path);
      expect(latest!.coverage).toMatchObject({ complete: true, casesCovered: caseIds.length, casesTotal: caseIds.length });
      expect(latest!.coverage.fullModels.length).toBeGreaterThanOrEqual(lib.MIN_COMPLETE_MODELS);
    } else {
      expect(latest!.coverage.graded).toBe(Math.max(...all.map((r) => r.json.results.length)));
    }
  });

  it("a newer partial run (one model, some cases) does not replace an older complete one", () => {
    const chosen = lib.chooseEvalReport([report("a", ["m1", "m2"], ids), report("b", ["m1", "m2", "m3"], ids), report("c", ["m1"], ids)], ids);
    expect(chosen?.path).toBe("evals/reports/b/results.json");
    expect(chosen?.coverage).toEqual({ complete: true, casesCovered: 3, casesTotal: 3, models: ["m1", "m2", "m3"], fullModels: ["m1", "m2", "m3"], graded: 9 });
  });

  it("is not complete when only one model covers every case, or a case added to the golden set is missing", () => {
    expect(lib.evalCoverage(report("a", ["m1"], ids).json, ids).complete).toBe(false);
    const oneShort = { results: [...report("a", ["m1"], ids).json.results, ...report("a", ["m2"], ["C-1", "C-2"]).json.results] };
    expect(lib.evalCoverage(oneShort, ids)).toMatchObject({ complete: false, fullModels: ["m1"], casesCovered: 3 });
    expect(lib.evalCoverage(report("a", ["m1", "m2"], ["C-1", "C-2"]).json, ids)).toMatchObject({ complete: false, casesCovered: 2 });
  });

  it("with no complete report, falls back to the most graded answers (newest on a tie) and labels it partial", () => {
    // graded answers: a 2, b 3, c 2, d 3 → b and d tie; the newer one (d) wins.
    const reports = [report("a", ["m1", "m2"], ["C-1"]), report("b", ["m1"], ids), report("c", ["m3", "m4"], ["C-1"]), report("d", ["m2"], ids)];
    const chosen = lib.chooseEvalReport(reports, ids);
    expect(chosen?.path).toBe("evals/reports/d/results.json");
    const meta = { startedAt: "2026-10-07T21:22:23.000Z", build: "a6af017", environment: "https://example.test" };
    expect(lib.recordedEval({ meta, ...chosen!.json }, chosen!.path, chosen!.coverage).note).toBe(
      "recorded 2026-10-07 21:22 UTC · build a6af017 · https://example.test · partial: 3/3 cases, 1 model",
    );
    expect(lib.chooseEvalReport([], ids)).toBeNull();
  });

  it("emits one recorded result per case × model, labelled with date, build, environment and coverage", () => {
    if (!latest) return;
    const { json, path: reportPath, coverage } = latest!;
    const rec = lib.recordedEval(json, reportPath, coverage);
    expect(rec.events).toHaveLength(json.results.length);
    const scope = coverage.complete ? `${coverage.casesTotal} cases × ${coverage.fullModels.length} models` : `partial: ${coverage.casesCovered}/${coverage.casesTotal} cases`;
    expect(rec.note.startsWith(`recorded ${json.meta.startedAt.slice(0, 10)} ${json.meta.startedAt.slice(11, 16)} UTC · build ${json.meta.build} · ${json.meta.environment} · ${scope}`)).toBe(true);
    expect(rec.counts.passed + rec.counts.failed + rec.counts.skipped).toBe(json.results.length);
    rec.events.forEach((event, i) => {
      const row = json.results[i];
      const parsed = parse(event);
      if (parsed.type !== "test-result") throw new Error("expected a test-result");
      expect(parsed.result).toMatchObject({
        id: `eval::${row.caseId}::${row.model}`,
        stage: "live-eval",
        file: reportPath,
        fullName: `${row.caseId} — ${row.question}`,
        source: "recorded",
        status: ({ pass: "passed", fail: "failed", fallback: "skipped" } as Record<string, string>)[row.verdict] ?? "failed",
      });
      expect(parsed.result.detail).toMatchObject({ model: row.model, reportPath, environment: json.meta.environment });
      // I6: the model's answer text is evidence in the report file, never in an event.
      if (row.answer) expect(JSON.stringify(event)).not.toContain(row.answer.slice(0, 60));
    });
  });

  it("maps verdicts — a fallback is skipped, never passed — keeps answer figures out of reasons, omits null metrics", () => {
    const rows = [
      { caseId: "C-1", question: "q1", model: "m", verdict: "fail", failed: ["missing /x/", "figures not in sources: 59, 12"], ttftMs: null, totalMs: 10, costUSD: 0 },
      { caseId: "C-2", question: "q2", model: "m", verdict: "fallback", failed: [], answeredBy: "backup", ttftMs: 5, totalMs: 20, costUSD: 0.001 },
      { caseId: "C-3", question: "q3", model: "m", verdict: "weird", failed: [], ttftMs: 5, totalMs: 30, costUSD: 0 },
      { caseId: "C-4", question: "q4", model: "m", verdict: "pass", failed: [], answeredBy: "m", ttftMs: 7, totalMs: 40, costUSD: 0.002 },
    ];
    const rec = lib.recordedEval({ meta: { startedAt: "2026-10-07T20:41:15.000Z", build: "091ba66", environment: "http://localhost:3300" }, results: rows }, "evals/reports/x/results.json");
    const results = rec.events.map((e) => {
      const parsed = parse(e);
      if (parsed.type !== "test-result") throw new Error("expected a test-result");
      return parsed.result;
    });
    expect(results[0]).toMatchObject({ status: "failed", error: "missing /x/; figures not in sources (2)" });
    expect(results[0].detail).not.toHaveProperty("ttftMs");
    expect(results[1]).toMatchObject({
      status: "skipped",
      detail: { verdict: "fallback", answeredBy: "backup", note: "answered by backup, so m was not evaluated on this case" },
    });
    expect(results[1].error).toBeUndefined();
    expect(results[2]).toMatchObject({ status: "failed", error: 'unknown verdict "weird"' });
    expect(results[3]).toMatchObject({ status: "passed", detail: { model: "m", ttftMs: 7 } });
    expect(results[3].detail).not.toHaveProperty("answeredBy");
    expect(rec).toMatchObject({ status: "failed", durationMs: 100, counts: { passed: 1, failed: 2, skipped: 1 }, note: "recorded 2026-10-07 20:41 UTC · build 091ba66 · http://localhost:3300" });
    expect(lib.recordedEval({ meta: {}, results: [] }, "p").status).toBe("skipped");
    expect(lib.recordedEval({ meta: {}, results: [rows[1]] }, "p").status).toBe("skipped");
  });
});

describe("event contract", () => {
  it("every event the helpers build parses with ReadinessEventSchema", () => {
    const meta = lib.runMeta({ root: lib.ROOT, runId: lib.newRunId(new Date("2026-10-07T21:30:00Z")), startedAt: new Date().toISOString() });
    const identity = lib.gateIdentity("lint", "npm run lint");
    const events = [
      lib.runStartEvent(meta, lib.RUNNER_STAGE_IDS),
      lib.stageStartEvent("lint"),
      lib.testStartEvent("lint", identity),
      lib.testResultEvent({ stage: "lint", ...identity, status: "passed", durationMs: 12.7 }),
      lib.testResultEvent({
        stage: "unit",
        id: "a::b",
        file: "a",
        fullName: "b",
        status: "failed",
        durationMs: -3,
        error: `${"boom ".repeat(300)}${KEYS.openai}`,
        detail: { n: 1, s: "x", b: true, nil: null, nan: Number.NaN, obj: { nested: 1 } },
      }),
      lib.logEvent("build", `line one\n${"z".repeat(500)}`),
      lib.stageEndEvent("lint", { status: "passed", durationMs: 1234.5, counts: lib.emptyCounts(), note: "1 warning(s), no errors" }),
      lib.runEndEvent("failed", 99),
    ];
    for (const event of events) expect(() => parse(event)).not.toThrow();
    const failed = parse(events[4]);
    if (failed.type !== "test-result") throw new Error("expected a test-result");
    expect(failed.result.durationMs).toBe(0);
    expect(failed.result.error).not.toContain(KEYS.openai);
    expect(failed.result.detail).toEqual({ n: 1, s: "x", b: true });
  });

  it("run meta: local mode, platform, dirty-aware build, and eval-live's exact corpus hash", () => {
    const meta = lib.runMeta({ root: lib.ROOT, runId: "2026-10-07-21-30-00", startedAt: "2026-10-07T21:30:00.000Z" });
    expect(meta).toMatchObject({ runId: "2026-10-07-21-30-00", mode: "local", environment: "local working tree" });
    expect(meta.platform).toBe(`node ${process.version} · ${process.platform} ${process.arch}`);
    expect(meta.build).toMatch(/^([0-9a-f]{7,}(\+dirty)?|local)$/);
    expect(meta.goldenVersion).toBe(JSON.parse(readFileSync(path.join(lib.ROOT, "evals/golden-set.json"), "utf8")).version);
    expect(meta.pricingVersion).toBe(JSON.parse(readFileSync(path.join(lib.ROOT, "config/models.json"), "utf8")).pricingVersion);
    expect(meta.promptHash).toMatch(/^[0-9a-f]{10}$/);
    // knowledge-base/ is read-only client data, so the hash must equal the one eval-live recorded.
    const latestReport = lib.latestEvalReport(lib.ROOT);
    if (latestReport) expect(meta.corpusHash).toBe(latestReport.json.meta.corpusHash);
  });

  it("runId uses the evals/reports stamp format", () => {
    expect(lib.newRunId(new Date("2026-10-07T21:30:05.123Z"))).toBe("2026-10-07-21-30-05");
  });
});

describe("reporter → runner wire protocol", () => {
  it("round-trips a tagged event, even after an unterminated line from the tool", () => {
    const tag = lib.newEventTag();
    const event = lib.stageStartEvent("unit");
    const line = lib.encodeTagged(event, tag);
    expect(line.endsWith("\n")).toBe(true);
    expect(lib.decodeTagged(`partial output${line.trimEnd()}`, tag)).toEqual(event);
  });

  it("ignores ordinary output, other tags and broken JSON", () => {
    const tag = lib.newEventTag();
    expect(lib.decodeTagged('{"type":"run-end"}', tag)).toBeNull();
    expect(lib.decodeTagged(lib.encodeTagged(lib.stageStartEvent("unit"), lib.newEventTag()), tag)).toBeNull();
    expect(lib.decodeTagged(`${tag}{"type":`, tag)).toBeNull();
  });
});

describe("child environment", () => {
  const parent = {
    PATH: "/usr/bin",
    NODE_ENV: "development",
    __NEXT_PROCESSED_ENV: "true",
    NEXT_RUNTIME: "nodejs",
    TURBOPACK: "1",
    ANTHROPIC_API_KEY: "k",
    NEXT_PUBLIC_SENTRY_DSN: "d",
    VERCEL_OIDC_TOKEN: "t",
    LLM_MODE: "live",
  };

  it("drops a next dev parent's internals, so builds and tests behave as from a terminal", () => {
    expect(lib.childEnv(parent)).toEqual({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "k", NEXT_PUBLIC_SENTRY_DSN: "d", VERCEL_OIDC_TOKEN: "t", LLM_MODE: "live" });
  });

  it("offline gates get no keys, tokens or DSN; extra vars win", () => {
    expect(lib.childEnv(parent, { offline: true, extra: { LLM_MODE: "mock", NEXT_DIST_DIR: lib.DIST_DIR } })).toEqual({ PATH: "/usr/bin", LLM_MODE: "mock", NEXT_DIST_DIR: ".next-readiness" });
  });
});

describe("isolation helpers (I4, I5)", () => {
  const dirs: string[] = [];
  const tmpRoot = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "readiness-lib-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("lock and route agree on the lock file and its max age", () => {
    expect(lib.LOCK_FILE).toBe(RUN_LOCK_FILE);
    expect(lib.LOCK_MAX_AGE_MS).toBe(RUN_LOCK_MAX_AGE_MS);
  });

  it("restores rewritten files byte-for-byte, removes files that did not exist, and leaves equal files alone", () => {
    const root = tmpRoot();
    const original = Buffer.from('{\n  "include": ["next-env.d.ts"]\n}\n');
    writeFileSync(path.join(root, "tsconfig.json"), original);
    const snapshot = lib.snapshotFiles(root);
    expect(snapshot["next-env.d.ts"]).toBeNull();
    expect(lib.restoreFiles(root, snapshot)).toEqual([]);
    writeFileSync(path.join(root, "tsconfig.json"), '{\n  "include": [\n    "next-env.d.ts",\n    ".next-readiness/types/**/*.ts"\n  ]\n}\n');
    writeFileSync(path.join(root, "next-env.d.ts"), 'import "./.next-readiness/types/routes.d.ts";\n');
    expect(lib.restoreFiles(root, snapshot).sort()).toEqual(["next-env.d.ts", "tsconfig.json"]);
    expect(readFileSync(path.join(root, "tsconfig.json")).equals(original)).toBe(true);
    expect(existsSync(path.join(root, "next-env.d.ts"))).toBe(false);
  });

  it("one run at a time: a live holder blocks, release frees the lock", () => {
    const root = tmpRoot();
    const first = lib.acquireLock(root, { runId: "a" });
    if (!first.ok) throw new Error("expected the lock");
    expect(JSON.parse(readFileSync(path.join(root, lib.LOCK_FILE), "utf8"))).toMatchObject({ pid: process.pid, runId: "a" });
    writeFileSync(path.join(root, lib.LOCK_FILE), JSON.stringify({ pid: 1, runId: "other", startedAt: new Date().toISOString() }));
    const second = lib.acquireLock(root, { runId: "b", alive: () => true });
    expect(second).toMatchObject({ ok: false, holder: { pid: 1, runId: "other" } });
    rmSync(path.join(root, lib.LOCK_FILE));
    const third = lib.acquireLock(root, { runId: "c" });
    if (!third.ok) throw new Error("expected the lock");
    third.release();
    expect(existsSync(path.join(root, lib.LOCK_FILE))).toBe(false);
  });

  it("a stale lock is recovered: its snapshot is restored only where the readiness rewrite is still present", () => {
    const root = tmpRoot();
    writeFileSync(path.join(root, "tsconfig.json"), "original tsconfig\n");
    writeFileSync(path.join(root, "next-env.d.ts"), "original env\n");
    const snapshot = lib.snapshotFiles(root);
    mkdirSync(path.join(root, "readiness"), { recursive: true });
    writeFileSync(path.join(root, lib.LOCK_FILE), JSON.stringify({ pid: 999_999, runId: "killed", startedAt: new Date().toISOString(), snapshot }));
    writeFileSync(path.join(root, "tsconfig.json"), "rewritten for .next-readiness\n");
    writeFileSync(path.join(root, "next-env.d.ts"), "edited by hand since\n");
    const lock = lib.acquireLock(root, { runId: "next", alive: () => false });
    if (!lock.ok) throw new Error("expected the stale lock to be taken over");
    expect(lock.recovered).toEqual(["tsconfig.json"]);
    expect(readFileSync(path.join(root, "tsconfig.json"), "utf8")).toBe("original tsconfig\n");
    expect(readFileSync(path.join(root, "next-env.d.ts"), "utf8")).toBe("edited by hand since\n");
    lock.release();
  });

  it("a lock older than the max age is stale even if its pid is alive", () => {
    const root = tmpRoot();
    mkdirSync(path.join(root, "readiness"), { recursive: true });
    const old = new Date(Date.now() - lib.LOCK_MAX_AGE_MS - 1000).toISOString();
    writeFileSync(path.join(root, lib.LOCK_FILE), JSON.stringify({ pid: 1, runId: "old", startedAt: old }));
    expect(lib.acquireLock(root, { runId: "new", alive: () => true }).ok).toBe(true);
  });

  it("prunes run scratch dirs to the newest N", () => {
    const root = tmpRoot();
    const ids = ["2026-10-07-10-00-00", "2026-10-07-11-00-00", "2026-10-07-12-00-00", "2026-10-07-13-00-00"];
    ids.forEach((id) => mkdirSync(path.join(root, lib.TMP_DIR, id), { recursive: true }));
    expect(lib.pruneTmp(root, 2)).toEqual(ids.slice(0, 2));
    expect(readdirSync(path.join(root, lib.TMP_DIR)).sort()).toEqual(ids.slice(2));
  });

  it("bundle scan env: the .env files a production build loads, in Next's precedence; the environment wins", () => {
    const root = tmpRoot();
    writeFileSync(path.join(root, ".env"), "A=from-env\nB=from-env\nC=from-env\n");
    writeFileSync(path.join(root, ".env.local"), "B=from-local\nC=from-local\n");
    writeFileSync(path.join(root, ".env.development.local"), "A=dev-only\n");
    const { env, files } = lib.withEnvFiles(root, { C: "from-process" });
    expect(files).toEqual([".env.local", ".env"]);
    expect(env).toEqual({ A: "from-env", B: "from-local", C: "from-process" });
  });

  it("detects a port that something is already listening on", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as net.AddressInfo;
    expect(await lib.portInUse(port)).toBe(true);
    await new Promise((resolve) => server.close(resolve));
    expect(await lib.portInUse(port)).toBe(false);
  });

  it("reads .next/BUILD_ID, or null when there is no build", () => {
    const root = tmpRoot();
    expect(lib.readBuildId(root)).toBeNull();
    mkdirSync(path.join(root, ".next"));
    writeFileSync(path.join(root, ".next", "BUILD_ID"), "abc123");
    expect(lib.readBuildId(root)).toBe("abc123");
  });
});
