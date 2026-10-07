"use client";

import { useState } from "react";
import { ChevronDownIcon } from "@/components/icons";
import type { CheckView } from "@/readiness/coverage";
import type { Status, TestResult } from "@/readiness/schema";
import { IdChip, LayerBadge, SourceBadge, StatusIcon, StatusPill, TONE_TEXT, toneOf } from "./badges";
import type { Filter, FilteredRequirement } from "./filter";
import { resultPasses } from "./filter";
import { formatDuration, leafName, parentName, plural, shortFile, slug } from "./format";

const RESULTS_PREVIEW = 6;

function statusRank(s: Status): number {
  return s === "failed" ? 0 : s === "running" ? 1 : 2;
}

/** Keys already shown elsewhere on the row (file) or too long to help at a glance. */
const DETAIL_SKIP = new Set(["reportPath", "environment", "note"]);

function detailValue(key: string, value: string | number | boolean): string {
  if (typeof value === "number") {
    if (/costUSD$/i.test(key)) return `$${value < 0.01 ? value.toFixed(5) : value.toFixed(4)}`;
    if (/Ms$/.test(key)) return formatDuration(value);
  }
  const text = String(value);
  return text.length > 48 ? `${text.slice(0, 47)}…` : text;
}

function DetailLine({ detail }: { detail: TestResult["detail"] }) {
  if (!detail) return null;
  const entries = Object.entries(detail).filter(([k]) => !DETAIL_SKIP.has(k)).slice(0, 6);
  const note = typeof detail.note === "string" ? detail.note : undefined;
  if (entries.length === 0 && !note) return null;
  return (
    <>
      {entries.length > 0 && (
        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted">
          {entries.map(([k, v]) => (
            <span key={k}>
              {k.replace(/Ms$/, "").replace(/USD$/, "")} <span className="text-text">{detailValue(k, v)}</span>
            </span>
          ))}
        </p>
      )}
      {note && <p className="mt-1 text-[11.5px] text-muted italic">{note}</p>}
    </>
  );
}

export function ResultRow({ result }: { result: TestResult }) {
  const tone = toneOf(result.status);
  const parent = parentName(result.fullName);
  return (
    <li
      data-result-id={result.id}
      data-status={result.status}
      data-source={result.source}
      className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 border-t border-border/70 py-2 first:border-t-0"
    >
      <span className={`mt-[3px] text-[13px] ${TONE_TEXT[tone]}`} title={result.status}>
        <StatusIcon status={result.status} />
        <span className="sr-only">{result.status}</span>
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <p className="min-w-0 text-[13px] leading-snug text-text">
            {parent && <span className="text-muted">{parent} › </span>}
            <span className="font-medium">{leafName(result.fullName)}</span>
          </p>
          <span className="flex shrink-0 items-center gap-2">
            <span className="text-[11.5px] text-muted tabular-nums">{formatDuration(result.durationMs)}</span>
            <SourceBadge source={result.source} size="xs" />
          </span>
        </div>
        <p className="mt-0.5 truncate font-mono text-[11px] text-muted" title={result.file}>
          {shortFile(result.file)}
        </p>
        <DetailLine detail={result.detail} />
        {result.error && (
          <pre className="mt-1.5 max-h-40 overflow-auto rounded-lg border border-[var(--rdy-fail-line)] bg-[var(--rdy-fail-bg)] px-2.5 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-[var(--rdy-fail)]">
            <span className="sr-only">Failure reason (redacted): </span>
            {result.error}
          </pre>
        )}
      </div>
    </li>
  );
}

function CheckBlock({ view, filter }: { view: CheckView; filter: Filter }) {
  const [showAll, setShowAll] = useState(false);
  const results = view.results.filter((r) => resultPasses(r, filter)).sort((a, b) => statusRank(a.status) - statusRank(b.status));
  const shown = showAll ? results : results.slice(0, RESULTS_PREVIEW);
  const { check } = view;
  return (
    <li data-check-id={check.id} data-status={view.status} className="rounded-xl border border-border bg-surface p-3 sm:p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <p className="flex flex-wrap items-center gap-2">
            <LayerBadge layer={check.layer} />
            <span className="text-[13.5px] font-semibold text-text">{check.title}</span>
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            <span className="font-semibold text-text/80">Verifies: </span>
            {check.verifies}
          </p>
        </div>
        <StatusPill status={view.status} kind="check" size="xs" />
      </div>
      {results.length > 0 ? (
        <>
          <ul className="mt-2 rounded-lg bg-surface-2 px-3" aria-label={`Results for ${check.title}`}>
            {shown.map((r) => (
              <ResultRow key={r.id} result={r} />
            ))}
          </ul>
          {results.length > RESULTS_PREVIEW && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="mt-2 text-[12.5px] font-semibold text-orange-ink underline-offset-2 hover:text-orange-ink-hover hover:underline"
            >
              {showAll ? "Show fewer" : `Show all ${results.length} results`}
            </button>
          )}
        </>
      ) : (
        <p className="mt-2 rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] text-muted">
          {view.status === "running" ? "Running…" : "No result from this run yet."}
        </p>
      )}
    </li>
  );
}

function RequirementRow({
  item,
  filter,
  expanded,
  onToggle,
}: {
  item: FilteredRequirement;
  filter: Filter;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { view, checks } = item;
  const r = view.requirement;
  const testCount = new Set(view.checks.flatMap((c) => c.results.map((x) => x.id))).size;
  const panelId = `req-${slug(r.id)}`;
  const failed = view.status === "failed";
  return (
    <li
      id={`req-row-${slug(r.id)}`}
      data-requirement-id={r.id}
      data-status={view.status}
      className={`scroll-mt-4 border-t border-border first:border-t-0 ${failed ? "bg-[var(--rdy-fail-bg)]/40" : ""}`}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={onToggle}
        className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 px-4 py-3.5 text-left transition-colors hover:bg-orange-soft/60 sm:px-5 md:grid-cols-[minmax(0,1fr)_auto_auto_auto] md:gap-x-4"
      >
        <span className="col-span-2 row-start-1 min-w-0 md:col-span-1 md:col-start-1">
          <span className="block text-[14px] leading-snug font-semibold text-text">
            <IdChip strong className="mr-1.5 align-[1px]">
              {r.id}
            </IdChip>
            <span className="mr-2 font-mono text-[10.5px] font-semibold text-muted" title={`Priority ${r.priority}`}>
              {r.priority}
            </span>
            {r.title}
          </span>
          <span className="mt-1.5 flex flex-wrap items-center gap-1">
            {r.brd.length > 0 && <span className="mr-0.5 text-[10px] font-semibold tracking-[0.1em] text-muted uppercase">BRD</span>}
            {r.brd.map((id) => (
              <IdChip key={id}>{id}</IdChip>
            ))}
            {r.acceptance.length > 0 && (
              <span className={`mr-0.5 text-[10px] font-semibold tracking-[0.1em] text-muted uppercase ${r.brd.length ? "ml-2" : ""}`}>Acceptance</span>
            )}
            {r.acceptance.map((id) => (
              <IdChip key={id}>{id}</IdChip>
            ))}
          </span>
        </span>
        <span className="col-span-2 col-start-2 row-start-2 flex min-w-0 flex-wrap items-center gap-2 md:col-span-1 md:col-start-2 md:row-start-1 md:flex-col md:items-end md:gap-1.5 md:pt-0.5">
          <span className="text-[12px] whitespace-nowrap text-muted tabular-nums">
            {plural(view.checks.length, "check")} · {plural(testCount, "test")}
          </span>
          <span className="flex gap-1">
            {view.sources.map((s) => (
              <SourceBadge key={s} source={s} size="xs" />
            ))}
          </span>
        </span>
        <span className="col-start-1 row-start-2 md:col-start-3 md:row-start-1 md:pt-0.5">
          <StatusPill status={view.status} kind="requirement" size="sm" />
        </span>
        <ChevronDownIcon
          className={`col-start-3 row-start-1 mt-0.5 shrink-0 text-muted transition-transform duration-200 md:col-start-4 md:mt-1.5 ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      {expanded && (
        <div id={panelId} className="px-4 pb-4 sm:px-5">
          {r.detail && <p className="mb-2.5 text-[13px] leading-relaxed text-muted">{r.detail}</p>}
          {checks.length > 0 ? (
            <ul className="space-y-2.5" aria-label={`Checks for ${r.id}`}>
              {checks.map((c) => (
                <CheckBlock key={c.check.id} view={c} filter={filter} />
              ))}
            </ul>
          ) : (
            <p className="text-[12.5px] text-muted">No checks match this filter.</p>
          )}
        </div>
      )}
    </li>
  );
}

export function TraceabilityMatrix({ items, filter, searching }: { items: FilteredRequirement[]; filter: Filter; searching: boolean }) {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  const groups: { name: string; items: FilteredRequirement[] }[] = [];
  for (const item of items) {
    const name = item.view.requirement.group;
    let g = groups.find((x) => x.name === name);
    if (!g) groups.push((g = { name, items: [] }));
    g.items.push(item);
  }
  for (const g of groups) {
    // Failed first, then running; otherwise the manifest's order (sort is stable).
    g.items.sort((a, b) => statusRank(a.view.status) - statusRank(b.view.status));
  }

  if (items.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-surface px-5 py-10 text-center text-[14px] text-muted">
        Nothing matches this filter{searching ? " and search" : ""}.
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="matrix">
      {groups.map((g) => {
        const verified = g.items.filter((i) => i.view.status === "passed").length;
        const failed = g.items.filter((i) => i.view.status === "failed").length;
        const headingId = `group-${slug(g.name)}`;
        return (
          <section
            key={g.name}
            id={`${headingId}-section`}
            aria-labelledby={headingId}
            data-testid="requirement-group"
            data-group={g.name}
            className="scroll-mt-4 overflow-hidden rounded-2xl border border-border bg-surface shadow-[0_1px_2px_rgb(15_23_42/0.04)]"
          >
            <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border bg-surface-2 px-4 py-2.5 sm:px-5">
              <h3 id={headingId} className="font-display text-[14.5px] font-bold tracking-[-0.01em] text-text">
                {g.name}
              </h3>
              <p className="text-[12px] text-muted tabular-nums">
                <span className={verified === g.items.length ? `font-semibold ${TONE_TEXT.pass}` : ""}>
                  {verified} / {g.items.length} verified
                </span>
                {failed > 0 && <span className={`font-semibold ${TONE_TEXT.fail}`}> · {failed} failed</span>}
              </p>
            </header>
            <ul>
              {g.items.map((item) => {
                const id = item.view.requirement.id;
                const auto = item.view.status === "failed" || (searching && item.matchedInside);
                const expanded = overrides[id] ?? auto;
                return (
                  <RequirementRow
                    key={id}
                    item={item}
                    filter={filter}
                    expanded={expanded}
                    onToggle={() => setOverrides((o) => ({ ...o, [id]: !expanded }))}
                  />
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
