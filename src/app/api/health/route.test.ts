import { afterEach, describe, expect, it } from "vitest";
import { GET } from "./route";

const originalMode = process.env.LLM_MODE;

afterEach(() => {
  if (originalMode === undefined) delete process.env.LLM_MODE;
  else process.env.LLM_MODE = originalMode;
});

describe("GET /api/health", () => {
  it("returns an operational, no-store smoke-check payload in mock mode", async () => {
    process.env.LLM_MODE = "mock";

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({
      ok: true,
      mode: "mock",
      providersAvailable: expect.arrayContaining(["anthropic", "google", "openai"]),
      corpusSource: { kind: expect.any(String) },
      pricingVersion: expect.any(String),
    });
    expect(body.corpus.files).toBe(10);
    expect(body.corpus.chunks).toBeGreaterThan(0);
    expect(body).not.toHaveProperty("apiKeys");
  });
});
