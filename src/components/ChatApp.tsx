"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readEvents } from "@/client/stream";
import { deadlineIn, formatWait } from "@/client/cooldown";
import { useCountdown } from "@/client/useCountdown";
import { toCSV, toJSON, totals, type UsageRow } from "@/client/usage";
import { applyEvent, emptyAnswer, type AnswerState } from "@/shared/answer";
import { contextLevel, estimateTokens } from "@/shared/context";
import { HISTORY_MESSAGES, KB_GUARD_ID, MAX_MESSAGE_CHARS, type ChatMessage, type ModelsResponse, type PublicModel } from "@/shared/contracts";
import { formatUSD } from "@/shared/cost";
import { AnswerCard } from "./AnswerCard";
import { BrandLockup } from "./BrandLockup";
import { EmptyState } from "./EmptyState";
import { AlertIcon, ArrowDownIcon, ArrowUpIcon, ChartIcon, PlusIcon, StopIcon } from "./icons";
import { ModelPicker } from "./ModelPicker";
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
  // This app's own rate limit (BR-26): until it lifts, asking is off and one notice counts down.
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const cooldownLeft = useCountdown(cooldownUntil);
  const cooling = cooldownLeft > 0;
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
  const modelName = (id: string) =>
    id === KB_GUARD_ID ? "Knowledge-base check (no AI call)" : (catalog?.models.find((m) => m.id === id)?.displayName ?? id);
  // R3: every option shows its provider (group label) and its short description, not only the selected one.
  const providerGroups = Object.entries(
    (catalog?.models ?? []).reduce<Record<string, PublicModel[]>>((groups, m) => ({ ...groups, [m.providerName]: [...(groups[m.providerName] ?? []), m] }), {}),
  );

  // Context meter (BRD BR-18): size of the next request vs the *selected* model's window.
  // Derived state, so switching models re-rates it immediately (brief E7).
  const lastMeasured = [...turns].reverse().find((t) => t.answer.usage)?.answer.usage;
  // Count only the history the server actually forwards (last HISTORY_MESSAGES messages = half as many turns).
  const historyEstimate = turns
    .slice(-(HISTORY_MESSAGES / 2))
    .reduce((sum, t) => sum + estimateTokens(t.question) + estimateTokens(t.answer.text), 0);
  const usedTokens =
    Math.max(lastMeasured ? lastMeasured.inputTokens + lastMeasured.outputTokens : 0, BASE_PROMPT_TOKENS + historyEstimate) + estimateTokens(draft);
  // 0 until /api/models answers, so no context-limit warning flashes before the real window is known.
  const contextWindow = selected?.contextWindow ?? 0;
  const level = contextWindow > 0 ? contextLevel(usedTokens, contextWindow) : "ok";
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
    if (!question || busy || !modelId || cooling) return; // brief E10: blank never reaches the server

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
        if (res.status === 429 && body?.error?.code === "rate_limited") {
          // This app's limit, not a model's: no error card. The question goes back into the composer and one
          // countdown notice replaces it; asking stays off until the wait is over.
          setTurns((ts) => ts.filter((t) => t.id !== id));
          setDraft(question);
          setCooldownUntil(deadlineIn(body.error.retryAfterSec ?? 30));
          return;
        }
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

  const canSend = draft.trim().length > 0 && !busy && !cooling && Boolean(modelId);
  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden">
      <header className="brand-glow relative z-20 flex h-16 shrink-0 items-center justify-between gap-3 border-b border-navy-3 bg-navy px-4 text-on-navy sm:px-6">
        <BrandLockup size="header" />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPanelOpen(true)}
            aria-controls="session-panel"
            aria-expanded={panelOpen}
            className="inline-flex h-9 items-center gap-2 rounded-xl border border-navy-3 bg-navy-2 px-3 text-sm font-semibold tabular-nums transition-colors hover:border-orange hover:text-orange lg:hidden"
          >
            <ChartIcon className="text-orange" />
            <span className="sr-only">Session usage:</span>
            {formatUSD(sessionTotals.costUSD)}
          </button>
          <button
            type="button"
            data-testid="new-conversation"
            onClick={newConversation}
            className="inline-flex h-9 items-center gap-2 rounded-xl border border-orange bg-orange px-3 text-sm font-semibold text-navy transition-colors hover:border-orange-strong hover:bg-orange-strong"
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
                <EmptyState />
              ) : (
                <div className="space-y-6">
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
                      <AnswerCard answer={t.answer} modelName={modelName} onRetry={busy || cooling ? undefined : () => retry(t)} />
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
                className="absolute -top-11 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-semibold shadow-md transition-colors hover:border-orange-strong hover:bg-orange-soft hover:text-orange-ink"
              >
                <ArrowDownIcon /> Jump to latest
              </button>
            )}
            <div className="mx-auto max-w-3xl">
              {cooling && (
                <p
                  role="status"
                  data-testid="cooldown"
                  className="mb-2 flex items-center gap-2 rounded-xl border border-amber/30 bg-amber-soft px-3 py-2 text-xs font-medium text-amber"
                >
                  <AlertIcon className="shrink-0" />
                  <span>
                    Too many questions in a short time. You can ask again in{" "}
                    <span className="font-semibold tabular-nums">{formatWait(cooldownLeft)}</span>.
                  </span>
                </p>
              )}
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
                  <ModelPicker value={modelId} groups={providerGroups} onChange={setModelId} />
                  <p
                    data-testid="model-description"
                    title={selected ? `${selected.providerName} · ${selected.description}` : undefined}
                    className="min-w-0 flex-1 text-xs leading-snug text-muted max-sm:order-last max-sm:basis-full max-sm:px-1 sm:truncate"
                  >
                    {selected ? `${selected.providerName} · ${selected.description}` : ""}
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
                        className="grid h-9 w-9 place-items-center rounded-full bg-text text-sm text-surface transition hover:bg-orange-deep hover:text-white active:scale-95"
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
                        className="grid h-9 w-9 place-items-center rounded-full bg-orange-strong text-lg text-white shadow-sm shadow-orange-strong/30 transition hover:bg-orange-deep active:scale-95 disabled:cursor-not-allowed disabled:bg-border disabled:text-muted disabled:shadow-none"
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
