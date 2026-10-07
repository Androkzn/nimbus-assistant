import type { ReactNode } from "react";
import type { Summary } from "@/readiness/coverage";
import type { RunSession } from "@/readiness/useReadinessRun";
import { TONE_CLASS, TONE_TEXT } from "./badges";
import { formatDuration, slug, splitParenthetical } from "./format";
import type { Verdict } from "./verdict";

function VerdictGlyph({ verdict }: { verdict: Verdict }) {
  const common = { viewBox: "0 0 24 24", width: 30, height: 30, fill: "none", stroke: "currentColor", strokeWidth: 2.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (verdict.kind) {
    case "ready":
      return (
        <svg {...common}>
          <path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.3 7.5 9.5 4.3-1.2 7.5-4.9 7.5-9.5V6z" />
          <path d="m8.8 12.2 2.3 2.3 4.3-4.6" />
        </svg>
      );
    case "not-ready":
      return (
        <svg {...common}>
          <path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.3 7.5 9.5 4.3-1.2 7.5-4.9 7.5-9.5V6z" />
          <path d="m9.5 9.5 5 5M14.5 9.5l-5 5" />
        </svg>
      );
    case "running":
      return (
        <svg {...common} className="animate-spin">
          <path d="M21 12a9 9 0 1 1-6.2-8.56" />
        </svg>
      );
    case "incomplete":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7.5v5M12 16h.01" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" strokeDasharray="3 3.4" />
        </svg>
      );
  }
}

function Stat({ label, value, sub, testId }: { label: string; value: ReactNode; sub?: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} className="min-w-0 rounded-xl border border-border bg-surface-2 px-4 py-3">
      <p className="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{label}</p>
      <p className="mt-1 font-display text-[22px] leading-tight font-bold text-text tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-[12.5px] leading-snug text-muted tabular-nums">{sub}</p>}
    </div>
  );
}

export interface GroupStat {
  name: string;
  total: number;
  verified: number;
  failed: number;
}

function GroupBreakdown({ groups }: { groups: GroupStat[] }) {
  return (
    <div className="border-t border-border px-5 py-4 sm:px-6">
      <h3 className="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">By requirement group</h3>
      <ul className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4 xl:grid-cols-7">
        {groups.map((g) => {
          const all = g.total > 0 && g.verified === g.total;
          return (
            <li key={g.name} className="min-w-0">
              <a
                href={`#group-${slug(g.name)}-section`}
                className="group flex h-full flex-col justify-between gap-2 rounded-lg border border-border px-3 py-2.5 transition-colors hover:border-orange-strong hover:bg-orange-soft/50"
              >
                <span className="line-clamp-2 text-[12.5px] leading-snug font-medium text-text group-hover:text-orange-ink">
                  {splitParenthetical(g.name)[0]}
                  {splitParenthetical(g.name)[1] && <> <span className="whitespace-nowrap">{splitParenthetical(g.name)[1]}</span></>}
                </span>
                <span className="flex items-center gap-2">
                  <span
                    className={`shrink-0 text-[12.5px] tabular-nums ${g.failed ? "font-semibold text-[var(--rdy-fail)]" : all ? "font-semibold text-[var(--rdy-pass)]" : "text-muted"}`}
                  >
                    {g.verified}/{g.total}
                    <span className="sr-only"> verified{g.failed ? `, ${g.failed} failed` : ""}</span>
                  </span>
                  <span aria-hidden className="flex h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--rdy-track)]">
                    <span className="h-full bg-[var(--rdy-pass)] transition-[width] duration-500" style={{ width: `${g.total ? (g.verified / g.total) * 100 : 0}%` }} />
                    <span className="h-full bg-[var(--rdy-fail)] transition-[width] duration-500" style={{ width: `${g.total ? (g.failed / g.total) * 100 : 0}%` }} />
                  </span>
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function VerdictPanel({
  verdict,
  summary,
  session,
  elapsedMs,
  controls,
  hint,
  groups,
}: {
  verdict: Verdict;
  summary: Summary;
  session: RunSession;
  elapsedMs?: number;
  controls: ReactNode;
  hint: ReactNode;
  groups: GroupStat[];
}) {
  const { requirements, checks, tests } = summary;
  const done = Math.max(0, checks.total - checks.pending);
  const pct = checks.total > 0 ? Math.round((done / checks.total) * 100) : 0;
  const running = verdict.kind === "running";
  const testsTotal = tests.passed + tests.failed + tests.skipped;
  const recordedNote =
    session.mode === "replay" && session.recorded?.durationMs !== undefined
      ? `recorded run took ${formatDuration(session.recorded.durationMs)}`
      : session.phase === "idle"
        ? "wall clock"
        : running
          ? "and counting"
          : "wall clock, start to verdict";

  return (
    <section aria-labelledby="verdict-heading" className="rounded-2xl border border-border bg-surface shadow-[0_1px_2px_rgb(15_23_42/0.05)]">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-border px-5 py-3.5 sm:px-6">
        <div className="min-w-0">
          <h2 id="verdict-heading" className="text-[11px] font-semibold tracking-[0.16em] text-muted uppercase">
            Verdict
          </h2>
          {hint}
        </div>
        {controls}
      </div>
      <div className="grid gap-6 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-8">
        <div className="min-w-0">
          <div className="flex items-center gap-4">
            <span
              aria-hidden
              className={`grid h-14 w-14 shrink-0 place-items-center rounded-2xl border transition-colors duration-500 ${TONE_CLASS[verdict.tone]}`}
            >
              <VerdictGlyph verdict={verdict} />
            </span>
            <p
              data-testid="verdict"
              data-verdict={verdict.kind}
              className={`font-display text-[34px] leading-none font-extrabold tracking-[-0.02em] uppercase transition-colors duration-500 sm:text-[40px] ${TONE_TEXT[verdict.tone]}`}
            >
              {verdict.label}
            </p>
          </div>
          <p className="mt-3 max-w-xl text-[14.5px] leading-relaxed text-text" data-testid="verdict-sentence">
            {verdict.sentence}
          </p>
          {verdict.refs && verdict.refs.length > 0 && (
            <p className="mt-2 flex flex-wrap items-center gap-1.5" aria-label="Requirements concerned">
              {verdict.refs.slice(0, 10).map((id) => (
                <a
                  key={id}
                  href={`#req-row-${slug(id)}`}
                  className={`inline-flex h-6 items-center rounded-md border px-2 font-mono text-[11.5px] font-semibold transition-colors hover:underline ${TONE_CLASS[verdict.tone]}`}
                >
                  {id}
                </a>
              ))}
              {verdict.refs.length > 10 && <span className="text-[12.5px] text-muted">+{verdict.refs.length - 10} more</span>}
            </p>
          )}

          <div className="mt-5">
            <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
              <span id="progress-label" className="font-semibold text-text">
                {running || session.phase === "idle" ? "Checks complete" : "Checks with a result"}
              </span>
              <span className="text-muted tabular-nums">
                {done} / {checks.total} · {pct}%
              </span>
            </div>
            <div
              role="progressbar"
              aria-labelledby="progress-label"
              aria-valuemin={0}
              aria-valuemax={checks.total}
              aria-valuenow={done}
              aria-valuetext={`${done} of ${checks.total} checks complete`}
              className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-[var(--rdy-track)]"
            >
              <span
                className="h-full bg-[var(--rdy-pass)] transition-[width] duration-500 ease-out"
                style={{ width: `${checks.total ? (checks.passed / checks.total) * 100 : 0}%` }}
              />
              <span
                className="h-full bg-[var(--rdy-fail)] transition-[width] duration-500 ease-out"
                style={{ width: `${checks.total ? (checks.failed / checks.total) * 100 : 0}%` }}
              />
              {running && <span className="rdy-indeterminate h-full flex-1" />}
            </div>
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="h-2 w-2 rounded-full bg-[var(--rdy-pass)]" /> passed
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="h-2 w-2 rounded-full bg-[var(--rdy-fail)]" /> failed
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="h-2 w-2 rounded-full bg-[var(--rdy-track)] ring-1 ring-border" />{" "}
                {running || session.phase === "idle" ? "not yet run" : "no result in this run"}
              </span>
            </p>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <Stat
              testId="stat-requirements"
              label="Requirements verified"
              value={
                <>
                  {requirements.verified}
                  <span className="text-muted"> / {requirements.total}</span>
                </>
              }
              sub={`${requirements.failed} failed · ${requirements.pending} without evidence yet`}
            />
            <Stat
              testId="stat-checks"
              label="Checks"
              value={
                <>
                  {checks.passed}
                  <span className="text-[15px] font-semibold text-muted"> passed</span>
                </>
              }
              sub={`${checks.failed} failed · ${checks.pending} ${running ? "running or queued" : "without a result"}`}
            />
            <Stat
              testId="stat-tests"
              label="Tests"
              value={testsTotal}
              sub={
                <>
                  {tests.live} live · {tests.recorded} recorded
                  {tests.failed > 0 && <span className="text-[var(--rdy-fail)]"> · {tests.failed} failed</span>}
                </>
              }
            />
            <Stat testId="stat-time" label="Total time" value={formatDuration(session.phase === "idle" ? undefined : elapsedMs)} sub={recordedNote} />
          </div>
        </div>
      </div>
      <GroupBreakdown groups={groups} />
    </section>
  );
}
