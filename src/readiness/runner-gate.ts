/**
 * Gate for the process-spawning readiness endpoint (docs/requirements/06_Readiness_Report.md §2, I3 / I5; RDY-005).
 * Pure functions so every branch is unit-tested; the route does the I/O.
 * Showcase-only: nothing in the chat path imports this (I1).
 */

export interface RunnerAvailability {
  available: boolean;
  /** Why the runner is unavailable; shown on the page. */
  reason?: string;
}

/**
 * The runner exists only on a developer machine: under `next dev`, or when explicitly enabled with
 * READINESS_RUNNER=1 (e.g. `next start` locally) — and never on Vercel, whatever else is set.
 */
export function runnerAvailability(env: Record<string, string | undefined>): RunnerAvailability {
  if (env.VERCEL) {
    return { available: false, reason: "Disabled on Vercel: the runner spawns local build and test processes, so it only runs on a developer machine." };
  }
  if (env.NODE_ENV === "development" || env.READINESS_RUNNER === "1") return { available: true };
  return { available: false, reason: "Available only under `next dev`, or with READINESS_RUNNER=1 on a local machine." };
}

/** Written by scripts/readiness/run.mjs while a run is in progress (same path as LOCK_FILE in scripts/readiness/lib.mjs). */
export const RUN_LOCK_FILE = "readiness/.run.lock";
/** Same as LOCK_MAX_AGE_MS in scripts/readiness/lib.mjs: an older lock is stale even if its pid was reused. */
export const RUN_LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * Pid of the run that holds the lock, or null when there is no lock or it is stale (process gone, too old, unreadable).
 * @param lockText contents of RUN_LOCK_FILE, or null when the file does not exist
 */
export function liveLockHolder(lockText: string | null, isAlive: (pid: number) => boolean, now: number = Date.now()): number | null {
  if (!lockText) return null;
  let lock: unknown;
  try {
    lock = JSON.parse(lockText);
  } catch {
    return null;
  }
  if (typeof lock !== "object" || lock === null) return null;
  const { pid, startedAt } = lock as { pid?: unknown; startedAt?: unknown };
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  const started = typeof startedAt === "string" ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(started) || now - started >= RUN_LOCK_MAX_AGE_MS) return null;
  return isAlive(pid) ? pid : null;
}
