import type { ReadinessOptions, ReplaySpeed, RunMode } from "@/readiness/useReadinessRun";

type Query = Record<string, string | string[] | undefined>;

function first(q: Query, key: string): string | undefined {
  const v = q[key];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Query string → run options.
 * autostart=1 · mode=local|replay|probes · speed=1|4|instant (replay, default 4) · answer=1 (run a local
 * run's live answer eval with real tokens; it is off by default)
 * · probes=0 (skip the live probes after a local run or replay).
 */
export function parseReadinessOptions(q: Query): ReadinessOptions {
  const modeRaw = first(q, "mode");
  const mode: RunMode | undefined = modeRaw === "local" || modeRaw === "replay" || modeRaw === "probes" ? modeRaw : undefined;
  const speedRaw = first(q, "speed");
  const speed: ReplaySpeed = speedRaw === "1" ? 1 : speedRaw === "instant" ? "instant" : 4;
  return {
    autostart: first(q, "autostart") === "1",
    mode,
    speed,
    // "Include live answers", off by default: a local run's live answer eval spends real tokens. The checkbox or answer=1 turns it on.
    includeAnswer: first(q, "answer") === "1",
    probes: first(q, "probes") !== "0",
  };
}
