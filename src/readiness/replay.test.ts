import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseNdjson, recordedTimeline, replay } from "./replay";
import { ReadinessEventSchema, type ReadinessEvent, type TestResult } from "./schema";

const T0 = Date.parse("2026-10-07T20:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const result = (id: string, stage: TestResult["stage"], durationMs: number): ReadinessEvent => ({
  type: "test-result",
  result: { id, stage, file: "src/x.test.ts", fullName: id, status: "passed", durationMs, source: "live" },
});
const counts = (passed: number) => ({ passed, failed: 0, skipped: 0 });

/** A recorded local run: an 8 s typecheck gate, then 4 unit tests over 2 s. */
const RECORDED: ReadinessEvent[] = [
  {
    type: "run-start",
    meta: { runId: "2026-10-07-20-00-00", mode: "local", startedAt: at(0), platform: "node v22.15.0 · darwin arm64", environment: "local working tree", build: "091ba66" },
    stages: [],
  },
  { type: "stage-start", stage: "typecheck", at: at(500) },
  result("gate::typecheck", "typecheck", 7900),
  { type: "stage-end", stage: "typecheck", status: "passed", durationMs: 8000, counts: counts(1), source: "live", at: at(8500) },
  { type: "stage-start", stage: "unit", at: at(8600) },
  { type: "test-start", stage: "unit", id: "a", file: "src/x.test.ts", fullName: "a" },
  result("a", "unit", 12),
  result("b", "unit", 340),
  { type: "log", stage: "unit", line: "retrieval eval: 41/41" },
  result("c", "unit", 5),
  result("d", "unit", 77),
  { type: "stage-end", stage: "unit", status: "passed", durationMs: 2000, counts: counts(4), source: "live", at: at(10_600), note: "4 files" },
  { type: "run-end", status: "passed", durationMs: 10_700, at: at(10_700) },
];

/** Recorded pause before each event (ms): stage events from `at`, results spread over their stage, the rest 0. */
const RECORDED_GAPS = [0, 500, 8000, 0, 100, 0, 500, 500, 0, 500, 500, 0, 100];

async function play(opts: Parameters<typeof replay>[2], events = RECORDED) {
  const emitted: { event: ReadinessEvent; t: number }[] = [];
  const start = Date.now();
  const done = replay(events, (event) => emitted.push({ event, t: Date.now() - start }), opts);
  await vi.runAllTimersAsync();
  await done;
  return emitted;
}

describe("replay of a recorded run (spec I7, RDY-003)", () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date("2026-10-08T09:00:00.000Z") }));
  afterEach(() => vi.useRealTimers());

  it("derives pauses from recorded timestamps, spreading a stage's results across its duration", () => {
    const times = recordedTimeline(RECORDED);
    const gaps: number[] = [];
    let previous: number | null = null;
    for (const t of times) {
      gaps.push(t !== null && previous !== null ? t - previous : 0);
      if (t !== null) previous = t;
    }
    expect(gaps).toEqual(RECORDED_GAPS);
  });

  it("I7: relabels every result and stage-end as recorded and keeps the run's date, build and durations", async () => {
    const out = (await play({ speed: Infinity })).map((e) => e.event);
    expect(out).toHaveLength(RECORDED.length);
    const start = out[0];
    expect(start).toMatchObject({ type: "run-start", meta: { mode: "replay", runId: "2026-10-07-20-00-00", startedAt: "2026-10-07T20:00:00.000Z", build: "091ba66" } });
    const results = out.filter((e) => e.type === "test-result");
    expect(results.map((e) => [e.result.id, e.result.source, e.result.durationMs])).toEqual([
      ["gate::typecheck", "recorded", 7900],
      ["a", "recorded", 12],
      ["b", "recorded", 340],
      ["c", "recorded", 5],
      ["d", "recorded", 77],
    ]);
    const ends = out.filter((e) => e.type === "stage-end");
    expect(ends.map((e) => [e.stage, e.source, e.durationMs, e.note])).toEqual([
      ["typecheck", "recorded", 8000, "recorded 2026-10-07 20:00 UTC · build 091ba66"],
      ["unit", "recorded", 2000, "4 files"],
    ]);
    expect(out.filter((e) => JSON.stringify(e).includes('"live"'))).toEqual([]);
    for (const e of out) expect(ReadinessEventSchema.parse(e)).toEqual(e);
  });

  it("scales pauses by speed and caps each at maxGapMs (default 1200 ms)", async () => {
    const expectAt = (speed: number, cap: number) => {
      let t = 0;
      return RECORDED_GAPS.map((gap) => (t += Math.min(gap / speed, cap)));
    };
    expect((await play({ speed: 1 })).map((e) => e.t)).toEqual(expectAt(1, 1200));
    expect((await play({ speed: 2 })).map((e) => e.t)).toEqual(expectAt(2, 1200));
    // The 8 s typecheck gate at 4x is 2 s, capped to 300 ms; the 100 ms gaps become 25 ms.
    expect((await play({ speed: 4, maxGapMs: 300 })).map((e) => e.t)).toEqual([0, 125, 425, 425, 450, 450, 575, 700, 700, 825, 950, 950, 975]);
  });

  it("fits a long recording into maxTotalMs at 4x (default 12 s) by shrinking every pause evenly", async () => {
    // A 5-minute live answer eval: 170 results, about 1.8 s apart, so 4x alone would take about 76 s.
    const many: ReadinessEvent[] = [
      { type: "run-start", meta: { runId: "r", mode: "local", startedAt: at(0), platform: "p", environment: "e", build: "b" }, stages: [] },
      { type: "stage-start", stage: "live-eval", at: at(0) },
      ...Array.from({ length: 170 }, (_, k) => result(`eval::c${k}::m`, "live-eval", 1000)),
      { type: "stage-end", stage: "live-eval", status: "passed", durationMs: 310_000, counts: counts(170), source: "live", at: at(310_000) },
      { type: "run-end", status: "passed", durationMs: 310_000, at: at(310_000) },
    ];
    const emitted: number[] = [];
    const started = Date.now();
    const done = replay(many, () => emitted.push(Date.now() - started), { speed: 4 });
    await vi.advanceTimersByTimeAsync(20_000);
    await done;
    expect(emitted).toHaveLength(many.length);
    expect(emitted.at(-1)).toBeLessThanOrEqual(12_001);
    expect(emitted.at(-1)).toBeGreaterThan(11_000);
  });

  it("speed Infinity never waits but still emits asynchronously", async () => {
    const emitted: ReadinessEvent[] = [];
    const done = replay(RECORDED, (e) => emitted.push(e), { speed: Infinity });
    expect(emitted).toHaveLength(0);
    await done;
    expect(emitted).toHaveLength(RECORDED.length);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("includeRunEnd false holds back the recorded run-end so the page can add live probes first", async () => {
    const out = (await play({ speed: Infinity, includeRunEnd: false })).map((e) => e.event.type);
    expect(out).toHaveLength(RECORDED.length - 1);
    expect(out).not.toContain("run-end");
    expect(out.at(-1)).toBe("stage-end");
  });

  it("an abort stops promptly mid-pause and resolves without throwing", async () => {
    const ctrl = new AbortController();
    const emitted: ReadinessEvent[] = [];
    const done = replay(RECORDED, (e) => emitted.push(e), { speed: 1, signal: ctrl.signal });
    await vi.advanceTimersByTimeAsync(600); // run-start, typecheck stage-start; now inside the capped 1200 ms pause
    expect(emitted.map((e) => e.type)).toEqual(["run-start", "stage-start"]);
    ctrl.abort();
    await expect(done).resolves.toBeUndefined();
    await vi.runAllTimersAsync();
    expect(emitted).toHaveLength(2);
  });

  it("rejects a non-positive speed", async () => {
    await expect(replay(RECORDED, () => {}, { speed: 0 })).rejects.toThrow("replay speed must be > 0 (got 0)");
  });
});

describe("parseNdjson (spec §4 contract)", () => {
  it("parses a recorded file line by line, skipping blank lines", () => {
    const text = RECORDED.map((e) => JSON.stringify(e)).join("\n\n") + "\n";
    expect(parseNdjson(text)).toEqual(RECORDED);
  });

  it("names the line of an event that breaks the contract", () => {
    const lines = RECORDED.slice(0, 2).map((e) => JSON.stringify(e));
    lines.push(JSON.stringify({ type: "stage-start", stage: "deploy", at: at(0) }));
    expect(() => parseNdjson(lines.join("\n"))).toThrow(/^line 3: breaks the readiness event contract — stage: /);
  });
});
