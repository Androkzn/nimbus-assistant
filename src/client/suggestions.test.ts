import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALL_SUGGESTIONS, FOLLOW_UP_SLA, nextQuestions, STARTERS } from "./suggestions";

const golden = JSON.parse(readFileSync("evals/golden-set.json", "utf8")) as { cases: { id: string; brief: string; question: string }[] };
const normalize = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const qs = (list: { q: string }[]) => list.map((s) => s.q);

describe("suggestion bubbles (NKA-CHAT-007, BR-27)", () => {
  it.each(ALL_SUGGESTIONS.map((s) => [s.req, s.q]))("%s bubble %j has a golden-set case for the same brief item", (req, q) => {
    const match = golden.cases.find((c) => normalize(c.question) === normalize(q));
    expect(match, `no golden case for "${q}"`).toBeDefined();
    expect(match!.brief.split("/")).toContain(req);
  });

  it("covers every representative question type and the edge cases a bubble can show", () => {
    const covered = new Set(ALL_SUGGESTIONS.map((s) => s.req));
    for (const req of ["Q1", "Q2", "Q3", "Q4", "E1", "E2", "E4", "E5", "E6"]) expect(covered, req).toContain(req);
  });

  it("offers one starter per product before anything is asked, none repeating the six examples", () => {
    const starters = nextQuestions({ asked: [] });
    expect(starters).toEqual(STARTERS);
    for (const p of ["Relay", "Vault", "Pulse", "Ledger"]) expect(qs(starters).some((q) => q.includes(p))).toBe(true);
    const examples = readFileSync("src/components/EmptyState.tsx", "utf8");
    for (const s of starters) expect(examples).not.toContain(s.q);
  });

  it("E1: after a single-product answer, the first bubble is the follow-up without the product name", () => {
    const asked = ["Which Vault tiers support SAML?"];
    const next = nextQuestions({ asked, lastQuestion: asked[0], lastAnswer: "Pro and Enterprise [1]" });
    expect(next[0]).toEqual(FOLLOW_UP_SLA);
    expect(qs(next).slice(1).every((q) => q.includes("Vault"))).toBe(true);
    expect(qs(next)).not.toContain(asked[0]);
  });

  it("does not offer the SLA follow-up after an SLA question", () => {
    const asked = ["What is the Relay Enterprise P1 SLA?"];
    expect(qs(nextQuestions({ asked, lastQuestion: asked[0] }))).not.toContain(FOLLOW_UP_SLA.q);
  });

  it("uses the products in the answer when the question names none, alternating between them", () => {
    const next = nextQuestions({
      asked: ["What's the P1 SLA?"],
      lastQuestion: "What's the P1 SLA?",
      lastAnswer: "Relay Enterprise: 15 minutes [1]. Ledger Enterprise: 30 minutes [2].",
    });
    expect(next[0].q).toContain("Relay");
    expect(next[1].q).toContain("Ledger");
  });

  it("matches asked questions regardless of case and punctuation", () => {
    expect(qs(nextQuestions({ asked: ["how much is relay pro"], lastQuestion: "how much is relay pro" }))).not.toContain("How much is Relay Pro?");
  });

  it("falls back to the starters when the conversation names no product", () => {
    const next = nextQuestions({ asked: ["hi"], lastQuestion: "hi", lastAnswer: "I couldn't find this in the NimbusStack knowledge base." });
    expect(next).toEqual(STARTERS.slice(0, 3));
  });
});
