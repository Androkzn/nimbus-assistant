import { describe, expect, it } from "vitest";
import { contextLevel, estimateTokens } from "./context";

describe("context meter (NKA-USG-004)", () => {
  it.each([
    [7499, "ok"],
    [7500, "amber"],
    [8999, "amber"],
    [9000, "red"],
    [12000, "red"],
  ])("%i of 10,000 tokens → %s", (used, level) => {
    expect(contextLevel(used, 10_000)).toBe(level);
  });

  it("E7: the same conversation is re-rated against a smaller window immediately", () => {
    const used = 80_000;
    expect(contextLevel(used, 1_000_000)).toBe("ok");
    expect(contextLevel(used, 100_000)).toBe("amber");
  });

  it("estimates ~4 characters per token", () => {
    expect(estimateTokens("abcd".repeat(10))).toBe(10);
  });
});
