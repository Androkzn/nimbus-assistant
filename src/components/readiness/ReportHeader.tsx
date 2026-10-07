import Link from "next/link";
import type { ReactNode } from "react";
import { BrandLockup } from "@/components/BrandLockup";
import type { RunMeta } from "@/readiness/schema";
import type { RunSession } from "@/readiness/useReadinessRun";
import styles from "./readiness.module.css";
import { formatUtc, shortOrigin } from "./format";

function speedLabel(speed: RunSession["speed"]): string {
  return speed === "instant" ? "replayed instantly" : speed === 1 ? "replayed at recorded pace" : `replayed at ${speed}×`;
}

function LivePill({ children = "Live" }: { children?: string }) {
  return (
    <span className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-[var(--rdy-pass-bg)] px-2 text-[11px] font-bold tracking-[0.08em] text-[var(--rdy-pass)] uppercase ring-1 ring-[var(--rdy-pass-line)] dark:bg-[rgb(46_160_67/0.22)]">
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full bg-current ${styles.pulse}`} />
      {children}
    </span>
  );
}

function RecordedPill() {
  return (
    <span className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-dashed border-on-navy-muted/70 px-2 text-[11px] font-bold tracking-[0.08em] text-on-navy uppercase">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2.4} aria-hidden>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3 2" strokeLinecap="round" />
      </svg>
      Recorded
    </span>
  );
}

/**
 * The mode banner (spec I7): says, before anything else, whether what follows ran now or is a recording,
 * and for a recording its date, build and replay speed.
 */
export function ModeBanner({ session, meta }: { session: RunSession; meta: RunMeta | null }) {
  const { mode, phase } = session;
  const active = phase === "connecting" || phase === "running";
  let body: ReactNode;

  if (phase === "idle") {
    body = (
      <span className="text-on-navy-muted">
        <span className="font-semibold text-on-navy">Not started.</span> Start a run to stream every gate and map each
        result to the requirement it proves.
      </span>
    );
  } else if (!mode) {
    body = <span className="text-on-navy-muted">Checking whether the local gate runner is available…</span>;
  } else if (mode === "replay") {
    const rec = session.recorded?.meta ?? meta;
    body = (
      <>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <RecordedPill />
          <span className="text-on-navy">
            {formatUtc(rec?.startedAt)}
            <span className="text-on-navy-muted"> · build </span>
            <span className="font-mono text-[12.5px]">{rec?.build ?? "—"}</span>
            <span className="text-on-navy-muted"> · {speedLabel(session.speed)}</span>
          </span>
        </span>
        {session.probeOrigin && (
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span aria-hidden className="text-on-navy-muted max-md:hidden">
              +
            </span>
            <LivePill>Live probes</LivePill>
            <span className="text-on-navy">
              {phase === "running" ? "running now against " : "ran against "}
              <span className="font-mono text-[12.5px]">{shortOrigin(session.probeOrigin)}</span>
            </span>
          </span>
        )}
      </>
    );
  } else {
    const where = mode === "probes" ? shortOrigin(meta?.environment ?? session.probeOrigin) : (meta?.environment ?? "this machine");
    body = (
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <LivePill />
        <span className="text-on-navy">
          {active ? "running now on " : "ran on "}
          <span className={mode === "probes" ? "font-mono text-[12.5px]" : ""}>{where}</span>
          {!active && session.startedAtMs !== undefined && meta?.startedAt && (
            <span className="text-on-navy-muted"> · {formatUtc(meta.startedAt)}</span>
          )}
          {mode === "probes" && <span className="text-on-navy-muted"> · live probes only</span>}
        </span>
      </span>
    );
  }

  return (
    <div
      data-testid="mode-banner"
      data-mode={phase === "idle" ? "idle" : (mode ?? "connecting")}
      className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-[13px] leading-snug"
    >
      {body}
    </div>
  );
}

export function ReportHeader({ session, meta }: { session: RunSession; meta: RunMeta | null }) {
  return (
    <header className="brand-glow z-30 border-b border-navy-3 bg-navy text-on-navy">
      <div className="mx-auto flex h-16 w-full max-w-[1440px] items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-4">
          <BrandLockup size="header" />
          <span aria-hidden className="h-7 w-px bg-navy-3 max-sm:hidden" />
          <h1 className="truncate font-display text-[15px] font-semibold tracking-[-0.01em] text-on-navy max-sm:sr-only">
            Feature readiness
          </h1>
        </div>
        <Link
          href="/"
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-xl border border-navy-3 bg-navy-2 px-3 text-sm font-semibold transition-colors hover:border-orange hover:text-orange"
        >
          <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
            <path d="M19 12H5M11 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="max-sm:hidden">Back to the assistant</span>
          <span className="sm:hidden">Assistant</span>
        </Link>
      </div>
      <div className="border-t border-navy-3/70 bg-navy-2/70">
        <div className="mx-auto flex min-h-11 w-full max-w-[1440px] items-center gap-3 px-4 py-2 sm:px-6 lg:px-8">
          <span className="shrink-0 text-[10.5px] font-semibold tracking-[0.18em] text-on-navy-muted uppercase max-md:hidden">
            Evidence
          </span>
          <ModeBanner session={session} meta={meta} />
        </div>
      </div>
    </header>
  );
}
