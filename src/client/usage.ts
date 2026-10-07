/** One row per answered question — the session usage ledger (brief R4). */
export interface UsageRow {
  turn: number;
  timestamp: string;
  requestedModel: string;
  answeredBy: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

export interface UsageTotals {
  answers: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

export function totals(rows: UsageRow[]): UsageTotals {
  return rows.reduce(
    (t, r) => ({
      answers: t.answers + 1,
      inputTokens: t.inputTokens + r.inputTokens,
      outputTokens: t.outputTokens + r.outputTokens,
      costUSD: t.costUSD + r.costUSD,
    }),
    { answers: 0, inputTokens: 0, outputTokens: 0, costUSD: 0 },
  );
}

const COLUMNS: (keyof UsageRow)[] = ["turn", "timestamp", "requestedModel", "answeredBy", "inputTokens", "outputTokens", "costUSD"];

export function toCSV(rows: UsageRow[]): string {
  const escape = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [COLUMNS.join(","), ...rows.map((r) => COLUMNS.map((c) => escape(c === "costUSD" ? r.costUSD.toFixed(6) : r[c])).join(","))].join("\n") + "\n";
}

export function toJSON(rows: UsageRow[], pricingVersion: string): string {
  return JSON.stringify({ exportedAt: new Date().toISOString(), pricingVersion, totals: totals(rows), rows }, null, 2);
}
