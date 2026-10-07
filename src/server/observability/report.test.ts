import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AttemptTrace } from "../llm/fallback";
import { redactSecrets, reportProviderFailures } from "./report";

interface CapturedEvent {
  message: string;
  level?: string;
  fingerprint?: string[];
  tags?: Record<string, unknown>;
  context?: unknown;
}

const sentry = vi.hoisted(() => ({ events: [] as CapturedEvent[], current: {} as Omit<CapturedEvent, "message"> }));

vi.mock("@sentry/nextjs", () => ({
  withScope: (fn: (scope: unknown) => void) => {
    sentry.current = {};
    fn({
      setLevel: (level: string) => (sentry.current.level = level),
      setFingerprint: (fingerprint: string[]) => (sentry.current.fingerprint = fingerprint),
      setTags: (tags: Record<string, unknown>) => (sentry.current.tags = tags),
      setContext: (_name: string, context: unknown) => (sentry.current.context = context),
    });
  },
  captureException: (err: Error) => sentry.events.push({ ...sentry.current, message: `${err.name}: ${err.message}` }),
}));

const failed = (model: string, outcome: AttemptTrace["outcome"], detail = "AI_APICallError 400: credit balance too low"): AttemptTrace => ({
  model,
  outcome,
  detail,
  emittedDeltas: 0,
});
const answered = (model: string): AttemptTrace => ({ model, outcome: "answered", emittedDeltas: 12 });

beforeEach(() => {
  sentry.events = [];
});

describe("Sentry provider-failure reporting (TRD §8)", () => {
  it("reports each failed attempt as a warning when a backup answered, grouped by model and class", () => {
    reportProviderFailures({
      requestId: "r1",
      requestedModel: "claude-haiku",
      outcome: "done",
      attempts: [failed("claude-haiku", "auth"), answered("gemini-flash-lite")],
      injectedFaults: 0,
    });
    expect(sentry.events).toHaveLength(1);
    expect(sentry.events[0]).toMatchObject({
      message: "LLMProviderFailure: claude-haiku failed (auth)",
      level: "warning",
      fingerprint: ["llm-provider-failure", "claude-haiku", "auth"],
      tags: { provider: "anthropic", model: "claude-haiku", error_class: "auth", backup_answered: true },
    });
  });

  it("reports an error when no model could answer", () => {
    reportProviderFailures({
      requestId: "r2",
      requestedModel: "gemini-flash-lite",
      outcome: "error",
      attempts: [failed("gemini-flash-lite", "rate_limited", "429"), failed("openai-luna", "rate_limited", "429")],
      injectedFaults: 0,
    });
    expect(sentry.events.map((e) => [e.message, e.level])).toEqual([
      ["LLMProviderFailure: gemini-flash-lite failed (rate_limited)", "error"],
      ["LLMProviderFailure: openai-luna failed (rate_limited)", "error"],
    ]);
  });

  it("redacts key-shaped strings from the vendor error detail before sending it", () => {
    reportProviderFailures({
      requestId: "r5",
      requestedModel: "openai-luna",
      outcome: "done",
      attempts: [failed("openai-luna", "auth", "AI_APICallError 401: Incorrect API key provided: sk-proj-abc1****************wxyz"), answered("claude-haiku")],
      injectedFaults: 0,
    });
    const detail = (sentry.events[0].context as { detail: string }).detail;
    expect(detail).toBe("AI_APICallError 401: Incorrect API key provided: [redacted-key]");
    expect(redactSecrets("key AIzaSyA-123456 and sk-ant-api03-xyz123")).toBe("key [redacted-key] and [redacted-key]");
  });

  it("stays silent for answered requests and for injected demo/E2E faults", () => {
    reportProviderFailures({ requestId: "r3", requestedModel: "gemini-flash-lite", outcome: "done", attempts: [answered("gemini-flash-lite")], injectedFaults: 0 });
    reportProviderFailures({
      requestId: "r4",
      requestedModel: "gemini-flash-lite",
      outcome: "done",
      attempts: [failed("gemini-flash-lite", "unavailable", "injected fault: unavailable"), answered("openai-luna")],
      injectedFaults: 1,
    });
    expect(sentry.events).toHaveLength(0);
  });
});
