"use client";

import { useState } from "react";
import type { StageState } from "@/readiness/coverage";
import { STAGE_IDS, STAGE_INFO, type Counts, type Source, type StageId, type StageInfo, type Status } from "@/readiness/schema";
import type { RunSession } from "@/readiness/useReadinessRun";
import { LayerBadge, SourceBadge, StatusIcon, StatusPill, TONE_TEXT, toneOf, type Tone } from "./badges";
import { formatDuration } from "./format";

/** Short chip titles; the full title is in the detail panel. */
const CHIP_TITLE: Partial<Record<StageId, string>> = {
  unit: "Unit · integration · retrieval eval",
  "bundle-scan": "Bundle secret scan",
};

interface StageView {
  info: StageInfo;
  status: Status;
  source?: Source;
  durationMs?: number;
  counts?: Counts;
  note?: string;
  /** True for a stage the page expects but no producer has announced yet. */
  planned?: boolean;
}

function viewsOf(stages: StageState[], session: RunSession, probesPlanned: boolean): StageView[] {
  if (stages.length === 0) {
    const ids = session.mode === "probes" ? (["probes"] as StageId[]) : STAGE_IDS.filter((id) => id !== "probes" || probesPlanned);
    return ids.map((id) => ({ info: STAGE_INFO[id], status: "pending", planned: true }));
  }
  const views: StageView[] = stages.map((s) => ({
    info: s.info,
    status: s.status,
    source: s.source,
    durationMs: s.durationMs,
    counts: s.counts,
    note: s.note,
  }));
  if (probesPlanned && !stages.some((s) => s.info.id === "probes")) {
    views.push({ info: STAGE_INFO.probes, status: "pending", planned: true });
  }
  return views;
}

function countsText(c: Counts | undefined): string {
  if (!c) return "";
  const parts = [`${c.passed} passed`];
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.skipped) parts.push(`${c.skipped} skipped`);
  return parts.join(" · ");
}

export function StagePipeline({
  stages,
  session,
  now,
  probesPlanned,
  runMode,
}: {
  stages: StageState[];
  session: RunSession;
  now: number;
  probesPlanned: boolean;
  /** The run's mode: a stage whose source differs from it (live probes in a replay, the recorded eval in a live run) is marked. */
  runMode?: "local" | "replay" | "probes";
}) {
  const [openId, setOpenId] = useState<StageId | null>(null);
  const views = viewsOf(stages, session, probesPlanned);
  const halted = session.phase === "stopped" || session.phase === "error";
  const open = views.find((v) => v.info.id === openId);

  const display = (v: StageView): { status: Status; tone: Tone; label?: string; duration?: number } => {
    if (v.status === "running" && halted) return { status: "skipped", tone: "warn", label: "Stopped", duration: v.durationMs };
    if (v.status === "running") {
      const t0 = session.stageClock[v.info.id];
      return { status: "running", tone: "run", duration: t0 !== undefined && now > 0 ? Math.max(0, now - t0) : undefined };
    }
    return { status: v.status, tone: toneOf(v.status), duration: v.durationMs };
  };

  return (
    <section aria-labelledby="pipeline-heading" className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="pipeline-heading" className="font-display text-[17px] font-bold tracking-[-0.01em] text-text">
          Gate pipeline
        </h2>
        <p className="text-[12.5px] text-muted">Same gates as CI, in order. Select a stage for its command and what it proves.</p>
      </div>
      <ol className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4 xl:grid-cols-8" data-testid="pipeline">
        {views.map((v, i) => {
          const d = display(v);
          const selected = openId === v.info.id;
          return (
            <li key={v.info.id} className="min-w-0">
              <button
                type="button"
                data-testid={`stage-${v.info.id}`}
                data-status={d.status}
                aria-expanded={selected}
                aria-controls="stage-detail"
                onClick={() => setOpenId(selected ? null : v.info.id)}
                className={`group relative flex h-full w-full min-w-0 flex-col overflow-hidden rounded-xl border bg-surface p-3 pt-3.5 text-left transition-[border-color,box-shadow] duration-300 hover:border-orange-strong ${
                  selected ? "border-orange-strong shadow-[0_0_0_3px_var(--orange-soft)]" : "border-border"
                } ${v.planned ? "border-dashed" : ""}`}
              >
                <span
                  aria-hidden
                  className={`absolute inset-x-0 top-0 h-[3px] transition-colors duration-300 ${
                    d.tone === "idle" ? "bg-[var(--rdy-track)]" : d.tone === "run" ? "rdy-indeterminate" : ""
                  } ${d.tone === "pass" ? "bg-[var(--rdy-pass)]" : d.tone === "fail" ? "bg-[var(--rdy-fail)]" : d.tone === "warn" ? "bg-[var(--rdy-warn)]" : ""}`}
                />
                <span className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="font-mono text-[11px] text-muted tabular-nums">{String(i + 1).padStart(2, "0")}</span>
                    {!v.planned && v.source && v.status !== "pending" && (runMode === "replay" ? v.source === "live" : v.source === "recorded") && (
                      <SourceBadge source={v.source} size="xs" />
                    )}
                  </span>
                  <span className={`text-[15px] ${TONE_TEXT[d.tone]}`}>
                    <StatusIcon status={d.status} />
                  </span>
                </span>
                <span className="mt-1.5 line-clamp-2 min-h-[2.5em] text-[13px] leading-tight font-semibold text-text">
                  {CHIP_TITLE[v.info.id] ?? v.info.title}
                </span>
                <span className="mt-2 flex items-center justify-between gap-2 text-[12px] tabular-nums">
                  <span className={`font-semibold ${d.tone === "idle" ? "text-muted" : TONE_TEXT[d.tone]}`}>
                    {d.label ?? (d.status === "pending" ? "Queued" : d.status === "running" ? "Running" : d.status === "passed" ? "Passed" : d.status === "failed" ? "Failed" : "Skipped")}
                  </span>
                  <span className="text-muted">{d.duration !== undefined ? formatDuration(d.duration) : ""}</span>
                </span>
                <span className="mt-0.5 truncate text-[11.5px] text-muted tabular-nums">
                  {v.counts && (v.counts.passed || v.counts.failed || v.counts.skipped) ? countsText(v.counts) : v.source === "recorded" ? "recorded" : " "}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {open && (
        <div
          id="stage-detail"
          className="mt-2.5 grid gap-4 rounded-xl border border-border bg-surface p-4 text-[13.5px] sm:grid-cols-[minmax(0,1fr)_auto]"
        >
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2">
              <span className="font-display text-[15px] font-bold text-text">{open.info.title}</span>
              <LayerBadge layer={open.info.layer} />
              {open.source && <SourceBadge source={open.source} size="xs" />}
            </p>
            <p className="mt-1.5 leading-relaxed text-text">{open.info.description}</p>
            {open.info.command && (
              <p className="mt-2 text-[12.5px] text-muted">
                Command{" "}
                <code className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[12px] text-text">{open.info.command}</code>
              </p>
            )}
            {open.note && <p className="mt-2 text-[12.5px] text-muted">{open.note}</p>}
          </div>
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <StatusPill status={display(open).status} kind="stage" label={display(open).label} />
            <span className="text-[12.5px] text-muted tabular-nums">
              {formatDuration(display(open).duration)}
              {open.counts ? ` · ${countsText(open.counts)}` : ""}
            </span>
          </div>
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {views
          .filter((v) => v.status === "running")
          .map((v) => `${v.info.title} running`)
          .join(". ")}
      </span>
    </section>
  );
}
