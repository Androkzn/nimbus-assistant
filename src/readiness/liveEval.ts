import golden from "../../evals/golden-set.json";
import { gradeAnswer, readChatStream } from "./grade.mjs";
import type { Counts, ReadinessEvent, TestResult } from "./schema";

/**
 * The live answer eval, run from the readiness page against its own server (a deployment has no local runner).
 * The same golden questions, models and grading as `npm run eval:live`; results carry the same ids
 * (eval::<case>::<model>), so the manifest's eval checks claim them. Spends real tokens: the page runs it only
 * while "Include live answers" is ticked.
 */

interface GoldenCase {
  id: string;
  brief: string;
  question: string;
  history?: { role: string; content: string }[];
  expectNotInKb?: boolean;
  noCitationRequired?: boolean;
  mustInclude?: string[];
  mustNotInclude?: string[];
  shouldInclude?: string[];
}

export interface LiveEvalOptions {
  origin: string;
  signal?: AbortSignal;
  /** Injected in tests; defaults to the browser's fetch. */
  fetch?: typeof fetch;
  /** Questions in flight at once (default 4). */
  concurrency?: number;
}

const CASES: GoldenCase[] = golden.cases;
const STATUS: Record<string, TestResult["status"]> = { pass: "passed", fail: "failed", fallback: "skipped" };

/** "figures not in sources: 59, 12" names numbers from the answer itself; only their count is kept. */
const publishable = (reason: string) => reason.replace(/^figures not in sources: (.*)$/, (_, list: string) => `figures not in sources (${list.split(",").length})`);

export async function runLiveEval(opts: LiveEvalOptions, emit: (e: ReadinessEvent) => void): Promise<void> {
  const { origin, signal, concurrency = 4 } = opts;
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const started = Date.now();
  emit({ type: "stage-start", stage: "live-eval", at: new Date(started).toISOString() });
  const counts: Counts = { passed: 0, failed: 0, skipped: 0 };

  const catalog = (await doFetch(`${origin}/api/models`, { cache: "no-store", signal })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)) as { models?: { id: string; available: boolean }[] } | null;
  const models = (catalog?.models ?? []).filter((m) => m.available).map((m) => m.id);
  if (signal?.aborted) return;
  if (models.length === 0) {
    emit(stageEnd("failed", started, counts, "no model is available on this server"));
    return;
  }

  const jobs = models.flatMap((model) => CASES.map((c) => ({ model, c })));
  emit({ type: "stage-total", stage: "live-eval", total: jobs.length });

  let next = 0;
  const worker = async () => {
    while (next < jobs.length && !signal?.aborted) {
      const { model, c } = jobs[next++];
      const id = `eval::${c.id}::${model}`;
      const fullName = `${c.id} — ${c.question}`;
      emit({ type: "test-start", stage: "live-eval", id, file: "evals/golden-set.json", fullName });
      const result = await askAndGrade(doFetch, origin, model, c, signal);
      if (signal?.aborted) return;
      const status = STATUS[result.verdict] ?? "failed";
      counts[status] += 1;
      const r: TestResult = {
        id,
        stage: "live-eval",
        file: "evals/golden-set.json",
        fullName,
        status,
        durationMs: result.ms,
        source: "live",
        ...(status === "failed" ? { error: result.failed.map(publishable).join("; ").slice(0, 500) } : {}),
        detail: {
          model,
          brief: c.brief,
          environment: origin,
          ...(result.usage ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } : {}),
          ...(result.costUSD ? { costUSD: result.costUSD } : {}),
          ...(result.verdict === "pass" ? {} : { verdict: result.verdict }),
          ...(result.answeredBy && result.answeredBy !== model && result.answeredBy !== "kb-guard"
            ? { answeredBy: result.answeredBy, note: `answered by ${result.answeredBy}, so ${model} was not evaluated on this case` }
            : {}),
        },
      };
      emit({ type: "test-result", result: r });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  if (signal?.aborted) return;
  emit(stageEnd(counts.failed ? "failed" : counts.passed ? "passed" : "skipped", started, counts, `${CASES.length} cases × ${models.length} models against ${origin}`));
}

function stageEnd(status: "passed" | "failed" | "skipped", started: number, counts: Counts, note: string): ReadinessEvent {
  const now = Date.now();
  return { type: "stage-end", stage: "live-eval", status, durationMs: now - started, counts, source: "live", at: new Date(now).toISOString(), note };
}

async function askAndGrade(doFetch: typeof fetch, origin: string, model: string, c: GoldenCase, signal?: AbortSignal) {
  const t0 = Date.now();
  let answer: ReturnType<typeof readChatStream> = { text: "", done: null, error: null, sources: [], fallbacks: [] };
  try {
    const res = await doFetch(`${origin}/api/chat`, {
      method: "POST",
      cache: "no-store",
      signal,
      // Marked so it never becomes a Knowledge base issue, and so the dev surface applies the eval allowance.
      headers: { "content-type": "application/json", "x-nimbus-test-run": "readiness-eval" },
      body: JSON.stringify({ modelId: model, messages: [...(c.history ?? []), { role: "user", content: c.question }] }),
    });
    if (!res.ok) answer = { ...answer, error: res.status === 429 ? "rate limited (HTTP 429)" : `HTTP ${res.status}` };
    else answer = readChatStream((await res.text()).split("\n"));
  } catch (err) {
    answer = { ...answer, error: (err as Error)?.name === "AbortError" ? "stopped" : "network error" };
  }
  const graded = gradeAnswer(c, answer, golden.notInKbPattern, model);
  return {
    ...graded,
    ms: Date.now() - t0,
    answeredBy: answer.done?.answeredBy as string | undefined,
    usage: answer.done?.usage as { inputTokens: number; outputTokens: number } | undefined,
    costUSD: answer.done?.costUSD as number | undefined,
  };
}
