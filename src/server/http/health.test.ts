import { describe, expect, it } from "vitest";
import type { ProviderId } from "@/server/config/models";
import { buildHealthPayload } from "./health";

const base = {
  mode: "live" as const,
  corpusFiles: 10,
  corpusChunks: 42,
  pricingVersion: "2026-10-01",
};

describe("deployment health payload", () => {
  it("reports a healthy deployment when fallback providers are configured", () => {
    const result = buildHealthPayload({ ...base, providersAvailable: ["anthropic", "google"] as ProviderId[] });

    expect(result).toMatchObject({ ok: true, status: "ok", providerCount: 2, fallbackReady: true });
    expect(result.providersAvailable).toEqual(["anthropic", "google"]);
  });

  it("keeps a single-provider deployment usable but marks fallback as degraded", () => {
    const result = buildHealthPayload({ ...base, providersAvailable: ["anthropic"] as ProviderId[] });

    expect(result).toMatchObject({ ok: true, status: "degraded", providerCount: 1, fallbackReady: false });
  });

  it.each([
    ["no providers", { ...base, providersAvailable: [] as ProviderId[] }],
    ["empty corpus", { ...base, corpusChunks: 0, providersAvailable: ["anthropic"] as ProviderId[] }],
  ])("reports down when %s", (_case, input) => {
    expect(buildHealthPayload(input)).toMatchObject({ ok: false, status: "down" });
  });
});
