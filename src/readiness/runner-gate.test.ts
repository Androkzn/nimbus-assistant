import { describe, expect, it } from "vitest";
import { liveLockHolder, RUN_LOCK_MAX_AGE_MS, runnerAvailability } from "./runner-gate";

// RDY-005 / I3: the process-spawning endpoint exists only on a developer machine.
describe("runnerAvailability (I3, RDY-005)", () => {
  it("is available under next dev", () => {
    expect(runnerAvailability({ NODE_ENV: "development" })).toEqual({ available: true });
  });

  it("is available outside dev only when READINESS_RUNNER=1 (e.g. a local next start)", () => {
    expect(runnerAvailability({ NODE_ENV: "production", READINESS_RUNNER: "1" })).toEqual({ available: true });
  });

  it("is unavailable in a production server, with a reason", () => {
    const gate = runnerAvailability({ NODE_ENV: "production" });
    expect(gate.available).toBe(false);
    expect(gate.reason).toMatch(/next dev.*READINESS_RUNNER=1/);
  });

  it("is unavailable with an empty environment", () => {
    expect(runnerAvailability({}).available).toBe(false);
  });

  it("accepts only the exact value READINESS_RUNNER=1", () => {
    for (const value of ["true", "yes", "0", ""]) {
      expect(runnerAvailability({ NODE_ENV: "production", READINESS_RUNNER: value }).available).toBe(false);
    }
  });

  it("is never available on Vercel, even with READINESS_RUNNER=1", () => {
    const gate = runnerAvailability({ VERCEL: "1", NODE_ENV: "production", READINESS_RUNNER: "1" });
    expect(gate.available).toBe(false);
    expect(gate.reason).toMatch(/Vercel/);
  });

  it("is never available on Vercel, even in development (vercel dev)", () => {
    expect(runnerAvailability({ VERCEL: "1", NODE_ENV: "development" }).available).toBe(false);
  });

  it("treats an empty VERCEL as unset", () => {
    expect(runnerAvailability({ VERCEL: "", NODE_ENV: "development" }).available).toBe(true);
  });
});

// I5: one run at a time — the route answers 409 while the runner's lock is held by a live process.
describe("liveLockHolder (I5)", () => {
  const now = Date.parse("2026-10-07T21:30:00Z");
  const lock = (pid: unknown, startedAt: unknown = new Date(now - 60_000).toISOString()) => JSON.stringify({ pid, runId: "r", startedAt });
  const alive = () => true;
  const dead = () => false;

  it("returns null when there is no lock file", () => {
    expect(liveLockHolder(null, alive, now)).toBeNull();
  });

  it("returns the pid of a fresh lock whose process is alive", () => {
    expect(liveLockHolder(lock(4242), alive, now)).toBe(4242);
  });

  it("treats a lock whose process is gone as stale", () => {
    expect(liveLockHolder(lock(4242), dead, now)).toBeNull();
  });

  it("treats a lock older than the max age as stale even if the pid is alive (pid reuse)", () => {
    const old = new Date(now - RUN_LOCK_MAX_AGE_MS).toISOString();
    expect(liveLockHolder(lock(4242, old), alive, now)).toBeNull();
  });

  it("treats unreadable or malformed locks as stale", () => {
    for (const text of ["{", "null", "42", lock("4242"), lock(-1), lock(1.5), lock(4242, "yesterday"), JSON.stringify({ pid: 4242 })]) {
      expect(liveLockHolder(text, alive, now)).toBeNull();
    }
  });
});
