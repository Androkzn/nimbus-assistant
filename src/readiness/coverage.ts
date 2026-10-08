import { checksFor, isReadinessTooling, type Check, type Manifest, type Requirement } from "./manifest";
import {
  SourceSchema,
  STAGE_INFO,
  type Counts,
  type ReadinessEvent,
  type RunMeta,
  type Source,
  type StageId,
  type StageInfo,
  type Status,
  type TestResult,
} from "./schema";

/**
 * Pure state for the /readiness page: folds the NDJSON event stream (spec §4) into one run, then maps the
 * results onto the traceability manifest (spec §5). No I/O and no clock, so a live run, a replayed run and
 * the tests all go through the same code.
 */

export interface StageState {
  info: StageInfo;
  status: Status;
  source: Source;
  durationMs?: number;
  counts: Counts;
  /** Results the stage expects (stage-total), when its producer announced them. */
  total?: number;
  note?: string;
  startedAt?: string;
}

export interface RunState {
  status: "idle" | "running" | "passed" | "failed";
  meta: RunMeta | null;
  /** Run order; a stage the run-start didn't announce is appended from STAGE_INFO. */
  stages: StageState[];
  /** By result id; a later result with the same id (a retry) replaces the earlier one. */
  results: Record<string, TestResult>;
  /** Result ids in arrival order for the live feed, no duplicates (a replaced result moves to the end). */
  resultOrder: string[];
  /** test-start seen, no result yet. */
  running: Record<string, { stage: StageId; file: string; fullName: string }>;
  /** Last LOG_LIMIT lines. */
  log: { stage: StageId; line: string }[];
  durationMs?: number;
}

export interface CheckView {
  check: Check;
  status: Status;
  results: TestResult[];
}

export interface RequirementView {
  requirement: Requirement;
  status: Status;
  checks: CheckView[];
  sources: Source[];
}

export interface Summary {
  status: RunState["status"];
  requirements: { total: number; verified: number; failed: number; pending: number };
  /** skipped: not evaluated in this run (their stage was skipped, or only skipped results); not counted as missing. */
  checks: { total: number; passed: number; failed: number; skipped: number; pending: number };
  tests: { passed: number; failed: number; skipped: number; live: number; recorded: number };
}

export interface UsageSummary {
  /** Number of measured model/guard answers represented by result details. */
  answers: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

export const LOG_LIMIT = 200;

const ENDED: ReadonlySet<Status> = new Set<Status>(["passed", "failed", "skipped"]);

export function initialRunState(): RunState {
  return { status: "idle", meta: null, stages: [], results: {}, resultOrder: [], running: {}, log: [] };
}

/** Until a stage reports its own source, assume the run's: a replayed run is recorded evidence (spec I7). */
function defaultSource(meta: RunMeta | null): Source {
  return meta?.mode === "replay" ? "recorded" : "live";
}

function freshStage(info: StageInfo, meta: RunMeta | null): StageState {
  return { info, status: "pending", source: defaultSource(meta), counts: { passed: 0, failed: 0, skipped: 0 } };
}

/** Copy of `stages` with stage `id` replaced by `fn(stage)`; an unannounced stage is appended first. */
function updateStage(stages: StageState[], meta: RunMeta | null, id: StageId, fn: (s: StageState) => StageState): StageState[] {
  const i = stages.findIndex((s) => s.info.id === id);
  if (i === -1) return [...stages, fn(freshStage(STAGE_INFO[id], meta))];
  return stages.map((s, j) => (j === i ? fn(s) : s));
}

function bump(counts: Counts, status: TestResult["status"], by: 1 | -1): Counts {
  return { ...counts, [status]: Math.max(0, counts[status] + by) };
}

function without<T>(record: Record<string, T>, drop: (key: string, value: T) => boolean): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key, value]) => !drop(key, value)));
}

/** Applies one event. Pure: returns a new state and never mutates `state` or `event`. */
export function reduceRun(state: RunState, event: ReadinessEvent): RunState {
  switch (event.type) {
    case "run-start":
      return {
        ...initialRunState(),
        status: "running",
        meta: event.meta,
        stages: event.stages.map((info) => freshStage(info, event.meta)),
      };

    case "stage-start":
      // A stage that starts after run-end (probes after a replayed run) puts the run back to running.
      return {
        ...state,
        status: "running",
        stages: updateStage(state.stages, state.meta, event.stage, (s) => ({ ...s, status: "running", startedAt: event.at })),
      };

    case "stage-total":
      return { ...state, stages: updateStage(state.stages, state.meta, event.stage, (s) => ({ ...s, total: event.total })) };

    // The report verifies the product only: results of its own tests (e.g. in an older recorded run) are ignored.
    case "test-start":
      if (isReadinessTooling(event.file)) return state;
      return {
        ...state,
        stages: updateStage(state.stages, state.meta, event.stage, (s) => (s.status === "pending" ? { ...s, status: "running" } : s)),
        running: { ...state.running, [event.id]: { stage: event.stage, file: event.file, fullName: event.fullName } },
      };

    case "test-result": {
      const result = event.result;
      if (isReadinessTooling(result.file)) return state;
      const previous = state.results[result.id];
      let stages = state.stages;
      if (previous) stages = updateStage(stages, state.meta, previous.stage, (s) => ({ ...s, counts: bump(s.counts, previous.status, -1) }));
      stages = updateStage(stages, state.meta, result.stage, (s) => ({
        ...s,
        status: s.status === "pending" ? "running" : s.status,
        // Once stage-end has spoken, its source is final.
        source: ENDED.has(s.status) ? s.source : result.source,
        counts: bump(s.counts, result.status, 1),
      }));
      return {
        ...state,
        stages,
        results: { ...state.results, [result.id]: result },
        resultOrder: [...state.resultOrder.filter((id) => id !== result.id), result.id],
        running: without(state.running, (id) => id === result.id),
      };
    }

    case "log":
      return { ...state, log: [...state.log, { stage: event.stage, line: event.line }].slice(-LOG_LIMIT) };

    case "stage-end":
      return {
        ...state,
        stages: updateStage(state.stages, state.meta, event.stage, (s) => ({
          ...s,
          status: event.status,
          durationMs: event.durationMs,
          counts: { ...event.counts },
          source: event.source,
          note: event.note,
        })),
        running: without(state.running, (_id, test) => test.stage === event.stage),
      };

    case "run-end": {
      // A failed stage keeps the run failed even if a later producer (probes after a replay) reports "passed".
      const failed = event.status === "failed" || state.stages.some((s) => s.status === "failed");
      return { ...state, status: failed ? "failed" : "passed", durationMs: event.durationMs, running: {} };
    }
  }
}

function checkStatus(results: TestResult[], stage: Status | undefined): Status {
  if (results.some((r) => r.status === "failed")) return "failed";
  if (results.some((r) => r.status === "passed")) return "passed";
  if (results.length > 0) return "skipped";
  // A stage skipped on purpose (e.g. the live answer eval with "Include live answers" off) leaves its checks skipped,
  // not pending: they were never meant to run, so they are not missing.
  if (stage === "skipped") return "skipped";
  return stage === "running" ? "running" : "pending";
}

function requirementStatus(checks: CheckView[]): Status {
  if (checks.some((c) => c.status === "failed")) return "failed";
  if (checks.some((c) => c.status === "passed")) return "passed";
  if (checks.some((c) => c.status === "running")) return "running";
  return "pending";
}

function coversRequirement(check: Check, requirement: Requirement): boolean {
  return check.covers.some((id) => id === requirement.id || requirement.acceptance.includes(id));
}

/** Every check with the results it claims (in arrival order) and its status. */
function checkViews(m: Manifest, state: RunState): Map<string, CheckView> {
  const matched = new Map<string, TestResult[]>(m.checks.map((c) => [c.id, []]));
  for (const id of state.resultOrder) {
    const result = state.results[id];
    if (result) for (const check of checksFor(result, m)) matched.get(check.id)?.push(result);
  }
  const stageStatus = new Map(state.stages.map((s) => [s.info.id, s.status]));
  return new Map(
    m.checks.map((check) => {
      const results = matched.get(check.id) ?? [];
      return [check.id, { check, status: checkStatus(results, stageStatus.get(check.stage)), results }];
    }),
  );
}

function coverageFrom(m: Manifest, views: Map<string, CheckView>): RequirementView[] {
  return m.requirements.map((requirement) => {
    const checks = m.checks.filter((c) => coversRequirement(c, requirement)).flatMap((c) => views.get(c.id) ?? []);
    const seen = new Set(checks.flatMap((c) => c.results.map((r) => r.source)));
    return { requirement, status: requirementStatus(checks), checks, sources: SourceSchema.options.filter((s) => seen.has(s)) };
  });
}

/** Requirement by requirement: Verified (passed) when ≥1 check passed and none failed (spec §5). */
export function computeCoverage(m: Manifest, state: RunState): RequirementView[] {
  return coverageFrom(m, checkViews(m, state));
}

export function summarize(m: Manifest, state: RunState): Summary {
  const views = checkViews(m, state);
  const requirements = coverageFrom(m, views);
  const checks = [...views.values()];
  const results = state.resultOrder.flatMap((id) => state.results[id] ?? []);
  const count = <T>(items: T[], pick: (item: T) => boolean) => items.filter(pick).length;

  const verified = count(requirements, (r) => r.status === "passed");
  const failedRequirements = count(requirements, (r) => r.status === "failed");
  const passedChecks = count(checks, (c) => c.status === "passed");
  const failedChecks = count(checks, (c) => c.status === "failed");
  const skippedChecks = count(checks, (c) => c.status === "skipped");
  return {
    status: state.status,
    requirements: { total: requirements.length, verified, failed: failedRequirements, pending: requirements.length - verified - failedRequirements },
    checks: { total: checks.length, passed: passedChecks, failed: failedChecks, skipped: skippedChecks, pending: checks.length - passedChecks - failedChecks - skippedChecks },
    tests: {
      passed: count(results, (r) => r.status === "passed"),
      failed: count(results, (r) => r.status === "failed"),
      skipped: count(results, (r) => r.status === "skipped"),
      live: count(results, (r) => r.source === "live"),
      recorded: count(results, (r) => r.source === "recorded"),
    },
  };
}

/** Adds usage emitted by probes and recorded live-eval results, without double-counting retries. */
export function usageSummary(state: RunState): UsageSummary {
  return state.resultOrder.reduce<UsageSummary>(
    (total, id) => {
      const detail = state.results[id]?.detail;
      const inputTokens = typeof detail?.inputTokens === "number" ? detail.inputTokens : 0;
      const outputTokens = typeof detail?.outputTokens === "number" ? detail.outputTokens : 0;
      const costUSD = typeof detail?.costUSD === "number" ? detail.costUSD : 0;
      const measured = detail?.inputTokens !== undefined || detail?.outputTokens !== undefined || detail?.costUSD !== undefined;
      return {
        answers: total.answers + (measured ? 1 : 0),
        inputTokens: total.inputTokens + inputTokens,
        outputTokens: total.outputTokens + outputTokens,
        costUSD: total.costUSD + costUSD,
      };
    },
    { answers: 0, inputTokens: 0, outputTokens: 0, costUSD: 0 },
  );
}

/** Results no check claims, in arrival order: evidence that proves nothing yet (spec §5, no orphan tests). */
export function unclaimedResults(m: Manifest, state: RunState): TestResult[] {
  return state.resultOrder.flatMap((id) => {
    const result = state.results[id];
    return result && checksFor(result, m).length === 0 ? [result] : [];
  });
}
