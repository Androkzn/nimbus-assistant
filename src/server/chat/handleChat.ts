import type { LanguageModel } from "ai";
import { ChatRequestSchema, HISTORY_MESSAGES, KB_GUARD_ID, type StreamEvent } from "@/shared/contracts";
import { catalog, getModel, type Env, type ModelEntry } from "../config/models";
import { createRateLimiter, type RateLimiter } from "../http/rateLimit";
import { runWithFallback, type AttemptTrace, type RunnerEvent } from "../llm/fallback";
import { extractFaults } from "../llm/faults";
import { sentryChatMonitor, type ChatMonitor } from "../observability/report";
import { buildInstructions, NOT_IN_KB } from "../prompt/build";
import { retrieve } from "../retrieval/retrieve";
import { unverifiedFigures } from "../verify/figures";
import { slaQualifier } from "../verify/qualifiers";

export interface ChatDeps {
  env?: Env;
  limiter?: RateLimiter;
  modelFactory?: (entry: ModelEntry) => LanguageModel;
  today?: () => string;
  log?: (record: Record<string, unknown>) => void;
  /** Error monitoring (Sentry); tests inject their own. */
  monitor?: ChatMonitor;
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
  const monitor = deps.monitor ?? sentryChatMonitor;
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
  const today = (deps.today ?? (() => new Date().toISOString().slice(0, 10)))();
  const instructions = buildInstructions(retrieval, today);
  const modelMessages = [...history.slice(-HISTORY_MESSAGES), { role: "user" as const, content: question }];
  // Guard questions the documents cannot answer deterministically: no meaningful match with no product
  // in scope, or pricing questions using tier labels absent from the corpus (brief E2, the one rule).
  const guarded =
    (retrieval.noMatch && retrieval.products.length === 0) ||
    retrieval.unsupportedPricingTier ||
    retrieval.ambiguousReleaseVersion ||
    retrieval.unsupportedTroubleshootingStatus;

  const trace: AttemptTrace[] = [];
  let ttftMs: number | null = null;
  let final: StreamEvent | null = null;
  let answerText = "";
  let unverified: string[] = [];
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: StreamEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        send({ type: "meta", requestId, requestedModel: modelId });
        send({
          type: "sources",
          passages: guarded
            ? []
            : retrieval.passages.map((p) => ({ n: p.n, file: p.chunk.file, section: p.chunk.section, docDate: p.chunk.docDate, text: p.chunk.text })),
        });
        const events = guarded
          ? guardAnswer(modelId, retrieval.ambiguousReleaseVersion ? AMBIGUOUS_VERSION_ANSWER : GUARD_ANSWER)
          : runWithFallback({
              requestedModelId: modelId,
              instructions,
              messages: modelMessages,
              signal: req.signal,
              faults,
              env,
              modelFactory: deps.modelFactory,
              trace,
              onFirstToken: () => (ttftMs ??= Date.now() - started),
            });
        for await (const event of events) {
          if (event.type === "delta") answerText += event.text;
          else if (event.type === "reset") answerText = "";
          if (event.type === "done") {
            // SLA definition (TRD §4.6): never let a response time read as a resolution time.
            const qualifier = guarded ? null : slaQualifier(answerText, retrieval.passages.map((p) => ({ n: p.n, text: p.chunk.text })));
            if (qualifier) {
              answerText += qualifier;
              send({ type: "delta", text: qualifier });
            }
            // Figure check: every number in the answer must appear in the passages or the question.
            // Sources: passages, the question, today's date, and the earlier turns this answer may restate.
            unverified = unverifiedFigures(answerText, [...retrieval.passages.map((p) => p.chunk.text), question, today, ...modelMessages.map((m) => m.content)]);
            final = { ...event, unverifiedFigures: unverified };
            send(final);
            continue;
          }
          if (event.type === "error") final = event;
          send(event);
        }
      } catch (err) {
        const message = "Something went wrong on our side. Please try again.";
        final = { type: "error", code: "unavailable", message };
        send(final);
        log({ event: "chat.unhandled", requestId, error: String(err).slice(0, 200) });
        monitor.unhandled(err, requestId);
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
          guarded,
          unverifiedFigures: unverified.length, // a count only: figures are answer content
        });
        monitor.providerFailures({ requestId, requestedModel: modelId, outcome: done?.type ?? "aborted", attempts: trace, injectedFaults: faults.length });
        if (done?.type === "done" && unverified.length > 0 && faults.length === 0) {
          monitor.unverifiedFigures({ requestId, answeredBy: done.answeredBy, count: unverified.length });
        }
      }
    },
  });

  return new Response(body, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-request-id": requestId },
  });
}

export const GUARD_ANSWER = `${NOT_IN_KB} I can answer questions about NimbusStack's products — Relay, Vault, Pulse and Ledger: pricing, features, integrations, release notes, troubleshooting and support SLAs.`;
export const AMBIGUOUS_VERSION_ANSWER = `${NOT_IN_KB} Please specify a product and an exact release version.`;

/** The deterministic off-topic answer, streamed like a model answer but with no model call and no cost. */
async function* guardAnswer(requestedModel: string, answer = GUARD_ANSWER): AsyncGenerator<RunnerEvent> {
  for (const word of answer.match(/\S+\s*/g) ?? []) yield { type: "delta", text: word };
  yield {
    type: "done",
    answeredBy: KB_GUARD_ID,
    requestedModel,
    usage: { inputTokens: 0, outputTokens: 0 },
    costUSD: 0,
    pricingVersion: catalog.pricingVersion,
  };
}
