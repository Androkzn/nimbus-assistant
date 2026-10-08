import { parseReadinessLine } from "./ndjson";
import type { ReadinessEvent, RunMeta } from "./schema";

/**
 * Replays a recorded run (`public/readiness/latest.ndjson`) as if it were streaming, so the page
 * renders it with the same code path as a live run — but every result is relabelled `recorded`
 * and the run keeps its original date and build (spec I7: recorded evidence never reads as live).
 */

/** Parses a recorded run, validating every line against the contract. Throws naming the first bad line. */
export function parseNdjson(text: string): ReadinessEvent[] {
  const events: ReadinessEvent[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line) events.push(parseReadinessLine(line, i + 1));
  });
  return events;
}

export interface ReplayOptions {
  /** 1 = recorded pace, 4 = four times faster, Infinity = no waiting. */
  speed: number;
  signal?: AbortSignal;
  /** Longest pause between two events after scaling (default 1200 ms), so a 60 s build doesn't stall the page. */
  maxGapMs?: number;
  /** Default true. The page passes false to run live probes before it shows the final verdict. */
  includeRunEnd?: boolean;
}

const DEFAULT_MAX_GAP_MS = 1200;

const toMs = (iso: string): number | null => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/**
 * Recorded time of each event. Stage and run events carry their own timestamps; test results don't,
 * so the k-th of K results in a stage is placed at k/K of the stage's recorded duration (arrival
 * order kept). test-start and log events get null: they follow the previous event without a pause.
 */
export function recordedTimeline(events: ReadinessEvent[]): (number | null)[] {
  const times: (number | null)[] = events.map(() => null);
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === "run-start") times[i] = toMs(e.meta.startedAt);
    else if (e.type === "stage-end" || e.type === "run-end") times[i] = toMs(e.at);
    else if (e.type === "stage-start") {
      const start = toMs(e.at);
      times[i] = start;
      const endIndex = events.findIndex((x, j) => j > i && x.type === "stage-end" && x.stage === e.stage);
      const end = endIndex < 0 ? null : (events[endIndex] as Extract<ReadinessEvent, { type: "stage-end" }>);
      const endMs = end ? toMs(end.at) : null;
      if (start === null || endMs === null) continue;
      const results: number[] = [];
      for (let j = i + 1; j < endIndex; j++) {
        const x = events[j];
        if (x.type === "test-result" && x.result.stage === e.stage) results.push(j);
      }
      const span = Math.max(0, endMs - start);
      results.forEach((j, k) => (times[j] = start + (span * (k + 1)) / results.length));
    }
  }
  return times;
}

/** Resolves true after `ms`, or false as soon as `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** "2026-10-07 20:41 UTC" — the label recorded stage results carry when the recording has no note of its own. */
function recordedLabel(meta: RunMeta | null): string {
  if (!meta) return "recorded";
  const t = toMs(meta.startedAt);
  const when = t === null ? meta.startedAt : `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return `recorded ${when} · build ${meta.build}`;
}

function relabel(e: ReadinessEvent, meta: RunMeta | null): ReadinessEvent {
  switch (e.type) {
    case "run-start":
      return { ...e, meta: { ...e.meta, mode: "replay" } };
    case "test-result":
      return { ...e, result: { ...e.result, source: "recorded" } };
    case "stage-end":
      return { ...e, source: "recorded", note: e.note ?? recordedLabel(meta) };
    default:
      return e;
  }
}

/**
 * Re-emits a recorded run at `speed`: pauses come from the recorded timestamps, are divided by
 * `speed` and capped at `maxGapMs`. Original durations, runId, startedAt and build are kept; run-start
 * says mode "replay", and every result and stage-end says source "recorded". Always asynchronous
 * (nothing is emitted before the first await). An abort stops promptly and resolves without throwing.
 */
export async function replay(events: ReadinessEvent[], emit: (e: ReadinessEvent) => void, opts: ReplayOptions): Promise<void> {
  const { speed, signal, maxGapMs = DEFAULT_MAX_GAP_MS, includeRunEnd = true } = opts;
  if (!(speed > 0)) throw new RangeError(`replay speed must be > 0 (got ${speed})`);
  const times = recordedTimeline(events);
  const meta = events.find((e): e is Extract<ReadinessEvent, { type: "run-start" }> => e.type === "run-start")?.meta ?? null;
  await Promise.resolve();
  let previous: number | null = null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (signal?.aborted) return;
    if (e.type === "run-end" && !includeRunEnd) continue;
    const t = times[i];
    const gap = t !== null && previous !== null ? Math.max(0, t - previous) : 0;
    if (t !== null) previous = t;
    const wait = Math.min(gap / speed, maxGapMs);
    if (wait > 0 && !(await sleep(wait, signal))) return;
    emit(relabel(e, meta));
  }
}
