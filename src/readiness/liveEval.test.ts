import { describe, expect, it } from "vitest";
import golden from "../../evals/golden-set.json";
import { runLiveEval } from "./liveEval";
import { ReadinessEventSchema, type ReadinessEvent } from "./schema";

const ORIGIN = "https://dev.example";
const ndjson = (events: object[]) => new Response(events.map((e) => JSON.stringify(e)).join("\n") + "\n", { status: 200 });

/** Two models; model-a answers itself, model-b is answered by a backup, and every third model-a question is rate limited. */
function fakeServer() {
  const headers: string[] = [];
  let asked = 0;
  const fetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/models")) return Response.json({ models: [{ id: "model-a", available: true }, { id: "model-b", available: true }, { id: "off", available: false }] });
    headers.push(new Headers(init?.headers).get("x-nimbus-test-run") ?? "");
    const { modelId } = JSON.parse(String(init?.body));
    if (modelId === "model-a" && ++asked % 3 === 0) return new Response("{}", { status: 429 });
    const answeredBy = modelId === "model-a" ? "model-a" : "backup";
    return ndjson([
      { type: "sources", passages: [{ n: 1 }] },
      { type: "delta", text: "I couldn't find this in the NimbusStack knowledge base." },
      { type: "done", answeredBy, usage: { inputTokens: 10, outputTokens: 5 }, costUSD: 0.0001, unverifiedFigures: [] },
    ]);
  }) as typeof globalThis.fetch;
  return { fetch, headers };
}

describe("live answer eval in the browser", () => {
  it("asks every golden question of every available model, graded like npm run eval:live, with the eval checks' ids", async () => {
    const server = fakeServer();
    const events: ReadinessEvent[] = [];
    await runLiveEval({ origin: ORIGIN, fetch: server.fetch, concurrency: 3 }, (e) => events.push(e));

    for (const e of events) expect(ReadinessEventSchema.safeParse(e).success, JSON.stringify(e)).toBe(true);
    const total = golden.cases.length * 2;
    expect(events[0]).toMatchObject({ type: "stage-start", stage: "live-eval" });
    expect(events).toContainEqual({ type: "stage-total", stage: "live-eval", total });
    const results = events.flatMap((e) => (e.type === "test-result" ? [e.result] : []));
    expect(results).toHaveLength(total);
    expect(new Set(results.map((r) => r.id)).size).toBe(total);
    expect(results.every((r) => /^eval::[A-Z]+-[A-Z]+-\d{3}::model-[ab]$/.test(r.id) && r.source === "live")).toBe(true);
    // A backup's answer does not evaluate the requested model: an otherwise passing answer is skipped, with the reason.
    const backup = results.filter((r) => r.id.endsWith("::model-b"));
    expect(backup.every((r) => r.detail?.answeredBy === "backup")).toBe(true);
    expect(backup.filter((r) => r.status !== "failed").every((r) => r.status === "skipped")).toBe(true);
    expect(backup.some((r) => r.status === "skipped")).toBe(true);
    // A rate-limited question fails with a plain reason; the eval is marked so the dev surface applies its allowance.
    expect(results.some((r) => r.status === "failed" && r.error?.includes("rate limited (HTTP 429)"))).toBe(true);
    expect(new Set(server.headers)).toEqual(new Set(["readiness-eval"]));
    expect(events.at(-1)).toMatchObject({ type: "stage-end", stage: "live-eval", status: "failed", source: "live" });
  });

  it("fails the stage plainly when the server offers no model", async () => {
    const events: ReadinessEvent[] = [];
    const fetch = (async () => Response.json({ models: [] })) as unknown as typeof globalThis.fetch;
    await runLiveEval({ origin: ORIGIN, fetch }, (e) => events.push(e));
    expect(events.at(-1)).toMatchObject({ type: "stage-end", status: "failed", note: "no model is available on this server" });
  });
});
