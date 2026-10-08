"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { initialRunState, reduceRun, type RunState } from "./coverage";
import { readReadinessEvents } from "./ndjson";
import { runProbes } from "./probes";
import { runLiveEval } from "./liveEval";
import { parseNdjson, replay } from "./replay";
import { STAGE_INFO, type ReadinessEvent, type RunMeta, type StageId } from "./schema";
import { deleteSavedAssessment, loadSavedAssessments, saveAssessment, type SavedAssessment } from "./storage";

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
  /** "Include live answers": run the live answer eval in a local run (real tokens). Off by default. */
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
  /** A deployment's live checks: recorded gates shown at once, then the live eval (or skipped) and the live probes. */
  liveChecks?: boolean;
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

/** A recorded event of the live answer eval stage (dropped when a deployment runs its own eval), or the recorded run-end. */
function isLiveEvalEvent(e: ReadinessEvent): boolean {
  if (e.type === "run-end") return true;
  if (e.type === "test-result") return e.result.stage === "live-eval";
  return "stage" in e && e.stage === "live-eval";
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
  return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname) ? "local server" : "deployed";
}

export function useReadinessRun(options: ReadinessOptions) {
  const [state, setState] = useState<RunState>(() => initialRunState());
  const [session, setSession] = useState<RunSession>(() => idleSession(options.speed, options.includeAnswer));
  const [speed, setSpeed] = useState<ReplaySpeed>(options.speed);
  const [includeAnswer, setIncludeAnswer] = useState(options.includeAnswer);
  const [availability, setAvailability] = useState<RunnerAvailability | null>(null);
  const [savedRuns, setSavedRuns] = useState<SavedAssessment[]>([]);

  const stateRef = useRef<RunState>(state);
  const clockRef = useRef<Partial<Record<StageId, number>>>({});
  const controllerRef = useRef<AbortController | null>(null);
  const tokenRef = useRef(0);
  const frameRef = useRef<{ raf?: number; timer?: ReturnType<typeof setTimeout> }>({});
  const savedEventsRef = useRef<ReadinessEvent[]>([]);
  const savedIdRef = useRef<string | null>(null);

  const persistSaved = useCallback(
    (phase: SavedAssessment["phase"], endedAtMs?: number) => {
      const id = savedIdRef.current;
      if (!id || savedEventsRef.current.length === 0) return;
      const record: SavedAssessment = {
        id,
        savedAt: new Date().toISOString(),
        phase,
        startedAtMs: sessionStartedAtRef.current,
        endedAtMs,
        includeAnswer: includeAnswerRef.current,
        events: savedEventsRef.current,
      };
      const saved = saveAssessment(record);
      // Storage is updated for every event; the history list only needs occasional refreshes while a run is hot.
      if (phase !== "running" || savedEventsRef.current.length === 1 || savedEventsRef.current.length % 10 === 0) setSavedRuns(saved);
    },
    [],
  );

  const sessionStartedAtRef = useRef<number | undefined>(undefined);
  const includeAnswerRef = useRef(options.includeAnswer);
  useEffect(() => {
    includeAnswerRef.current = includeAnswer;
  }, [includeAnswer]);

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

  const saveEvent = useCallback(
    (event: ReadinessEvent) => {
      savedEventsRef.current = [...savedEventsRef.current, event];
      persistSaved("running");
    },
    [persistSaved],
  );

  const stop = useCallback(() => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    controllerRef.current = null;
    tokenRef.current += 1;
    ctrl.abort();
    flush();
    persistSaved("stopped", Date.now());
    setSession((s) =>
      s.phase === "connecting" || s.phase === "running" ? { ...s, phase: "stopped", endedAtMs: Date.now() } : s,
    );
  }, [flush, persistSaved]);

  const start = useCallback(async () => {
    if (controllerRef.current) persistSaved("stopped", Date.now());
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
    savedIdRef.current = `${runId(new Date(t0))}-${t0}`;
    savedEventsRef.current = [];
    sessionStartedAtRef.current = t0;
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
      saveEvent(e);
      if (e.type === "stage-start") clockRef.current = { ...clockRef.current, [e.stage]: Date.now() };
      stateRef.current = reduceRun(stateRef.current, e);
      schedule();
    };
    const patch = (p: Partial<RunSession>) => {
      if (live()) setSession((s) => ({ ...s, ...p }));
    };
    /** "Include live answers": the golden questions asked of this server for real (~170 answers, real tokens), else skipped. */
    const liveEvalStage = async (origin: string) => {
      if (runAnswer) return runLiveEval({ origin, signal }, push);
      const at = new Date().toISOString();
      push({ type: "stage-start", stage: "live-eval", at });
      const note = 'skipped: "Include live answers" is off, so no provider tokens were spent';
      push({ type: "stage-end", stage: "live-eval", status: "skipped", durationMs: 0, counts: { passed: 0, failed: 0, skipped: 0 }, source: "live", at, note });
    };

    try {
      let mode: RunMode | undefined = options.mode;
      let notice: string | undefined;
      if (!mode) {
        const avail = await fetchRunnerAvailability(signal);
        if (!live()) return;
        setAvailability(avail);
        // A deployment has no local runner: it shows the recorded gates and runs the live checks against itself.
        if (avail.available && !avail.running) mode = "local";
        else {
          mode = "replay";
          notice = avail.available ? "A local run is already in progress elsewhere, so this page shows the recorded gates and runs the live checks." : undefined;
        }
      }

      if (mode === "local") {
        patch({ mode, notice, phase: "running" });
        const res = await fetch(runAnswer ? RUN_ENDPOINT : `${RUN_ENDPOINT}?answers=0`, { method: "POST", cache: "no-store", signal });
        if (res.status === 404) {
          mode = "replay";
          notice = "The local runner is not available here, so this page shows the recorded gates and runs the live checks.";
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
        // Without an explicit mode=replay this is a deployment's live checks: the recorded gates appear at once, and the
        // recorded eval and verdict are dropped, because the eval runs live here (or is skipped) and the probes run live.
        const liveChecks = !options.mode;
        patch({
          liveChecks,
          recorded: {
            meta: recordedStart.meta,
            status: recordedEnd?.type === "run-end" ? recordedEnd.status : undefined,
            durationMs: recordedEnd?.type === "run-end" ? recordedEnd.durationMs : undefined,
          },
        });
        const shown = liveChecks ? events.filter((e) => !isLiveEvalEvent(e)) : events;
        await replay(shown, push, { speed: liveChecks || runSpeed === "instant" ? Infinity : runSpeed, signal, includeRunEnd: false });
        if (!live()) return;
        if (liveChecks) {
          await liveEvalStage(window.location.origin);
          if (!live()) return;
        }
        // The recorded producer's verdict counts too: a failed recorded run cannot turn green by replaying it. (Its
        // eval is not shown in live checks, so there the shown stages decide.)
        else if (recordedEnd?.type === "run-end") held.end = recordedEnd;
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
        push({ type: "run-start", meta, stages: [STAGE_INFO["live-eval"], STAGE_INFO.probes] });
        await liveEvalStage(origin);
        if (!live()) return;
      }

      if (mode === "probes" || options.probes) {
        const origin = window.location.origin;
        patch({ probeOrigin: origin });
        // The grounded-answer probe (one real question, ~3k tokens) always runs; the checkbox only switches the live eval.
        await runProbes({ origin, includeAnswer: true, signal }, push);
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
      const finalEvent: ReadinessEvent = {
        type: "run-end",
        status: failed ? "failed" : "passed",
        durationMs: ended - t0,
        at: new Date(ended).toISOString(),
      };
      saveEvent(finalEvent);
      flush();
      persistSaved("finished", ended);
      setSession((s) => ({ ...s, phase: "finished", endedAtMs: ended }));
      if (controllerRef.current === ctrl) controllerRef.current = null;
    } catch (err) {
      if (isAbort(err) || !live()) return;
      flush();
      const ended = Date.now();
      persistSaved("error", ended);
      setSession((s) => ({ ...s, phase: "error", error: errorText(err), endedAtMs: ended }));
      if (controllerRef.current === ctrl) controllerRef.current = null;
    }
  }, [flush, includeAnswer, options.mode, options.probes, persistSaved, saveEvent, schedule, speed]);

  const reviewSavedRun = useCallback(
    (record: SavedAssessment) => {
      controllerRef.current?.abort();
      tokenRef.current += 1;
      const next = record.events.reduce(reduceRun, initialRunState());
      const meta = record.events.find((event): event is Extract<ReadinessEvent, { type: "run-start" }> => event.type === "run-start")?.meta;
      const reviewPhase: Phase = record.phase === "running" ? "stopped" : record.phase;
      stateRef.current = next;
      savedEventsRef.current = record.events;
      savedIdRef.current = record.id;
      sessionStartedAtRef.current = record.startedAtMs;
      setState(next);
      setSession({
        ...idleSession("instant", record.includeAnswer),
        phase: reviewPhase,
        mode: meta?.mode ?? null,
        startedAtMs: record.startedAtMs,
        endedAtMs: record.endedAtMs,
        recorded: meta
          ? {
              meta,
              status: next.status === "passed" || next.status === "failed" ? next.status : undefined,
              durationMs: next.durationMs,
            }
          : undefined,
      });
    },
    [],
  );

  const removeSavedRun = useCallback((id: string) => setSavedRuns(deleteSavedAssessment(id)), []);

  // Without a run on load, label the Start button with what it will do. GET never spawns anything.
  useEffect(() => {
    setSavedRuns(loadSavedAssessments());
  }, []);

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

  return { state, session, start, stop, speed, setSpeed, includeAnswer, setIncludeAnswer, availability, savedRuns, reviewSavedRun, removeSavedRun };
}
