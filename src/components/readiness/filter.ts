import type { CheckView, RequirementView } from "@/readiness/coverage";
import type { TestResult } from "@/readiness/schema";

/** All · Failed · Live · Recorded, plus free-text search over requirement, check and test text. */
export type Filter = "all" | "failed" | "live" | "recorded";

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
  if (filter === "failed") return r.status === "failed";
  if (filter === "live") return r.source === "live";
  if (filter === "recorded") return r.source === "recorded";
  return true;
}

function checkPasses(c: CheckView, filter: Filter): boolean {
  if (filter === "all") return true;
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

export function filterCoverage(coverage: RequirementView[], filter: Filter, query: string): FilteredRequirement[] {
  const terms = tokens(query);
  const out: FilteredRequirement[] = [];
  for (const view of coverage) {
    const byFilter = view.checks.filter((c) => checkPasses(c, filter));
    const reqHit = terms.length > 0 && matches(requirementText(view), terms);
    if (terms.length === 0 || reqHit) {
      const failedReq = filter === "failed" && view.status === "failed";
      if (filter === "all" || byFilter.length > 0 || failedReq) out.push({ view, checks: byFilter, matchedInside: false });
      continue;
    }
    const inside = byFilter.filter((c) => matches(checkText(c), terms));
    if (inside.length > 0) out.push({ view, checks: inside, matchedInside: true });
  }
  return out;
}

export function countFor(coverage: RequirementView[], filter: Filter): number {
  return filterCoverage(coverage, filter, "").length;
}
