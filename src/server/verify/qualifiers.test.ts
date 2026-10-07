import { describe, expect, it } from "vitest";
import { slaQualifier } from "./qualifiers";

const SLA = { n: 1, text: "Nimbus Vault — Support SLA (updated 2026-07-03)\nResponse time to first human reply.\n\n| P1 (service down) | 4 business hours | 1 hour | 30 minutes, 24x7 |" };
const PRICING = { n: 2, text: "Nimbus Vault — Pricing\n| Price | $12 | $35 | Custom |" };

describe("SLA qualifier (NKA-GRD-012)", () => {
  it("adds the documents' definition when an SLA answer omits it", () => {
    expect(slaQualifier("Vault · Enterprise · P1: 30 minutes, 24x7 [1]", [SLA, PRICING])).toBe(
      "\n\n_SLA times are the response time to the first human reply, not a resolution time [1]._",
    );
  });

  it("adds nothing when the answer already says what the times measure", () => {
    expect(slaQualifier("P1 first human reply within 30 minutes, 24x7 [1]", [SLA])).toBeNull();
  });

  it("adds nothing when no SLA table is cited", () => {
    expect(slaQualifier("Vault Pro is $35 per seat [2]", [SLA, PRICING])).toBeNull();
    expect(slaQualifier("I couldn't find this in the NimbusStack knowledge base.", [SLA])).toBeNull();
  });
});
