import type { ErrorCode } from "@/shared/contracts";

/** An error we raise ourselves (missing key, timeout, injected fault) with a known class. */
export class ProviderError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface ClassifiedError {
  code: ErrorCode;
  retryAfterSec?: number;
  /** Internal detail for logs only — never sent to the browser. */
  detail: string;
}

interface ErrorLike {
  statusCode?: number;
  status?: number;
  responseHeaders?: Record<string, string>;
  lastError?: unknown;
  cause?: unknown;
  message?: string;
  name?: string;
}

/** Map any provider/SDK/network error to the four classes of TRD §4.4. */
export function classifyError(err: unknown): ClassifiedError {
  if (err instanceof ProviderError) return { code: err.code, retryAfterSec: err.retryAfterSec, detail: err.message };

  // The SDK may wrap the provider error (RetryError.lastError, Error.cause).
  let e = (err ?? {}) as ErrorLike;
  for (let i = 0; i < 3 && e.statusCode === undefined && (e.lastError || e.cause); i++) {
    e = (e.lastError ?? e.cause) as ErrorLike;
  }
  const status = e.statusCode ?? e.status;
  const message = String(e.message ?? err);
  const detail = `${e.name ?? "Error"}${status ? ` ${status}` : ""}: ${message.slice(0, 200)}`;

  // An unusable key (no credit / billing) is not a rate limit: waiting will not help. Check it first,
  // because OpenAI reports `insufficient_quota` as HTTP 429 and Anthropic reports low credit as 400.
  if (/credit balance|billing|insufficient_quota|payment required/i.test(message) || status === 402) {
    return { code: "auth", detail };
  }
  if (status === 429 || /rate.?limit|quota|resource.?exhausted|too many requests/i.test(message)) {
    return { code: "rate_limited", retryAfterSec: parseRetryAfter(e.responseHeaders), detail };
  }
  if (status === 401 || status === 403 || /api key|unauthori[sz]ed|permission/i.test(message)) {
    return { code: "auth", detail };
  }
  if (status !== undefined && status >= 400 && status < 500 && status !== 408) {
    return { code: "bad_request", detail };
  }
  // 5xx, 408, timeouts, network failures, overloaded, unknown.
  return { code: "unavailable", detail };
}

function parseRetryAfter(headers: Record<string, string> | undefined): number | undefined {
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(1, Math.ceil((date - Date.now()) / 1000));
}

/** User-facing copy (BRD §5). Names the problem and the action; never vendor error bodies. */
export function userMessage(code: ErrorCode, _providerName: string, retryAfterSec?: number): string {
  switch (code) {
    case "rate_limited":
      return `That model is busy right now. Wait about ${retryAfterSec ?? 30} seconds and try again, or choose another model.`;
    case "auth":
      return "That model isn't available right now. Choose another model or try again later.";
    case "bad_request":
      return "That question couldn't be processed. Try rephrasing it or choose another model.";
    case "invalid_input":
      return "Please enter a question first.";
    case "unavailable":
    default:
      return "The assistant couldn't answer right now. Your conversation is kept — try again in a minute, or choose another model.";
  }
}
