"use client";

import { useEffect, useId, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { citationNumber, linkCitations } from "@/client/citations";
import type { AnswerState } from "@/shared/answer";
import type { ErrorCode, PassageDTO } from "@/shared/contracts";
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
  const sourceFiles = [...new Set(answer.sources.map((s) => s.file))];

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

        {answer.status === "error" && answer.error && (
          <div
            data-testid="answer-error"
            role="alert"
            className={`flex gap-3 rounded-xl border border-red/25 bg-red-soft p-4 text-sm ${answer.text ? "mt-4" : ""}`}
          >
            <AlertIcon className="mt-0.5 shrink-0 text-base text-red" />
            <div className="min-w-0 flex-1">
              {ERROR_TITLE[answer.error.code] && <p className="font-semibold text-text">{ERROR_TITLE[answer.error.code]}</p>}
              <p className="text-text/80">{answer.error.message}</p>
              {onRetry && <RetryButton seconds={answer.error.retryAfterSec ?? 0} onRetry={onRetry} />}
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
            <span className="font-semibold">Sources</span>
            <span className="rounded-full border border-border bg-surface-2 px-1.5 text-xs font-medium tabular-nums text-muted">
              {answer.sources.length}
            </span>
            <span className="hidden min-w-0 flex-1 truncate text-xs text-muted sm:block">{sourceFiles.join(" · ")}</span>
            <ChevronDownIcon className="ml-auto shrink-0 text-muted transition-transform group-open/src:rotate-180" />
          </summary>
          <ol className="space-y-2 px-5 pb-5 sm:px-6">
            {answer.sources.map((s) => (
              <li
                key={s.n}
                id={`${uid}-src-${s.n}`}
                className={`scroll-mt-4 rounded-xl border bg-surface-2 p-3.5 transition-[border-color,box-shadow] duration-300 ${
                  highlight === s.n ? "border-orange-strong shadow-[0_0_0_4px_rgb(234_88_12/0.15)]" : "border-border"
                }`}
              >
                <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span className="grid h-5 min-w-5 place-items-center rounded-full bg-[#c2410c] px-1 text-[11px] font-bold text-white">{s.n}</span>
                  <span className="font-semibold text-text">
                    {s.file} · {s.section}
                  </span>
                  {s.docDate && <span className="rounded-full border border-border px-1.5 py-px text-[11px] text-muted">{s.docDate}</span>}
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
            Answered by {modelName(answer.answeredBy)}
          </span>
          {answer.requestedModel && answer.requestedModel !== answer.answeredBy && (
            <span
              data-testid="fallback-note"
              className="inline-flex items-center gap-1.5 rounded-full border border-amber/30 bg-amber-soft px-2.5 py-1 font-medium text-amber"
            >
              <SwitchIcon className="shrink-0" />
              {modelName(answer.requestedModel)} {REASON[answer.fallbacks[0]?.reason ?? "unavailable"]} — backup answered
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
function RetryButton({ seconds, onRetry }: { seconds: number; onRetry: () => void }) {
  const [left, setLeft] = useState(seconds);

  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);

  return (
    <button
      type="button"
      onClick={onRetry}
      disabled={left > 0}
      className="mt-3 inline-flex items-center rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text transition-colors hover:border-orange-strong hover:bg-orange-soft hover:text-orange-ink disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-border disabled:hover:bg-surface disabled:hover:text-text"
    >
      {left > 0 ? `Try again in ${left}s` : "Try again"}
    </button>
  );
}
