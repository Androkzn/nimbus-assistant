import { describe, expect, it } from "vitest";
import { retrieve } from "./retrieve";
import type { HistoryMessage } from "./query";

/**
 * Retrieval eval — the offline CI gate (TRD §9). Each case is taken from the discovery answer key
 * (docs/requirements/00_KB_Discovery.md §3). `all` = every id must be retrieved;
 * `anyOf` = at least one id of each group must be retrieved.
 */
interface Case {
  id: string;
  question: string;
  history?: HistoryMessage[];
  all?: string[];
  anyOf?: string[][];
  first?: string;
}

const cases: Case[] = [
  {
    id: "NKA-RET-001 Q5 SAML across all products (+ C1 conflict sources)",
    question: "Which of our products support SSO via SAML 2.0?",
    all: ["vault.md#pricing", "pulse.md#access-and-sign-in", "security-overview.md#identity", "vault-release-notes.md#3-1-2026-04-14"],
    anyOf: [
      ["relay.md#pricing", "relay.md#integrations"],
      ["ledger.md#features", "ledger.md#pricing"],
    ],
  },
  {
    id: "NKA-RET-003 E5 loose wording finds Ledger federated login",
    question: "does ledger do single sign-on?",
    anyOf: [["ledger.md#features", "ledger.md#pricing"]],
  },
  {
    id: "NKA-RET-004 Q6 P1 SLA with no product → every SLA table",
    question: "What's the SLA for Priority 1 support tickets?",
    all: ["relay.md#support-sla", "vault.md#support-sla", "pulse.md#support-sla", "ledger.md#support-sla"],
  },
  {
    id: "NKA-RET-009 Q3 Relay 4.2 release notes ranked first",
    question: "What new features were released in v4.2 of Relay?",
    first: "relay-release-notes.md#4-2-2026-06-10",
  },
  {
    id: "NKA-RET-010 Q4 403 troubleshooting for both documented products",
    question: "A client is getting a 403 on the API. What should they check first?",
    all: ["relay.md#troubleshooting", "pulse.md#troubleshooting"],
  },
  {
    id: "NKA-RET-007 Q2 Pulse Salesforce integration",
    question: "Does Pulse integrate with Salesforce? What version is required?",
    all: ["pulse.md#integrations"],
  },
  {
    id: "NKA-RET-008 Q2 Ledger Salesforce (roadmap only)",
    question: "Does Ledger integrate with Salesforce?",
    anyOf: [["ledger.md#integrations", "ledger-release-notes.md#2-6-2026-06-25"]],
  },
  {
    id: "NKA-CHAT-002 E1 follow-up inherits the product from history",
    question: "what about its SLA?",
    history: [
      { role: "user", content: "Does Pulse integrate with Salesforce?" },
      { role: "assistant", content: "Yes — Pulse 4.3 or later with Salesforce API v59 or later [1]." },
    ],
    first: "pulse.md#support-sla",
  },
  {
    id: "NKA-GRD-005 C1 Vault SAML tiers → both sides of the conflict",
    question: "Which Vault tiers support SAML?",
    all: ["vault.md#pricing", "vault-release-notes.md#3-1-2026-04-14", "security-overview.md#identity"],
  },
  {
    id: "NKA-GRD-006 C2 Relay Pro price → product doc and 4.2 price change",
    question: "How much is Relay Pro?",
    all: ["relay.md#pricing", "relay-release-notes.md#4-2-2026-06-10"],
  },
  {
    id: "NKA-RET-011 Q1 Pro vs Enterprise → every pricing table",
    question: "What are the key differences between the Pro and Enterprise pricing tiers?",
    all: ["relay.md#pricing", "vault.md#pricing", "pulse.md#pricing", "ledger.md#pricing"],
  },
];

describe("retrieval eval (golden cases)", () => {
  for (const c of cases) {
    it(c.id, () => {
      const result = retrieve(c.question, c.history);
      const ids = result.passages.map((p) => p.chunk.id);
      for (const id of c.all ?? []) expect(ids, `missing ${id}`).toContain(id);
      for (const group of c.anyOf ?? []) expect(group.some((id) => ids.includes(id)), `none of ${group.join(", ")}`).toBe(true);
      if (c.first) expect(ids[0]).toBe(c.first);
      expect(result.passages.length).toBeLessThanOrEqual(10);
      expect(result.noMatch).toBe(false);
    });
  }

  it("flags an off-corpus question as noMatch", () => {
    expect(retrieve("What's the weather in Paris tomorrow?").noMatch).toBe(true);
  });

  it("numbers passages 1..n in order", () => {
    const { passages } = retrieve("Relay pricing");
    expect(passages.map((p) => p.n)).toEqual(passages.map((_, i) => i + 1));
  });

  it("does not inherit a product for an explicit cross-product question", () => {
    const r = retrieve("Which of our products support SSO?", [{ role: "user", content: "Tell me about Vault" }]);
    expect(r.inheritedProducts).toBe(false);
  });
});
