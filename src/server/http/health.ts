import type { ProviderId } from "@/server/config/models";

export type HealthStatus = "ok" | "degraded" | "down";

export interface HealthInput {
  mode: "mock" | "live";
  corpusFiles: number;
  corpusChunks: number;
  providersAvailable: ProviderId[];
  pricingVersion: string;
}

/** Build the public deploy-smoke payload without exposing provider credentials. */
export function buildHealthPayload(input: HealthInput) {
  const corpusReady = input.corpusFiles > 0 && input.corpusChunks > 0;
  const providerCount = input.providersAvailable.length;
  const status: HealthStatus =
    !corpusReady || providerCount === 0 ? "down" : providerCount === 1 ? "degraded" : "ok";

  return {
    ok: status !== "down",
    status,
    mode: input.mode,
    corpus: { files: input.corpusFiles, chunks: input.corpusChunks },
    providersAvailable: input.providersAvailable,
    providerCount,
    fallbackReady: providerCount > 1,
    pricingVersion: input.pricingVersion,
  };
}
