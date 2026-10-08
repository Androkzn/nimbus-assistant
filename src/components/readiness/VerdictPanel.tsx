import type { ReactNode } from "react";
import type { Summary, UsageSummary } from "@/readiness/coverage";
import type { RunSession } from "@/readiness/useReadinessRun";
import { TONE_CLASS, TONE_TEXT } from "./badges";
import type { TooltipDetail } from "./CardTooltip";
import { formatDuration, slug } from "./format";
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

function Stat({ label, value, sub, explanation, details, testId, lower = false }: { label: string; value: ReactNode; sub?: ReactNode; explanation: string; details: TooltipDetail[]; testId?: string; lower?: boolean }) {
  return (
    <div
      data-testid={testId}
      tabIndex={0}
      aria-describedby={testId ? `${testId}-tooltip` : undefined}
      className="group relative isolate z-0 h-24 min-w-0 rounded-xl border border-border bg-surface-2 px-4 py-3 outline-none transition-[border-color,box-shadow] focus-within:z-20 focus-within:border-orange-strong focus-within:ring-2 focus-within:ring-orange-soft focus:z-20 focus:border-orange-strong focus:ring-2 focus:ring-orange-soft group-hover:z-20"
    >
      <p className="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{label}</p>
      <p className="mt-1 font-display text-[22px] leading-tight font-bold text-text tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-muted tabular-nums">{sub}</p>}
      <span
        id={testId ? `${testId}-tooltip` : undefined}
        role="tooltip"
        className={`pointer-events-none invisible absolute left-0 z-30 w-64 rounded-lg border border-border bg-navy px-3 py-2.5 text-left text-[12px] leading-relaxed text-on-navy opacity-0 shadow-lg transition-opacity group-hover:visible group-hover:opacity-100 group-focus-visible:visible group-focus-visible:opacity-100 ${
          lower ? "bottom-full mb-2" : "top-[calc(100%+8px)]"
        }`}
      >
        <span className="block font-semibold text-white">{label}</span>
        <span className="mt-0.5 block text-on-navy-muted">{explanation}</span>
        <span className="mt-2 grid gap-1.5 border-t border-white/15 pt-2">
          {details.map((detail) => (
            <span key={detail.label} className="block">
              <span className="font-semibold text-white">{detail.label}: </span>
              <span className="text-on-navy-muted">{detail.text}</span>
            </span>
          ))}
        </span>
      </span>
    </div>
  );
}

function formatTokens(value: number): string {
  return value.toLocaleString();
}

function formatCost(value: number): string {
  return value === 0 ? "$0.00" : value < 0.01 ? `$${value.toFixed(5)}` : `$${value.toFixed(4)}`;
}

export function VerdictPanel({
  verdict,
  summary,
  session,
  elapsedMs,
  controls,
  hint,
  usage,
}: {
  verdict: Verdict;
  summary: Summary;
  session: RunSession;
  elapsedMs?: number;
  controls: ReactNode;
  hint: ReactNode;
  usage: UsageSummary;
}) {
  const { requirements, checks, tests } = summary;
  const done = Math.max(0, checks.total - checks.pending);
  const pct = checks.total > 0 ? Math.round((done / checks.total) * 100) : 0;
  const running = verdict.kind === "running";
  const testsTotal = tests.passed + tests.failed + tests.skipped;
  const tokensUsed = usage.inputTokens + usage.outputTokens;
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
      <div className="flex flex-col gap-3 border-b border-border px-5 py-3.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-x-6 sm:px-6">
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
              explanation="The number of brief requirements with passing evidence and no failed checks. This is the main release-readiness measure."
              details={[
                { label: "Counts", text: "Requirements with at least one passing check and no failed check." },
                { label: "Why check", text: "This is the release decision: every requirement must have trustworthy evidence." },
                { label: "Read it", text: "39 / 39 means all requirements are covered; a failed count means release risk." },
              ]}
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
              explanation="The individual automated checks that passed. This shows how much of the requirement coverage has concrete evidence."
              details={[
                { label: "Counts", text: "Manifest checks, such as an acceptance rule or a deployment check." },
                { label: "Why check", text: "Checks are the concrete evidence underneath each requirement." },
                { label: "Read it", text: "A failed check can make its requirement fail even when many other checks pass." },
              ]}
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
              explanation="The recorded and live tests that produced evidence for this assessment. It helps reviewers understand the breadth of verification."
              details={[
                { label: "Live", text: "Ran now against this browser or the running app." },
                { label: "Recorded", text: "Read from the committed evaluation report and labelled with its source date." },
                { label: "Why check", text: "Shows how much evidence came from the current build versus a saved report." },
              ]}
            />
            <Stat
              testId="stat-usage"
              label="Tokens used"
              value={formatTokens(tokensUsed)}
              sub={
                <>
                  {formatTokens(usage.inputTokens)} in · {formatTokens(usage.outputTokens)} out
                  {running && <span className="text-[var(--rdy-run)]"> · updating live</span>}
                </>
              }
              explanation="The model tokens used by answer evaluations. This makes model usage and evaluation cost visible."
              details={[
                { label: "Counts", text: "Input tokens sent to models plus output tokens generated by them." },
                { label: "Why check", text: "Makes expensive or unexpectedly long evaluations visible to reviewers." },
                { label: "Note", text: "Deterministic checks and live probes may use zero model tokens." },
              ]}
            />
            <Stat
              testId="stat-cost"
              lower
              label="Estimated cost"
              value={formatCost(usage.costUSD)}
              sub={`${usage.answers} measured ${usage.answers === 1 ? "answer" : "answers"}`}
              explanation="The estimated provider cost of measured model answers. It helps teams review the cost of running the readiness assessment."
              details={[
                { label: "Counts", text: "Estimated cost for measured provider answers, not hosting or database cost." },
                { label: "Why check", text: "Keeps real-token evaluation spend visible before repeating a run." },
                { label: "Note", text: "The number is an estimate based on the configured provider pricing." },
              ]}
            />
            <Stat
              testId="stat-time"
              lower
              label="Total time"
              value={formatDuration(session.phase === "idle" ? undefined : elapsedMs)}
              sub={recordedNote}
              explanation="The elapsed time from the start of the assessment to its verdict. It helps identify slow checks and release-gate delays."
              details={[
                { label: "Counts", text: "Wall-clock time for the current local run or the recorded run being replayed." },
                { label: "Why check", text: "Shows whether a gate is practical to run during development and CI." },
                { label: "Read it", text: "Expand a slow stage below to see its command and evidence." },
              ]}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
