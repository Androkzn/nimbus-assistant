"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { ArrowDownIcon } from "@/components/icons";
import type { Layer, StageId, TestResult } from "@/readiness/schema";
import { IdChip, LayerBadge, SourceBadge, StatusPill } from "./badges";
import { formatDuration, leafName, parentName } from "./format";
import styles from "./readiness.module.css";

export interface ResultContext {
  verifies?: string;
  layer: Layer;
  requirementIds: string[];
}

export interface RunningTest {
  id: string;
  stage: StageId;
  file: string;
  fullName: string;
}

const FEED_CAP = 200;

function FeedItem({ result, ctx }: { result: TestResult; ctx: ResultContext }) {
  const parent = parentName(result.fullName);
  return (
    <li
      data-testid="feed-item"
      data-result-id={result.id}
      data-status={result.status}
      data-source={result.source}
      className={`border-b border-border px-4 py-3 last:border-b-0 ${styles.enter} ${result.status === "failed" ? "bg-[var(--rdy-fail-bg)]/50" : ""}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <StatusPill status={result.status} kind="test" size="xs" />
          <LayerBadge layer={ctx.layer} />
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="text-[11.5px] text-muted tabular-nums">{formatDuration(result.durationMs)}</span>
          <SourceBadge source={result.source} size="xs" />
        </span>
      </div>
      <p className="mt-1.5 text-[13px] leading-snug text-text">
        <span className="font-semibold">{leafName(result.fullName)}</span>
        {parent && <span className="block truncate text-[11.5px] text-muted">{parent}</span>}
      </p>
      {ctx.verifies ? (
        <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-muted">{ctx.verifies}</p>
      ) : (
        <p className="mt-1 text-[12.5px] text-[var(--rdy-warn)]">Not claimed by any check in the manifest.</p>
      )}
      {result.error && (
        <p className="mt-1 line-clamp-3 font-mono text-[11.5px] leading-relaxed break-words text-[var(--rdy-fail)]">{result.error}</p>
      )}
      {ctx.requirementIds.length > 0 && (
        <p className="mt-1.5 flex flex-wrap gap-1" aria-label="Requirements">
          {ctx.requirementIds.map((id) => (
            <IdChip key={id}>{id}</IdChip>
          ))}
        </p>
      )}
    </li>
  );
}

export function LiveFeed({
  results,
  totalResults,
  running,
  contextFor,
  active,
  filtered,
}: {
  results: TestResult[];
  totalResults: number;
  running: RunningTest[];
  contextFor: (r: TestResult) => ResultContext;
  active: boolean;
  filtered: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const shown = results.length > FEED_CAP ? results.slice(-FEED_CAP) : results;

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setFollow((f) => (f === atBottom ? f : atBottom));
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [shown.length, running.length, follow]);

  const jump = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setFollow(true);
  };

  return (
    <section
      aria-labelledby="feed-heading"
      className="relative flex max-h-[26rem] min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-[0_1px_2px_rgb(15_23_42/0.04)] lg:h-[min(calc(100dvh-2rem),60rem)] lg:max-h-none"
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface-2 px-4 py-2.5">
        <h2 id="feed-heading" className="flex items-center gap-2 font-display text-[14.5px] font-bold tracking-[-0.01em] text-text">
          {active && <span aria-hidden className={`h-2 w-2 rounded-full bg-[var(--rdy-live-dot)] ${styles.pulse}`} />}
          Live feed
        </h2>
        <span className="text-[12px] text-muted tabular-nums" data-testid="feed-count">
          {filtered ? `${results.length} of ${totalResults}` : totalResults} {totalResults === 1 ? "result" : "results"}
        </span>
      </header>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        tabIndex={0}
        aria-label="Live feed of test results, newest last"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {results.length > FEED_CAP && (
          <p className="border-b border-border px-4 py-2 text-[12px] text-muted">
            Showing the latest {FEED_CAP} of {results.length}. The matrix holds every result.
          </p>
        )}
        {shown.length === 0 && running.length === 0 ? (
          <p className="px-4 py-10 text-center text-[13px] text-muted">
            {active ? "Waiting for the first result…" : filtered && totalResults > 0 ? "No results match this filter." : "Results stream in here as each test finishes."}
          </p>
        ) : (
          <ol aria-live="polite" aria-relevant="additions" data-testid="feed">
            {shown.map((r) => (
              <FeedItem key={r.id} result={r} ctx={contextFor(r)} />
            ))}
            {running.map((t) => (
              <li key={`running-${t.id}`} data-testid="feed-running" className="border-b border-border px-4 py-3 last:border-b-0">
                <div className="flex items-center gap-1.5">
                  <StatusPill status="running" kind="test" size="xs" />
                  <span className="truncate font-mono text-[11px] text-muted">{t.file}</span>
                </div>
                <p className="mt-1.5 text-[13px] leading-snug font-semibold text-text">{leafName(t.fullName)}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
      {!follow && (
        <button
          type="button"
          onClick={jump}
          className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-text shadow-md transition-colors hover:border-orange-strong hover:text-orange-ink"
        >
          <ArrowDownIcon />
          Jump to latest
        </button>
      )}
    </section>
  );
}
