import type { ReadinessOptions, ReplaySpeed, RunMode } from "@/readiness/useReadinessRun";

type Query = Record<string, string | string[] | undefined>;

function first(q: Query, key: string): string | undefined {
  const v = q[key];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Query string → run options.
 * autostart=1 · mode=local|replay|probes · speed=1|4|instant (replay, default 4)
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
    // The grounded-answer probe is part of every readiness assessment. It is one
    // required real-model check, so it is deliberately not user-configurable.
    includeAnswer: true,
    probes: first(q, "probes") !== "0",
  };
}
