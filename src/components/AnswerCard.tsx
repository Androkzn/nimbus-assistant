"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { citationNumber, citedNumbers, linkCitations } from "@/client/citations";
import { deadlineIn, formatWait, liveWaitCopy } from "@/client/cooldown";
import { useCountdown } from "@/client/useCountdown";
import type { AnswerState } from "@/shared/answer";
import { KB_GUARD_ID, type ErrorCode, type PassageDTO } from "@/shared/contracts";
import { formatUSD } from "@/shared/cost";
import { AlertIcon, CheckIcon, ChevronDownIcon, CopyIcon, DocIcon, SwitchIcon } from "./icons";

const REASON: Record<ErrorCode, string> = {
  rate_limited: "was rate-limited",
  auth: "isn't usable (key or billing)",
  unavailable: "was unavailable",
  bad_request: "rejected the request",
  invalid_input: "rejected the input",
};

/** Short headline above the server's message; plain messages (e.g. "Stopped.") need none. */
const ERROR_TITLE: Partial<Record<ErrorCode, string>> = {
  rate_limited: "Rate limit reached",
  auth: "Provider not available",
  invalid_input: "Can't send that question",
};

/** Passage body without its first line, which repeats the file and section shown in the header. */
const passageBody = (s: PassageDTO) => s.text.split("\n").slice(1).join("\n");

export function AnswerCard({
  answer,
  modelName,
  onRetry,
}: {
  answer: AnswerState;
  modelName: (id: string) => string;
  onRetry?: () => void;
}) {
  const uid = useId();
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(highlightTimer.current), []);

  const streaming = answer.status === "streaming";
  const waiting = streaming && answer.text.length === 0;
  const lastFallback = answer.fallbacks.at(-1);
  const guarded = answer.answeredBy === KB_GUARD_ID;
  // R2: which retrieved passages the answer actually came from. Cited ones are always visible and
  // listed first; the rest stay available but marked, so nobody mistakes them for the answer's basis.
  const cited = useMemo(() => citedNumbers(answer.text), [answer.text]);
  const citedSources = answer.sources.filter((s) => cited.has(s.n));
  const orderedSources = [...citedSources, ...answer.sources.filter((s) => !cited.has(s.n))];

  function showSource(n: number) {
    setSourcesOpen(true);
    setHighlight(n);
    clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlight(null), 1800);
    requestAnimationFrame(() => document.getElementById(`${uid}-src-${n}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }

  async function copy() {
    const refs = answer.sources.map((s) => `[${s.n}] ${s.file} · ${s.section}`).join("\n");
    await navigator.clipboard?.writeText(refs ? `${answer.text}\n\nSources:\n${refs}` : answer.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const markdown: Components = {
    a: ({ href, children }) => {
      const n = citationNumber(href);
      if (n === null) {
        return (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        );
      }
      const source = answer.sources.find((s) => s.n === n);
      return (
        <button
          type="button"
          onClick={() => showSource(n)}
          disabled={!source}
          title={source ? `${source.file} · ${source.section}` : undefined}
          aria-label={source ? `Source ${n}: ${source.file}, ${source.section}` : `Source ${n}`}
          className="cite mx-[2px] inline-flex h-[1.2rem] min-w-[1.2rem] -translate-y-px items-center justify-center rounded-md border border-orange-line bg-orange-soft px-1 align-middle text-[0.68rem] font-bold leading-none text-orange-ink transition-colors hover:border-orange-deep hover:bg-orange-deep hover:text-white disabled:cursor-default disabled:hover:border-orange-line disabled:hover:bg-orange-soft disabled:hover:text-orange-ink"
        >
          <span className="sr-only" aria-hidden>
            [
          </span>
          {n}
          <span className="sr-only" aria-hidden>
            ]
          </span>
        </button>
      );
    },
  };

  return (
    <article
      data-testid="answer"
      data-status={answer.status}
      className="overflow-hidden rounded-2xl border border-border bg-surface shadow-[0_1px_2px_rgb(15_23_42/0.04),0_8px_24px_-12px_rgb(15_23_42/0.08)]"
    >
      <div className="px-5 py-4 sm:px-6 sm:py-5">
        {streaming && lastFallback && (
          <p className="mb-3 flex items-center gap-2 rounded-lg border border-amber/25 bg-amber-soft px-3 py-2 text-sm text-amber" role="status">
            <SwitchIcon className="shrink-0" />
            {modelName(lastFallback.from)} {REASON[lastFallback.reason]} — switching to {modelName(lastFallback.to)}…
          </p>
        )}

        {waiting && (
          <div role="status" className="space-y-3">
            <p className="flex items-center gap-2.5 text-sm text-muted">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-orange opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-orange-strong" />
              </span>
              {answer.sources.length > 0
                ? `Found ${answer.sources.length} relevant passages — writing the answer…`
                : "Searching the knowledge base…"}
            </p>
            <div className="space-y-2" aria-hidden>
              <div className="skeleton h-3 w-11/12 rounded-full" />
              <div className="skeleton h-3 w-8/12 rounded-full" />
              <div className="skeleton h-3 w-10/12 rounded-full" />
            </div>
          </div>
        )}

        {answer.text && (
          <div className={`answer-md text-[15px] leading-relaxed ${streaming ? "is-streaming" : ""}`} data-testid="answer-text">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdown}>
              {linkCitations(answer.text)}
            </ReactMarkdown>
          </div>
        )}

        {answer.status === "done" && citedSources.length > 0 && (
          <div data-testid="cited-sources" className="mt-4 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="mr-1 font-semibold text-muted">Sources used:</span>
            {citedSources.map((s) => (
              <button
                key={s.n}
                type="button"
                onClick={() => showSource(s.n)}
                className="inline-flex items-center gap-1.5 rounded-full border border-orange-line bg-orange-soft px-2 py-0.5 text-orange-ink transition-colors hover:border-orange-strong"
              >
                <b className="tabular-nums">{s.n}</b>
                {s.file} · {s.section}
              </button>
            ))}
          </div>
        )}

        {answer.status === "error" && answer.error && (
          <div
            data-testid="answer-error"
            role="alert"
            className={`flex gap-3 rounded-xl border border-red/25 bg-red-soft p-4 text-sm ${answer.text ? "mt-4" : ""}`}
          >
            <AlertIcon className="mt-0.5 shrink-0 text-base text-red" />
            <div className="min-w-0 flex-1">
              {ERROR_TITLE[answer.error.code] && <p className="font-semibold text-text">{ERROR_TITLE[answer.error.code]}</p>}
              <ErrorDetail message={answer.error.message} seconds={answer.error.retryAfterSec ?? 0} onRetry={onRetry} />
            </div>
          </div>
        )}
      </div>

      {answer.sources.length > 0 && answer.text && (
        <details
          data-testid="sources"
          open={sourcesOpen}
          onToggle={(e) => setSourcesOpen(e.currentTarget.open)}
          className="group/src border-t border-border"
        >
          <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3 text-sm select-none transition-colors hover:bg-orange-soft hover:text-orange-ink sm:px-6 [&::-webkit-details-marker]:hidden">
            <DocIcon className="shrink-0 text-orange-ink" />
            <span className="font-semibold">Passages</span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted tabular-nums">
              {citedSources.length} cited · {answer.sources.length} retrieved
            </span>
            <ChevronDownIcon className="ml-auto shrink-0 text-muted transition-transform group-open/src:rotate-180" />
          </summary>
          <ol className="space-y-2 px-5 pb-5 sm:px-6">
            {orderedSources.map((s) => (
              <li
                key={s.n}
                id={`${uid}-src-${s.n}`}
                className={`scroll-mt-4 rounded-xl border bg-surface-2 p-3.5 transition-[border-color,box-shadow] duration-300 ${
                  highlight === s.n ? "border-orange-strong shadow-[0_0_0_4px_rgb(234_88_12/0.15)]" : "border-border"
                } ${cited.has(s.n) ? "" : "opacity-70"}`}
              >
                <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span className="grid h-5 min-w-5 place-items-center rounded-full bg-[#c2410c] px-1 text-[11px] font-bold text-white">{s.n}</span>
                  <span className="font-semibold text-text">
                    {s.file} · {s.section}
                  </span>
                  {s.docDate && <span className="rounded-full border border-border px-1.5 py-px text-[11px] text-muted">{s.docDate}</span>}
                  {!cited.has(s.n) && <span className="text-[11px] text-muted italic">retrieved, not cited</span>}
                </div>
                <div className="answer-md passage-md text-[13px] leading-relaxed text-muted">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{passageBody(s)}</ReactMarkdown>
                </div>
              </li>
            ))}
          </ol>
        </details>
      )}

      {answer.status === "done" && answer.answeredBy && (
        <footer className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border bg-surface-2/60 px-5 py-2.5 text-xs text-muted sm:px-6">
          <span data-testid="answered-by" className="rounded-full border border-border bg-surface px-2.5 py-1 font-semibold text-text">
            {guarded ? "No AI call — nothing in the knowledge base matched" : `Answered by ${modelName(answer.answeredBy)}`}
          </span>
          {!guarded && answer.requestedModel && answer.requestedModel !== answer.answeredBy && (
            <span
              data-testid="fallback-note"
              className="inline-flex items-center gap-1.5 rounded-full border border-amber/30 bg-amber-soft px-2.5 py-1 font-medium text-amber"
            >
              <SwitchIcon className="shrink-0" />
              {modelName(answer.requestedModel)} {REASON[answer.fallbacks[0]?.reason ?? "unavailable"]} — backup answered
            </span>
          )}
          {!guarded && answer.unverifiedFigures && (
            <span
              data-testid="figure-check"
              data-ok={answer.unverifiedFigures.length === 0}
              title="Every number in the answer is checked against the passages the model was given."
              className={answer.unverifiedFigures.length === 0 ? "inline-flex items-center gap-1 font-medium text-ok" : "inline-flex items-center gap-1 rounded-full border border-amber/30 bg-amber-soft px-2.5 py-1 font-medium text-amber"}
            >
              {answer.unverifiedFigures.length === 0 ? (
                <>
                  <CheckIcon className="shrink-0" /> Figures match sources
                </>
              ) : (
                <>
                  <AlertIcon className="shrink-0" /> Not found in sources: {answer.unverifiedFigures.join(", ")} — verify before quoting
                </>
              )}
            </span>
          )}
          {answer.usage && (
            <span data-testid="usage-line" className="tabular-nums">
              in {answer.usage.inputTokens.toLocaleString()} · out {answer.usage.outputTokens.toLocaleString()} tokens · est.{" "}
              {formatUSD(answer.costUSD ?? 0)}
            </span>
          )}
          <button
            type="button"
            onClick={copy}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2 py-1 font-medium transition-colors hover:bg-orange-soft hover:text-orange-ink"
          >
            {copied ? <CheckIcon className="text-ok" /> : <CopyIcon />}
            {copied ? "Copied" : "Copy"}
          </button>
        </footer>
      )}
    </article>
  );
}

/** Retry that waits out the provider's rate-limit window instead of letting the user hammer it (brief E9). */
/** Error copy and retry share one countdown, so "wait about N seconds" and the button always agree (BR-21). */
function ErrorDetail({ message, seconds, onRetry }: { message: string; seconds: number; onRetry?: () => void }) {
  // Fixed when the error first shows: the button can unmount while another answer streams without restarting the wait.
  const [retryAt] = useState(() => (seconds > 0 ? deadlineIn(seconds) : null));
  const left = useCountdown(retryAt);

  return (
    <>
      <p className="text-text/80">{retryAt === null ? message : liveWaitCopy(message, left)}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={left > 0}
          className="mt-3 inline-flex items-center rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text transition-colors hover:border-orange-strong hover:bg-orange-soft hover:text-orange-ink disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-border disabled:hover:bg-surface disabled:hover:text-text"
        >
          {left > 0 ? `Try again in ${formatWait(left)}` : "Try again"}
        </button>
      )}
    </>
  );
}
