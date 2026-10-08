import type { CheckView, RequirementView } from "@/readiness/coverage";
import type { TestResult } from "@/readiness/schema";

/**
 * All · Needs improvement · Failed · Live · Recorded · Skipped, plus free-text search over requirement, check and test
 * text. Every tab except Skipped counts only the checks in this run, the same number the progress bar uses: a check
 * that was not evaluated (its stage was skipped, e.g. the live answer eval with "Include live answers" off) is under
 * Skipped.
 */
export type Filter = "needs-improvement" | "failed" | "live" | "recorded" | "skipped" | "all";

export interface FilteredRequirement {
  view: RequirementView;
  /** The checks to show under this filter and query. */
  checks: CheckView[];
  /** True when the query matched a check or test rather than the requirement itself (rows open to show it). */
  matchedInside: boolean;
}

export function tokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function matches(haystack: string, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const h = haystack.toLowerCase();
  return terms.every((t) => h.includes(t));
}

export function resultPasses(r: TestResult, filter: Filter): boolean {
  if (filter === "needs-improvement") return r.status !== "passed";
  if (filter === "failed") return r.status === "failed";
  if (filter === "live") return r.source === "live";
  if (filter === "recorded") return r.source === "recorded";
  if (filter === "skipped") return r.status === "skipped";
  return true;
}

/**
 * Needs improvement = a failed or skipped result, or no evidence once the run is over. A check that is queued or
 * running while the run is in progress is only waiting, so it does not count.
 */
function needsImprovement(c: CheckView, settled: boolean): boolean {
  if (c.status === "failed" || c.results.some((r) => r.status === "failed")) return true;
  return settled && (c.status === "pending" || c.status === "running");
}

function checkPasses(c: CheckView, filter: Filter, settled: boolean): boolean {
  if (filter === "skipped") return c.status === "skipped";
  if (c.status === "skipped") return false;
  if (filter === "all") return true;
  if (filter === "needs-improvement") return needsImprovement(c, settled);
  if (filter === "failed") return c.status === "failed" || c.results.some((r) => r.status === "failed");
  return c.results.some((r) => resultPasses(r, filter));
}

function requirementText(v: RequirementView): string {
  const r = v.requirement;
  return [r.id, r.group, r.title, r.detail ?? "", r.priority, ...r.brd, ...r.acceptance].join(" ");
}

function checkText(c: CheckView): string {
  const k = c.check;
  return [k.id, k.title, k.verifies, k.layer, k.stage, ...k.covers, ...c.results.flatMap((r) => [r.id, r.fullName, r.file])].join(" ");
}

export function resultText(r: TestResult, verifies: string[]): string {
  return [r.id, r.fullName, r.file, r.stage, ...verifies].join(" ");
}

/** @param settled the run is over (finished, stopped or failed to run): a check still without a result has no evidence. */
export function filterCoverage(coverage: RequirementView[], filter: Filter, query: string, settled = true): FilteredRequirement[] {
  const terms = tokens(query);
  const out: FilteredRequirement[] = [];
  for (const view of coverage) {
    // A verified requirement can contain optional or supporting checks without
    // needing improvement. Keep this filter aligned with the requirement badge,
    // otherwise VERIFIED rows appear under "Needs improvement".
    if (filter === "needs-improvement" && view.status === "passed") continue;
    const byFilter = view.checks.filter((c) => checkPasses(c, filter, settled));
    const reqHit = terms.length > 0 && matches(requirementText(view), terms);
    if (terms.length === 0 || reqHit) {
      const failedReq = filter === "failed" && view.status === "failed";
      if (filter === "all" || byFilter.length > 0 || failedReq) {
        out.push({ view, checks: byFilter, matchedInside: false });
      }
      continue;
    }
    const inside = byFilter.filter((c) => matches(checkText(c), terms));
    if (inside.length > 0) out.push({ view, checks: inside, matchedInside: true });
  }
  return out;
}

/** Distinct checks and requirements in a filtered list. A check that covers two requirements counts once. */
export function countsOf(items: FilteredRequirement[]): { checks: number; requirements: number } {
  return { checks: new Set(items.flatMap((i) => i.checks.map((c) => c.check.id))).size, requirements: items.length };
}

/** A tab's count, in checks: the unit of the headline ("162 of 174 checks complete") and the Checks card. */
export function countFor(coverage: RequirementView[], filter: Filter, settled = true): number {
  return countsOf(filterCoverage(coverage, filter, "", settled)).checks;
}
