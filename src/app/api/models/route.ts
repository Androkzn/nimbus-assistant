import "server-only";
import { catalog, isAvailable } from "@/server/config/models";
import type { ModelsResponse } from "@/shared/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public view of config/models.json. Availability reflects which provider keys are set — never the keys. */
export function GET(): Response {
  const body: ModelsResponse = {
    defaultModelId: catalog.defaultModelId,
    pricingVersion: catalog.pricingVersion,
    models: catalog.models.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      providerName: m.providerName,
      description: m.description,
      contextWindow: m.contextWindow,
      pricing: { inputPerMTok: m.pricing.inputPerMTok, outputPerMTok: m.pricing.outputPerMTok },
      available: isAvailable(m),
    })),
  };
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
