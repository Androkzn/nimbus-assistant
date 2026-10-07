import { describe, expect, it } from "vitest";
import { toCSV, toJSON, totals, type UsageRow } from "./usage";

const rows: UsageRow[] = [
  { turn: 1, timestamp: "2026-10-07T12:00:00Z", requestedModel: "gemini-flash", answeredBy: "gemini-flash", inputTokens: 1200, outputTokens: 200, costUSD: 0.0036 },
  { turn: 2, timestamp: "2026-10-07T12:01:00Z", requestedModel: "claude-haiku", answeredBy: "gemini-flash", inputTokens: 1500, outputTokens: 100, costUSD: 0.00315 },
];

describe("session usage (NKA-USG-003 / NKA-USG-006)", () => {
  it("totals equal the sum of the per-answer rows", () => {
    expect(totals(rows)).toEqual({ answers: 2, inputTokens: 2700, outputTokens: 300, costUSD: 0.0036 + 0.00315 });
  });

  it("exports CSV with a header and one row per answer", () => {
    const lines = toCSV(rows).trim().split("\n");
    expect(lines[0]).toBe("turn,timestamp,requestedModel,answeredBy,inputTokens,outputTokens,costUSD");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("2,2026-10-07T12:01:00Z,claude-haiku,gemini-flash,1500,100,0.003150");
  });

  it("exports JSON with rows, totals and the pricing version", () => {
    const parsed = JSON.parse(toJSON(rows, "2026-10-07"));
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.totals.inputTokens).toBe(2700);
    expect(parsed.pricingVersion).toBe("2026-10-07");
  });
});
