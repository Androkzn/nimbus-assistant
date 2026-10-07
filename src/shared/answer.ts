import type { ErrorCode, PassageDTO, StreamEvent } from "./contracts";

/** What one assistant turn looks like to the user. Built only by `applyEvent`. */
export interface AnswerState {
  status: "streaming" | "done" | "error";
  text: string;
  sources: PassageDTO[];
  requestedModel: string | null;
  answeredBy: string | null;
  /** Model switches that happened while answering, e.g. "gemini-flash → claude-haiku (unavailable)". */
  fallbacks: { from: string; to: string; reason: ErrorCode }[];
  usage: { inputTokens: number; outputTokens: number } | null;
  costUSD: number | null;
  /** Figure check result: [] = every number found in the passages; null = not checked. */
  unverifiedFigures: string[] | null;
  error: { code: ErrorCode; message: string; retryAfterSec?: number } | null;
}

export const emptyAnswer = (): AnswerState => ({
  status: "streaming",
  text: "",
  sources: [],
  requestedModel: null,
  answeredBy: null,
  fallbacks: [],
  usage: null,
  costUSD: null,
  unverifiedFigures: null,
  error: null,
});

/**
 * Pure reducer over the stream protocol. `reset` discards partial text, which is what guarantees
 * the user never sees output from two models mixed together (brief E8).
 */
export function applyEvent(state: AnswerState, event: StreamEvent): AnswerState {
  switch (event.type) {
    case "meta":
      return { ...state, requestedModel: event.requestedModel };
    case "sources":
      return { ...state, sources: event.passages };
    case "delta":
      return { ...state, text: state.text + event.text };
    case "reset":
      return { ...state, text: "" };
    case "fallback":
      return { ...state, fallbacks: [...state.fallbacks, { from: event.from, to: event.to, reason: event.reason }] };
    case "done":
      return {
        ...state,
        status: "done",
        answeredBy: event.answeredBy,
        requestedModel: event.requestedModel,
        usage: event.usage,
        costUSD: event.costUSD,
        unverifiedFigures: event.unverifiedFigures ?? null,
      };
    case "error":
      return { ...state, status: "error", text: "", error: { code: event.code, message: event.message, retryAfterSec: event.retryAfterSec } };
  }
}
