import { APICallError, simulateReadableStream, type LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { applyEvent, emptyAnswer } from "@/shared/answer";
import { StreamEventSchema, type StreamEvent } from "@/shared/contracts";
import { costUSD } from "@/shared/cost";
import { attemptOrder, catalog, type ModelEntry } from "../config/models";
import { classifyError } from "./errors";
import { runWithFallback, type AttemptTrace } from "./fallback";

const ENV = { GOOGLE_GENERATIVE_AI_API_KEY: "g", ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" };
// Expectations follow config/models.json instead of duplicating it.
const PRIMARY = catalog.defaultModelId;
const BACKUP = attemptOrder(PRIMARY, ENV)[1];
const finish = {
  type: "finish" as const,
  finishReason: { unified: "stop" as const, raw: undefined },
  usage: {
    inputTokens: { total: 1000, noCache: 1000, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 50, text: 50, reasoning: undefined },
  },
};

function answering(text: string): LanguageModel {
  const words = text.match(/\S+\s*/g) ?? [];
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start" as const, id: "1" },
          ...words.map((w) => ({ type: "text-delta" as const, id: "1", delta: w })),
          { type: "text-end" as const, id: "1" },
          finish,
        ],
      }),
    }),
  });
}

function failingBefore(status: number, headers: Record<string, string> = {}): LanguageModel {
  return new MockLanguageModelV4({
    doStream: async () => {
      throw new APICallError({ message: `HTTP ${status}`, url: "https://x", requestBodyValues: {}, statusCode: status, responseHeaders: headers });
    },
  });
}

function failingMidStream(): LanguageModel {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start" as const, id: "1" },
          { type: "text-delta" as const, id: "1", delta: "PRIMARY-PARTIAL " },
          { type: "text-delta" as const, id: "1", delta: "TEXT " },
          { type: "error" as const, error: new APICallError({ message: "overloaded", url: "x", requestBodyValues: {}, statusCode: 529 }) },
        ],
      }),
    }),
  });
}

async function run(factory: (e: ModelEntry) => LanguageModel, requested = PRIMARY) {
  const events: StreamEvent[] = [];
  const trace: AttemptTrace[] = [];
  for await (const ev of runWithFallback({ requestedModelId: requested, instructions: "x", messages: [{ role: "user", content: "q" }], env: ENV, modelFactory: factory, trace })) {
    StreamEventSchema.parse(ev); // contract test: every event matches the shared schema
    events.push(ev);
  }
  const shown = events.reduce(applyEvent, emptyAnswer());
  return { events, trace, shown };
}

describe("fallback runner", () => {
  it("answers with the selected model when it works", async () => {
    const { shown, events } = await run(() => answering("Relay Enterprise P1 is 15 minutes, 24x7 [1]"));
    expect(shown.answeredBy).toBe(PRIMARY);
    expect(shown.text).toBe("Relay Enterprise P1 is 15 minutes, 24x7 [1]");
    expect(events.filter((e) => e.type === "delta").length).toBeGreaterThan(1); // streamed, not one blob
  });

  it("NKA-MDL-004: falls back before the first token and labels the answering model", async () => {
    const { shown, events } = await run((e) => (e.id === PRIMARY ? failingBefore(503) : answering(`answer from ${e.id}`)));
    expect(BACKUP.provider).not.toBe(catalog.models.find((m) => m.id === PRIMARY)?.provider); // backup is another vendor
    expect(events.find((e) => e.type === "fallback")).toMatchObject({ from: PRIMARY, to: BACKUP.id, reason: "unavailable" });
    expect(shown.answeredBy).toBe(BACKUP.id);
    expect(shown.requestedModel).toBe(PRIMARY);
    expect(shown.text).toBe(`answer from ${BACKUP.id}`);
  });

  it("NKA-MDL-005: mid-stream failure resets partial text — the user never sees mixed output", async () => {
    const { shown, events } = await run((e) => (e.id === PRIMARY ? failingMidStream() : answering("BACKUP ANSWER")));
    const resetAt = events.findIndex((e) => e.type === "reset");
    const firstBackupDelta = events.findIndex((e, i) => i > resetAt && e.type === "delta");
    expect(resetAt).toBeGreaterThan(-1);
    expect(firstBackupDelta).toBeGreaterThan(resetAt);
    expect(shown.text).toBe("BACKUP ANSWER");
    expect(shown.text).not.toContain("PRIMARY-PARTIAL");
  });

  it("NKA-MDL-006: all providers rate-limited → one clear error with the wait time", async () => {
    const { shown, trace } = await run(() => failingBefore(429, { "retry-after": "12" }));
    expect(shown.status).toBe("error");
    expect(shown.error?.code).toBe("rate_limited");
    expect(shown.error?.retryAfterSec).toBe(12);
    expect(shown.error?.message).toMatch(/Google Gemini is rate-limited right now\. Wait about 12 seconds.*choose another model/);
    expect(trace.every((t) => t.outcome === "rate_limited")).toBe(true);
  });

  it("NKA-USG-001: reports usage and cost for the model that actually answered", async () => {
    const { shown } = await run((e) => (e.id === PRIMARY ? failingBefore(500) : answering("ok")));
    expect(shown.usage).toEqual({ inputTokens: 1000, outputTokens: 50 });
    const usage = { inputTokens: 1000, outputTokens: 50 };
    const primaryPricing = catalog.models.find((m) => m.id === PRIMARY)!.pricing;
    expect(shown.costUSD).toBeCloseTo(costUSD(usage, BACKUP.pricing), 12);
    // Proves the answering model was priced, not the selected one (their prices differ).
    expect(costUSD(usage, primaryPricing)).not.toBeCloseTo(shown.costUSD!, 12);
  });

  it("flags an answer cut off at the length limit instead of presenting it as complete", async () => {
    const cutOff = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start" as const, id: "1" },
            { type: "text-delta" as const, id: "1", delta: "Relay Pro is $49 " },
            { type: "text-delta" as const, id: "1", delta: "per seat per" },
            { type: "text-end" as const, id: "1" },
            { ...finish, finishReason: { unified: "length" as const, raw: "max_tokens" } },
          ],
        }),
      }),
    });
    const { shown } = await run(() => cutOff);
    expect(shown.status).toBe("done");
    expect(shown.text).toContain("cut off at the length limit");
  });

  it("skips models whose provider has no key", async () => {
    const env = { GOOGLE_GENERATIVE_AI_API_KEY: "g" };
    const used: string[] = [];
    const events: StreamEvent[] = [];
    for await (const ev of runWithFallback({ requestedModelId: "claude-haiku", instructions: "x", messages: [{ role: "user", content: "q" }], env, modelFactory: (e) => (used.push(e.id), answering("ok")) })) events.push(ev);
    const firstGoogle = catalog.fallbackOrder.find((id) => catalog.models.find((m) => m.id === id)?.provider === "google");
    expect(used[0]).toBe(firstGoogle);
    expect(used.every((id) => catalog.models.find((m) => m.id === id)?.provider === "google")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", answeredBy: firstGoogle, requestedModel: "claude-haiku" });
  });
});

describe("error classification (NKA-MDL-007)", () => {
  const apiError = (status: number) => new APICallError({ message: "x", url: "x", requestBodyValues: {}, statusCode: status });
  it.each([
    [429, "rate_limited"],
    [401, "auth"],
    [403, "auth"],
    [400, "bad_request"],
    [500, "unavailable"],
    [503, "unavailable"],
  ])("HTTP %i → %s", (status, code) => {
    expect(classifyError(apiError(status)).code).toBe(code);
  });
  it("unusable key (no credit) → auth, not rate limit or bad request", () => {
    const lowCredit = new APICallError({ message: "Your credit balance is too low to access the Anthropic API.", url: "x", requestBodyValues: {}, statusCode: 400 });
    const noQuota = new APICallError({ message: "You exceeded your current quota (insufficient_quota)", url: "x", requestBodyValues: {}, statusCode: 429 });
    expect(classifyError(lowCredit).code).toBe("auth");
    expect(classifyError(noQuota).code).toBe("auth");
  });
  it("network failure → unavailable", () => {
    expect(classifyError(new TypeError("fetch failed")).code).toBe("unavailable");
  });
});
