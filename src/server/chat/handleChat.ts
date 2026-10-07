import type { LanguageModel } from "ai";
import { ChatRequestSchema, type StreamEvent } from "@/shared/contracts";
import { getModel, type Env, type ModelEntry } from "../config/models";
import { createRateLimiter, type RateLimiter } from "../http/rateLimit";
import { runWithFallback, type AttemptTrace } from "../llm/fallback";
import { extractFaults } from "../llm/faults";
import { buildInstructions } from "../prompt/build";
import { retrieve } from "../retrieval/retrieve";

/** Prior turns forwarded to the model; retrieval runs fresh every turn anyway. */
const HISTORY_TURNS = 12;

export interface ChatDeps {
  env?: Env;
  limiter?: RateLimiter;
  modelFactory?: (entry: ModelEntry) => LanguageModel;
  today?: () => string;
  log?: (record: Record<string, unknown>) => void;
}

const defaultLimiter = createRateLimiter({
  max: Number(process.env.RATE_LIMIT_MAX ?? 20),
  windowMs: 5 * 60_000,
});

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** POST /api/chat (TRD §5). Kept free of Next.js specifics so it is testable with plain Requests. */
export async function handleChat(req: Request, deps: ChatDeps = {}): Promise<Response> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((r) => console.log(JSON.stringify(r)));
  const requestId = crypto.randomUUID();
  const started = Date.now();

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  // The live eval runs many questions from one IP; it may bypass the limiter with a shared secret.
  const evalToken = env.EVAL_BYPASS_TOKEN;
  const isEval = Boolean(evalToken) && req.headers.get("x-eval-token") === evalToken;
  const limit = isEval ? ({ ok: true } as const) : (deps.limiter ?? defaultLimiter).check(ip);
  if (!limit.ok) {
    return json(
      429,
      { error: { code: "rate_limited", message: `Too many questions in a short time. Please wait ${limit.retryAfterSec} seconds.`, retryAfterSec: limit.retryAfterSec } },
      { "retry-after": String(limit.retryAfterSec) },
    );
  }

  const parsed = ChatRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(400, { error: { code: "invalid_input", message: parsed.error.issues[0]?.message ?? "Invalid request." } });
  }
  const { modelId, messages } = parsed.data;
  if (!getModel(modelId)) return json(400, { error: { code: "invalid_input", message: `Unknown model "${modelId}".` } });

  const history = messages.slice(0, -1);
  const { text: question, faults } = extractFaults(messages[messages.length - 1].content, env);
  if (!question) return json(400, { error: { code: "invalid_input", message: "Please type a question first." } });

  const retrieval = retrieve(question, history);
  const instructions = buildInstructions(retrieval, (deps.today ?? (() => new Date().toISOString().slice(0, 10)))());
  const modelMessages = [...history.slice(-HISTORY_TURNS), { role: "user" as const, content: question }];

  const trace: AttemptTrace[] = [];
  let ttftMs: number | null = null;
  let final: StreamEvent | null = null;
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: StreamEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        send({ type: "meta", requestId, requestedModel: modelId });
        send({
          type: "sources",
          passages: retrieval.passages.map((p) => ({ n: p.n, file: p.chunk.file, section: p.chunk.section, docDate: p.chunk.docDate, text: p.chunk.text })),
        });
        for await (const event of runWithFallback({
          requestedModelId: modelId,
          instructions,
          messages: modelMessages,
          signal: req.signal,
          faults,
          env,
          modelFactory: deps.modelFactory,
          trace,
          onFirstToken: () => (ttftMs ??= Date.now() - started),
        })) {
          if (event.type === "done" || event.type === "error") final = event;
          send(event);
        }
      } catch (err) {
        const message = "Something went wrong on our side. Please try again.";
        final = { type: "error", code: "unavailable", message };
        send(final);
        log({ event: "chat.unhandled", requestId, error: String(err).slice(0, 200) });
      } finally {
        controller.close();
        // Structured log: no message text, no keys (TRD §7).
        const done = final as StreamEvent | null;
        log({
          event: "chat.request",
          requestId,
          requestedModel: modelId,
          answeredBy: done?.type === "done" ? done.answeredBy : null,
          outcome: done?.type ?? "aborted",
          // `detail` is the vendor's error summary — server logs only, never sent to the browser.
          attempts: trace.map((t) => ({ model: t.model, outcome: t.outcome, detail: t.detail })),
          ttftMs,
          totalMs: Date.now() - started,
          inputTokens: done?.type === "done" ? done.usage.inputTokens : null,
          outputTokens: done?.type === "done" ? done.usage.outputTokens : null,
          costUSD: done?.type === "done" ? done.costUSD : null,
          passages: retrieval.passages.map((p) => p.chunk.id),
          historyTurns: history.length,
          faults,
        });
      }
    },
  });

  return new Response(body, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-request-id": requestId },
  });
}
