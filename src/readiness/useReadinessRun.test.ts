import { describe, expect, it } from "vitest";
import { initialRunState } from "./coverage";
import { STAGE_INFO } from "./schema";
import { liveFailureEvidence } from "./useReadinessRun";

describe("live Readiness failure reporting", () => {
  it("keeps recorded failures out of newly detected Dev issues", () => {
    const state = {
      ...initialRunState(),
      results: {
        live: { id: "probe.health", stage: "probes" as const, file: "src/readiness/probes.ts", fullName: "Health", status: "failed" as const, durationMs: 1, source: "live" as const },
        recorded: { id: "eval.old", stage: "live-eval" as const, file: "evals/results.json", fullName: "Old evaluation", status: "failed" as const, durationMs: 1, source: "recorded" as const },
      },
      stages: [
        { info: STAGE_INFO.probes, status: "failed" as const, source: "live" as const, counts: { passed: 0, failed: 1, skipped: 0 } },
        { info: STAGE_INFO["live-eval"], status: "failed" as const, source: "recorded" as const, counts: { passed: 0, failed: 1, skipped: 0 } },
      ],
    };

    expect(liveFailureEvidence(state)).toEqual({ failedChecks: ["probe.health"], failedStages: ["probes"] });
  });
});
