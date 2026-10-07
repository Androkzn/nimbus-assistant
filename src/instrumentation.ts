import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "@/shared/sentry";

export function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" && process.env.NEXT_RUNTIME !== "edge") return;
  Sentry.init({
    ...sentryOptions,
    // The mock LLM (E2E, offline demo) injects provider faults on purpose — keep them out of Sentry.
    enabled: sentryOptions.enabled && process.env.LLM_MODE !== "mock",
    // gen_ai spans keep model, tokens and latency per provider; prompts and answers stay out (also off globally).
    integrations: [Sentry.vercelAIIntegration({ recordInputs: false, recordOutputs: false })],
  });
}

/** Unhandled errors in route handlers and server components (Next.js `onRequestError` hook). */
export const onRequestError = Sentry.captureRequestError;
