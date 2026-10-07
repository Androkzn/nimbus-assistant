export interface Rates {
  inputPerMTok: number;
  outputPerMTok: number;
  longPrompt?: { aboveInputTokens: number; inputPerMTok: number; outputPerMTok: number };
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** Estimated cost in USD from list prices (TRD §4.3). Uses the answering model's rates. */
export function costUSD(usage: Usage, rates: Rates): number {
  const tier = rates.longPrompt && usage.inputTokens > rates.longPrompt.aboveInputTokens ? rates.longPrompt : rates;
  return (usage.inputTokens * tier.inputPerMTok + usage.outputTokens * tier.outputPerMTok) / 1_000_000;
}

export function formatUSD(value: number): string {
  if (value === 0) return "$0.0000";
  return value < 0.01 ? `$${value.toFixed(5)}` : `$${value.toFixed(4)}`;
}
