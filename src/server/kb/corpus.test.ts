import { describe, expect, it } from "vitest";
import { loadCorpus } from "./corpus";

const corpus = loadCorpus();
const byId = (id: string) => {
  const chunk = corpus.find((c) => c.id === id);
  if (!chunk) throw new Error(`missing chunk ${id}`);
  return chunk;
};

describe("corpus chunking", () => {
  it("loads all 10 documents", () => {
    expect(new Set(corpus.map((c) => c.file)).size).toBe(10);
  });

  // NKA-RET-012 — a table must never be separated from its header row.
  it("keeps every table together with its header row", () => {
    const tableChunks = corpus.filter((c) => c.text.includes("|"));
    expect(tableChunks.length).toBeGreaterThan(10);
    for (const chunk of tableChunks) {
      expect(chunk.text, chunk.id).toMatch(/\|\s*-{3,}/);
    }
  });

  it("prefixes chunks with document title, section and date", () => {
    const sla = byId("vault.md#support-sla");
    expect(sla.text.split("\n")[0]).toBe("Nimbus Vault — Support SLA (updated 2026-07-03)");
    expect(sla.product).toBe("vault");
    expect(sla.text).toContain("| P1 (service down) | 4 business hours | 1 hour | 30 minutes, 24x7 |");
  });

  it("splits release notes per version with the release date", () => {
    const r42 = byId("relay-release-notes.md#4-2-2026-06-10");
    expect(r42.version).toBe("4.2");
    expect(r42.docDate).toBe("2026-06-10");
    expect(r42.text).toContain("Request replay");
    expect(r42.text).not.toContain("Slack integration"); // that is 4.1
  });

  it("treats company-wide documents as product-less", () => {
    expect(byId("security-overview.md#identity").product).toBeNull();
    expect(byId("support-policy.md#business-hours").product).toBeNull();
  });
});
