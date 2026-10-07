import { readFileSync } from "node:fs";
import path from "node:path";
import { simulateReadableStream, type LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as healthRoute } from "@/app/api/health/route";
import { GET as modelsRoute } from "@/app/api/models/route";
import { handleChat, type ChatDeps } from "@/server/chat/handleChat";
import { catalog, type ModelEntry } from "@/server/config/models";
import { createRateLimiter } from "@/server/http/rateLimit";
import { mockModel } from "@/server/llm/providers";
import { redactSecrets } from "@/server/observability/report";
import { KB_GUARD_ID, MAX_MESSAGE_CHARS } from "@/shared/contracts";
import { GROUNDED_QUESTION, KEY_SHAPES, keyShapesIn, OFFTOPIC_QUESTION, PROBES, redact, runProbes, scriptUrls, type ProbeOptions } from "./probes";
import { PROBE_IDS, ReadinessEventSchema, type ProbeId, type ReadinessEvent, type TestResult } from "./schema";

const ORIGIN = "https://nimbus.example.test";
const ROOT = process.cwd();
const source = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

// Fake keys are assembled at runtime, like the probe's own patterns: no literal key shape in the repo.
const fakeKey = {
  anthropic: ["sk", "ant", "api03", "x".repeat(40)].join("-"),
  openai: ["sk", "proj", "y".repeat(40)].join("-"),
  google: "AI" + "za" + "z".repeat(35),
  sentry: "sntrys" + "_" + "eyJpYXQiOjE3".repeat(4),
};

type Handler = (req: Request) => Response | Promise<Response>;

/** Re-splits every body into 7-byte chunks: lines and multi-byte characters straddle chunk boundaries. */
function rechunk(res: Response, size = 7): Response {
  if (!res.body) return res;
  const body = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        for (let i = 0; i < chunk.length; i += size) controller.enqueue(chunk.slice(i, i + size));
      },
    }),
  );
  return new Response(body, { status: res.status, headers: res.headers });
}

const html = (...scripts: string[]) =>
  `<!DOCTYPE html><html><head><meta charSet="utf-8"/>` +
  `<link rel="preload" as="script" fetchPriority="low" href="/_next/static/chunks/webpack-1a2b.js"/>` +
  `<link rel="modulepreload" href="/_next/static/chunks/app-page-3c4d.js?dpl=dpl_abc&amp;v=1">` +
  `<link rel="preload" as="style" href="/_next/static/css/app-9f.css"/><link rel="stylesheet" href="/_next/static/css/app-9f.css"/>` +
  `<script src="/_next/static/chunks/main-app-5e6f.js" async=""></script>` +
  `<script src="https://cdn.example.com/analytics.js"></script>` +
  scripts.map((s) => `<script src='${s}' async></script>`).join("") +
  `<script>self.__next_f.push([1,"NimbusStack — product answers"])</script></head><body></body></html>`;

const JS = (name: string) => `(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([["${name}"],{1:function(e,t,n){"use strict";n.d(t,{a:()=>r});let r="sk-"+"ok"}}]);`;
const READINESS_CHUNK = "/_next/static/chunks/app/readiness/page-7a8b.js";

/** The readiness page's chunk is the probe module itself, so the live scan also proves spec I8 against its own source. */
const STATIC_FILES: Record<string, string> = {
  "/_next/static/chunks/webpack-1a2b.js": JS("webpack"),
  "/_next/static/chunks/app-page-3c4d.js": JS("app-page"),
  "/_next/static/chunks/main-app-5e6f.js": JS("main-app"),
  [READINESS_CHUNK]: source("src/readiness/probes.ts"),
};

const js = (body: string) => new Response(body, { headers: { "content-type": "application/javascript; charset=utf-8" } });
const htmlRes = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
const notFound = () => new Response("<h1>404</h1>", { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** The app as deployed: its own route handlers and chat handler, plus a page HTML with Next-style script tags. */
function appRoutes(chatDeps: ChatDeps): Record<string, Handler> {
  const routes: Record<string, Handler> = {
    "GET /api/health": () => healthRoute(),
    "GET /api/models": () => modelsRoute(),
    "POST /api/chat": (req) => handleChat(req, chatDeps),
    "GET /": () => htmlRes(html()),
    "GET /readiness": () => htmlRes(html(READINESS_CHUNK)),
  };
  for (const [file, body] of Object.entries(STATIC_FILES)) routes[`GET ${file}`] = () => js(body);
  return routes;
}

function fakeFetch(routes: Record<string, Handler>) {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const key = `${req.method} ${url.origin === ORIGIN ? url.pathname : url.href}`;
    calls.push(key);
    if (req.method === "POST") bodies.push(await req.clone().json());
    const handler = routes[key];
    return rechunk(handler ? await handler(req) : notFound());
  };
  return { fetch: impl as typeof fetch, calls, bodies };
}

const quietDeps = (overrides: Partial<ChatDeps> = {}): ChatDeps => ({
  env: { LLM_MODE: "mock" },
  limiter: createRateLimiter({ max: 100, windowMs: 300_000 }),
  today: () => "2026-10-07",
  log: () => {},
  monitor: { providerFailures: () => {}, unhandled: () => {}, unverifiedFigures: () => {} },
  ...overrides,
});

async function run(routes: Record<string, Handler>, opts: Partial<ProbeOptions> = {}) {
  const app = fakeFetch(routes);
  const events: ReadinessEvent[] = [];
  await runProbes({ origin: `${ORIGIN}/`, includeAnswer: false, fetch: app.fetch, ...opts }, (e) => events.push(e));
  const results = Object.fromEntries(events.flatMap((e) => (e.type === "test-result" ? [[e.result.id.replace("probe::", ""), e.result]] : []))) as Record<ProbeId, TestResult>;
  return { events, results, calls: app.calls, bodies: app.bodies };
}

/** A stream response the way handleChat writes it. */
function ndjson(events: unknown[], headers: Record<string, string> = {}): Response {
  const text = events.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n") + "\n";
  return new Response(text, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-request-id": "req-1", ...headers },
  });
}

/** Routes one probe's chat request (identified by its question) to `handler`; the rest go to the real app. */
function chatOverride(deps: ChatDeps, match: (content: string, modelId: string) => boolean, handler: Handler): Handler {
  return async (req) => {
    const body = (await req.clone().json()) as { modelId: string; messages: { content: string }[] };
    return match(body.messages.at(-1)!.content, body.modelId) ? handler(req) : handleChat(req, deps);
  };
}

/** A model that streams `answer(passages)`, where passages maps each passage number in its prompt to the file. */
function scriptedModel(answer: (passages: Map<number, string>) => string, usage = { input: 1450, output: 64 }): (entry: ModelEntry) => LanguageModel {
  return () =>
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const system = prompt
          .filter((m) => m.role === "system")
          .map((m) => m.content)
          .join("\n");
        const passages = new Map([...system.matchAll(/^\[(\d+)\] source: (\S+)/gm)].map((m) => [Number(m[1]), m[2]]));
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start" as const, id: "1" },
              ...(answer(passages).match(/\S+\s*/g) ?? []).map((w) => ({ type: "text-delta" as const, id: "1", delta: w })),
              { type: "text-end" as const, id: "1" },
              {
                type: "finish" as const,
                finishReason: { unified: "stop" as const, raw: undefined },
                usage: {
                  inputTokens: { total: usage.input, noCache: usage.input, cacheRead: undefined, cacheWrite: undefined },
                  outputTokens: { total: usage.output, text: usage.output, reasoning: undefined },
                },
              },
            ],
          }),
        };
      },
    });
}

const first = (passages: Map<number, string>, re: RegExp) => [...passages].find(([, file]) => re.test(file))![0];
const SAML_ANSWER = (passages: Map<number, string>) =>
  `⚠️ Documents disagree: vault.md lists SAML on Pro and Enterprise [${first(passages, /^vault/)}], while the security overview says Enterprise only [${first(passages, /^security-overview/)}].`;

const LIVE_KEYS = { ANTHROPIC_API_KEY: "test-a", OPENAI_API_KEY: "test-o", GOOGLE_GENERATIVE_AI_API_KEY: "test-g" };

describe("live probes against the app's own handlers (RDY-003)", () => {
  beforeEach(() => vi.stubEnv("LLM_MODE", "mock"));
  afterEach(() => vi.unstubAllEnvs());

  it("contract: emits stage-start, a test-start/test-result pair per probe in order, then stage-end — every event valid", async () => {
    const { events } = await run(appRoutes(quietDeps()), { includeAnswer: true });
    for (const e of events) expect(ReadinessEventSchema.parse(e)).toEqual(e);
    expect(events.map((e) => (e.type === "test-start" || e.type === "test-result" ? `${e.type}:${e.type === "test-start" ? e.id : e.result.id}` : e.type))).toEqual([
      "stage-start",
      ...PROBE_IDS.flatMap((id) => [`test-start:probe::${id}`, `test-result:probe::${id}`]),
      "stage-end",
    ]);
    const results = events.filter((e) => e.type === "test-result").map((e) => e.result);
    expect(results.map((r) => [r.status, r.stage, r.file, r.source])).toEqual(PROBE_IDS.map(() => ["passed", "probes", ORIGIN, "live"]));
    expect(results.map((r) => r.fullName)).toEqual(PROBES.map((p) => p.title));
    expect(events.at(-1)).toMatchObject({ type: "stage-end", stage: "probes", status: "passed", source: "live", counts: { passed: 9, failed: 0, skipped: 0 }, note: `live · ${ORIGIN}` });
    expect(events.some((e) => e.type === "run-start" || e.type === "run-end")).toBe(false);
  });

  it("is cheap: without the opt-in answer, 4 chat requests and no model call; the answer probe is skipped with its reason", async () => {
    const modelFactory = vi.fn((entry: ModelEntry) => mockModel(entry));
    const { results, calls, bodies, events } = await run(appRoutes(quietDeps({ modelFactory })));
    expect(modelFactory).not.toHaveBeenCalled();
    expect(calls.filter((c) => c === "POST /api/chat")).toHaveLength(4);
    expect(results["grounded-answer"]).toMatchObject({ status: "skipped", detail: { note: "opt-in: one real model call" } });
    expect(results["grounded-answer"].error).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "stage-end", status: "passed", counts: { passed: 8, failed: 0, skipped: 1 } });
    // I6: the only text sent is the fixed probe questions (and filler for the size limit).
    const sent = (bodies as { messages: { content: string }[] }[]).map((b) => b.messages[0].content);
    expect(sent).toEqual(["   ", "x".repeat(MAX_MESSAGE_CHARS + 1), OFFTOPIC_QUESTION, OFFTOPIC_QUESTION]);
  });

  it("records concrete evidence for each probe", async () => {
    const { results } = await run(appRoutes(quietDeps()), { includeAnswer: true });
    expect(results.health.detail).toMatchObject({ httpStatus: 200, mode: "mock", corpusFiles: 10, providers: "anthropic, google, openai", pricingVersion: catalog.pricingVersion });
    expect(results.models.detail).toMatchObject({ models: catalog.models.length, defaultModelId: catalog.defaultModelId, providers: "Anthropic Claude, Google Gemini, OpenAI" });
    expect(results.blank.detail).toMatchObject({ httpStatus: 400, code: "invalid_input", message: "Please type a question first." });
    expect(results.oversize.detail).toMatchObject({ httpStatus: 400, code: "invalid_input", message: `Questions are limited to ${MAX_MESSAGE_CHARS} characters.`, sentChars: 2001 });
    expect(results["unknown-model"].detail).toMatchObject({ httpStatus: 400, code: "invalid_input", message: 'Unknown model "not-a-model".' });
    expect(results["offtopic-guard"].detail).toMatchObject({ httpStatus: 200, answeredBy: KB_GUARD_ID, inputTokens: 0, outputTokens: 0, costUSD: 0, sources: 0 });
    expect(results["stream-headers"].detail).toMatchObject({ contentType: "application/x-ndjson; charset=utf-8", cacheControl: "no-store" });
    expect(Number(results["stream-headers"].detail?.deltas)).toBeGreaterThanOrEqual(2);
    expect(results["bundle-keys"].detail).toMatchObject({ pages: "/, /readiness", scripts: 4, files: 6 });
    expect(results["grounded-answer"].detail).toMatchObject({
      answeredBy: catalog.defaultModelId,
      requestedModel: catalog.defaultModelId,
      mode: "mock",
      citations: "1",
      note: "mock LLM: content check skipped (stream order, citations, usage and cost still asserted)",
    });
    expect(Number(results["grounded-answer"].detail?.costUSD)).toBeGreaterThan(0);
  });

  it("E4 / NKA-GRD-005: with a live model, passes when the answer states the disagreement citing vault and security-overview", async () => {
    for (const [k, v] of Object.entries(LIVE_KEYS)) vi.stubEnv(k, v);
    vi.stubEnv("LLM_MODE", "");
    const deps = quietDeps({ env: LIVE_KEYS, modelFactory: scriptedModel(SAML_ANSWER) });
    const { results, bodies } = await run(appRoutes(deps), { includeAnswer: true });
    const r = results["grounded-answer"];
    expect(r.status, r.error).toBe("passed");
    expect(r.detail).toMatchObject({ mode: "live", answeredBy: catalog.defaultModelId, inputTokens: 1450, outputTokens: 64 });
    expect(r.detail?.vaultCited).toMatch(/^\d+$/);
    expect(r.detail?.securityCited).toMatch(/^\d+$/);
    expect(Number(r.detail?.ttftMs)).toBeGreaterThanOrEqual(0);
    expect(bodies.at(-1)).toEqual({ modelId: catalog.defaultModelId, messages: [{ role: "user", content: GROUNDED_QUESTION }] });
  });

  it("NKA-GRD-001: fails when the answer cites a passage that was never sent", async () => {
    for (const [k, v] of Object.entries(LIVE_KEYS)) vi.stubEnv(k, v);
    vi.stubEnv("LLM_MODE", "");
    let sent: number[] = [];
    const model = scriptedModel((passages) => {
      sent = [...passages.keys()];
      return `${SAML_ANSWER(passages)} Ledger also supports it [${sent.length + 3}].`;
    });
    const { results } = await run(appRoutes(quietDeps({ env: LIVE_KEYS, modelFactory: model })), { includeAnswer: true });
    expect(results["grounded-answer"]).toMatchObject({ status: "failed", error: `cites [${sent.length + 3}] but only passages ${sent.join(", ")} were sent` });
  });

  it("E4: fails when a live answer does not flag the documents' disagreement", async () => {
    for (const [k, v] of Object.entries(LIVE_KEYS)) vi.stubEnv(k, v);
    vi.stubEnv("LLM_MODE", "");
    const model = scriptedModel((p) => `Vault supports SAML on Pro and Enterprise [${first(p, /^vault/)}].`);
    const { results } = await run(appRoutes(quietDeps({ env: LIVE_KEYS, modelFactory: model })), { includeAnswer: true });
    expect(results["grounded-answer"]).toMatchObject({ status: "failed", error: "the answer does not say the documents disagree on Vault SAML tiers" });
  });

  it("NKA-SEC-003: a 429 from the app's own limiter is a skipped result with the wait, not a failure", async () => {
    const deps = quietDeps({ limiter: createRateLimiter({ max: 2, windowMs: 300_000, now: () => 0 }) });
    const { results, events } = await run(appRoutes(deps), { includeAnswer: true });
    expect([results.blank.status, results.oversize.status]).toEqual(["passed", "passed"]);
    for (const id of ["unknown-model", "offtopic-guard", "stream-headers", "grounded-answer"] as const) {
      expect(results[id]).toMatchObject({ status: "skipped", error: "rate-limited by the app's own per-IP limit — retry in 300 s", detail: { httpStatus: 429, retryAfterSec: 300 } });
    }
    expect(events.at(-1)).toMatchObject({ type: "stage-end", status: "passed", counts: { passed: 5, failed: 0, skipped: 4 } });
  });
});

describe("live probes: each failure is reported precisely", () => {
  beforeEach(() => vi.stubEnv("LLM_MODE", "mock"));
  afterEach(() => vi.unstubAllEnvs());
  const deps = quietDeps();
  const app = (overrides: Record<string, Handler>) => ({ ...appRoutes(deps), ...overrides });
  const health = (body: Record<string, unknown>) => () => json(200, { ok: true, mode: "live", corpus: { files: 10, chunks: 38 }, providersAvailable: ["anthropic", "google"], pricingVersion: "2026-10-07", ...body });

  it("health: an incomplete corpus fails naming the count", async () => {
    const { results } = await run(app({ "GET /api/health": health({ corpus: { files: 9, chunks: 35 } }) }));
    expect(results.health).toMatchObject({ status: "failed", error: "corpus.files is 9 — expected all 10 knowledge-base documents", detail: { httpStatus: 200, corpusFiles: 9 } });
  });

  it("health / NKA-MDL-008: a single provider passes, with a note that the fallback needs a second", async () => {
    const { results } = await run(app({ "GET /api/health": health({ providersAvailable: ["google"] }) }));
    expect(results.health).toMatchObject({ status: "passed", detail: { providers: "google", note: "only google is configured — the brief's fallback demo needs a second provider" } });
  });

  it("health: no provider and a server error page", async () => {
    expect((await run(app({ "GET /api/health": health({ ok: false, providersAvailable: [] }) }))).results.health.error).toBe("ok is false — the server reports it cannot answer");
    const down = await run(app({ "GET /api/health": () => new Response("<h1>500</h1>", { status: 500, headers: { "content-type": "text/html" } }) }));
    expect(down.results.health).toMatchObject({ status: "failed", error: "GET /api/health returned HTTP 500 (text/html)" });
  });

  it("models / NKA-MDL-001: a vendor missing from the catalog fails naming it", async () => {
    const res = await modelsRoute();
    const body = await res.json();
    body.models = body.models.filter((m: { providerName: string }) => m.providerName !== "Google Gemini");
    const { results } = await run(app({ "GET /api/models": () => json(200, body) }));
    expect(results.models).toMatchObject({ status: "failed", error: "no Google model in the catalog (providers: Anthropic Claude, OpenAI)" });
  });

  it("models / R5: a key-shaped string in the public catalog fails without echoing it", async () => {
    const body = await (await modelsRoute()).json();
    body.models[0].description = `Uses ${fakeKey.openai}`;
    const { results } = await run(app({ "GET /api/models": () => json(200, body) }));
    expect(results.models).toMatchObject({ status: "failed", error: "the public model catalog contains a string shaped like a secret: OpenAI key" });
    expect(JSON.stringify(results.models)).not.toContain(fakeKey.openai);
  });

  it("blank / E10: a server that accepts a blank question fails, and the probe cancels the stream it got", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"type":"meta","requestId":"r","requestedModel":"m"}\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const accepting = chatOverride(deps, (q) => q === "   ", () => new Response(stream, { headers: { "content-type": "application/x-ndjson" } }));
    const { results } = await run(app({ "POST /api/chat": accepting }));
    expect(results.blank).toMatchObject({ status: "failed", error: "HTTP 200 NDJSON stream — the server accepted the request instead of rejecting it with 400" });
    expect(cancelled).toBe(true);
  });

  it("oversize / NKA-CHAT-006: a 400 that doesn't state the limit fails", async () => {
    const vague = chatOverride(deps, (q) => q.length > MAX_MESSAGE_CHARS, () => json(400, { error: { code: "invalid_input", message: "Too long." } }));
    const { results } = await run(app({ "POST /api/chat": vague }));
    expect(results.oversize).toMatchObject({ status: "failed", error: "the 400 message does not state the 2,000-character limit", detail: { message: "Too long." } });
  });

  it("unknown-model: a server error instead of a 400 fails with the server's own code and message", async () => {
    const broken = chatOverride(deps, (_q, m) => m === "not-a-model", () => json(500, { error: { code: "unavailable", message: "Something went wrong on our side. Please try again." } }));
    const { results } = await run(app({ "POST /api/chat": broken }));
    expect(results["unknown-model"]).toMatchObject({
      status: "failed",
      error: "expected HTTP 400 invalid_input, got HTTP 500 unavailable: Something went wrong on our side. Please try again.",
    });
  });

  it("NKA-GRD-011: a deployment that predates the guard fails naming the model and the tokens it spent", async () => {
    const answered = ndjson([
      { type: "meta", requestId: "req-1", requestedModel: "claude-haiku" },
      { type: "sources", passages: [{ n: 1, file: "pulse.md", section: "Overview", docDate: null, text: "Pulse is…" }] },
      { type: "delta", text: "I couldn’t find " },
      { type: "delta", text: "the weather." },
      { type: "done", answeredBy: "claude-haiku", requestedModel: "claude-haiku", usage: { inputTokens: 1480, outputTokens: 62 }, costUSD: 0.000179, pricingVersion: "2026-10-07" },
    ]);
    const { results } = await run(app({ "POST /api/chat": chatOverride(deps, (q, m) => q === OFFTOPIC_QUESTION && m !== "not-a-model", () => answered) }));
    expect(results["offtopic-guard"]).toMatchObject({
      status: "failed",
      error:
        'answered by model "claude-haiku" (1480 input + 62 output tokens, $0.000179) instead of kb-guard — this deployment predates the off-topic guard, or the guard missed this question',
      detail: { answeredBy: "claude-haiku", inputTokens: 1480, outputTokens: 62, costUSD: 0.000179, sources: 1 },
    });
    // The headers of that same response are still inspected, without a second request.
    expect(results["stream-headers"].status).toBe("passed");
  });

  it("offtopic-guard: a stream line that breaks the shared wire contract fails naming the line", async () => {
    const bad = ndjson([{ type: "meta", requestId: "req-1", requestedModel: "m" }, { type: "sources", passages: [] }, { type: "delta", text: 5 }]);
    const { results } = await run(app({ "POST /api/chat": chatOverride(deps, (q, m) => q === OFFTOPIC_QUESTION && m !== "not-a-model", () => bad) }));
    expect(results["offtopic-guard"]).toMatchObject({ status: "failed", error: expect.stringMatching(/^stream line 3 breaks the wire contract \(StreamEventSchema\) — text: /) });
  });

  it("stream-headers: a cacheable stream and a request id that doesn't match meta both fail", async () => {
    const guardStream = (headers: Record<string, string>) =>
      chatOverride(deps, (q, m) => q === OFFTOPIC_QUESTION && m !== "not-a-model", async (req) => {
        const real = await handleChat(req, deps);
        return new Response(real.body, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-request-id": real.headers.get("x-request-id")!, ...headers } });
      });
    const cached = await run(app({ "POST /api/chat": guardStream({ "cache-control": "public, max-age=60" }) }));
    expect(cached.results["stream-headers"]).toMatchObject({ status: "failed", error: 'cache-control is "public, max-age=60", expected no-store' });
    expect(cached.results["offtopic-guard"].status).toBe("passed");
    const mismatched = await run(app({ "POST /api/chat": guardStream({ "x-request-id": "someone-else" }) }));
    expect(mismatched.results["stream-headers"]).toMatchObject({ status: "failed", error: "x-request-id does not match the stream's meta.requestId" });
  });

  it("bundle-keys / NKA-SEC-001: a key in a served chunk fails naming the file, never the key", async () => {
    const leaky = `${JS("main-app")}const k="${fakeKey.anthropic}";`;
    const { results } = await run(app({ "GET /_next/static/chunks/main-app-5e6f.js": () => js(leaky) }));
    expect(results["bundle-keys"]).toMatchObject({
      status: "failed",
      error: "1 key-shaped string(s) served to the browser: Anthropic key in /_next/static/chunks/main-app-5e6f.js",
      detail: { files: 6, scripts: 4 },
    });
    expect(JSON.stringify(results["bundle-keys"])).not.toContain(fakeKey.anthropic);
  });

  it("bundle-keys: a key leaked into the page HTML (server-component props) is caught too", async () => {
    const { results } = await run(app({ "GET /": () => htmlRes(html().replace("product answers", fakeKey.google)) }));
    expect(results["bundle-keys"]).toMatchObject({ status: "failed", error: "1 key-shaped string(s) served to the browser: Google API key in / (HTML)" });
  });

  it("bundle-keys: a page with no Next script to scan fails instead of passing vacuously", async () => {
    const { results } = await run(app({ "GET /": () => htmlRes("<html><body>maintenance</body></html>"), "GET /readiness": notFound }));
    expect(results["bundle-keys"]).toMatchObject({ status: "failed", error: "no /_next/static script found in the HTML of / — nothing to scan" });
  });

  it("grounded-answer: an error event fails with the server's code and message", async () => {
    const outage = ndjson([
      { type: "meta", requestId: "req-1", requestedModel: "claude-haiku" },
      { type: "sources", passages: [{ n: 1, file: "vault.md", section: "Plans", docDate: "2026-06-01", text: "…" }] },
      { type: "error", code: "unavailable", message: "No AI provider is reachable right now. Your conversation is kept — try again in a minute." },
    ]);
    const { results } = await run(app({ "POST /api/chat": chatOverride(deps, (q) => q === GROUNDED_QUESTION, () => outage) }), { includeAnswer: true });
    expect(results["grounded-answer"]).toMatchObject({
      status: "failed",
      error: "stream ended with error unavailable: No AI provider is reachable right now. Your conversation is kept — try again in a minute.",
    });
  });

  it("a network error fails the probe with the reason and the run continues", async () => {
    const { results } = await run(
      app({
        "GET /api/health": () => {
          throw new TypeError("fetch failed");
        },
      }),
    );
    expect(results.health).toMatchObject({ status: "failed", error: "network error on GET /api/health: fetch failed" });
    expect(results.models.status).toBe("passed");
  });
});

describe("live probes: time limits and abort", () => {
  beforeEach(() => vi.stubEnv("LLM_MODE", "mock"));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("a probe with no response within 10 s fails as timed out, even if the request ignores its signal", async () => {
    vi.useFakeTimers();
    const ctrl = new AbortController();
    const events: ReadinessEvent[] = [];
    const routes = { ...appRoutes(quietDeps()), "GET /api/health": () => new Promise<Response>(() => {}) };
    const done = runProbes({ origin: ORIGIN, includeAnswer: false, fetch: fakeFetch(routes).fetch, signal: ctrl.signal }, (e) => {
      events.push(e);
      if (e.type === "test-result") ctrl.abort(); // stop after the first result: the rest needs real timers
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(events.map((e) => e.type)).toEqual(["stage-start", "test-start"]);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    const result = events.find((e) => e.type === "test-result");
    expect(result).toMatchObject({ result: { id: "probe::health", status: "failed", error: "no complete response within 10 s", durationMs: 10_000 } });
  });

  it("an abort mid-probe resolves promptly with no result for the probe in flight and no stage-end", async () => {
    const ctrl = new AbortController();
    const events: ReadinessEvent[] = [];
    const hanging = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"type":"meta","requestId":"req-1","requestedModel":"m"}\n'));
        setTimeout(() => ctrl.abort(), 0); // the user leaves while the stream is still open
      },
    });
    const routes = {
      ...appRoutes(quietDeps()),
      "POST /api/chat": chatOverride(quietDeps(), (q, m) => q === OFFTOPIC_QUESTION && m !== "not-a-model", () => ndjsonHeaders(hanging)),
    };
    await runProbes({ origin: ORIGIN, includeAnswer: true, fetch: fakeFetch(routes).fetch, signal: ctrl.signal }, (e) => events.push(e));
    const ids = events.map((e) => (e.type === "test-result" ? e.result.id : e.type === "test-start" ? `start ${e.id}` : e.type));
    expect(ids.slice(-2)).toEqual(["probe::unknown-model", "start probe::offtopic-guard"]);
    expect(events.some((e) => e.type === "stage-end")).toBe(false);
  });

  it("an already-aborted signal emits nothing", async () => {
    const events: ReadinessEvent[] = [];
    await runProbes({ origin: ORIGIN, includeAnswer: true, fetch: fakeFetch({}).fetch, signal: AbortSignal.abort() }, (e) => events.push(e));
    expect(events).toEqual([]);
  });
});

function ndjsonHeaders(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-request-id": "req-1" } });
}

describe("probe metadata", () => {
  it("lists every probe id of the contract once, in run order, each with what it verifies and the ids it covers", () => {
    expect(PROBES.map((p) => p.id)).toEqual([...PROBE_IDS]);
    const matrix = source("docs/requirements/04_Acceptance_Matrix.md");
    for (const p of PROBES) {
      expect(p.verifies.length).toBeGreaterThan(40);
      for (const id of p.covers.filter((c) => c.startsWith("NKA-"))) expect(matrix, `${p.id} covers ${id}`).toContain(`| ${id} |`);
    }
  });

  it("finds same-origin Next scripts from script src, modulepreload and preload-as-script only", () => {
    expect(scriptUrls(html(READINESS_CHUNK), ORIGIN)).toEqual([
      `${ORIGIN}/_next/static/chunks/webpack-1a2b.js`,
      `${ORIGIN}/_next/static/chunks/app-page-3c4d.js?dpl=dpl_abc&v=1`,
      `${ORIGIN}/_next/static/chunks/main-app-5e6f.js`,
      `${ORIGIN}${READINESS_CHUNK}`,
    ]);
  });
});

describe("spec I8 — the probe code itself cannot trip the CI bundle scan (NKA-SEC-001)", () => {
  /** The scanner's own regexes, read from its source so this test follows any change to them. */
  const scannerPatterns = [...source("scripts/scan-client-bundle.mjs").matchAll(/name: "([^"]+)", re: \/((?:\\.|[^/\n])+)\/([a-z]*)/g)].map((m) => ({
    name: m[1],
    re: new RegExp(m[2], m[3]),
  }));
  const OWN_FILES = ["src/readiness/probes.ts", "src/readiness/replay.ts", "src/readiness/ndjson.ts"];

  it("reads all three key patterns from scripts/scan-client-bundle.mjs", () => {
    expect(scannerPatterns.map((p) => p.name)).toEqual(["Anthropic key", "OpenAI key", "Google API key"]);
  });

  it.each(OWN_FILES)("no scanner pattern matches the source of %s, even with adjacent string literals folded as a minifier would", (file) => {
    const text = source(file);
    const folded = text.replace(/(["'`])\s*\+\s*(["'`])/g, "");
    for (const { name, re } of scannerPatterns) {
      expect(re.test(text), `${name} in ${file}`).toBe(false);
      expect(re.test(folded), `${name} in folded ${file}`).toBe(false);
    }
    expect(keyShapesIn(text)).toEqual([]);
  });

  it("the runtime-built shapes catch every planted key, and agree with the scanner on each", () => {
    expect(keyShapesIn(`a="${fakeKey.anthropic}"`)).toEqual(["Anthropic key"]);
    expect(keyShapesIn(`a="${fakeKey.openai}"`)).toEqual(["OpenAI key"]);
    expect(keyShapesIn(`a="${fakeKey.google}"`)).toEqual(["Google API key"]);
    expect(keyShapesIn(`a="${fakeKey.sentry}"`)).toEqual(["Sentry auth token"]);
    expect(keyShapesIn('const ok="no secrets here"; let r="sk-"+"ok";')).toEqual([]);
    for (const sample of [fakeKey.anthropic, fakeKey.openai, fakeKey.google, "sk-short", "AI" + "za-short"]) {
      const ours = KEY_SHAPES.filter((s) => s.name !== "Sentry auth token" && s.re.test(sample)).map((s) => s.name);
      const theirs = scannerPatterns.filter((p) => p.re.test(sample)).map((p) => p.name);
      expect(ours, sample.slice(0, 8)).toEqual(theirs);
    }
  });

  it("I6: error text is redacted exactly like the server's redactSecrets, then capped at 500 chars", () => {
    const text = `401 Incorrect API key provided: ${fakeKey.openai.slice(0, 12)}***abcd; google ${fakeKey.google}; ${fakeKey.sentry}`;
    expect(redact(text)).toBe(redactSecrets(text));
    expect(redact(text)).not.toMatch(/sk-proj|AIza|sntrys_/);
    expect(redact("x".repeat(900))).toHaveLength(500);
  });
});
