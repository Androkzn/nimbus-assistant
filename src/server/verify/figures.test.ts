import { describe, expect, it } from "vitest";
import { unverifiedFigures } from "./figures";

const VAULT_SLA = "| P1 (service down) | 4 business hours | 1 hour | 30 minutes, 24x7 |";
const RELAY_PRICING = "| Price | $19 | $49 | Custom |\n| Included seats | 5 | 25 | Unlimited |\n| API rate limit | 1,000 req/min | 10,000 req/min | 100,000 req/min |";

describe("figure check (NKA-GRD-010)", () => {
  it("passes figures that appear in the passages, whatever their formatting", () => {
    expect(unverifiedFigures("Vault · Enterprise · P1: 30 minutes, 24x7 [1]", [VAULT_SLA])).toEqual([]);
    expect(unverifiedFigures("Pro: $49 per seat, 25 seats, 10,000 req/min [2].", [RELAY_PRICING])).toEqual([]);
  });

  it("flags an invented figure", () => {
    expect(unverifiedFigures("Vault Enterprise has a 99.9% uptime SLA [1].", [VAULT_SLA])).toEqual(["99.9"]);
    expect(unverifiedFigures("Relay Enterprise costs $499 per seat [2].", [RELAY_PRICING])).toEqual(["499"]);
  });

  it("flags a derived figure the documents never state", () => {
    expect(unverifiedFigures("25 seats at $49 is $1,225 a month.", [RELAY_PRICING])).toEqual(["1,225"]);
  });

  it("ignores citation markers and list numbering, and accepts numbers from the question", () => {
    const answer = "1. Check the token scope [1][3].\n2. Check the allowlist [1, 2].";
    expect(unverifiedFigures(answer, ["no numbers here"])).toEqual([]);
    expect(unverifiedFigures("Relay 4.2 added request replay [1].", ["What's new in v4.2?"])).toEqual([]);
  });
});
