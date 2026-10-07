import { z } from "zod";
import rawConfig from "../../../config/models.json";

const RatesSchema = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
});

const ModelSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  provider: z.enum(["anthropic", "openai", "google"]),
  vendorModelId: z.string().min(1),
  displayName: z.string().min(1),
  providerName: z.string().min(1),
  description: z.string().min(1).max(80),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  pricing: RatesSchema.extend({
    /** Higher rates once the prompt exceeds a size (e.g. Claude Haiku 5.5 above 100k tokens). */
    longPrompt: RatesSchema.extend({ aboveInputTokens: z.number().int().positive() }).optional(),
  }),
  providerOptions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

export const CatalogSchema = z
  .object({
    pricingVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    pricingSources: z.record(z.string(), z.string().url()),
    defaultModelId: z.string(),
    fallbackOrder: z.array(z.string()).min(1),
    models: z.array(ModelSchema).min(1),
  })
  .superRefine((cfg, ctx) => {
    const ids = cfg.models.map((m) => m.id);
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (new Set(ids).size !== ids.length) issue("model ids must be unique");
    if (!ids.includes(cfg.defaultModelId)) issue(`defaultModelId "${cfg.defaultModelId}" is not a model`);
    for (const id of cfg.fallbackOrder) if (!ids.includes(id)) issue(`fallbackOrder entry "${id}" is not a model`);
    for (const id of ids) if (!cfg.fallbackOrder.includes(id)) issue(`model "${id}" is missing from fallbackOrder`);
    for (const p of ["anthropic", "openai", "google"] as const) {
      if (!cfg.models.some((m) => m.provider === p)) issue(`no model for provider "${p}" (brief R3 requires all three)`);
    }
    for (const m of cfg.models) {
      if (m.maxOutputTokens >= m.contextWindow) issue(`${m.id}: maxOutputTokens must be below contextWindow`);
    }
  });

export type Catalog = z.infer<typeof CatalogSchema>;
export type ModelEntry = Catalog["models"][number];
export type ProviderId = ModelEntry["provider"];

/** Parsed at module load: a broken config fails the build and every test, not a user request. */
export const catalog: Catalog = CatalogSchema.parse(rawConfig);

/** Environment variables as a plain map — `process.env` in production, a literal in tests. */
export type Env = Record<string, string | undefined>;

export const PROVIDER_KEY_ENV: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

export function getModel(id: string): ModelEntry | undefined {
  return catalog.models.find((m) => m.id === id);
}

export function isMockMode(env: Env = process.env): boolean {
  return env.LLM_MODE === "mock";
}

/** A model can answer if its provider key is configured (or the app runs with the mock LLM). */
export function isAvailable(model: ModelEntry, env: Env = process.env): boolean {
  return isMockMode(env) || Boolean(env[PROVIDER_KEY_ENV[model.provider]]?.trim());
}

/** Attempt order for a request: the selected model, then the configured fallback order. */
export function attemptOrder(selectedId: string, env: Env = process.env): ModelEntry[] {
  const ids = [selectedId, ...catalog.fallbackOrder.filter((id) => id !== selectedId)];
  return ids.map((id) => getModel(id)).filter((m): m is ModelEntry => Boolean(m && isAvailable(m, env)));
}
