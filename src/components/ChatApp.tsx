"use client";

import { useEffect, useRef, useState } from "react";
import { readEvents } from "@/client/stream";
import { toCSV, toJSON, totals, type UsageRow } from "@/client/usage";
import { applyEvent, emptyAnswer, type AnswerState } from "@/shared/answer";
import { contextLevel, estimateTokens } from "@/shared/context";
import { MAX_MESSAGE_CHARS, type ChatMessage, type ModelsResponse } from "@/shared/contracts";
import { formatUSD } from "@/shared/cost";
import { AnswerCard } from "./AnswerCard";

interface Turn {
  id: string;
  question: string;
  answer: AnswerState;
}

/** Instructions + retrieved passages, measured at ≈1.1–1.4k tokens per request. */
const BASE_PROMPT_TOKENS = 1500;

const EXAMPLES = [
  "What are the key differences between the Pro and Enterprise pricing tiers?",
  "Does Vault integrate with Salesforce? What version is required?",
  "What new features were released in v4.2 of Relay?",
  "A client is getting a 403 on the API. What should they check first?",
  "Which of our products support SSO via SAML 2.0?",
  "What's the SLA for Priority 1 support tickets?",
];

export function ChatApp() {
  const [catalog, setCatalog] = useState<ModelsResponse | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [modelId, setModelId] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/models")
      .then((r) => r.json() as Promise<ModelsResponse>)
      .then((c) => {
        setCatalog(c);
        setModelId((prev) => prev || c.defaultModelId);
      })
      .catch(() => setCatalogError(true));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  const selected = catalog?.models.find((m) => m.id === modelId);
  const modelName = (id: string) => catalog?.models.find((m) => m.id === id)?.displayName ?? id;

  // Context meter (BRD BR-18): size of the next request vs the *selected* model's window.
  // Derived state, so switching models re-rates it immediately (brief E7).
  const lastMeasured = [...turns].reverse().find((t) => t.answer.usage)?.answer.usage;
  const historyEstimate = turns.reduce((sum, t) => sum + estimateTokens(t.question) + estimateTokens(t.answer.text), 0);
  const usedTokens =
    Math.max(lastMeasured ? lastMeasured.inputTokens + lastMeasured.outputTokens : 0, BASE_PROMPT_TOKENS + historyEstimate) + estimateTokens(draft);
  const window = selected?.contextWindow ?? 1;
  const level = contextLevel(usedTokens, window);
  const sessionTotals = totals(usage);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy || !modelId) return; // brief E10: blank never reaches the server

    const history: ChatMessage[] = turns.flatMap((t) =>
      t.answer.status === "done" ? [{ role: "user" as const, content: t.question }, { role: "assistant" as const, content: t.answer.text }] : [],
    );
    const id = crypto.randomUUID();
    const update = (next: AnswerState) => setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, answer: next } : t)));
    setTurns((ts) => [...ts, { id, question, answer: emptyAnswer() }]);
    setDraft("");
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    let state = emptyAnswer();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelId, messages: [...history, { role: "user", content: question }] }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        update({
          ...state,
          status: "error",
          error: {
            code: body?.error?.code ?? "unavailable",
            message: body?.error?.message ?? `The request failed (HTTP ${res.status}). Please try again.`,
            retryAfterSec: body?.error?.retryAfterSec,
          },
        });
        return;
      }
      for await (const event of readEvents(res)) {
        state = applyEvent(state, event);
        update(state);
      }
      if (state.status === "done" && state.usage && state.answeredBy && state.requestedModel) {
        const done = state;
        setUsage((rows) => [
          ...rows,
          {
            turn: rows.length + 1,
            timestamp: new Date().toISOString(),
            requestedModel: done.requestedModel!,
            answeredBy: done.answeredBy!,
            inputTokens: done.usage!.inputTokens,
            outputTokens: done.usage!.outputTokens,
            costUSD: done.costUSD ?? 0,
          },
        ]);
      } else if (state.status === "streaming") {
        update({ ...state, status: "error", error: { code: "unavailable", message: "The answer was interrupted. Please try again." } });
      }
    } catch {
      update({
        ...state,
        status: "error",
        error: controller.signal.aborted
          ? { code: "unavailable", message: "Stopped. Ask again whenever you're ready." }
          : { code: "unavailable", message: "Network error — check your connection and try again." },
      });
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function retry(turn: Turn) {
    setTurns((ts) => ts.filter((t) => t.id !== turn.id));
    void send(turn.question);
  }

  function newConversation() {
    abortRef.current?.abort();
    setTurns([]);
    setUsage([]);
    setDraft("");
  }

  function download(name: string, content: string, type: string) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    a.click();
    URL.revokeObjectURL(url);
  }

  const canSend = draft.trim().length > 0 && !busy && Boolean(modelId);

  return (
    <div className="mx-auto flex h-dvh w-full max-w-4xl flex-col">
      <header className="border-b border-border bg-surface px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">NimbusStack Product Assistant</h1>
            <p className="text-xs text-muted">Answers only from NimbusStack&apos;s own documents — every answer shows its sources.</p>
          </div>
          <div className="flex items-start gap-2">
            <div className="flex flex-col">
              <label htmlFor="model" className="sr-only">
                AI model
              </label>
              <select
                id="model"
                data-testid="model-select"
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
              >
                {catalog?.models.map((m) => (
                  <option key={m.id} value={m.id} disabled={!m.available}>
                    {m.providerName} — {m.displayName}
                    {m.available ? "" : " (not configured)"}
                  </option>
                ))}
              </select>
              <span data-testid="model-description" className="mt-1 max-w-72 text-xs text-muted">
                {selected?.description}
              </span>
            </div>
            <button
              data-testid="new-conversation"
              onClick={newConversation}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-bg"
            >
              New Conversation
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted">
          <div data-testid="context-meter" data-level={level} className="flex items-center gap-2" title="Size of the next request vs the selected model's context window">
            <span>Context</span>
            <span className="h-1.5 w-24 overflow-hidden rounded-full bg-border" aria-hidden>
              <span
                className={`block h-full ${level === "red" ? "bg-red" : level === "amber" ? "bg-amber" : "bg-ok"}`}
                style={{ width: `${Math.max(2, Math.min(100, (usedTokens / window) * 100))}%` }}
              />
            </span>
            <span>
              {((usedTokens / window) * 100).toFixed(usedTokens / window < 0.01 ? 2 : 0)}% of {window.toLocaleString()} tokens
            </span>
            {level !== "ok" && (
              <span className={level === "red" ? "font-medium text-red" : "font-medium text-amber"}>
                {level === "red" ? "⚠ Near the limit — start a new conversation" : "⚠ Approaching the limit"}
              </span>
            )}
          </div>
          <div data-testid="session-totals">
            Session: {sessionTotals.answers} answers · in {sessionTotals.inputTokens.toLocaleString()} · out{" "}
            {sessionTotals.outputTokens.toLocaleString()} tokens · est. {formatUSD(sessionTotals.costUSD)}
          </div>
          <div className="flex gap-1">
            <span>Export:</span>
            <button
              data-testid="export-csv"
              disabled={usage.length === 0}
              onClick={() => download("nimbus-usage.csv", toCSV(usage), "text/csv")}
              className="underline disabled:no-underline disabled:opacity-50"
            >
              CSV
            </button>
            <button
              data-testid="export-json"
              disabled={usage.length === 0}
              onClick={() => download("nimbus-usage.json", toJSON(usage, catalog?.pricingVersion ?? ""), "application/json")}
              className="underline disabled:no-underline disabled:opacity-50"
            >
              JSON
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 space-y-4 overflow-y-auto px-4 py-4" aria-live="polite">
        {catalogError && (
          <p role="alert" className="rounded-lg bg-red-soft p-3 text-sm">
            Couldn&apos;t load the model list. Refresh the page to try again.
          </p>
        )}
        {turns.length === 0 && (
          <section className="mx-auto mt-6 max-w-2xl text-center">
            <h2 className="text-base font-medium">Ask about Relay, Vault, Pulse or Ledger</h2>
            <p className="mt-1 text-sm text-muted">
              Pricing, integrations, release notes, troubleshooting and SLAs — answered from the knowledge base, with sources.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {EXAMPLES.map((q) => (
                <button
                  key={q}
                  onClick={() => send(q)}
                  disabled={!modelId}
                  className="rounded-full border border-border bg-surface px-3 py-1.5 text-left text-sm hover:border-accent"
                >
                  {q}
                </button>
              ))}
            </div>
          </section>
        )}
        {turns.map((t) => (
          <div key={t.id} className="space-y-2">
            <div className="flex justify-end">
              <p data-testid="question" className="max-w-[85%] whitespace-pre-wrap rounded-xl bg-accent px-3 py-2 text-sm text-white">
                {t.question}
              </p>
            </div>
            <AnswerCard answer={t.answer} modelName={modelName} onRetry={busy ? undefined : () => retry(t)} />
          </div>
        ))}
        <div ref={bottomRef} />
      </main>

      <form
        className="border-t border-border bg-surface px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <div className="flex items-end gap-2">
          <label htmlFor="composer" className="sr-only">
            Your question
          </label>
          <textarea
            id="composer"
            data-testid="composer"
            value={draft}
            maxLength={MAX_MESSAGE_CHARS}
            rows={2}
            placeholder="Ask a product question… (Enter to send, Shift+Enter for a new line)"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(draft);
              }
            }}
            className="flex-1 resize-none rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
          />
          {busy ? (
            <button type="button" data-testid="stop" onClick={() => abortRef.current?.abort()} className="rounded-lg border border-border px-4 py-2 text-sm">
              Stop
            </button>
          ) : (
            <button
              type="submit"
              data-testid="send"
              disabled={!canSend}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              Send
            </button>
          )}
        </div>
        {draft.length > MAX_MESSAGE_CHARS * 0.9 && (
          <p className="mt-1 text-xs text-amber">
            {draft.length} / {MAX_MESSAGE_CHARS} characters
          </p>
        )}
      </form>
    </div>
  );
}
