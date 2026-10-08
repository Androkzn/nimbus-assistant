import type { LanguageModel } from "ai";
import { ChatRequestSchema, HISTORY_MESSAGES, KB_GUARD_ID, type StreamEvent } from "@/shared/contracts";
import { catalog, getModel, type Env, type ModelEntry } from "../config/models";
import { createRateLimiter, type RateLimiter } from "../http/rateLimit";
import { runWithFallback, type AttemptTrace, type RunnerEvent } from "../llm/fallback";
import { extractFaults } from "../llm/faults";
import { sentryChatMonitor, type ChatMonitor } from "../observability/report";
import { buildInstructions, NOT_IN_KB } from "../prompt/build";
import { retrieveAsync, type RetrievalResult } from "../retrieval/retrieve";
import { unverifiedFigures } from "../verify/figures";
import { slaQualifier, sourceLine } from "../verify/qualifiers";
import { buildFinding, persistFinding, type FindingSink } from "../findings/database";
import { devPortalEnabled } from "../dev-portal/enabled";

export interface ChatDeps {
  env?: Env;
  limiter?: RateLimiter;
  /** The readiness live eval's allowance on the developer surface; tests inject their own. */
  evalLimiter?: RateLimiter;
  modelFactory?: (entry: ModelEntry) => LanguageModel;
  today?: () => string;
  log?: (record: Record<string, unknown>) => void;
  /** Error monitoring (Sentry); tests inject their own. */
  monitor?: ChatMonitor;
  /** Privacy-safe quality finding sink; tests inject a collector. */
  findingSink?: FindingSink;
}

const defaultLimiter = createRateLimiter({
  max: Number(process.env.RATE_LIMIT_MAX ?? 20),
  windowMs: 5 * 60_000,
});

/** The readiness page's live answer eval on the developer deployment: about one full eval (~170 questions) per 10 minutes per client. */
const defaultEvalLimiter = createRateLimiter({
  max: Number(process.env.READINESS_EVAL_MAX ?? 200),
  windowMs: 10 * 60_000,
});

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** POST /api/chat (TRD §5). Kept free of Next.js specifics so it is testable with plain Requests. */
export async function handleChat(req: Request, deps: ChatDeps = {}): Promise<Response> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((r) => console.log(JSON.stringify(r)));
  const monitor = deps.monitor ?? sentryChatMonitor;
  // Automated verification exercises fallback and abstention paths on purpose. Those requests are
  // evidence for the test run, not customer findings, so they must never pollute the review portal.
  // The header is set only by the readiness probes/E2E harness; normal browser traffic has no header.
  const suppressFinding = Boolean(req.headers.get("x-nimbus-test-run")) || env.NIMBUS_DISABLE_FINDINGS === "1" || env.LLM_MODE === "mock";
  const requestId = crypto.randomUUID();
  const started = Date.now();

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  // The live eval runs many questions from one IP; it may bypass the limiter with a shared secret.
  const evalToken = env.EVAL_BYPASS_TOKEN;
  const isEval = Boolean(evalToken) && req.headers.get("x-eval-token") === evalToken;
  // The readiness page's live answer eval asks ~170 questions from one browser. On the developer surface only it
  // draws on its own allowance; production ignores the header, so the public limit there is unchanged (BR-26).
  const readinessEval = req.headers.get("x-nimbus-test-run") === "readiness-eval" && devPortalEnabled(env);
  const limiter = readinessEval ? (deps.evalLimiter ?? defaultEvalLimiter) : (deps.limiter ?? defaultLimiter);
  const limit = isEval ? ({ ok: true } as const) : limiter.check(ip);
  if (!limit.ok) {
    return json(
      429,
      { error: { code: "rate_limited", message: `Too many questions in a short time. Please wait ${limit.retryAfterSec} seconds.`, retryAfterSec: limit.retryAfterSec } },
      { "retry-after": String(limit.retryAfterSec) },
    );
  }

  const parsed = ChatRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(400, { error: { code: "invalid_input", message: friendlyInputError(parsed.error.issues[0]) } });
  }
  const { modelId, messages } = parsed.data;
  if (!getModel(modelId)) return json(400, { error: { code: "invalid_input", message: "Please choose one of the available models and try again." } });

  const history = messages.slice(0, -1);
  const { text: question, faults } = extractFaults(messages[messages.length - 1].content, env);
  if (!question) return json(400, { error: { code: "invalid_input", message: "Please enter a question first." } });

  const retrieval = await retrieveAsync(question, history);
  const today = (deps.today ?? (() => new Date().toISOString().slice(0, 10)))();
  const instructions = buildInstructions(retrieval, today);
  const modelMessages = [...history.slice(-HISTORY_MESSAGES), { role: "user" as const, content: question }];
  // Guard questions the documents cannot answer deterministically: no meaningful match with no product
  // in scope, or pricing questions using tier labels absent from the corpus (brief E2, the one rule).
  const guarded = retrieval.answerability !== "answerable";

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
          ? guardAnswer(modelId, guardMessage(retrieval))
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
            const passages = retrieval.passages.map((p) => ({ n: p.n, text: p.chunk.text }));
            // Citations (rule 5): an answer that cites nothing gets the passages it copied from, so it can be checked.
            // SLA definition (TRD §4.6): never let a response time read as a resolution time.
            for (const qualify of guarded ? [] : [sourceLine, slaQualifier]) {
              const qualifier = qualify(answerText, passages);
              if (!qualifier) continue;
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
          answerability: retrieval.answerability,
          guardReason: retrieval.guardReason,
          retrievalBestScore: retrieval.retrievalBestScore,
          retrievalFocusScore: retrieval.retrievalFocusScore,
          unverifiedFigures: unverified.length, // a count only: figures are answer content
        });
        monitor.providerFailures({ requestId, requestedModel: modelId, outcome: done?.type ?? "aborted", attempts: trace, injectedFaults: faults.length });
        if (done?.type === "done" && unverified.length > 0 && faults.length === 0) {
          monitor.unverifiedFigures({ requestId, answeredBy: done.answeredBy, count: unverified.length });
        }
        const finding = buildFinding({
          requestId,
          observedAt: new Date().toISOString(),
          retrieval,
          modelOutcome: done?.type ?? "aborted",
          unverifiedFigureCount: unverified.length,
          question,
        });
        if (finding && !suppressFinding) {
          try {
            await (deps.findingSink ?? persistFinding)(finding, env);
          } catch (error) {
            log({ event: "chat.finding_write_failed", requestId, error: String(error).slice(0, 200) });
          }
        }
        // Keep the invocation alive until the optional operational write has completed.
        // This matters on serverless runtimes, which may freeze immediately after the
        // response stream is closed.
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-request-id": requestId },
  });
}

export const GUARD_ANSWER = `${NOT_IN_KB} I can answer questions about NimbusStack's products — Relay, Vault, Pulse and Ledger: pricing, features, integrations, release notes, troubleshooting and support SLAs.`;
export const AMBIGUOUS_VERSION_ANSWER = `${NOT_IN_KB} Please specify a product and an exact release version.`;

function friendlyInputError(issue?: { message?: string; path?: PropertyKey[] }): string {
  if (!issue) return "We couldn't send that. Please check your question and try again.";
  if (issue.message === "This chat is full. Start a new conversation to keep going.") return issue.message;
  if (issue.message === "Please shorten your question to 2,000 characters and try again.") return issue.message;
  if (issue.path?.includes("content") && issue.message?.includes("Too big")) return "Please shorten your question to 2,000 characters and try again.";
  if (issue.message === "The last message must be from the user.") return "Please enter a question to continue.";
  if (issue.message === "Please enter a question first.") return issue.message;
  return "We couldn't send that. Please check your question and try again.";
}

function guardMessage(retrieval: RetrievalResult): string {
  if (retrieval.guardReason === "incomplete") {
    const product = retrieval.products.length === 1 ? ` for Nimbus ${retrieval.products[0][0].toUpperCase()}${retrieval.products[0].slice(1)}` : " and the NimbusStack product";
    return `Please specify the topic or feature you want to know about${product}.`;
  }
  if (retrieval.guardReason === "ambiguous_release") return AMBIGUOUS_VERSION_ANSWER;
  return GUARD_ANSWER;
}

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
