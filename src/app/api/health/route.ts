import "server-only";
import { catalog, isAvailable, isMockMode } from "@/server/config/models";
import { corpusSourceAsync, loadCorpusAsync } from "@/server/kb/corpus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Deploy smoke check: corpus loaded, which providers can answer. */
export async function GET(): Promise<Response> {
  const chunks = await loadCorpusAsync();
  const providers = [...new Set(catalog.models.filter((m) => isAvailable(m)).map((m) => m.provider))];
  return Response.json(
    {
      ok: chunks.length > 0 && providers.length > 0,
      mode: isMockMode() ? "mock" : "live",
      corpus: { files: new Set(chunks.map((c) => c.file)).size, chunks: chunks.length },
      corpusSource: await corpusSourceAsync(),
      providersAvailable: providers,
      pricingVersion: catalog.pricingVersion,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
