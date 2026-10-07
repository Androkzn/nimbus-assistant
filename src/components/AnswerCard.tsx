"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AnswerState } from "@/shared/answer";
import type { ErrorCode } from "@/shared/contracts";
import { formatUSD } from "@/shared/cost";

const REASON: Record<ErrorCode, string> = {
  rate_limited: "was rate-limited",
  auth: "isn't usable (key or billing)",
  unavailable: "was unavailable",
  bad_request: "rejected the request",
  invalid_input: "rejected the input",
};

export function AnswerCard({
  answer,
  modelName,
  onRetry,
}: {
  answer: AnswerState;
  modelName: (id: string) => string;
  onRetry?: () => void;
}) {
  const waiting = answer.status === "streaming" && answer.text.length === 0;
  const lastFallback = answer.fallbacks.at(-1);

  return (
    <article data-testid="answer" data-status={answer.status} className="rounded-xl border border-border bg-surface p-4 shadow-sm">
      {answer.status === "streaming" && lastFallback && (
        <p className="mb-2 text-sm text-amber" role="status">
          {modelName(lastFallback.from)} {REASON[lastFallback.reason]} — switching to {modelName(lastFallback.to)}…
        </p>
      )}

      {waiting && (
        <p className="text-sm text-muted" role="status">
          Searching the knowledge base<span className="animate-pulse">…</span>
        </p>
      )}

      {answer.text && (
        <div className="answer-md text-[0.95rem] leading-relaxed" data-testid="answer-text">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{answer.text}</ReactMarkdown>
        </div>
      )}

      {answer.status === "error" && answer.error && (
        <div data-testid="answer-error" role="alert" className="mt-1 rounded-lg border border-red/40 bg-red-soft p-3 text-sm">
          <p>{answer.error.message}</p>
          {onRetry && (
            <button onClick={onRetry} className="mt-2 rounded-md border border-border bg-surface px-3 py-1 text-sm hover:bg-bg">
              Try again
            </button>
          )}
        </div>
      )}

      {answer.status === "done" && answer.answeredBy && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-2 text-xs text-muted">
          <span data-testid="answered-by" className="rounded-full bg-accent-soft px-2 py-0.5 font-medium text-accent">
            Answered by {modelName(answer.answeredBy)}
          </span>
          {answer.requestedModel && answer.requestedModel !== answer.answeredBy && (
            <span data-testid="fallback-note" className="text-amber">
              {modelName(answer.requestedModel)} {REASON[answer.fallbacks[0]?.reason ?? "unavailable"]} — backup answered
            </span>
          )}
          {answer.usage && (
            <span data-testid="usage-line">
              in {answer.usage.inputTokens.toLocaleString()} · out {answer.usage.outputTokens.toLocaleString()} tokens · est.{" "}
              {formatUSD(answer.costUSD ?? 0)}
            </span>
          )}
        </div>
      )}

      {answer.sources.length > 0 && (
        <details data-testid="sources" className="mt-3 text-sm">
          <summary className="cursor-pointer select-none text-muted hover:text-text">Sources ({answer.sources.length})</summary>
          <ol className="mt-2 space-y-2">
            {answer.sources.map((s) => (
              <li key={s.n} className="rounded-lg border border-border bg-bg p-2">
                <div className="mb-1 text-xs font-medium">
                  [{s.n}] {s.file} · {s.section}
                  {s.docDate ? ` · ${s.docDate}` : ""}
                </div>
                <pre className="whitespace-pre-wrap break-words font-mono text-xs text-muted">{s.text.split("\n").slice(1).join("\n")}</pre>
              </li>
            ))}
          </ol>
        </details>
      )}
    </article>
  );
}
