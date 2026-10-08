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
  ])("adds no change hint where documents agree: %s", (_name, question) => {
    expect(comparisonHints(retrieve(question)).filter((h) => h.includes("Compare it value by value"))).toEqual([]);
  });

  it("C3: names an agreeing company-wide summary as confirmation, only for the products asked about (NKA-RET-017)", () => {
    expect(comparisonHints(retrieve("Does Pulse support SAML SSO?"))).toEqual([
      expect.stringMatching(/^\[\d\] security-overview\.md \(2026-01-15\) is a company-wide summary, .* change for Nimbus Pulse: read it as confirming \[\d\] pulse\.md/),
    ]);
    // Vault 3.1 records a change, so Vault gets the comparison hint and no confirmation; pulse.md, also retrieved, is off-topic.
    const vault = comparisonHints(retrieve("Which Vault tiers support SAML?"));
    expect(vault).toHaveLength(1);
    expect(vault[0]).toContain("records a change for Nimbus Vault");
    // A question naming no product confirms every agreeing product and still compares Vault.
    const all = comparisonHints(retrieve("Which of our products support SSO via SAML 2.0?"));
    expect(all.filter((h) => h.includes("read it as confirming")).map((h) => h.match(/change for (Nimbus \w+)/)?.[1])).toEqual([
      "Nimbus Relay",
      "Nimbus Pulse",
      "Nimbus Ledger",
    ]);
    expect(all.some((h) => h.includes("records a change for Nimbus Vault"))).toBe(true);
  });
});
