"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import logoMark from "@/assets/logo-mark.png";
import { readEvents } from "@/client/stream";
import { toCSV, toJSON, totals, type UsageRow } from "@/client/usage";
import { applyEvent, emptyAnswer, type AnswerState } from "@/shared/answer";
import { contextLevel, estimateTokens } from "@/shared/context";
import { MAX_MESSAGE_CHARS, type ChatMessage, type ModelsResponse } from "@/shared/contracts";
import { formatUSD } from "@/shared/cost";
import { AnswerCard } from "./AnswerCard";
import { EmptyState } from "./EmptyState";
import { AlertIcon, ArrowDownIcon, ArrowUpIcon, ChartIcon, ChevronDownIcon, PlusIcon, StopIcon } from "./icons";
import { SessionPanel } from "./SessionPanel";

interface Turn {
  id: string;
  question: string;
  answer: AnswerState;
}

/** Instructions + retrieved passages, measured at ≈1.1–1.4k tokens per request. */
const BASE_PROMPT_TOKENS = 1500;

/** How close to the bottom (px) still counts as "following" the conversation. */
const FOLLOW_THRESHOLD = 96;

export function ChatApp() {
  const [catalog, setCatalog] = useState<ModelsResponse | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [modelId, setModelId] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLElement>(null);
  const followRef = useRef(true);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch("/api/models")
      .then((r) => r.json() as Promise<ModelsResponse>)
      .then((c) => {
        setCatalog(c);
        setModelId((prev) => prev || c.defaultModelId);
      })
      .catch(() => setCatalogError(true));
  }, []);

  // Follow the streaming answer only while the user is at the bottom — never yank them away from what they're reading.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && turns.length > 0 && followRef.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  // Grow the composer with its content, up to a cap.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [draft]);

  const closePanel = useCallback(() => setPanelOpen(false), []);

  const selected = catalog?.models.find((m) => m.id === modelId);
  const modelName = (id: string) => catalog?.models.find((m) => m.id === id)?.displayName ?? id;
  const providerCount = new Set(catalog?.models.map((m) => m.providerName)).size;

  // Context meter (BRD BR-18): size of the next request vs the *selected* model's window.
  // Derived state, so switching models re-rates it immediately (brief E7).
  const lastMeasured = [...turns].reverse().find((t) => t.answer.usage)?.answer.usage;
  const historyEstimate = turns.reduce((sum, t) => sum + estimateTokens(t.question) + estimateTokens(t.answer.text), 0);
  const usedTokens =
    Math.max(lastMeasured ? lastMeasured.inputTokens + lastMeasured.outputTokens : 0, BASE_PROMPT_TOKENS + historyEstimate) + estimateTokens(draft);
  const contextWindow = selected?.contextWindow ?? 1;
  const level = contextLevel(usedTokens, contextWindow);
  const sessionTotals = totals(usage);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD;
    followRef.current = near;
    setAtBottom(near);
  }

  function jumpToLatest() {
    followRef.current = true;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy || !modelId) return; // brief E10: blank never reaches the server

    const history: ChatMessage[] = turns.flatMap((t) =>
      t.answer.status === "done" ? [{ role: "user" as const, content: t.question }, { role: "assistant" as const, content: t.answer.text }] : [],
    );
    const id = crypto.randomUUID();
    const update = (next: AnswerState) => setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, answer: next } : t)));
    followRef.current = true;
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
    followRef.current = true;
    setAtBottom(true);
    scrollRef.current?.scrollTo({ top: 0 });
    composerRef.current?.focus();
  }

  function download(name: string, content: string, type: string) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    a.click();
    URL.revokeObjectURL(url);
  }

  const canSend = draft.trim().length > 0 && !busy && Boolean(modelId);

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden">
      <header className="brand-glow relative z-20 flex h-16 shrink-0 items-center justify-between gap-3 border-b border-navy-3 bg-navy px-4 text-on-navy sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-navy-3 bg-navy-2">
            {/* Decorative: the wordmark next to it names the brand. Unoptimized keeps the logo's edges crisp. */}
            <Image src={logoMark} alt="" className="h-6 w-auto" priority unoptimized />
          </span>
          <div className="min-w-0 leading-tight">
            <p className="font-display text-[15px] font-extrabold tracking-tight">
              NimbusStack<span className="text-orange">.</span>
            </p>
            <p className="truncate text-[10px] font-semibold tracking-[0.18em] text-on-navy-muted uppercase max-sm:hidden">
              Product knowledge assistant
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPanelOpen(true)}
            aria-controls="session-panel"
            aria-expanded={panelOpen}
            className="inline-flex h-9 items-center gap-2 rounded-xl border border-navy-3 bg-navy-2 px-3 text-sm font-semibold tabular-nums transition-colors hover:border-orange lg:hidden"
          >
            <ChartIcon className="text-orange" />
            <span className="sr-only">Session usage:</span>
            {formatUSD(sessionTotals.costUSD)}
          </button>
          <button
            type="button"
            data-testid="new-conversation"
            onClick={newConversation}
            className="inline-flex h-9 items-center gap-2 rounded-xl border border-navy-3 bg-navy-2 px-3 text-sm font-semibold transition-colors hover:border-orange hover:text-orange"
          >
            <PlusIcon />
            <span className="max-sm:sr-only">New conversation</span>
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <main ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto" aria-live="polite" aria-busy={busy}>
            <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
              {catalogError && (
                <p role="alert" className="mb-6 flex items-center gap-2 rounded-xl border border-red/25 bg-red-soft p-3 text-sm">
                  <AlertIcon className="shrink-0 text-red" />
                  Couldn&apos;t load the model list. Refresh the page to try again.
                </p>
              )}
              {turns.length === 0 ? (
                <EmptyState onAsk={(q) => void send(q)} disabled={!modelId || busy} providerCount={providerCount} />
              ) : (
                <div className="space-y-8">
                  {turns.map((t) => (
                    <div key={t.id} className="space-y-3">
                      <div className="flex justify-end">
                        <p
                          data-testid="question"
                          className="max-w-[85%] rounded-2xl rounded-br-md bg-navy px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-on-navy shadow-sm dark:bg-navy-3"
                        >
                          {t.question}
                        </p>
                      </div>
                      <AnswerCard answer={t.answer} modelName={modelName} onRetry={busy ? undefined : () => retry(t)} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </main>

          <form
            className="relative shrink-0 px-4 pt-2 pb-3 sm:px-6 sm:pb-4"
            onSubmit={(e) => {
              e.preventDefault();
              void send(draft);
            }}
          >
            {!atBottom && turns.length > 0 && (
              <button
                type="button"
                onClick={jumpToLatest}
                className="absolute -top-11 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-semibold shadow-md transition-colors hover:border-orange-strong"
              >
                <ArrowDownIcon /> Jump to latest
              </button>
            )}
            <div className="mx-auto max-w-3xl">
              {level !== "ok" && (
                <p
                  role="status"
                  className={`mb-2 flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-medium ${
                    level === "red" ? "border-red/30 bg-red-soft text-red" : "border-amber/30 bg-amber-soft text-amber"
                  }`}
                >
                  <AlertIcon className="shrink-0" />
                  {level === "red"
                    ? "This conversation is near the model's context limit. Start a new conversation."
                    : "This conversation is approaching the model's context limit."}
                </p>
              )}
              <div className="rounded-2xl border border-border bg-surface shadow-[0_8px_30px_-12px_rgb(15_23_42/0.18)] transition-[border-color,box-shadow] focus-within:border-orange-strong focus-within:shadow-[0_0_0_4px_rgb(234_88_12/0.12)]">
                <label htmlFor="composer" className="sr-only">
                  Your question
                </label>
                <textarea
                  id="composer"
                  ref={composerRef}
                  data-testid="composer"
                  value={draft}
                  maxLength={MAX_MESSAGE_CHARS}
                  rows={1}
                  placeholder="Ask about pricing, integrations, SLAs…"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void send(draft);
                    }
                  }}
                  className="block max-h-[200px] w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-base leading-relaxed outline-none placeholder:text-muted/80 focus-visible:outline-none sm:text-[15px]"
                />
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-2.5 pb-2.5">
                  <div className="relative shrink-0">
                    <label htmlFor="model" className="sr-only">
                      AI model
                    </label>
                    <select
                      id="model"
                      data-testid="model-select"
                      value={modelId}
                      onChange={(e) => setModelId(e.target.value)}
                      className="h-9 max-w-[16rem] cursor-pointer sm:max-w-none appearance-none truncate rounded-full border border-border bg-surface-2 pr-8 pl-3.5 text-[13px] font-semibold text-text transition-colors hover:border-orange-line"
                    >
                      {catalog?.models.map((m) => (
                        <option key={m.id} value={m.id} disabled={!m.available}>
                          {m.providerName} — {m.displayName}
                          {m.available ? "" : " (not configured)"}
                        </option>
                      ))}
                    </select>
                    <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted" />
                  </div>
                  <p
                    data-testid="model-description"
                    title={selected?.description}
                    className="min-w-0 flex-1 text-xs leading-snug text-muted max-sm:order-last max-sm:basis-full max-sm:px-1 sm:truncate"
                  >
                    {selected?.description}
                  </p>
                  <div className="ml-auto flex items-center gap-2">
                    {draft.length > MAX_MESSAGE_CHARS * 0.9 && (
                      <span className="text-xs text-amber tabular-nums">
                        {draft.length} / {MAX_MESSAGE_CHARS}
                      </span>
                    )}
                    {busy ? (
                      <button
                        type="button"
                        data-testid="stop"
                        onClick={() => abortRef.current?.abort()}
                        aria-label="Stop answering"
                        title="Stop"
                        className="grid h-9 w-9 place-items-center rounded-full bg-text text-sm text-surface transition-transform active:scale-95"
                      >
                        <StopIcon />
                      </button>
                    ) : (
                      <button
                        type="submit"
                        data-testid="send"
                        disabled={!canSend}
                        aria-label="Send question"
                        title="Send (Enter)"
                        className="grid h-9 w-9 place-items-center rounded-full bg-orange-strong text-lg text-white shadow-sm shadow-orange-strong/30 transition hover:brightness-110 active:scale-95 disabled:cursor-not-allowed disabled:bg-border disabled:text-muted disabled:shadow-none disabled:hover:brightness-100"
                      >
                        <ArrowUpIcon />
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <p className="mt-2 hidden text-center text-[11px] text-muted sm:block">
                <kbd className="font-sans font-semibold">Enter</kbd> to send · <kbd className="font-sans font-semibold">Shift + Enter</kbd> for a new
                line · Answers come only from NimbusStack documents
              </p>
            </div>
          </form>
        </div>

        <SessionPanel
          open={panelOpen}
          onClose={closePanel}
          totals={sessionTotals}
          rows={usage}
          modelName={modelName}
          selected={selected}
          usedTokens={usedTokens}
          contextWindow={contextWindow}
          level={level}
          onExportCSV={() => download("nimbus-usage.csv", toCSV(usage), "text/csv")}
          onExportJSON={() => download("nimbus-usage.json", toJSON(usage, catalog?.pricingVersion ?? ""), "application/json")}
        />
      </div>
    </div>
  );
}
