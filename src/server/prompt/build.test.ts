import { describe, expect, it } from "vitest";
import { retrieve } from "../retrieval/retrieve";
import { comparisonHints } from "./build";

describe("comparison hints (rule 4 support, brief E4)", () => {
  it("C1: quotes Vault 3.1's change and points at the product doc and the older company summary", () => {
    const [hint] = comparisonHints(retrieve("Which Vault tiers support SAML?"));
    expect(hint).toContain("vault-release-notes.md (2026-04-14) records a change for Nimbus Vault");
    expect(hint).toContain("previously Enterprise only");
    expect(hint).toContain("vault.md (2026-07-03)");
    expect(hint).toContain("security-overview.md (2026-01-15)");
  });

  it("C2: quotes Relay 4.2's price change and points at relay.md", () => {
    const hint = comparisonHints(retrieve("How much is Relay Pro?")).find((h) => h.includes("Nimbus Relay"));
    expect(hint).toContain("$59 per seat per month");
    expect(hint).toContain("relay.md");
  });

  it.each([
    ["Q6 SLA table lookup", "What's the SLA for Priority 1 support tickets?"],
    ["Ledger SSO (summary and doc agree)", "does ledger do single sign-on?"],
    ["Pulse Salesforce (doc and 4.3 notes agree)", "Does Pulse integrate with Salesforce? What version is required?"],
    ["Pulse SAML (a Fixed note says 'changed workspace': a bug, not a changed fact)", "Does Pulse support SAML SSO?"],
  ])("adds no hint where documents agree: %s", (_name, question) => {
    expect(comparisonHints(retrieve(question))).toEqual([]);
  });
});
