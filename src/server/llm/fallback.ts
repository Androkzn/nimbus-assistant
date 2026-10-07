import { streamText, type LanguageModel, type ModelMessage } from "ai";
import type { ErrorCode, StreamEvent } from "@/shared/contracts";
import { costUSD } from "@/shared/cost";
import { attemptOrder, catalog, getModel, type Env, type ModelEntry } from "../config/models";
import { classifyError, ProviderError, userMessage } from "./errors";
import { faultForAttempt, type Fault } from "./faults";
import { languageModelFor } from "./providers";

export type RunnerEvent = Extract<StreamEvent, { type: "delta" | "fallback" | "reset" | "done" | "error" }>;

export const TRUNCATION_NOTE = "_⚠️ This answer was cut off at the length limit. Ask about one product at a time for the full detail._";

export interface AttemptTrace {
  model: string;
  outcome: "answered" | ErrorCode;
  detail?: string;
  emittedDeltas: number;
}

export interface RunOptions {
  requestedModelId: string;
  instructions: string;
  messages: ModelMessage[];
  signal?: AbortSignal;
  faults?: Fault[];
  env?: Env;
  firstTokenTimeoutMs?: number;
  /**
   * Total time to keep trying models before giving up with a clean error. Must stay below the
   * platform's function limit (route maxDuration = 60 s), or a slow chain is killed mid-answer.
   */
  budgetMs?: number;
  /** Injection point for tests; defaults to the real provider factory. */
  modelFactory?: (entry: ModelEntry) => LanguageModel;
  /** Filled in as attempts run — for structured logs. */
  trace?: AttemptTrace[];
  onFirstToken?: () => void;
}

/**
 * Fallback state machine (TRD §4.4, brief R3/E8/E9).
 * - Error before the first word → try the next model (`fallback` event).
 * - Error after words were streamed → `reset` (client discards the partial text), then `fallback`.
 *   The user never sees text from two models mixed together.
 * - Every model failed → one `error` event with copy for the selected model's failure class.
 */
export async function* runWithFallback(opts: RunOptions): AsyncGenerator<RunnerEvent> {
  const env = opts.env ?? process.env;
  const factory = opts.modelFactory ?? ((entry: ModelEntry) => languageModelFor(entry, env));
  const attempts = attemptOrder(opts.requestedModelId, env);
  const requested = getModel(opts.requestedModelId);
  const trace = opts.trace ?? [];

  if (attempts.length === 0) {
    yield { type: "error", code: "auth", message: "No AI provider is configured on the server." };
    return;
  }

  let firstFailure: { code: ErrorCode; retryAfterSec?: number } | null = null;
  const deadline = Date.now() + (opts.budgetMs ?? 45_000);

  for (let i = 0; i < attempts.length; i++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break; // out of time budget: stop starting new attempts, report cleanly below
    const model = attempts[i];
    const fault = faultForAttempt(opts.faults ?? [], i);
    const controller = new AbortController();
    const onClientAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onClientAbort);
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      Math.min(opts.firstTokenTimeoutMs ?? 20_000, remaining),
    );
    let emitted = 0;

    try {
      if (fault?.when === "before-first-token") {
        throw new ProviderError(fault.code, `injected fault: ${fault.code}`, fault.retryAfterSec);
      }
      const result = streamText({
        model: factory(model),
        instructions: opts.instructions,
        messages: opts.messages,
        maxRetries: 0, // fail over fast and observably instead of retrying inside the SDK
        maxOutputTokens: model.maxOutputTokens,
        providerOptions: model.providerOptions as never,
        abortSignal: controller.signal,
        onError: () => {}, // errors are handled (and logged) below
      });

      let usage = { inputTokens: 0, outputTokens: 0 };
      let truncated = false;
      for await (const part of result.stream) {
        if (part.type === "text-delta") {
          if (!part.text) continue;
          if (emitted === 0) {
            clearTimeout(timer);
            opts.onFirstToken?.();
          }
          emitted++;
          yield { type: "delta", text: part.text };
          if (fault?.when === "mid-stream" && emitted === 2) {
            throw new ProviderError(fault.code, "injected fault: mid-stream failure");
          }
        } else if (part.type === "error") {
          throw part.error;
        } else if (part.type === "abort") {
          throw new ProviderError("unavailable", timedOut ? "timed out waiting for the first token" : "aborted");
        } else if (part.type === "finish") {
          usage = { inputTokens: part.totalUsage.inputTokens ?? 0, outputTokens: part.totalUsage.outputTokens ?? 0 };
          truncated = part.finishReason === "length";
        }
      }
      if (emitted === 0) throw new ProviderError("unavailable", "empty response");
      // Never let a cut-off answer look complete (found by the live eval: reasoning tokens can
      // consume the output budget before the visible answer ends).
      if (truncated) yield { type: "delta", text: `\n\n${TRUNCATION_NOTE}` };

      trace.push({ model: model.id, outcome: "answered", emittedDeltas: emitted });
      yield {
        type: "done",
        answeredBy: model.id,
        requestedModel: opts.requestedModelId,
        usage,
        costUSD: costUSD(usage, model.pricing),
        pricingVersion: catalog.pricingVersion,
      };
      return;
    } catch (err) {
      if (opts.signal?.aborted) return; // the user pressed Stop or left — nothing to fall back for
      const failure = timedOut ? { code: "unavailable" as const, detail: "first-token timeout" } : classifyError(err);
      trace.push({ model: model.id, outcome: failure.code, detail: failure.detail, emittedDeltas: emitted });
      firstFailure ??= failure;
      if (emitted > 0) yield { type: "reset", reason: failure.code };
      const next = attempts[i + 1];
      if (next && Date.now() < deadline) yield { type: "fallback", from: model.id, to: next.id, reason: failure.code };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onClientAbort);
    }
  }

  const code = firstFailure?.code ?? "unavailable";
  yield {
    type: "error",
    code,
    message: userMessage(code, requested?.providerName ?? "The selected provider", firstFailure?.retryAfterSec),
    ...(firstFailure?.retryAfterSec ? { retryAfterSec: firstFailure.retryAfterSec } : {}),
  };
}
