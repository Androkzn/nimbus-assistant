"use client";

import type { SavedAssessment } from "@/readiness/storage";
import { formatUtc } from "./format";

function label(run: SavedAssessment): string {
  const start = run.startedAtMs === undefined ? undefined : new Date(run.startedAtMs).toISOString();
  return start ? formatUtc(start) : "Unnamed assessment";
}

export function SavedAssessments({
  runs,
  onReview,
  onDelete,
  }: {
  runs: SavedAssessment[];
  onReview: (run: SavedAssessment) => void;
  onDelete: (id: string) => void;
}) {
  if (runs.length === 0) return null;

  return (
    <section aria-labelledby="saved-assessments-heading" className="rounded-xl border border-border bg-surface px-4 py-3 shadow-[0_1px_0_rgb(15_23_42/0.03)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="saved-assessments-heading" className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">
            Saved assessments
          </h2>
          <p className="mt-0.5 text-[12.5px] text-muted">Results save automatically in this browser as the run progresses.</p>
        </div>
        <span className="text-[12px] text-muted">{runs.length} saved</span>
      </div>
      <ul className="mt-3 flex w-full flex-nowrap gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]">
        {runs.map((run) => (
          <li key={run.id} className="h-11 w-[min(360px,calc(100vw-4rem))] shrink-0">
            <div className="flex h-full min-w-0 items-center gap-2 overflow-hidden rounded-lg border border-border bg-surface-2 px-2.5 py-2">
              <span className={`h-2 w-2 shrink-0 rounded-full ${run.phase === "finished" ? "bg-[var(--rdy-pass)]" : run.phase === "error" ? "bg-[var(--rdy-fail)]" : "bg-[var(--rdy-warn)]"}`} aria-hidden />
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-text">
                <span className="font-semibold">{label(run)}</span>
                <span className="ml-1.5 text-muted">· {run.events.length} events · {run.phase}</span>
              </span>
              <button
                type="button"
                onClick={() => onReview(run)}
                className="shrink-0 rounded-md px-2 py-1 text-[12px] font-semibold text-orange-ink hover:bg-orange-soft"
              >
                Review
              </button>
              <button
                type="button"
                onClick={() => onDelete(run.id)}
                className="shrink-0 rounded-md px-1.5 py-1 text-[12px] text-muted hover:bg-[var(--rdy-fail-bg)] hover:text-[var(--rdy-fail)]"
                aria-label={`Delete saved assessment from ${label(run)}`}
              >
                ×
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
