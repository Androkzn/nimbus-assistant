import { describe, expect, it } from "vitest";
import { retrieve } from "../retrieval/retrieve";
import { buildFinding, mergeFinding } from "./googleDrive";

describe("privacy-safe daily findings", () => {
  it("classifies weather as an out-of-scope statistic without retaining the question", () => {
    const finding = buildFinding({
      requestId: "req-1",
      observedAt: "2026-10-07T12:00:00.000Z",
      retrieval: retrieve("Tell me about weather?"),
      modelOutcome: "done",
      unverifiedFigureCount: 0,
    });
    expect(finding).toMatchObject({ category: "out_of_scope", reason: "out_of_scope", status: "new", affectedProducts: [] });
    expect(JSON.stringify(finding)).not.toContain("weather");
  });

  it("classifies an undocumented API status as a documentation gap", () => {
    const finding = buildFinding({
      requestId: "req-api-500",
      observedAt: "2026-10-07T12:01:00.000Z",
      retrieval: retrieve("A client is getting a 500 on the API. What should they check first?"),
      modelOutcome: "done",
      unverifiedFigureCount: 0,
    });
    expect(finding).toMatchObject({ category: "documentation_gap", reason: "unsupported_troubleshooting_status", evidence: { troubleshootingStatus: "500" } });
  });

  it("increments an existing daily finding instead of creating another row", () => {
    const finding = buildFinding({
      requestId: "req-weather-2",
      observedAt: "2026-10-07T12:02:00.000Z",
      retrieval: retrieve("Tell me about weather?"),
      modelOutcome: "done",
      unverifiedFigureCount: 0,
    });
    if (!finding) throw new Error("expected a finding");
    const first = mergeFinding(null, finding, "2026-10-07", "nimbus-assistant-production", "2026-10-07T12:02:01.000Z");
    const second = mergeFinding(first, { ...finding, requestId: "req-weather-3" }, "2026-10-07", "nimbus-assistant-production", "2026-10-07T12:03:01.000Z");
    expect(second.findings).toHaveLength(1);
    expect(second.findings[0]).toMatchObject({ occurrences: 2, sampleRequestId: "req-weather-3" });
    expect(second.totals).toMatchObject({ observations: 2, outOfScope: 2, documentationGaps: 0, clarificationNeeded: 0 });
  });

  it("does not create a finding for an answerable request", () => {
    const finding = buildFinding({
      requestId: "req-answerable",
      observedAt: "2026-10-07T12:04:00.000Z",
      retrieval: retrieve("What is Relay's support SLA?"),
      modelOutcome: "done",
      unverifiedFigureCount: 0,
    });
    expect(finding).toBeNull();
  });
});
