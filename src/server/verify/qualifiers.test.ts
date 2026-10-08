import { describe, expect, it } from "vitest";
import { slaQualifier, sourceLine } from "./qualifiers";

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

const RELAY_SLA = {
  n: 1,
  text: "Nimbus Relay — Support SLA (updated 2026-06-12)\nResponse time to first human reply.\n\n| Priority | Starter | Pro | Enterprise |\n|---|---|---|---|\n| P1 (service down) | 8 business hours | 2 hours | 15 minutes, 24x7 |\n| P4 (feature request) | Best effort | Best effort | 5 business days |",
};
const PULSE_SLA = {
  n: 2,
  text: "Nimbus Pulse — Support SLA (updated 2026-08-22)\n\n| Priority | Growth | Pro | Enterprise |\n|---|---|---|---|\n| P1 (service down) | Next business day | 4 hours | 1 hour, 24x7 |\n| P4 (feature request) | Best effort | Best effort | 5 business days |",
};
// gemini-flash-lite's live answer to NKA-RET-013: Relay's table under a plain heading, no [n] anywhere.
const UNCITED_TABLE =
  "Nimbus Relay — Support SLA (updated 2026-06-12), response time to first human reply:\n\n| Priority | Starter | Pro | Enterprise |\n|---|---|---|---|\n| P1 (service down) | 8 business hours | 2 hours | 15 minutes, 24x7 |\n| P4 (feature request) | Best effort | Best effort | 5 business days |";

describe("source line (rule 5, NKA-RET-013)", () => {
  it("adds a source line when an answer copies a passage without citing it", () => {
    // The P4 row is in both tables; Relay's passage already covers it, so Pulse is not credited.
    expect(sourceLine(UNCITED_TABLE, [RELAY_SLA, PULSE_SLA])).toBe("\n\n_Source: [1]._");
    expect(sourceLine(`${UNCITED_TABLE}\n\n|P1 (service down)|Next business day|4 hours|1 hour, 24x7|`, [PULSE_SLA, RELAY_SLA])).toBe("\n\n_Source: [1] [2]._");
  });

  it("adds no source line when the answer cites a passage or copied nothing", () => {
    expect(sourceLine(`${UNCITED_TABLE} [1]`, [RELAY_SLA])).toBeNull();
    expect(sourceLine("I couldn't find this in the NimbusStack knowledge base.", [RELAY_SLA])).toBeNull();
    expect(sourceLine("Relay answers P1 tickets within 15 minutes on Enterprise.", [RELAY_SLA])).toBeNull();
  });
});
