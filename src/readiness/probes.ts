import { applyEvent, emptyAnswer } from "@/shared/answer";
import { citedNumbers } from "@/shared/citations";
import { KB_GUARD_ID, MAX_MESSAGE_CHARS, StreamEventSchema, type PassageDTO, type StreamEvent } from "@/shared/contracts";
import { describeParseError, ndjsonLines } from "./ndjson";
import type { ProbeId, ReadinessEvent } from "./schema";

/**
 * Live probes (docs/requirements/06_Readiness_Report.md §3–4): requests this browser sends to the
 * running app — local or production — right now. Cheap by design: eight probes cost no model call
 * (the off-topic probe is answered by the deterministic guard); the grounded-answer probe spends one
 * real model call on every readiness assessment. Results never carry app message text or anything
 * key-shaped (spec I6).
 */

export interface ProbeOptions {
  /** e.g. "https://nimbus.example.app" — the app being probed (normally the page's own origin). */
  origin: string;
  /** Run the probe that asks one real question of the default model (~3k tokens). The page always runs it. */
  includeAnswer: boolean;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export interface ProbeInfo {
  id: ProbeId;
  title: string;
  /** One plain-English sentence for the report: what passing proves. */
  verifies: string;
  /** Brief items (ids as in manifest.ts) and acceptance ids (04_Acceptance_Matrix.md) this probe is evidence for. */
  covers: string[];
}

/**
 * The off-topic question the guard's own integration test uses (handleChat.test.ts, NKA-GRD-011). Not
 * "…today?": "today" matches pulse.md ("not available today"), so that variant reaches a paid model.
 */
export const OFFTOPIC_QUESTION = "What's the weather in Paris tomorrow?";
export const GROUNDED_QUESTION = "Which Vault tiers support SAML?";
const NOT_IN_KB_PHRASE = "couldn't find this in the NimbusStack knowledge base";
const LIMIT = MAX_MESSAGE_CHARS.toLocaleString("en-US");

export const PROBES: ProbeInfo[] = [
  {
    id: "health",
    title: "Health: knowledge base loaded, providers configured",
    verifies:
      "GET /api/health on this deployment reports ok, all 10 knowledge-base documents loaded into chunks, and at least one AI provider with a key configured; it lists the providers and the LLM mode, and notes when fewer than two are configured (the fallback needs a second provider).",
    // Not D3 / NKA-MDL-008 (two providers): this probe passes with one, so it cannot claim them.
    covers: ["D1"],
  },
  {
    id: "models",
    title: "Model catalog: three vendors, priced, no secrets",
    verifies:
      "GET /api/models offers Anthropic, OpenAI and Google models, each with provider name, description, context window and per-token prices from config/models.json; the default model is one of them; and the public JSON contains nothing shaped like an API key.",
    covers: ["R3", "AF-KEY", "NKA-MDL-001"],
  },
  {
    id: "blank",
    title: "Blank question rejected with 400",
    verifies:
      "POST /api/chat with a whitespace-only question gets 400 invalid_input as plain JSON, not a stream: the deployed server rejects it before any model call. (That no provider is called is proven by the unit test; this proves the live endpoint behaves the same.)",
    covers: ["E10", "NKA-CHAT-005"],
  },
  {
    id: "oversize",
    title: `Question over ${LIMIT} characters rejected, limit stated`,
    verifies: `POST /api/chat with a question one character over the ${LIMIT}-character limit gets 400 invalid_input, and the error message states the limit.`,
    covers: ["NKA-CHAT-006"],
  },
  {
    id: "unknown-model",
    title: "Unknown model id rejected with 400",
    verifies:
      "POST /api/chat naming a model that is not in config/models.json gets 400 invalid_input. The question sent is the off-topic one, so even a regression here could not spend tokens.",
    covers: ["R3", "R5"],
  },
  {
    id: "offtopic-guard",
    title: "Off-topic question answered by the guard, no model call",
    verifies: `"${OFFTOPIC_QUESTION}" is answered by the deterministic off-topic guard: every stream event matches the shared wire contract, no sources, answeredBy ${KB_GUARD_ID}, 0 tokens, $0, and the text says it is not in the NimbusStack knowledge base. If a model answered instead, the probe fails naming the model and the tokens spent.`,
    covers: ["RULE", "E2", "NKA-GRD-011"],
  },
  {
    id: "stream-headers",
    title: "Chat reply is an uncached NDJSON stream",
    verifies:
      "The chat reply (the off-topic request above, no extra call) is a streamed response: content-type application/x-ndjson, cache-control no-store, an x-request-id header equal to the stream's meta.requestId (the id the server logs carry), and the answer arrives as at least two delta events before done.",
    covers: ["R1", "R5", "NKA-CHAT-001"],
  },
  {
    id: "bundle-keys",
    title: "Served JavaScript contains no API key",
    verifies:
      "Downloads the HTML of / and /readiness and every /_next/static script they load, as a browser would, and scans all of it for Anthropic, OpenAI, Google and Sentry auth-token key shapes. Complements the CI scan of the whole build, which also checks the real key values (a browser cannot know them).",
    covers: ["AF-KEY", "NKA-SEC-001"],
  },
  {
    id: "grounded-answer",
    title: "One real grounded answer: Vault SAML conflict",
    verifies: `One real model call (~3k tokens): "${GROUNDED_QUESTION}" on the default model. Asserts the stream contract and order (meta, sources, deltas, done), that every [n] citation points to a passage that was sent, real token usage and cost, a clean figure check, and — with a live model — that the answer states the documents disagree, citing both a vault and a security-overview passage.`,
    covers: ["RULE", "R2", "R4", "E4", "NKA-GRD-001", "NKA-GRD-005", "NKA-GRD-010", "NKA-USG-001"],
  },
];

// ---------------------------------------------------------------------------------------------
// Key shapes. Prefixes are assembled from char codes so that this file's source (and the bundle
// built from it) never contains a key prefix followed by key-like characters: the CI bundle scan
// reads this module once the readiness page ships it (spec I8; proven in probes.test.ts).

const chars = (...codes: number[]) => String.fromCharCode(...codes);
const SK = chars(115, 107, 45);
const ANT = chars(97, 110, 116, 45);
const PROJ = chars(112, 114, 111, 106, 45);
const GOOG = chars(65, 73, 122, 97);
const SENTRY = chars(115, 110, 116, 114, 121, 115, 95);

/** Same shapes as scripts/scan-client-bundle.mjs, plus Sentry org auth tokens. */
export const KEY_SHAPES: { name: string; re: RegExp }[] = [
  { name: "Anthropic key", re: new RegExp(`${SK}${ANT}[A-Za-z0-9_-]{20,}`) },
  { name: "OpenAI key", re: new RegExp(`${SK}(?!${ANT})(?:${PROJ})?[A-Za-z0-9_-]{32,}`) },
  { name: "Google API key", re: new RegExp(`${GOOG}[0-9A-Za-z_-]{35}`) },
  { name: "Sentry auth token", re: new RegExp(`${SENTRY}[A-Za-z0-9+/=_-]{20,}`) },
];

/** Mirrors redactSecrets (src/server/observability/report.ts), which the browser cannot import. */
const REDACT = new RegExp(`\\b(${SK}[A-Za-z0-9_*.-]{6,}|${GOOG}[0-9A-Za-z_*.-]{6,}|${SENTRY}[A-Za-z0-9_*.-]{6,})`, "g");

/** Redacts anything key-shaped, then caps the length (the contract allows 500 chars for `error`). */
export function redact(text: string, max = 500): string {
  return text.replace(REDACT, "[redacted-key]").slice(0, max);
}

/** Names of the key shapes found in `text` — never the match itself. */
export function keyShapesIn(text: string): string[] {
  return KEY_SHAPES.filter(({ re }) => re.test(text)).map(({ name }) => name);
}

// ---------------------------------------------------------------------------------------------
// Probe plumbing

type Detail = Record<string, string | number | boolean>;
interface Outcome {
  status: "passed" | "failed" | "skipped";
  /** Why it did not pass: a failure, or an obstacle such as the app's rate limit. */
  error?: string;
  detail: Detail;
}

/** An assertion failed: the app misbehaved. */
class ProbeFailure extends Error {}
/** The app's own limiter answered 429 — the limiter working, not a defect. */
class RateLimited extends Error {
  constructor(
    message: string,
    readonly retryAfterSec: number | null,
  ) {
    super(message);
  }
}
class NetworkError extends Error {}
class ProbeTimeout extends Error {}
class RunAborted extends Error {}

const now = () => globalThis.performance?.now() ?? Date.now();
const iso = () => new Date().toISOString();
const ms = (t0: number) => Math.max(0, Math.round(now() - t0));

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ProbeFailure(message);
}

interface Io {
  signal: AbortSignal;
  get(path: string): Promise<Response>;
  post(path: string, body: unknown): Promise<Response>;
}

interface GuardCapture {
  status: number;
  headers: Headers;
  events: StreamEvent[];
}

interface Session {
  origin: string;
  includeAnswer: boolean;
  fetch: typeof fetch;
  health?: { mode: string };
  models?: { defaultModelId: string };
  /** The off-topic response, kept so stream-headers inspects it without a second request. */
  guard?: GuardCapture;
  outcomes: Partial<Record<ProbeId, Outcome>>;
}

function makeIo(s: Session, signal: AbortSignal): Io {
  const send = async (path: string, init: RequestInit): Promise<Response> => {
    let res: Response;
    try {
      res = await s.fetch(new URL(path, `${s.origin}/`).href, {
        ...init,
        headers: { ...(init.headers ?? {}), "x-nimbus-test-run": "readiness-probe" },
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new NetworkError(`network error on ${init.method ?? "GET"} ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status === 429) {
      const body = (await res.json().catch(() => null)) as { error?: { code?: string; retryAfterSec?: number } } | null;
      const header = Number(res.headers.get("retry-after"));
      const retry = body?.error?.retryAfterSec ?? (Number.isFinite(header) && header > 0 ? header : null);
      const wait = retry ? `retry in ${retry} s` : "retry later";
      throw new RateLimited(
        body?.error?.code === "rate_limited" ? `rate-limited by the app's own per-IP limit — ${wait}` : `HTTP 429 from the platform, not the app's limiter — ${wait}`,
        retry,
      );
    }
    return res;
  };
  return {
    signal,
    get: (path) => send(path, { method: "GET" }),
    post: (path, body) => send(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  };
}

/** Runs `fn` with its own signal; settles at `timeoutMs` or on the run's abort even if a body ignores its signal. */
function withDeadline<T>(timeoutMs: number, parent: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const ctrl = new AbortController();
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
      ctrl.abort();
      settle();
    };
    const onAbort = () => finish(() => reject(new RunAborted()));
    const timer = setTimeout(() => finish(() => reject(new ProbeTimeout())), timeoutMs);
    if (parent?.aborted) return onAbort();
    parent?.addEventListener("abort", onAbort, { once: true });
    fn(ctrl.signal).then(
      (value) => finish(() => resolve(value)),
      (err) => finish(() => reject(err)),
    );
  });
}

async function readJson<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProbeFailure(`${what} returned HTTP ${res.status} with a body that is not JSON (${res.headers.get("content-type") ?? "no content-type"})`);
  }
}

/** "HTTP 503 unavailable: <server's message>" — the server's own copy, never the question. */
async function describeHttp(res: Response): Promise<string> {
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json")) {
    await res.body?.cancel().catch(() => {});
    return `HTTP ${res.status} (${type || "no content-type"})`;
  }
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  const code = body?.error?.code;
  return code ? `HTTP ${res.status} ${code}: ${body?.error?.message ?? ""}`.trim() : `HTTP ${res.status}`;
}

/** Fails with "<what> <status summary>" unless `ok`; reads the body only on failure. */
async function requireStatus(ok: boolean, res: Response, what: string): Promise<void> {
  if (!ok) throw new ProbeFailure(`${what} ${await describeHttp(res)}`);
}

/** A stream `error` event is a failed answer; its message is the server's own copy. */
function requireNoError(events: StreamEvent[]): void {
  const failure = events.find((e): e is Extract<StreamEvent, { type: "error" }> => e.type === "error");
  if (failure) throw new ProbeFailure(`stream ended with error ${failure.code}: ${failure.message}`);
}

const chatBody = (modelId: string, content: string) => ({ modelId, messages: [{ role: "user", content }] });

/** Reads the chat stream, validating every line with the shared wire contract (StreamEventSchema). */
async function readChatStream(res: Response, signal: AbortSignal, onEvent: (e: StreamEvent) => void): Promise<void> {
  check(res.body, `HTTP ${res.status} with no body`);
  for await (const { line, lineNo } of ndjsonLines(res.body, signal)) {
    let event: StreamEvent;
    try {
      event = StreamEventSchema.parse(JSON.parse(line));
    } catch (err) {
      throw new ProbeFailure(`stream line ${lineNo} breaks the wire contract (StreamEventSchema) — ${describeParseError(err)}`);
    }
    onEvent(event);
  }
}

async function loadModels(s: Session, io: Io): Promise<string> {
  if (s.models) return s.models.defaultModelId;
  const res = await io.get("/api/models");
  await requireStatus(res.ok, res, "a valid model id is needed from GET /api/models, which returned");
  const body = await readJson<{ defaultModelId?: unknown }>(res, "GET /api/models");
  check(typeof body.defaultModelId === "string" && body.defaultModelId, "GET /api/models has no defaultModelId");
  s.models = { defaultModelId: body.defaultModelId };
  return body.defaultModelId;
}

async function loadMode(s: Session, io: Io): Promise<string> {
  if (s.health) return s.health.mode;
  const res = await io.get("/api/health");
  await requireStatus(res.ok, res, "the LLM mode is needed from GET /api/health, which returned");
  const body = await readJson<{ mode?: unknown }>(res, "GET /api/health");
  s.health = { mode: String(body.mode) };
  return s.health.mode;
}

/** Shared by blank / oversize / unknown-model: a 400 JSON invalid_input, never a stream. */
async function expectInvalidInput(res: Response, d: Detail): Promise<string> {
  d.httpStatus = res.status;
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("ndjson")) {
    await res.body?.cancel().catch(() => {}); // stop the stream: an accepted request may be calling a model
    throw new ProbeFailure(`HTTP ${res.status} NDJSON stream — the server accepted the request instead of rejecting it with 400`);
  }
  await requireStatus(res.status === 400, res, "expected HTTP 400 invalid_input, got");
  check(type.includes("application/json"), `HTTP 400 with content-type "${type}", expected application/json`);
  const body = await readJson<{ error?: { code?: unknown; message?: unknown } }>(res, "POST /api/chat");
  const code = String(body.error?.code);
  const message = typeof body.error?.message === "string" ? body.error.message : "";
  d.code = code;
  d.message = redact(message, 200);
  check(code === "invalid_input", `HTTP 400 with code "${code}", expected invalid_input`);
  return message;
}

const basename = (file: string) => file.split("/").pop() ?? file;
const normalizeQuotes = (text: string) => text.replace(/[‘’]/g, "'");

// ---------------------------------------------------------------------------------------------
// The probes

type ProbeFn = (s: Session, io: Io, d: Detail) => Promise<Outcome>;
const pass = (detail: Detail): Outcome => ({ status: "passed", detail });

const RUNNERS: Record<ProbeId, ProbeFn> = {
  async health(s, io, d) {
    const t0 = now();
    const res = await io.get("/api/health");
    d.httpStatus = res.status;
    await requireStatus(res.ok, res, "GET /api/health returned");
    const body = await readJson<{ ok?: unknown; mode?: unknown; corpus?: { files?: unknown; chunks?: unknown }; providersAvailable?: unknown; pricingVersion?: unknown }>(res, "GET /api/health");
    d.ms = ms(t0);
    const providers = Array.isArray(body.providersAvailable) ? body.providersAvailable.map(String) : [];
    d.mode = String(body.mode);
    d.providers = providers.join(", ") || "none";
    d.corpusFiles = Number(body.corpus?.files);
    d.chunks = Number(body.corpus?.chunks);
    if (typeof body.pricingVersion === "string") d.pricingVersion = body.pricingVersion;
    s.health = { mode: String(body.mode) };
    check(body.ok === true, `ok is ${JSON.stringify(body.ok)} — the server reports it cannot answer`);
    check(body.corpus?.files === 10, `corpus.files is ${JSON.stringify(body.corpus?.files)} — expected all 10 knowledge-base documents`);
    check(typeof body.corpus?.chunks === "number" && body.corpus.chunks > 0, `corpus.chunks is ${JSON.stringify(body.corpus?.chunks)} — expected > 0`);
    check(providers.length >= 1, "providersAvailable is empty — no provider key is configured");
    if (providers.length < 2) d.note = `only ${providers[0]} is configured — the brief's fallback demo needs a second provider`;
    return pass(d);
  },

  async models(s, io, d) {
    const t0 = now();
    const res = await io.get("/api/models");
    d.httpStatus = res.status;
    await requireStatus(res.ok, res, "GET /api/models returned");
    const text = await res.text();
    d.ms = ms(t0);
    const leaked = keyShapesIn(text);
    check(leaked.length === 0, `the public model catalog contains a string shaped like a secret: ${leaked.join(", ")}`);
    let body: { defaultModelId?: unknown; pricingVersion?: unknown; models?: unknown };
    try {
      body = JSON.parse(text);
    } catch {
      throw new ProbeFailure(`GET /api/models returned a body that is not JSON (${res.headers.get("content-type") ?? "no content-type"})`);
    }
    check(Array.isArray(body.models) && body.models.length > 0, "models is missing or empty");
    const models = body.models as Record<string, unknown>[];
    const ids = models.map((m) => String(m.id));
    d.defaultModelId = String(body.defaultModelId);
    // The chat probes only need a valid id, even if a later catalog check fails.
    if (typeof body.defaultModelId === "string" && ids.includes(body.defaultModelId)) s.models = { defaultModelId: body.defaultModelId };
    for (const m of models) {
      const id = String(m.id);
      const price = m.pricing as { inputPerMTok?: unknown; outputPerMTok?: unknown } | undefined;
      check(typeof m.providerName === "string" && m.providerName.trim(), `model "${id}" has no providerName`);
      check(typeof m.description === "string" && m.description.trim(), `model "${id}" has no description`);
      check(typeof m.contextWindow === "number" && m.contextWindow > 0, `model "${id}" has contextWindow ${JSON.stringify(m.contextWindow)} — expected a positive number`);
      check(
        typeof price?.inputPerMTok === "number" && price.inputPerMTok > 0 && typeof price.outputPerMTok === "number" && price.outputPerMTok > 0,
        `model "${id}" has no input/output price per million tokens`,
      );
    }
    const names = models.map((m) => String(m.providerName));
    const vendors = { Anthropic: /anthropic|claude/i, OpenAI: /openai|gpt/i, Google: /google|gemini/i };
    const missing = Object.entries(vendors)
      .filter(([, re]) => !names.some((n) => re.test(n)))
      .map(([vendor]) => vendor);
    d.models = models.length;
    d.available = models.filter((m) => m.available === true).length;
    d.providers = [...new Set(names)].sort().join(", ");
    if (typeof body.pricingVersion === "string") d.pricingVersion = body.pricingVersion;
    check(missing.length === 0, `no ${missing.join(" or ")} model in the catalog (providers: ${d.providers})`);
    check(s.models, `defaultModelId "${d.defaultModelId}" is not one of the models (${ids.join(", ")})`);
    return pass(d);
  },

  async blank(s, io, d) {
    const modelId = await loadModels(s, io);
    const t0 = now();
    const res = await io.post("/api/chat", chatBody(modelId, "   "));
    await expectInvalidInput(res, d);
    d.ms = ms(t0);
    return pass(d);
  },

  async oversize(s, io, d) {
    const modelId = await loadModels(s, io);
    const t0 = now();
    d.sentChars = MAX_MESSAGE_CHARS + 1;
    const res = await io.post("/api/chat", chatBody(modelId, "x".repeat(MAX_MESSAGE_CHARS + 1)));
    const message = await expectInvalidInput(res, d);
    d.ms = ms(t0);
    check(message.replace(/[,\s]/g, "").includes(String(MAX_MESSAGE_CHARS)), `the 400 message does not state the ${LIMIT}-character limit`);
    return pass(d);
  },

  async "unknown-model"(_s, io, d) {
    const t0 = now();
    const res = await io.post("/api/chat", chatBody("not-a-model", OFFTOPIC_QUESTION));
    await expectInvalidInput(res, d);
    d.ms = ms(t0);
    return pass(d);
  },

  async "offtopic-guard"(s, io, d) {
    const modelId = await loadModels(s, io);
    const t0 = now();
    const res = await io.post("/api/chat", chatBody(modelId, OFFTOPIC_QUESTION));
    d.httpStatus = res.status;
    const capture: GuardCapture = { status: res.status, headers: res.headers, events: [] };
    s.guard = capture;
    await requireStatus(res.status === 200, res, "expected a 200 stream, got");
    await readChatStream(res, io.signal, (e) => capture.events.push(e));
    d.ms = ms(t0);
    const events = capture.events;
    d.events = events.length;
    requireNoError(events);
    const sources = events.find((e) => e.type === "sources");
    const done = events.find((e) => e.type === "done");
    check(done?.type === "done", "stream ended without a done event");
    d.answeredBy = done.answeredBy;
    d.inputTokens = done.usage.inputTokens;
    d.outputTokens = done.usage.outputTokens;
    d.costUSD = done.costUSD;
    if (sources?.type === "sources") d.sources = sources.passages.length;
    check(
      done.answeredBy === KB_GUARD_ID,
      `answered by model "${done.answeredBy}" (${done.usage.inputTokens} input + ${done.usage.outputTokens} output tokens, $${done.costUSD}) instead of ${KB_GUARD_ID} — this deployment predates the off-topic guard, or the guard missed this question`,
    );
    check(sources?.type === "sources", "no sources event");
    check(sources.passages.length === 0, `the guard sent ${sources.passages.length} source passage(s); expected none`);
    check(done.usage.inputTokens === 0 && done.usage.outputTokens === 0, `${KB_GUARD_ID} reported ${done.usage.inputTokens}/${done.usage.outputTokens} tokens — expected 0/0`);
    check(done.costUSD === 0, `${KB_GUARD_ID} reported cost $${done.costUSD} — expected $0`);
    const text = events.reduce(applyEvent, emptyAnswer()).text;
    check(normalizeQuotes(text).includes(NOT_IN_KB_PHRASE), `the guard's answer does not say "I ${NOT_IN_KB_PHRASE}"`);
    return pass(d);
  },

  async "stream-headers"(s, _io, d) {
    const g = s.guard;
    if (!g) {
      const guard = s.outcomes["offtopic-guard"];
      if (guard?.status === "skipped") return { status: "skipped", error: guard.error, detail: { ...guard.detail } };
      throw new ProbeFailure(`no chat response to inspect — the off-topic request failed: ${guard?.error ?? "it did not run"}`);
    }
    const type = g.headers.get("content-type") ?? "";
    const cache = g.headers.get("cache-control") ?? "";
    const requestId = g.headers.get("x-request-id") ?? "";
    const meta = g.events[0];
    const doneAt = g.events.findIndex((e) => e.type === "done");
    const deltas = g.events.slice(0, doneAt < 0 ? undefined : doneAt).filter((e) => e.type === "delta").length;
    Object.assign(d, { httpStatus: g.status, contentType: type, cacheControl: cache, requestId: requestId.slice(0, 64), deltas });
    check(type.startsWith("application/x-ndjson"), `content-type is "${type}" (HTTP ${g.status}), expected application/x-ndjson`);
    check(/\bno-store\b/.test(cache), `cache-control is "${cache}", expected no-store`);
    check(requestId, "no x-request-id header");
    check(meta?.type === "meta", `the first stream event is "${meta?.type ?? "none"}", expected meta`);
    check(meta.requestId === requestId, "x-request-id does not match the stream's meta.requestId");
    check(doneAt >= 0, "stream ended without a done event");
    check(deltas >= 2, `${deltas} delta event(s) before done — expected the answer to stream in at least 2`);
    return pass(d);
  },

  async "bundle-keys"(s, io, d) {
    const scripts = new Set<string>();
    const pages: string[] = [];
    const hits: string[] = [];
    const encoder = new TextEncoder();
    d.files = 0;
    d.bytes = 0;
    // The HTML is scanned too: a server component that leaked a key into props would show up there.
    const scan = (text: string, where: string) => {
      d.files = Number(d.files) + 1;
      d.bytes = Number(d.bytes) + encoder.encode(text).length;
      for (const name of keyShapesIn(text)) hits.push(`${name} in ${where}`);
    };
    for (const page of ["/", "/readiness"]) {
      const res = await io.get(page);
      if (!res.ok && page !== "/") {
        await res.body?.cancel().catch(() => {});
        continue; // a deployment without the readiness page: scan what the chat page serves
      }
      await requireStatus(res.ok, res, "GET / returned");
      const html = await res.text();
      pages.push(page);
      scan(html, `${page} (HTML)`);
      for (const src of scriptUrls(html, s.origin)) scripts.add(src);
    }
    d.pages = pages.join(", ");
    d.scripts = scripts.size;
    check(scripts.size > 0, `no /_next/static script found in the HTML of ${d.pages} — nothing to scan`);
    for (const src of scripts) {
      const path = new URL(src).pathname;
      const res = await io.get(src);
      await requireStatus(res.ok, res, `GET ${path} returned`);
      scan(await res.text(), path);
    }
    check(hits.length === 0, `${hits.length} key-shaped string(s) served to the browser: ${hits.slice(0, 5).join("; ")}`);
    return pass(d);
  },

  async "grounded-answer"(s, io, d) {
    if (!s.includeAnswer) return { status: "skipped", detail: { note: "disabled by direct caller" } };
    const modelId = await loadModels(s, io);
    const mode = await loadMode(s, io);
    Object.assign(d, { requestedModel: modelId, mode });
    const t0 = now();
    const res = await io.post("/api/chat", chatBody(modelId, GROUNDED_QUESTION));
    d.httpStatus = res.status;
    await requireStatus(res.status === 200, res, "expected a 200 stream, got");
    const events: StreamEvent[] = [];
    await readChatStream(res, io.signal, (e) => {
      if (e.type === "delta" && d.ttftMs === undefined) d.ttftMs = ms(t0);
      events.push(e);
    });
    d.totalMs = ms(t0);
    requireNoError(events);
    const types = events.map((e) => e.type);
    check(types[0] === "meta", `the first event is "${types[0] ?? "none"}", expected meta`);
    check(types[1] === "sources", `the second event is "${types[1] ?? "none"}", expected sources`);
    const doneAt = types.indexOf("done");
    check(doneAt >= 0, "stream ended without a done event");
    check(doneAt === types.length - 1, `${types.length - 1 - doneAt} event(s) after done`);
    const middle = types.slice(2, doneAt);
    const stray = middle.find((t) => t !== "delta" && t !== "fallback" && t !== "reset");
    check(!stray, `unexpected "${stray}" event between sources and done`);
    check(middle.includes("delta"), "no delta event before done");
    const passages = (events[1] as Extract<StreamEvent, { type: "sources" }>).passages;
    const done = events[doneAt] as Extract<StreamEvent, { type: "done" }>;
    const fallbacks = events.filter((e): e is Extract<StreamEvent, { type: "fallback" }> => e.type === "fallback");
    Object.assign(d, {
      answeredBy: done.answeredBy,
      inputTokens: done.usage.inputTokens,
      outputTokens: done.usage.outputTokens,
      costUSD: done.costUSD,
      passages: passages.length,
    });
    if (fallbacks.length) d.fallback = fallbacks.map((f) => `${f.from} → ${f.to} (${f.reason})`).join("; ");
    check(passages.length > 0, "the sources event is empty — retrieval found no passage for the Vault SAML question");
    const text = events.reduce(applyEvent, emptyAnswer()).text;
    const cited = [...citedNumbers(text)].sort((a, b) => a - b);
    d.citations = cited.join(", ");
    const sent = new Set(passages.map((p) => p.n));
    const unsent = cited.filter((n) => !sent.has(n));
    check(unsent.length === 0, `cites [${unsent.join(", ")}] but only passages ${[...sent].sort((a, b) => a - b).join(", ")} were sent`);
    check(cited.length > 0, "the answer cites no passage — every fact must carry an [n] citation");
    check(done.answeredBy.trim(), "done.answeredBy is empty");
    check(done.usage.inputTokens > 0 && done.usage.outputTokens > 0, `usage is ${done.usage.inputTokens} input / ${done.usage.outputTokens} output tokens — expected both > 0 for a model answer`);
    check(done.costUSD > 0, `costUSD is ${done.costUSD} — expected > 0 for a model answer`);
    const unverified = done.unverifiedFigures?.length ?? 0;
    check(unverified === 0, `the figure check flagged ${unverified} number(s) found in no passage`);
    if (mode === "mock") {
      d.note = "mock LLM: content check skipped (stream order, citations, usage and cost still asserted)";
      return pass(d);
    }
    check(/disagree/i.test(text), "the answer does not say the documents disagree on Vault SAML tiers");
    const citedFiles = (match: (file: string) => boolean) => passages.filter((p: PassageDTO) => match(basename(p.file)) && cited.includes(p.n)).map((p) => p.n);
    const vault = citedFiles((f) => /^vault/i.test(f));
    const security = citedFiles((f) => /^security-overview/i.test(f));
    d.vaultCited = vault.join(", ");
    d.securityCited = security.join(", ");
    check(vault.length > 0 && security.length > 0, `the disagreement must cite both sides: vault passage cited ${vault.length ? "yes" : "no"}, security-overview passage cited ${security.length ? "yes" : "no"}`);
    return pass(d);
  },
};

/** Same-origin /_next/static/**.js URLs from <script src> and <link rel=modulepreload|preload as=script>. */
export function scriptUrls(html: string, origin: string): string[] {
  const urls: string[] = [];
  const attr = (tag: string, name: string) => {
    const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"));
    return m ? (m[1] ?? m[2] ?? m[3]).replace(/&amp;/g, "&") : null;
  };
  for (const tag of html.match(/<(?:script|link)\b[^>]*>/gi) ?? []) {
    let ref: string | null = null;
    if (/^<script/i.test(tag)) ref = attr(tag, "src");
    else {
      const rel = (attr(tag, "rel") ?? "").toLowerCase().split(/\s+/);
      if (rel.includes("modulepreload") || (rel.includes("preload") && attr(tag, "as")?.toLowerCase() === "script")) ref = attr(tag, "href");
    }
    if (!ref) continue;
    let url: URL;
    try {
      url = new URL(ref, `${origin}/`);
    } catch {
      continue;
    }
    if (url.origin === origin && url.pathname.startsWith("/_next/static/") && url.pathname.endsWith(".js") && !urls.includes(url.href)) urls.push(url.href);
  }
  return urls;
}

const TIMEOUT_MS: Partial<Record<ProbeId, number>> = {
  // The served JS can be a few MB on a slow link.
  "bundle-keys": 20_000,
  // 5 s past the server's 45 s fallback budget, so the server's own clean error arrives before we give up.
  "grounded-answer": 50_000,
};
const DEFAULT_TIMEOUT_MS = 10_000;

async function runOne(id: ProbeId, s: Session, parent: AbortSignal | undefined): Promise<Outcome | null> {
  const timeoutMs = TIMEOUT_MS[id] ?? DEFAULT_TIMEOUT_MS;
  const d: Detail = {};
  try {
    return await withDeadline(timeoutMs, parent, (signal) => RUNNERS[id](s, makeIo(s, signal), d));
  } catch (err) {
    if (err instanceof RunAborted || parent?.aborted) return null;
    if (err instanceof RateLimited) {
      if (err.retryAfterSec) d.retryAfterSec = err.retryAfterSec;
      return { status: "skipped", error: redact(err.message), detail: { ...d, httpStatus: 429 } };
    }
    if (err instanceof ProbeTimeout) return { status: "failed", error: `no complete response within ${timeoutMs / 1000} s`, detail: d };
    if (err instanceof ProbeFailure || err instanceof NetworkError) return { status: "failed", error: redact(err.message), detail: d };
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { status: "failed", error: redact(`probe error — ${reason}`), detail: d };
  }
}

const cleanDetail = (d: Detail): Detail =>
  Object.fromEntries(Object.entries(d).map(([k, v]) => [k, typeof v === "string" ? redact(v, 200) : typeof v === "number" && !Number.isFinite(v) ? String(v) : v]));

/**
 * Runs every probe in order against `opts.origin` and reports through `emit`:
 * stage-start(probes) → (test-start, test-result) per probe → stage-end(probes, source "live").
 * Never emits run-start / run-end (the page owns the run). A failing probe is a failed result, never
 * a throw; a 429 from the app's own limiter is a skipped result. On abort it stops promptly and
 * resolves without emitting anything further (no result for the probe in flight, no stage-end).
 */
export async function runProbes(opts: ProbeOptions, emit: (e: ReadinessEvent) => void): Promise<void> {
  const { signal } = opts;
  if (signal?.aborted) return;
  const origin = opts.origin.replace(/\/+$/, "");
  const s: Session = { origin, includeAnswer: opts.includeAnswer, fetch: opts.fetch ?? globalThis.fetch.bind(globalThis), outcomes: {} };
  const counts = { passed: 0, failed: 0, skipped: 0 };
  const stageStarted = now();
  emit({ type: "stage-start", stage: "probes", at: iso() });
  emit({ type: "stage-total", stage: "probes", total: PROBES.length });
  for (const probe of PROBES) {
    if (signal?.aborted) return;
    const id = `probe::${probe.id}`;
    emit({ type: "test-start", stage: "probes", id, file: origin, fullName: probe.title });
    const started = now();
    const outcome = await runOne(probe.id, s, signal);
    if (!outcome || signal?.aborted) return;
    s.outcomes[probe.id] = outcome;
    counts[outcome.status] += 1;
    emit({
      type: "test-result",
      result: {
        id,
        stage: "probes",
        file: origin,
        fullName: probe.title,
        status: outcome.status,
        durationMs: ms(started),
        source: "live",
        ...(outcome.error ? { error: redact(outcome.error) } : {}),
        detail: cleanDetail(outcome.detail),
      },
    });
  }
  emit({
    type: "stage-end",
    stage: "probes",
    status: counts.failed > 0 ? "failed" : counts.passed > 0 ? "passed" : "skipped",
    durationMs: ms(stageStarted),
    counts,
    source: "live",
    at: iso(),
    note: `live · ${origin}`,
  });
}
