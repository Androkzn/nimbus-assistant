"use client";

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { computeCoverage, summarize, unclaimedResults } from "@/readiness/coverage";
import { checksFor, manifest } from "@/readiness/manifest";
import { STAGE_INFO, type TestResult } from "@/readiness/schema";
import { useReadinessRun, type ReadinessOptions } from "@/readiness/useReadinessRun";
import { countFor, filterCoverage, resultPasses, resultText, tokens, type Filter } from "./filter";
import { LiveFeed, type ResultContext, type RunningTest } from "./LiveFeed";
import { MetaRow } from "./MetaRow";
import { MethodPanel } from "./MethodPanel";
import { ReportHeader } from "./ReportHeader";
import { RunControls } from "./RunControls";
import { StagePipeline } from "./StagePipeline";
import { TraceabilityMatrix } from "./TraceabilityMatrix";
import { verdictOf } from "./verdict";
import { VerdictPanel, type GroupStat } from "./VerdictPanel";

/** Wall clock for ticking durations; only ticks while a run is in flight. */
function useNow(active: boolean, intervalMs = 250): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [active, intervalMs]);
  return now;
}

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "failed", label: "Failed" },
  { id: "live", label: "Live" },
  { id: "recorded", label: "Recorded" },
];

export function ReadinessReport({ options }: { options: ReadinessOptions }) {
  const run = useReadinessRun(options);
  const { state, session } = run;
  const active = session.phase === "connecting" || session.phase === "running";
  const now = useNow(active);

  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);

  // One coverage pass per published state (at most one per animation frame while streaming).
  const coverage = useMemo(() => computeCoverage(manifest, state), [state]);
  const summary = useMemo(() => summarize(manifest, state), [state]);
  const unclaimed = useMemo(() => unclaimedResults(manifest, state), [state]);
  const verdict = verdictOf(summary, session, coverage);
  const groupStats = useMemo(() => {
    const out: GroupStat[] = [];
    for (const v of coverage) {
      let g = out.find((x) => x.name === v.requirement.group);
      if (!g) out.push((g = { name: v.requirement.group, total: 0, verified: 0, failed: 0 }));
      g.total += 1;
      if (v.status === "passed") g.verified += 1;
      if (v.status === "failed") g.failed += 1;
    }
    return out;
  }, [coverage]);

  // check id → requirement ids, as the coverage computed it.
  const checkRequirements = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const view of coverage) {
      for (const c of view.checks) {
        const list = map.get(c.check.id) ?? [];
        if (!list.includes(view.requirement.id)) list.push(view.requirement.id);
        map.set(c.check.id, list);
      }
    }
    return map;
  }, [coverage]);

  const contexts = useMemo(() => {
    const map = new Map<string, ResultContext>();
    for (const id of state.resultOrder) {
      const r = state.results[id];
      if (!r) continue;
      const checks = checksFor(r, manifest);
      const reqIds = [...new Set(checks.flatMap((c) => checkRequirements.get(c.id) ?? []))];
      map.set(id, { verifies: checks[0]?.verifies, layer: checks[0]?.layer ?? STAGE_INFO[r.stage].layer, requirementIds: reqIds });
    }
    return map;
  }, [state.resultOrder, state.results, checkRequirements]);

  const contextFor = (r: TestResult): ResultContext =>
    contexts.get(r.id) ?? { layer: STAGE_INFO[r.stage].layer, requirementIds: [] };

  const allResults = useMemo(
    () => state.resultOrder.map((id) => state.results[id]).filter((r): r is TestResult => Boolean(r)),
    [state.resultOrder, state.results],
  );

  const terms = tokens(deferredQuery);
  const feedResults = useMemo(() => {
    const t = tokens(deferredQuery);
    return allResults.filter((r) => {
      if (!resultPasses(r, filter)) return false;
      if (t.length === 0) return true;
      const ctx = contexts.get(r.id);
      const hay = resultText(r, [ctx?.verifies ?? "", ...(ctx?.requirementIds ?? [])]).toLowerCase();
      return t.every((x) => hay.includes(x));
    });
  }, [allResults, filter, deferredQuery, contexts]);

  const matrixItems = useMemo(() => filterCoverage(coverage, filter, deferredQuery), [coverage, filter, deferredQuery]);
  const filterCounts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.id, countFor(coverage, f.id)])) as Record<Filter, number>,
    [coverage],
  );

  const running: RunningTest[] = useMemo(
    () => Object.entries(state.running).map(([id, t]) => ({ id, stage: t.stage, file: t.file, fullName: t.fullName })),
    [state.running],
  );

  const elapsedMs =
    session.startedAtMs === undefined ? undefined : (session.endedAtMs ?? Math.max(now, session.startedAtMs)) - session.startedAtMs;
  const probesPlanned = session.mode === "probes" || options.probes;

  return (
    <div className="rdy-root flex min-h-dvh w-full flex-col bg-canvas">
      <ReportHeader session={session} meta={state.meta} />

      <main className="mx-auto w-full max-w-[1440px] flex-1 space-y-6 px-4 py-5 sm:px-6 sm:py-6 lg:space-y-7 lg:px-8 lg:py-7">
        <MetaRow meta={state.meta} session={session} elapsedMs={elapsedMs} />

        {session.notice && (
          <p role="status" className="rounded-xl border border-[var(--rdy-warn-line)] bg-[var(--rdy-warn-bg)] px-4 py-2.5 text-[13.5px] text-text">
            {session.notice}
          </p>
        )}
        {session.phase === "error" && session.error && (
          <p role="alert" className="rounded-xl border border-[var(--rdy-fail-line)] bg-[var(--rdy-fail-bg)] px-4 py-2.5 text-[13.5px] text-text">
            <span className="font-semibold text-[var(--rdy-fail)]">The run did not finish. </span>
            {session.error}
          </p>
        )}

        <VerdictPanel
          verdict={verdict}
          summary={summary}
          session={session}
          elapsedMs={elapsedMs}
          groups={groupStats}
          controls={
            <RunControls
              session={session}
              mode={options.mode}
              probes={options.probes}
              availability={run.availability}
              speed={run.speed}
              onSpeed={run.setSpeed}
              includeAnswer={run.includeAnswer}
              onIncludeAnswer={run.setIncludeAnswer}
              onStart={() => void run.start()}
              onStop={run.stop}
            />
          }
        />

        <StagePipeline stages={state.stages} session={session} now={now} probesPlanned={probesPlanned} />

        <section aria-labelledby="trace-heading" className="min-w-0">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="trace-heading" className="font-display text-[17px] font-bold tracking-[-0.01em] text-text">
              Traceability
            </h2>
            <p className="text-[12.5px] text-muted">Brief item → BRD → acceptance row → automated check → test result.</p>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <div role="group" aria-label="Filter results" className="inline-flex max-w-full flex-wrap rounded-xl border border-border bg-surface p-1">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={filter === f.id}
                  data-testid={`filter-${f.id}`}
                  onClick={() => setFilter(f.id)}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-semibold transition-colors ${
                    filter === f.id ? "bg-navy text-on-navy dark:bg-navy-3" : "text-muted hover:bg-orange-soft hover:text-orange-ink"
                  }`}
                >
                  {f.label}
                  <span className={`text-[11.5px] tabular-nums ${filter === f.id ? "text-on-navy-muted" : "text-muted/80"}`}>
                    {filterCounts[f.id]}
                  </span>
                </button>
              ))}
            </div>
            <label className="relative min-w-0 flex-1 basis-60 sm:max-w-md">
              <span className="sr-only">Search requirements, checks and tests</span>
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" strokeLinecap="round" />
              </svg>
              <input
                type="search"
                data-testid="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search requirements, checks, tests…"
                className="h-10 w-full rounded-xl border border-border bg-surface pr-3 pl-9 text-[13.5px] text-text placeholder:text-muted/80 focus:border-orange-strong focus:outline-none"
              />
            </label>
          </div>

          <div className="mt-4 grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(340px,420px)] lg:gap-6">
            <TraceabilityMatrix items={matrixItems} filter={filter} searching={terms.length > 0} />
            <div className="order-first min-w-0 lg:sticky lg:top-4 lg:order-none">
              <LiveFeed
                results={feedResults}
                totalResults={allResults.length}
                running={running}
                contextFor={contextFor}
                active={active}
                filtered={filter !== "all" || terms.length > 0}
              />
            </div>
          </div>
        </section>

        <MethodPanel unclaimed={unclaimed} requirementCount={manifest.requirements.length} checkCount={manifest.checks.length} />
      </main>

      <footer className="border-t border-border bg-surface">
        <div className="mx-auto flex w-full max-w-[1440px] flex-wrap items-center justify-between gap-2 px-4 py-4 text-[12px] text-muted sm:px-6 lg:px-8">
          <span>Showcase tooling: it reads the product; the product never imports it.</span>
          <span className="font-mono">manifest {manifest.version}</span>
        </div>
      </footer>
    </div>
  );
}
