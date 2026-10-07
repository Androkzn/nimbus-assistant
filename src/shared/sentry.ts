import type * as Sentry from "@sentry/nextjs";

type InitOptions = NonNullable<Parameters<typeof Sentry.init>[0]>;

/**
 * Public ingest key for the `nimbus-assistant` Sentry project. A DSN can only *send* events, so it is
 * safe in the browser bundle (unlike provider API keys — AGENTS.md rule 3). Unset → Sentry is off,
 * which is the case in CI and on a fresh clone.
 */
export const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

/**
 * Privacy (AGENTS.md rule 5, TRD §7): Sentry receives errors, ids, models, tokens and latency — never
 * questions, answers, prompts or retrieved passages. SDK v11 collects most of that by default, so each
 * channel is switched off explicitly: request/response bodies (the user's question, the prompt sent to
 * the provider), headers (provider keys travel in them), gen-AI inputs/outputs, and stack-frame
 * variables (`providers.ts` holds the key in a local).
 */
const PRIVACY: InitOptions["dataCollection"] = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  genAI: { inputs: false, outputs: false },
  stackFrameVariables: false,
};

/** Defence in depth: strip request payloads even if an integration attaches them anyway. */
function scrub<E extends { request?: { data?: unknown; cookies?: unknown; headers?: unknown; query_string?: unknown } }>(event: E): E {
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.query_string;
  }
  return event;
}

/** Span attributes that can carry message text. Models, token counts and timings are kept. */
const CONTENT_ATTRIBUTE =
  /^(gen_ai\.(input|output|prompt|request\.messages|response\.text|system_instructions|tool\.call\.(arguments|result))|ai\.(prompt|response\.(text|object|toolCalls))|http\.(request|response)\.body)/;

/** SDK v11 streams spans (`traceLifecycle: 'stream'`), so spans are scrubbed here, not in `beforeSendTransaction`. */
function scrubSpan<S extends { attributes?: object }>(span: S): S {
  const attributes = span.attributes as Record<string, unknown> | undefined;
  for (const key of Object.keys(attributes ?? {})) if (CONTENT_ATTRIBUTE.test(key)) delete attributes![key];
  return span;
}

/** Options shared by the browser, Node.js and Edge runtimes. */
export const sentryOptions = {
  dsn: SENTRY_DSN,
  enabled: Boolean(SENTRY_DSN),
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? "development",
  // Low-traffic internal tool: trace every request. Lower this when traffic grows.
  tracesSampleRate: 1,
  dataCollection: PRIVACY,
  beforeSend: scrub,
  beforeSendSpan: scrubSpan,
} satisfies InitOptions;
