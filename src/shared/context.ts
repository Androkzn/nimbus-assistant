export type ContextLevel = "ok" | "amber" | "red";

export const AMBER_AT = 0.75;
export const RED_AT = 0.9;

/** Rough token estimate (≈ 4 characters per token) for text not yet measured by a provider. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Context-window warning level (brief R4: amber at 75%, red at 90%). */
export function contextLevel(usedTokens: number, contextWindow: number): ContextLevel {
  const ratio = usedTokens / contextWindow;
  if (ratio >= RED_AT) return "red";
  if (ratio >= AMBER_AT) return "amber";
  return "ok";
}
