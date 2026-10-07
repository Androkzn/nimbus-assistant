"use client";

import { useEffect, useRef, type ReactNode } from "react";
import type { UsageRow, UsageTotals } from "@/client/usage";
import type { ContextLevel } from "@/shared/context";
import type { PublicModel } from "@/shared/contracts";
import { formatUSD } from "@/shared/cost";
import { CloseIcon, DownloadIcon } from "./icons";

/** Warning colours stay fixed: the panel is navy in both light and dark mode. */
const LEVEL_BAR: Record<ContextLevel, string> = { ok: "bg-on-navy/80", amber: "bg-[#f5b14a]", red: "bg-[#f87171]" };

function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="flex items-center gap-3 text-[11px] font-bold tracking-[0.18em] text-orange uppercase">
        {title}
        <span className="h-px flex-1 bg-navy-3" aria-hidden />
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Stat({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-navy-3 bg-navy-2 px-3.5 py-3">
      <p className={`font-display text-[1.35rem] leading-tight font-extrabold tabular-nums ${accent ? "text-orange" : "text-on-navy"}`}>{value}</p>{" "}
      <p className="mt-0.5 text-xs text-on-navy-muted">{label}</p>
    </div>
  );
}

export function SessionPanel({
  open,
  onClose,
  totals,
  rows,
  modelName,
  selected,
  usedTokens,
  contextWindow,
  level,
  onExportCSV,
  onExportJSON,
}: {
  open: boolean;
  onClose: () => void;
  totals: UsageTotals;
  rows: UsageRow[];
  modelName: (id: string) => string;
  selected: PublicModel | undefined;
  usedTokens: number;
  contextWindow: number;
  level: ContextLevel;
  onExportCSV: () => void;
  onExportJSON: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Drawer behaviour on small screens: focus the close button, Escape closes.
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const ratio = contextWindow > 0 ? usedTokens / contextWindow : 0;
  const canExport = rows.length > 0;
  const exportButton =
    "inline-flex items-center justify-center gap-2 rounded-xl border border-navy-3 bg-navy-2 px-3 py-2 text-sm font-semibold transition-colors hover:border-orange hover:text-orange disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-navy-3 disabled:hover:text-on-navy";

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-navy/60 backdrop-blur-[2px] lg:hidden" onClick={onClose} aria-hidden />}
      <aside
        id="session-panel"
        aria-label="Session usage and model details"
        className={`fixed inset-y-0 right-0 z-40 flex w-[min(340px,88vw)] flex-col overflow-y-auto bg-navy text-on-navy shadow-2xl transition-[translate,visibility] duration-200 ease-out lg:static lg:z-auto lg:w-80 lg:shrink-0 lg:translate-x-0 lg:border-l lg:border-navy-3 lg:shadow-none ${
          open ? "translate-x-0" : "translate-x-full max-lg:invisible"
        }`}
      >
        <div className="flex items-center justify-between px-6 pt-5 lg:hidden">
          <p className="font-display text-base font-bold">Session</p>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close session panel"
            className="grid h-9 w-9 place-items-center rounded-lg text-lg text-on-navy-muted transition-colors hover:bg-navy-2 hover:text-orange"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-9 p-6">
          <PanelSection title="Session usage">
            <div data-testid="session-totals" className="grid grid-cols-2 gap-2">
              <Stat value={String(totals.answers)} label={totals.answers === 1 ? "answer" : "answers"} />
              <Stat value={formatUSD(totals.costUSD)} label="estimated cost" accent />
              <Stat value={totals.inputTokens.toLocaleString()} label="input tokens" />
              <Stat value={totals.outputTokens.toLocaleString()} label="output tokens" />
            </div>
            {rows.length > 0 && (
              <ol className="mt-3 max-h-48 space-y-0.5 overflow-y-auto text-xs" aria-label="Usage per answer">
                {[...rows].reverse().map((r) => (
                  <li key={r.turn} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-navy-2">
                    <span className="w-6 shrink-0 text-on-navy-muted tabular-nums">#{r.turn}</span>
                    <span className="min-w-0 flex-1 truncate">{modelName(r.answeredBy)}</span>
                    <span className="shrink-0 text-on-navy-muted tabular-nums">{(r.inputTokens + r.outputTokens).toLocaleString()} tok</span>
                    <span className="w-[4.5rem] shrink-0 text-right tabular-nums">{formatUSD(r.costUSD)}</span>
                  </li>
                ))}
              </ol>
            )}
          </PanelSection>

          <PanelSection title="Model & context">
            <p className="font-semibold">{selected?.displayName ?? "Loading models…"}</p>
            {selected && (
              <p className="mt-0.5 text-xs text-on-navy-muted tabular-nums">
                {selected.providerName} · ${selected.pricing.inputPerMTok.toFixed(2)} in / ${selected.pricing.outputPerMTok.toFixed(2)} out per 1M
                tokens
              </p>
            )}
            <div
              data-testid="context-meter"
              data-level={level}
              className="mt-4"
              title="Size of the next request vs the selected model's context window"
            >
              <div className="h-2 overflow-hidden rounded-full bg-navy-3" aria-hidden>
                <div className={`h-full rounded-full transition-[width] duration-500 ${LEVEL_BAR[level]}`} style={{ width: `${Math.max(2, Math.min(100, ratio * 100))}%` }} />
              </div>
              <p className="mt-2 text-xs text-on-navy-muted tabular-nums">
                {contextWindow > 0
                  ? `${(ratio * 100).toFixed(ratio < 0.01 ? 2 : 0)}% of ${contextWindow.toLocaleString()} tokens`
                  : "Loading model…"}
              </p>
              {level !== "ok" && (
                <p className={`mt-2 text-xs font-semibold ${level === "red" ? "text-[#f87171]" : "text-[#f5b14a]"}`}>
                  {level === "red" ? "⚠ Near the limit — start a new conversation" : "⚠ Approaching the limit"}
                </p>
              )}
            </div>
          </PanelSection>

          <PanelSection title="Export usage">
            <div className="grid grid-cols-2 gap-2">
              <button type="button" data-testid="export-csv" disabled={!canExport} onClick={onExportCSV} className={exportButton}>
                <DownloadIcon /> CSV
              </button>
              <button type="button" data-testid="export-json" disabled={!canExport} onClick={onExportJSON} className={exportButton}>
                <DownloadIcon /> JSON
              </button>
            </div>
            {!canExport && <p className="mt-2 text-xs text-on-navy-muted">Available after the first answer.</p>}
          </PanelSection>

        </div>
      </aside>
    </>
  );
}
