import { describe, expect, it } from "vitest";
import rawConfig from "../../../config/models.json";
import { costUSD } from "@/shared/cost";
import { attemptOrder, catalog, CatalogSchema } from "./models";

const clone = () => JSON.parse(JSON.stringify(rawConfig));

describe("model catalog (NKA-MDL-002)", () => {
  it("parses the shipped config", () => {
    expect(catalog.models.length).toBeGreaterThanOrEqual(3);
  });

  it.each([
    ["duplicate id", (c: typeof rawConfig) => c.models.push({ ...c.models[0] })],
    ["unknown fallback id", (c: typeof rawConfig) => c.fallbackOrder.push("nope")],
    ["model missing from fallback order", (c: typeof rawConfig) => c.fallbackOrder.pop()],
    ["unknown default", (c: typeof rawConfig) => (c.defaultModelId = "nope")],
    ["missing provider", (c: typeof rawConfig) => (c.models = c.models.filter((m) => m.provider !== "openai"))],
    ["negative price", (c: typeof rawConfig) => (c.models[0].pricing.inputPerMTok = -1)],
  ])("rejects a config with %s", (_name, mutate) => {
    const cfg = clone();
    mutate(cfg);
    expect(CatalogSchema.safeParse(cfg).success).toBe(false);
  });

  it("orders attempts: selected first, then fallback order, skipping unconfigured providers", () => {
    const env = { GOOGLE_GENERATIVE_AI_API_KEY: "x", ANTHROPIC_API_KEY: "y" };
    const ids = attemptOrder("claude-haiku", env).map((m) => m.id);
    expect(ids[0]).toBe("claude-haiku");
    expect(ids).not.toContain("openai-luna");
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("cost (NKA-USG-002)", () => {
  it("matches the TRD worked example: 2,000 in @ $1 + 300 out @ $5 = $0.0035", () => {
    expect(costUSD({ inputTokens: 2000, outputTokens: 300 }, { inputPerMTok: 1, outputPerMTok: 5 })).toBeCloseTo(0.0035, 10);
  });

  it("switches to long-prompt rates above the threshold", () => {
    const rates = { inputPerMTok: 0.1, outputPerMTok: 0.5, longPrompt: { aboveInputTokens: 100_000, inputPerMTok: 0.5, outputPerMTok: 2.5 } };
    expect(costUSD({ inputTokens: 100_000, outputTokens: 0 }, rates)).toBeCloseTo(0.01, 10);
    expect(costUSD({ inputTokens: 100_001, outputTokens: 0 }, rates)).toBeCloseTo(0.0500005, 10);
  });
});
