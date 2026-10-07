import { APICallError, simulateReadableStream, type LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { KB_GUARD_ID, StreamEventSchema, type StreamEvent } from "@/shared/contracts";
import { attemptOrder, type ModelEntry } from "../config/models";
import { createRateLimiter } from "../http/rateLimit";
import { handleChat, type ChatDeps } from "./handleChat";

const ENV = { GOOGLE_GENERATIVE_AI_API_KEY: "g", ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" };

function recordingModel(seen: unknown[], text = "Vault · Enterprise · P1: 30 minutes, 24x7 [1]"): LanguageModel {
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      seen.push(prompt);
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start" as const, id: "1" },
            ...(text.match(/\S+\s*/g) ?? []).map((w) => ({ type: "text-delta" as const, id: "1", delta: w })),
            { type: "text-end" as const, id: "1" },
            {
              type: "finish" as const,
              finishReason: { unified: "stop" as const, raw: undefined },
              usage: { inputTokens: { total: 900, noCache: 900, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 20, text: 20, reasoning: undefined } },
            },
          ],
        }),
      };
    },
  });
}

function post(body: unknown): Request {
  return new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function events(res: Response): Promise<StreamEvent[]> {
  const lines = (await res.text()).split("\n").filter(Boolean);
  return lines.map((l) => StreamEventSchema.parse(JSON.parse(l)));
}

function deps(overrides: Partial<ChatDeps> = {}) {
  const factory = vi.fn<(e: ModelEntry) => LanguageModel>(() => recordingModel([]));
  const logs: Record<string, unknown>[] = [];
  return {
    factory,
    logs,
    deps: {
      env: ENV,
      modelFactory: factory,
      limiter: createRateLimiter({ max: 100, windowMs: 60_000 }),
      today: () => "2026-10-07",
      log: (r: Record<string, unknown>) => logs.push(r),
      ...overrides,
    } satisfies ChatDeps,
  };
}

describe("POST /api/chat", () => {
  it.each([
    ["empty", ""],
    ["whitespace", "   \n\t "],
  ])("NKA-CHAT-005: rejects a %s message with 400 and never calls a provider", async (_n, content) => {
    const d = deps();
    const res = await handleChat(post({ modelId: "gemini-flash", messages: [{ role: "user", content }] }), d.deps);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_input");
    expect(d.factory).not.toHaveBeenCalled();
  });

  it("NKA-CHAT-006: rejects messages over 2,000 characters, stating the limit", async () => {
    const d = deps();
    const res = await handleChat(post({ modelId: "gemini-flash", messages: [{ role: "user", content: "x".repeat(2001) }] }), d.deps);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("2000 characters");
    expect(d.factory).not.toHaveBeenCalled();
  });

  it("rejects an unknown model id", async () => {
    const res = await handleChat(post({ modelId: "gpt-imaginary", messages: [{ role: "user", content: "hi" }] }), deps().deps);
    expect(res.status).toBe(400);
  });

  it("NKA-CHAT-001: streams meta → sources → delta… → done, every event matching the contract", async () => {
    const res = await handleChat(post({ modelId: "gemini-flash", messages: [{ role: "user", content: "What's the P1 SLA for Vault Enterprise?" }] }), deps().deps);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const evs = await events(res);
    expect(evs[0].type).toBe("meta");
    expect(evs[1].type).toBe("sources");
    expect(evs.at(-1)?.type).toBe("done");
    expect(evs.filter((e) => e.type === "delta").length).toBeGreaterThan(1);
    const sources = evs[1].type === "sources" ? evs[1].passages : [];
    expect(sources.some((p) => p.file === "vault.md" && p.section === "Support SLA")).toBe(true);
  });

  it("NKA-MDL-003: switching model keeps history and the reply comes from the new model", async () => {
    const seen: unknown[] = [];
    const d = deps({ modelFactory: () => recordingModel(seen) });
    const res = await handleChat(
      post({
        modelId: "claude-haiku",
        messages: [
          { role: "user", content: "Does Pulse integrate with Salesforce?" },
          { role: "assistant", content: "Yes, Pulse 4.3 or later [1]." },
          { role: "user", content: "what about its SLA?" },
        ],
      }),
      d.deps,
    );
    const evs = await events(res);
    expect(evs.at(-1)).toMatchObject({ type: "done", answeredBy: "claude-haiku", requestedModel: "claude-haiku" });
    const prompt = JSON.stringify(seen[0]);
    expect(prompt).toContain("Does Pulse integrate with Salesforce?");
    expect(prompt).toContain("Nimbus Pulse — Support SLA"); // E1: follow-up resolved to Pulse
  });

  it("logs a structured record without any message text", async () => {
    const d = deps();
    await (await handleChat(post({ modelId: "gemini-flash", messages: [{ role: "user", content: "SECRET-QUESTION-TEXT about Relay" }] }), d.deps)).text();
    const record = d.logs.find((l) => l.event === "chat.request");
    expect(record).toMatchObject({ requestedModel: "gemini-flash", answeredBy: "gemini-flash", outcome: "done" });
    expect(JSON.stringify(d.logs)).not.toContain("SECRET-QUESTION-TEXT");
  });

  it("NKA-SEC-002: never forwards vendor error bodies to the browser", async () => {
    const leaky = new MockLanguageModelV4({
      doStream: async () => {
        throw new APICallError({ message: "invalid x-api-key sk-ant-SECRET123", url: "x", requestBodyValues: {}, statusCode: 401 });
      },
    });
    const res = await handleChat(post({ modelId: "gemini-flash", messages: [{ role: "user", content: "Relay pricing" }] }), deps({ modelFactory: () => leaky }).deps);
    const body = await res.text();
    expect(body).not.toContain("sk-ant-SECRET123");
    expect(body).toContain('"code":"auth"');
  });

  it("ignores fault markers unless fault injection is enabled", async () => {
    const seen: unknown[] = [];
    const res = await handleChat(post({ modelId: "gemini-flash", messages: [{ role: "user", content: "Relay pricing #fail-primary" }] }), deps({ modelFactory: () => recordingModel(seen) }).deps);
    const evs = await events(res);
    expect(evs.some((e) => e.type === "fallback")).toBe(false);
  });

  it("with fault injection enabled, #fail-primary demonstrates a labelled fallback", async () => {
    const res = await handleChat(
      post({ modelId: "gemini-flash", messages: [{ role: "user", content: "Relay pricing #fail-primary" }] }),
      deps({ env: { ...ENV, ALLOW_FAULT_INJECTION: "1" } }).deps,
    );
    const evs = await events(res);
    const backup = attemptOrder("gemini-flash", ENV)[1].id;
    expect(evs.find((e) => e.type === "fallback")).toMatchObject({ from: "gemini-flash", to: backup });
    expect(evs.at(-1)).toMatchObject({ type: "done", answeredBy: backup });
  });
});

describe("deterministic grounding layers", () => {
  it.each(["hi", "What's the weather in Paris tomorrow?", "Tell me about Nimbus Edge.", "What are the key differences between the Professional and Company pricing tiers?"])(
    "NKA-GRD-011: off-topic %j is answered 'not in the knowledge base' without calling any model",
    async (question) => {
      const d = deps();
      const evs = await events(await handleChat(post({ modelId: "gemini-flash-lite", messages: [{ role: "user", content: question }] }), d.deps));
      const text = evs.filter((e) => e.type === "delta").map((e) => (e.type === "delta" ? e.text : "")).join("");
      expect(text).toContain("couldn't find this in the NimbusStack knowledge base");
      expect(evs.at(-1)).toMatchObject({ type: "done", answeredBy: KB_GUARD_ID, usage: { inputTokens: 0, outputTokens: 0 }, costUSD: 0 });
      expect(d.factory).not.toHaveBeenCalled();
      expect(d.logs.find((l) => l.event === "chat.request")).toMatchObject({ guarded: true });
    },
  );

  it("does not guard a question that names a product, even with a weak match", async () => {
    const d = deps();
    await (await handleChat(post({ modelId: "gemini-flash-lite", messages: [{ role: "user", content: "Is there a free trial of Vault?" }] }), d.deps)).text();
    expect(d.factory).toHaveBeenCalled();
  });

  it("NKA-GRD-010: done carries the figure check — invented figures listed, sourced ones not", async () => {
    const invented = await events(
      await handleChat(
        post({ modelId: "gemini-flash-lite", messages: [{ role: "user", content: "What's Vault's uptime SLA?" }] }),
        deps({ modelFactory: () => recordingModel([], "Vault guarantees 99.95% uptime and P1 in 30 minutes [1].") }).deps,
      ),
    );
    expect(invented.at(-1)).toMatchObject({ type: "done", unverifiedFigures: ["99.95"] });

    const sourced = await events(
      await handleChat(post({ modelId: "gemini-flash-lite", messages: [{ role: "user", content: "Vault Enterprise P1 SLA?" }] }), deps().deps),
    );
    expect(sourced.at(-1)).toMatchObject({ type: "done", unverifiedFigures: [] });
  });
});

describe("rate limiter (NKA-SEC-003)", () => {
  it("allows 20 requests per window and rejects the 21st with a retry time", () => {
    let t = 0;
    const limiter = createRateLimiter({ max: 20, windowMs: 5 * 60_000, now: () => t });
    for (let i = 0; i < 20; i++) expect(limiter.check("1.2.3.4").ok).toBe(true);
    const blocked = limiter.check("1.2.3.4");
    expect(blocked).toEqual({ ok: false, retryAfterSec: 300 });
    expect(limiter.check("5.6.7.8").ok).toBe(true); // per client
    t = 5 * 60_000;
    expect(limiter.check("1.2.3.4").ok).toBe(true); // window slides
  });

  it("returns 429 JSON from the endpoint when exceeded", async () => {
    const d = deps({ limiter: createRateLimiter({ max: 0, windowMs: 1000 }) });
    const res = await handleChat(post({ modelId: "gemini-flash", messages: [{ role: "user", content: "hi" }] }), d.deps);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });
});
