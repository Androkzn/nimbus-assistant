"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { initialRunState, reduceRun, type RunState } from "./coverage";
import { readReadinessEvents } from "./ndjson";
import { runProbes } from "./probes";
import { parseNdjson, replay } from "./replay";
import { STAGE_INFO, type ReadinessEvent, type RunMeta, type StageId } from "./schema";

/**
 * Orchestrates the readiness page's evidence sources (docs/requirements/06_Readiness_Report.md §3):
 * - local:  POST /api/readiness/run, an NDJSON stream of the CI gates run now (dev / READINESS_RUNNER=1 only);
 * - replay: public/readiness/latest.ndjson, the last published local run, relabelled "recorded" (spec I7);
 * - probes: requests sent from this browser to this origin, always live.
 * Local and replay runs are followed by the live probes; the producer's run-end is held back and the page
 * dispatches the final one, so the verdict covers everything that ran.
 *
 * Events are reduced eagerly into a ref (reduceRun is pure and cheap) and published to React at most once
 * per animation frame, so a burst of ~250 results costs a handful of renders.
 */

export type RunMode = "local" | "replay" | "probes";
export type ReplaySpeed = 1 | 4 | "instant";

export interface ReadinessOptions {
  /** Start on mount (the header button opens /readiness?autostart=1). */
  autostart: boolean;
  /** Explicit source; without it the page asks the runner endpoint and falls back to replay. */
  mode?: RunMode;
  speed: ReplaySpeed;
  /** Opt-in probe: one real model call (~1.5k tokens). */
  includeAnswer: boolean;
  /** Append the live probes after a local run or a replay (default true). */
  probes: boolean;
}

export type Phase = "idle" | "connecting" | "running" | "finished" | "stopped" | "error";

export interface RecordedRun {
  meta: RunMeta;
  status?: "passed" | "failed";
  durationMs?: number;
}

export interface RunSession {
  phase: Phase;
  /** The source actually used for this run (after availability checks and fallbacks). */
  mode: RunMode | null;
  /** Why the page used a different source than asked, in plain words. */
  notice?: string;
  error?: string;
  startedAtMs?: number;
  endedAtMs?: number;
  /** Replay speed this run used. */
  speed: ReplaySpeed;
  includeAnswer: boolean;
  /** Present when the gates come from a recorded run. */
  recorded?: RecordedRun;
  /** Origin the live probes ran against, once they start. */
  probeOrigin?: string;
  /** Wall-clock time (Date.now()) the page saw each stage start: drives the ticking durations. */
  stageClock: Partial<Record<StageId, number>>;
}

export interface RunnerAvailability {
  available: boolean;
  running: boolean;
  reason?: string;
}

const RUN_ENDPOINT = "/api/readiness/run";
const RECORDED_RUN = "/readiness/latest.ndjson";

function idleSession(speed: ReplaySpeed, includeAnswer: boolean): RunSession {
  return { phase: "idle", mode: null, speed, includeAnswer, stageClock: {} };
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException ? err.name === "AbortError" : (err as { name?: string })?.name === "AbortError";
}

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}

/** "2026-10-07-21-30-00" from a Date, the runner's run-id format. */
function runId(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}-${p(d.getUTCMinutes())}-${p(d.getUTCSeconds())}`;
}

/** "browser · Chrome 141 · macOS" — enough to say where a probe-only run came from, nothing identifying. */
export function browserPlatform(ua: string): string {
  const browser =
    /Edg\/(\d+)/.exec(ua)?.[1] !== undefined
      ? `Edge ${/Edg\/(\d+)/.exec(ua)?.[1]}`
      : /Firefox\/(\d+)/.test(ua)
        ? `Firefox ${/Firefox\/(\d+)/.exec(ua)?.[1]}`
        : /Chrome\/(\d+)/.test(ua)
          ? `Chrome ${/Chrome\/(\d+)/.exec(ua)?.[1]}`
          : /Version\/(\d+).*Safari/.test(ua)
            ? `Safari ${/Version\/(\d+)/.exec(ua)?.[1]}`
            : "browser";
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : undefined;
  return ["browser", browser === "browser" ? undefined : browser, os].filter(Boolean).join(" · ");
}

export async function fetchRunnerAvailability(signal?: AbortSignal): Promise<RunnerAvailability> {
  try {
    const res = await fetch(RUN_ENDPOINT, { method: "GET", cache: "no-store", signal });
    if (!res.ok) return { available: false, running: false, reason: res.status === 404 ? "not available on this deployment" : `HTTP ${res.status}` };
    const body = (await res.json()) as Partial<RunnerAvailability>;
    return { available: body.available === true, running: body.running === true, reason: body.reason };
  } catch (err) {
    if (isAbort(err)) throw err;
    return { available: false, running: false, reason: "runner endpoint unreachable" };
  }
}

/** Build id for a probe-only run: what /api/health reports, else a plain label. */
async function probeBuild(signal: AbortSignal): Promise<string> {
  try {
    const res = await fetch("/api/health", { cache: "no-store", signal });
    if (res.ok) {
      const body = (await res.json()) as { build?: unknown; commit?: unknown };
      if (typeof body.build === "string" && body.build) return body.build;
      if (typeof body.commit === "string" && body.commit) return body.commit;
    }
  } catch (err) {
    if (isAbort(err)) throw err;
  }
  return "deployed";
}

export function useReadinessRun(options: ReadinessOptions) {
  const [state, setState] = useState<RunState>(() => initialRunState());
  const [session, setSession] = useState<RunSession>(() => idleSession(options.speed, options.includeAnswer));
  const [speed, setSpeed] = useState<ReplaySpeed>(options.speed);
  const [includeAnswer, setIncludeAnswer] = useState(options.includeAnswer);
  const [availability, setAvailability] = useState<RunnerAvailability | null>(null);

  const stateRef = useRef<RunState>(state);
  const clockRef = useRef<Partial<Record<StageId, number>>>({});
  const controllerRef = useRef<AbortController | null>(null);
  const tokenRef = useRef(0);
  const frameRef = useRef<{ raf?: number; timer?: ReturnType<typeof setTimeout> }>({});

  /** Publish the ref state to React; the rAF path keeps renders to one per frame, the timer covers hidden tabs. */
  const flush = useCallback(() => {
    const f = frameRef.current;
    if (f.raf !== undefined) cancelAnimationFrame(f.raf);
    if (f.timer !== undefined) clearTimeout(f.timer);
    frameRef.current = {};
    setState(stateRef.current);
    const clock = clockRef.current;
    setSession((s) => (s.stageClock === clock ? s : { ...s, stageClock: clock }));
  }, []);

  const schedule = useCallback(() => {
    const f = frameRef.current;
    if (f.raf !== undefined || f.timer !== undefined) return;
    f.raf = requestAnimationFrame(flush);
    f.timer = setTimeout(flush, 150);
  }, [flush]);

  const stop = useCallback(() => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    controllerRef.current = null;
    tokenRef.current += 1;
    ctrl.abort();
    flush();
    setSession((s) =>
      s.phase === "connecting" || s.phase === "running" ? { ...s, phase: "stopped", endedAtMs: Date.now() } : s,
    );
  }, [flush]);

  const start = useCallback(async () => {
    controllerRef.current?.abort();
    const ctrl = new AbortController();
    controllerRef.current = ctrl;
    const token = ++tokenRef.current;
    const { signal } = ctrl;
    const live = () => tokenRef.current === token && !signal.aborted;

    const t0 = Date.now();
    const runSpeed = speed;
    const runAnswer = includeAnswer;
    stateRef.current = initialRunState();
    clockRef.current = {};
    setState(stateRef.current);
    setSession({ ...idleSession(runSpeed, runAnswer), phase: "connecting", startedAtMs: t0 });

    // The producer's own run-end, held back until the live probes have run too.
    const held: { end: Extract<ReadinessEvent, { type: "run-end" }> | null } = { end: null };
    const push = (e: ReadinessEvent) => {
      if (!live()) return;
      if (e.type === "run-end") {
        held.end = e;
        return;
      }
      if (e.type === "stage-start") clockRef.current = { ...clockRef.current, [e.stage]: Date.now() };
      stateRef.current = reduceRun(stateRef.current, e);
      schedule();
    };
    const patch = (p: Partial<RunSession>) => {
      if (live()) setSession((s) => ({ ...s, ...p }));
    };

    try {
      let mode: RunMode | undefined = options.mode;
      let notice: string | undefined;
      if (!mode) {
        const avail = await fetchRunnerAvailability(signal);
        if (!live()) return;
        setAvailability(avail);
        if (avail.available && !avail.running) mode = "local";
        else {
          mode = "replay";
          notice = avail.available
            ? "A local run is already in progress elsewhere, so this page replays the last recorded run."
            : undefined;
        }
      }

      if (mode === "local") {
        patch({ mode, notice, phase: "running" });
        const res = await fetch(RUN_ENDPOINT, { method: "POST", cache: "no-store", signal });
        if (res.status === 404) {
          mode = "replay";
          notice = "The local runner is not available here, so this page replays the last recorded run.";
        } else if (res.status === 409) {
          throw new Error("Another readiness run is already in progress on this machine. Wait for it to finish, then re-run.");
        } else if (!res.ok || !res.body) {
          throw new Error(`The local runner answered HTTP ${res.status}.`);
        } else {
          for await (const event of readReadinessEvents(res.body)) {
            if (!live()) break;
            push(event);
          }
          if (!live()) return;
          if (!held.end) throw new Error("The runner stream ended before the run finished.");
        }
      }

      if (mode === "replay") {
        patch({ mode, notice, phase: "running" });
        const res = await fetch(RECORDED_RUN, { cache: "no-store", signal });
        if (!res.ok) throw new Error(res.status === 404 ? "No recorded run has been published yet." : `Couldn't load the recorded run (HTTP ${res.status}).`);
        const events = parseNdjson(await res.text());
        const recordedStart = events.find((e) => e.type === "run-start");
        const recordedEnd = events.find((e) => e.type === "run-end");
        if (!recordedStart || recordedStart.type !== "run-start") throw new Error("The recorded run has no run-start event.");
        patch({
          recorded: {
            meta: recordedStart.meta,
            status: recordedEnd?.type === "run-end" ? recordedEnd.status : undefined,
            durationMs: recordedEnd?.type === "run-end" ? recordedEnd.durationMs : undefined,
          },
        });
        await replay(events, push, { speed: runSpeed === "instant" ? Infinity : runSpeed, signal, includeRunEnd: false });
        if (!live()) return;
        // The recorded producer's verdict counts too: a failed recorded run cannot turn green by replaying it.
        if (recordedEnd?.type === "run-end") held.end = recordedEnd;
      }

      if (mode === "probes") {
        patch({ mode, notice, phase: "running" });
        const origin = window.location.origin;
        const meta: RunMeta = {
          runId: runId(new Date(t0)),
          mode: "probes",
          startedAt: new Date(t0).toISOString(),
          platform: browserPlatform(navigator.userAgent),
          environment: origin,
          build: await probeBuild(signal),
        };
        if (!live()) return;
        push({ type: "run-start", meta, stages: [STAGE_INFO.probes] });
      }

      if (mode === "probes" || options.probes) {
        const origin = window.location.origin;
        patch({ probeOrigin: origin });
        await runProbes({ origin, includeAnswer: runAnswer, signal }, push);
        if (!live()) return;
      }

      const final = stateRef.current;
      const failed = final.stages.some((s) => s.status === "failed") || held.end?.status === "failed";
      const ended = Date.now();
      stateRef.current = reduceRun(final, {
        type: "run-end",
        status: failed ? "failed" : "passed",
        durationMs: ended - t0,
        at: new Date(ended).toISOString(),
      });
      flush();
      setSession((s) => ({ ...s, phase: "finished", endedAtMs: ended }));
      if (controllerRef.current === ctrl) controllerRef.current = null;
    } catch (err) {
      if (isAbort(err) || !live()) return;
      flush();
      setSession((s) => ({ ...s, phase: "error", error: errorText(err), endedAtMs: Date.now() }));
      if (controllerRef.current === ctrl) controllerRef.current = null;
    }
  }, [flush, includeAnswer, options.mode, options.probes, schedule, speed]);

  // Without a run on load, label the Start button with what it will do. GET never spawns anything.
  useEffect(() => {
    if (options.mode || options.autostart) return;
    const ctrl = new AbortController();
    fetchRunnerAvailability(ctrl.signal).then(setAvailability, () => undefined);
    return () => ctrl.abort();
  }, [options.mode, options.autostart]);

  // Run once on load when asked to (autostart=1, or an explicit mode). The timer makes a StrictMode
  // mount/unmount/mount start a single run: nothing — least of all the POST that spawns a local run —
  // leaves the page before the real mount.
  const startRef = useRef(start);
  useEffect(() => {
    startRef.current = start;
  }, [start]);
  useEffect(() => {
    if (!options.autostart && !options.mode) return;
    const timer = setTimeout(() => void startRef.current(), 0);
    return () => clearTimeout(timer);
  }, [options.autostart, options.mode]);

  // Leaving the page stops whatever is running (a local run stops server-side when its stream is aborted).
  useEffect(
    () => () => {
      tokenRef.current += 1;
      controllerRef.current?.abort();
      const f = frameRef.current;
      if (f.raf !== undefined) cancelAnimationFrame(f.raf);
      if (f.timer !== undefined) clearTimeout(f.timer);
    },
    [],
  );

  return { state, session, start, stop, speed, setSpeed, includeAnswer, setIncludeAnswer, availability };
}
