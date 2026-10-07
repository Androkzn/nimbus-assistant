import { describe, expect, it } from "vitest";
import { computeCoverage, initialRunState, LOG_LIMIT, reduceRun, summarize, unclaimedResults, type RunState } from "./coverage";
import { manifest, type Check, type Manifest } from "./manifest";
import { ReadinessEventSchema, STAGE_INFO, type Counts, type ReadinessEvent, type RunMeta, type Source, type StageId, type StageInfo, type Status, type TestResult } from "./schema";

const AT = "2026-10-07T21:30:00.000Z";
const META: RunMeta = {
  runId: "2026-10-07-21-30-00",
  mode: "local",
  startedAt: AT,
  platform: "node v22.15.0 · darwin arm64",
  environment: "local working tree",
  build: "091ba66+dirty",
};

/** Every fixture event goes through the shared contract, so fixtures cannot drift from what producers send. */
const ev = (event: ReadinessEvent): ReadinessEvent => ReadinessEventSchema.parse(event);
const runStart = (stages: StageInfo[] = [STAGE_INFO.lint, STAGE_INFO.unit, STAGE_INFO.probes], meta: RunMeta = META) => ev({ type: "run-start", meta, stages });
const stageStart = (stage: StageId) => ev({ type: "stage-start", stage, at: AT });
const testStart = (stage: StageId, id: string) => ev({ type: "test-start", stage, id, file: "src/a.test.ts", fullName: id });
const stageEnd = (stage: StageId, status: Status, counts: Counts, source: Source = "live", note?: string) =>
  ev({ type: "stage-end", stage, status, durationMs: 1200, counts, source, at: AT, ...(note ? { note } : {}) });
const runEnd = (status: "passed" | "failed", durationMs = 5000) => ev({ type: "run-end", status, durationMs, at: AT });
const result = (r: Partial<TestResult> & Pick<TestResult, "id">) =>
  ev({ type: "test-result", result: { stage: "unit", file: "src/a.test.ts", fullName: r.id, status: "passed", durationMs: 5, source: "live", ...r } });
const run = (...events: ReadinessEvent[]): RunState => events.reduce(reduceRun, initialRunState());
const stage = (s: RunState, id: StageId) => s.stages.find((x) => x.info.id === id);

const check = (id: string, match: Check["match"], covers: string[], stageId: StageId = "unit"): Check => ({
  id,
  title: id,
  layer: "unit",
  stage: stageId,
  match,
  verifies: `${id} verifies something concrete.`,
  covers,
});

describe("reduceRun (06 §4 event protocol)", () => {
  it("starts idle with nothing recorded", () => {
    expect(initialRunState()).toEqual({ status: "idle", meta: null, stages: [], results: {}, resultOrder: [], running: {}, log: [] });
  });

  it("RDY-002: run-start lists the announced stages as pending and wipes the previous run", () => {
    const previous = run(runStart(), stageStart("lint"), result({ id: "gate::lint", stage: "lint" }), ev({ type: "log", stage: "lint", line: "ok" }), runEnd("passed"));
    const replay: RunMeta = { ...META, runId: "2026-10-07-20-41-15", mode: "replay" };
    expect(reduceRun(previous, runStart([STAGE_INFO.e2e], replay))).toEqual({
      status: "running",
      meta: replay,
      stages: [{ info: STAGE_INFO.e2e, status: "pending", source: "recorded", counts: { passed: 0, failed: 0, skipped: 0 } }],
      results: {},
      resultOrder: [],
      running: {},
      log: [],
    });
  });

  it("RDY-002: a stage-start for a stage run-start did not announce is appended from STAGE_INFO", () => {
    const s = run(runStart([STAGE_INFO.lint]), stageStart("probes"));
    expect(s.stages.map((x) => [x.info.id, x.status])).toEqual([
      ["lint", "pending"],
      ["probes", "running"],
    ]);
    expect(stage(s, "probes")).toMatchObject({ info: STAGE_INFO.probes, startedAt: AT, source: "live" });
  });

  it("RDY-002: a test is running from test-start until its result arrives", () => {
    const started = run(runStart(), stageStart("unit"), testStart("unit", "src/a.test.ts::t1"));
    expect(started.running).toEqual({ "src/a.test.ts::t1": { stage: "unit", file: "src/a.test.ts", fullName: "src/a.test.ts::t1" } });
    const finished = reduceRun(started, result({ id: "src/a.test.ts::t1" }));
    expect(finished.running).toEqual({});
    expect(finished.results["src/a.test.ts::t1"].status).toBe("passed");
  });

  it("RDY-002: a retried test's later result replaces the earlier one; the feed lists it once, latest last", () => {
    const s = run(
      runStart(),
      stageStart("unit"),
      result({ id: "t1", status: "failed", error: "expected 2 to be 3" }),
      result({ id: "t2" }),
      result({ id: "t1", status: "passed" }),
    );
    expect(s.results.t1).toMatchObject({ status: "passed" });
    expect(s.results.t1.error).toBeUndefined();
    expect(s.resultOrder).toEqual(["t2", "t1"]);
    expect(stage(s, "unit")?.counts).toEqual({ passed: 2, failed: 0, skipped: 0 });
  });

  it("RDY-003: a result for an unannounced stage appends it; recorded results mark it recorded", () => {
    const s = run(runStart([STAGE_INFO.unit]), result({ id: "eval::NKA-RET-005::claude-haiku", stage: "live-eval", source: "recorded" }));
    expect(stage(s, "live-eval")).toMatchObject({ info: STAGE_INFO["live-eval"], status: "running", source: "recorded", counts: { passed: 1, failed: 0, skipped: 0 } });
  });

  it("RDY-002: stage-end sets the verdict, counts, source and note, and drops that stage's unfinished tests", () => {
    const note = "recorded 2026-10-07 20:41 UTC · build 091ba66";
    const s = run(
      runStart(),
      stageStart("unit"),
      testStart("unit", "u1"),
      testStart("probes", "p1"),
      stageEnd("unit", "failed", { passed: 3, failed: 1, skipped: 0 }, "recorded", note),
    );
    expect(stage(s, "unit")).toMatchObject({ status: "failed", durationMs: 1200, counts: { passed: 3, failed: 1, skipped: 0 }, source: "recorded", note });
    expect(Object.keys(s.running)).toEqual(["p1"]);
  });

  it("keeps only the last 200 log lines", () => {
    const lines = Array.from({ length: 205 }, (_, i) => ev({ type: "log", stage: "build", line: `line ${i}` }));
    const s = run(runStart(), ...lines);
    expect(LOG_LIMIT).toBe(200);
    expect(s.log).toHaveLength(200);
    expect(s.log[0]).toEqual({ stage: "build", line: "line 5" });
    expect(s.log.at(-1)).toEqual({ stage: "build", line: "line 204" });
  });

  it("RDY-003: run-end settles the run; a failed stage keeps it failed even when later probes report passed", () => {
    expect(run(runStart(), stageStart("lint"), stageEnd("lint", "passed", { passed: 1, failed: 0, skipped: 0 }), runEnd("passed"))).toMatchObject({
      status: "passed",
      durationMs: 5000,
    });

    const replayed = [runStart(), stageStart("unit"), stageEnd("unit", "failed", { passed: 3, failed: 1, skipped: 0 }, "recorded"), runEnd("failed")];
    expect(run(...replayed, stageStart("probes")).status).toBe("running");
    expect(run(...replayed, stageStart("probes"), stageEnd("probes", "passed", { passed: 9, failed: 0, skipped: 0 }), runEnd("passed")).status).toBe("failed");
  });

  it("never mutates the state or the event it is given", () => {
    const deepFreeze = <T>(value: T): T => {
      if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        Object.values(value).forEach(deepFreeze);
      }
      return value;
    };
    const events = [
      runStart(),
      stageStart("unit"),
      testStart("unit", "t1"),
      result({ id: "t1", status: "failed" }),
      result({ id: "t1", status: "passed" }),
      ev({ type: "log", stage: "unit", line: "1 passed" }),
      stageEnd("unit", "passed", { passed: 1, failed: 0, skipped: 0 }),
      runEnd("passed"),
    ].map(deepFreeze);
    let state = deepFreeze(initialRunState());
    for (const event of events) {
      const before = JSON.stringify(state);
      const next = reduceRun(state, event); // frozen input: any write would throw in strict mode
      expect(JSON.stringify(state)).toBe(before);
      state = deepFreeze(next);
    }
    expect(state).toMatchObject({ status: "passed", resultOrder: ["t1"] });
  });
});

describe("computeCoverage (06 §5 status rules)", () => {
  // f1: a pass and a failure · f2: a pass and a skip · f3: only skips · lint gate: no result, stage running · probe: no result, stage pending
  const statusManifest: Manifest = {
    version: "test",
    requirements: [
      { id: "R-FAILED", group: "g", title: "has a failing check", brd: [], acceptance: [], priority: "P0" },
      { id: "R-VERIFIED", group: "g", title: "a passing check, the rest pending", brd: [], acceptance: [], priority: "P0" },
      { id: "R-RUNNING", group: "g", title: "a running check, nothing settled", brd: [], acceptance: [], priority: "P1" },
      { id: "R-PENDING", group: "g", title: "only skipped and pending checks", brd: [], acceptance: [], priority: "P2" },
    ],
    checks: [
      check("c-fail", { file: "src/f1.test.ts" }, ["R-FAILED"]),
      check("c-pass", { file: "src/f2.test.ts" }, ["R-FAILED", "R-VERIFIED"]),
      check("c-skip", { file: "src/f3.test.ts" }, ["R-PENDING"]),
      check("c-running", { id: "^gate::lint$" }, ["R-RUNNING"], "lint"),
      check("c-pending", { id: "^probe::health$" }, ["R-VERIFIED", "R-RUNNING", "R-PENDING"], "probes"),
    ],
  };
  const state = run(
    runStart(),
    stageStart("unit"),
    result({ id: "f1::a", file: "src/f1.test.ts" }),
    result({ id: "f1::b", file: "src/f1.test.ts", status: "failed", error: "expected 'Custom' to be '$35'" }),
    result({ id: "f2::a", file: "src/f2.test.ts" }),
    result({ id: "f2::b", file: "src/f2.test.ts", status: "skipped" }),
    result({ id: "f3::a", file: "src/f3.test.ts", status: "skipped" }),
    result({ id: "f3::b", file: "src/f3.test.ts", status: "skipped" }),
    stageEnd("unit", "failed", { passed: 2, failed: 1, skipped: 3 }),
    stageStart("lint"),
  );
  const views = computeCoverage(statusManifest, state);

  it("RDY-004: a check fails on any failure, passes on a pass with no failure, is skipped only when every result skipped", () => {
    const checkStatus = Object.fromEntries(views.flatMap((v) => v.checks).map((c) => [c.check.id, c.status]));
    expect(checkStatus).toEqual({ "c-fail": "failed", "c-pass": "passed", "c-skip": "skipped", "c-running": "running", "c-pending": "pending" });
    expect(views[0].checks.find((c) => c.check.id === "c-fail")?.results.map((r) => r.id)).toEqual(["f1::a", "f1::b"]);
  });

  it("RDY-004: a requirement is Verified only with a passing check and no failing one; skips never verify", () => {
    expect(views.map((v) => [v.requirement.id, v.status])).toEqual([
      ["R-FAILED", "failed"],
      ["R-VERIFIED", "passed"],
      ["R-RUNNING", "running"],
      ["R-PENDING", "pending"],
    ]);
  });

  it("RDY-004: a check covers a requirement through any of its acceptance ids", () => {
    const m: Manifest = {
      version: "test",
      requirements: [{ id: "E6", group: "g", title: "table value", brd: ["BR-07"], acceptance: ["NKA-RET-004", "NKA-RET-005"], priority: "P1" }],
      checks: [check("by-row", { file: "src/a.test.ts" }, ["NKA-RET-005"]), check("unrelated", { file: "src/b.test.ts" }, ["NKA-RET-001"])],
    };
    const [e6] = computeCoverage(m, run(runStart(), result({ id: "a::t" })));
    expect(e6.checks.map((c) => c.check.id)).toEqual(["by-row"]);
    expect(e6.status).toBe("passed");
  });

  it("RDY-003: maps real results onto the real manifest, keeping recorded and live evidence apart", () => {
    const s = run(
      runStart([STAGE_INFO["live-eval"], STAGE_INFO.probes]),
      result({ id: "eval::NKA-RET-005::claude-haiku", stage: "live-eval", file: "evals/reports/2026-10-07-21-16-33/results.json", fullName: "NKA-RET-005 — What is the Relay Enterprise P1 SLA?", source: "recorded" }),
      result({ id: "probe::health", stage: "probes", file: "https://nimbus.example", fullName: "Health" }),
      result({ id: "probe::bundle-keys", stage: "probes", file: "https://nimbus.example", fullName: "Served JS key scan", status: "failed", error: "chunks/app.js: Anthropic key pattern" }),
    );
    const byId = Object.fromEntries(computeCoverage(manifest, s).map((v) => [v.requirement.id, v]));
    expect(byId.E6).toMatchObject({ status: "passed", sources: ["recorded"] });
    expect(byId.D1).toMatchObject({ status: "passed", sources: ["live"] });
    expect(byId["AF-KEY"]).toMatchObject({ status: "failed", sources: ["live"] });
    expect(byId["AF-KEY"].checks.find((c) => c.check.id === "probe.bundle-keys")?.results[0].error).toBe("chunks/app.js: Anthropic key pattern");
    expect(byId.Q1.status).toBe("pending");
  });
});

describe("summarize and unclaimedResults", () => {
  const m: Manifest = {
    version: "test",
    requirements: [
      { id: "REQ-A", group: "g", title: "A", brd: [], acceptance: ["ACC-1"], priority: "P0" },
      { id: "REQ-B", group: "g", title: "B", brd: [], acceptance: [], priority: "P1" },
      { id: "REQ-C", group: "g", title: "C", brd: [], acceptance: [], priority: "P2" },
    ],
    checks: [
      check("file-check", { file: "src/a.test.ts" }, ["ACC-1"]),
      check("named-check", { file: "src/b.test.ts", name: "^suite › NKA-1" }, ["REQ-B"]),
      check("lint-gate", { id: "^gate::lint$" }, ["REQ-B"], "lint"),
      check("health-probe", { id: "^probe::health$" }, ["REQ-C"], "probes"),
    ],
  };
  const state = run(
    runStart(),
    stageStart("unit"),
    result({ id: "src/a.test.ts::t1" }),
    result({ id: "src/b.test.ts::suite › NKA-1 works", file: "src/b.test.ts", fullName: "suite › NKA-1 works", status: "failed" }),
    result({ id: "eval::NKA-X::claude-haiku", stage: "live-eval", file: "evals/reports/x/results.json", source: "recorded" }),
    result({ id: "src/c.test.ts::t", file: "src/c.test.ts", status: "skipped", source: "recorded" }),
  );

  it("RDY-004: counts requirements, checks and tests, with live and recorded results apart", () => {
    expect(summarize(m, state)).toEqual({
      status: "running",
      requirements: { total: 3, verified: 1, failed: 1, pending: 1 },
      checks: { total: 4, passed: 1, failed: 1, pending: 2 },
      tests: { passed: 2, failed: 1, skipped: 1, live: 2, recorded: 2 },
    });
  });

  it("RDY-004: lists results no check claims, in arrival order", () => {
    expect(unclaimedResults(m, state).map((r) => r.id)).toEqual(["eval::NKA-X::claude-haiku", "src/c.test.ts::t"]);
  });
});
