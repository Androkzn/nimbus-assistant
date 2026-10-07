import "server-only";
import { catalog, isAvailable, isMockMode } from "@/server/config/models";
import { loadCorpus } from "@/server/kb/corpus";
import { buildHealthPayload } from "@/server/http/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Deploy smoke check: corpus loaded, which providers can answer. */
export function GET(): Response {
  const chunks = loadCorpus();
  const providers = [...new Set(catalog.models.filter((m) => isAvailable(m)).map((m) => m.provider))];
  return Response.json(buildHealthPayload({
    mode: isMockMode() ? "mock" : "live",
    corpusFiles: new Set(chunks.map((c) => c.file)).size,
    corpusChunks: chunks.length,
    providersAvailable: providers,
    pricingVersion: catalog.pricingVersion,
  }), { headers: { "cache-control": "no-store" } });
}
