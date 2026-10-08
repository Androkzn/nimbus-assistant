import { describe, expect, it } from "vitest";
import type { CheckView, RequirementView } from "@/readiness/coverage";
import type { Check, Requirement } from "@/readiness/manifest";
import type { Status, TestResult } from "@/readiness/schema";
import { countFor, countsOf, filterCoverage } from "./filter";

const check = (id: string, status: Status, results: TestResult["status"][] = []): CheckView => ({
  check: { id, title: id, layer: "unit", stage: "unit", match: { id: `^${id}$` }, verifies: id, covers: [] } as Check,
  status,
  results: results.map((s, i) => ({ id: `${id}::${i}`, stage: "unit", file: "src/x.test.ts", fullName: `${id} ${i}`, status: s, durationMs: 1, source: "live" })),
});
const req = (id: string, status: Status, checks: CheckView[]): RequirementView => ({
  requirement: { id, group: "g", title: id, brd: [], acceptance: [], priority: "P1" } as Requirement,
  status,
  checks,
  sources: ["live"],
});

describe("Traceability filters count checks", () => {
  // One failed check shared by two requirements, one queued, one running, one passed.
  const failed = check("c-failed", "failed", ["failed"]);
  const coverage = [
    req("R1", "failed", [failed, check("c-queued", "pending")]),
    req("R2", "failed", [failed, check("c-running", "running")]),
    req("R3", "passed", [check("c-passed", "passed", ["passed"])]),
  ];

  it("All counts every distinct check once, even one that covers two requirements", () => {
    expect(countFor(coverage, "all")).toBe(4);
    expect(countsOf(filterCoverage(coverage, "failed", ""))).toEqual({ checks: 1, requirements: 2 });
  });

  it("while a run is in progress, queued and running checks are waiting, not needing improvement", () => {
    expect(countFor(coverage, "needs-improvement", false)).toBe(1);
  });

  it("once the run is over, a check still without a result has no evidence and needs improvement", () => {
    expect(countFor(coverage, "needs-improvement", true)).toBe(3);
  });

  it("a verified requirement never appears under Needs improvement", () => {
    const rows = filterCoverage(coverage, "needs-improvement", "", true).map((r) => r.view.requirement.id);
    expect(rows).not.toContain("R3");
  });
});
