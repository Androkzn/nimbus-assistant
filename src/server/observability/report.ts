import * as Sentry from "@sentry/nextjs";
import { getModel } from "../config/models";
import type { AttemptTrace } from "../llm/fallback";

export interface ChatOutcome {
  requestId: string;
  requestedModel: string;
  /** Final stream event type: "done", "error", or "aborted". */
  outcome: string;
  attempts: AttemptTrace[];
  injectedFaults: number;
}

/**
 * Vendor error summaries can echo a (partly masked) key — e.g. OpenAI's 401 "Incorrect API key
 * provided: sk-proj-…". Redact anything key-shaped before it leaves the server.
 */
export function redactSecrets(text: string): string {
  return text.replace(/\b(sk-[A-Za-z0-9_*.-]{6,}|AIza[0-9A-Za-z_*.-]{6,}|sntrys_[A-Za-z0-9_*.-]{6,})/g, "[redacted-key]");
}

/** Named so the Sentry issue title reads "LLMProviderFailure: claude-haiku failed (auth)". */
export class LLMProviderFailure extends Error {
  override name = "LLMProviderFailure";
}

export interface ChatMonitor {
  providerFailures: (outcome: ChatOutcome) => void;
  unhandled: (err: unknown, requestId: string) => void;
  unverifiedFigures: (o: { requestId: string; answeredBy: string; count: number }) => void;
}

/** Named so the Sentry issue title reads "UnverifiedFigures: gemini-flash-lite — 1 figure not in the passages". */
export class UnverifiedFigures extends Error {
  override name = "UnverifiedFigures";
}

/**
 * Figure-check hit (TRD §4.6): the answer contains a number found in no passage — the leading
 * indicator of a hallucination. A count and the model only; the figures themselves are answer content.
 */
export function reportUnverifiedFigures(o: { requestId: string; answeredBy: string; count: number }): void {
  Sentry.withScope((scope) => {
    scope.setLevel("warning");
    scope.setFingerprint(["unverified-figures", o.answeredBy]);
    scope.setTags({ request_id: o.requestId, model: o.answeredBy, unverified_count: o.count });
    Sentry.captureException(new UnverifiedFigures(`${o.answeredBy} — ${o.count} figure(s) not in the passages`));
  });
}

/**
 * A failed provider (bad key, billing, rate limit, outage) never crashes the request — the fallback hides
 * it from the user — so without this it would only be visible in server logs. One Sentry issue per model
 * and failure class: "error" when no model could answer, "warning" when a backup did. Carries ids, models
 * and error classes only, never message text (AGENTS.md rule 5).
 */
export function reportProviderFailures(o: ChatOutcome): void {
  if (o.injectedFaults > 0) return; // injected fault markers are not incidents
  for (const a of o.attempts) {
    if (a.outcome === "answered") continue;
    Sentry.withScope((scope) => {
      scope.setLevel(o.outcome === "done" ? "warning" : "error");
      scope.setFingerprint(["llm-provider-failure", a.model, a.outcome]);
      scope.setTags({
        request_id: o.requestId,
        provider: getModel(a.model)?.provider ?? "unknown",
        model: a.model,
        error_class: a.outcome,
        requested_model: o.requestedModel,
        backup_answered: o.outcome === "done",
      });
      // `detail` is the vendor's error summary (e.g. "AI_APICallError 400: credit balance too low").
      scope.setContext("attempt", { detail: a.detail ? redactSecrets(a.detail) : null, emittedDeltas: a.emittedDeltas });
      Sentry.captureException(new LLMProviderFailure(`${a.model} failed (${a.outcome})`));
    });
  }
}

/** A bug in our own chat pipeline (not a provider failure). */
export function reportUnhandled(err: unknown, requestId: string): void {
  Sentry.captureException(err, { tags: { request_id: requestId, area: "chat" } });
}

export const sentryChatMonitor: ChatMonitor = {
  providerFailures: reportProviderFailures,
  unhandled: reportUnhandled,
  unverifiedFigures: reportUnverifiedFigures,
};
