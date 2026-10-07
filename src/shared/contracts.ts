import { z } from "zod";

/**
 * Wire contract between browser and server (TRD §5). Both sides import these schemas, and the
 * integration tests validate every emitted event against them (contract test).
 */

export const MAX_MESSAGE_CHARS = 2000;
export const MAX_MESSAGES = 40;
/** `answeredBy` when the off-topic guard answered without calling any model (no tokens, no cost). */
export const KB_GUARD_ID = "kb-guard";
/** Prior messages the server forwards to the model (retrieval runs fresh every turn). The UI's context meter counts the same window. */
export const HISTORY_MESSAGES = 12;

export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(20_000),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatRequestSchema = z
  .object({
    modelId: z.string().min(1),
    messages: z.array(ChatMessageSchema).min(1).max(MAX_MESSAGES),
  })
  .superRefine((req, ctx) => {
    const last = req.messages[req.messages.length - 1];
    if (last.role !== "user") {
      ctx.addIssue({ code: "custom", message: "The last message must be from the user." });
    } else if (last.content.trim().length === 0) {
      ctx.addIssue({ code: "custom", message: "Please type a question first." });
    } else if (last.content.length > MAX_MESSAGE_CHARS) {
      ctx.addIssue({ code: "custom", message: `Questions are limited to ${MAX_MESSAGE_CHARS} characters.` });
    }
  });
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ErrorCodeSchema = z.enum(["rate_limited", "auth", "unavailable", "bad_request", "invalid_input"]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const PassageSchema = z.object({
  n: z.number().int().positive(),
  file: z.string(),
  section: z.string(),
  docDate: z.string().nullable(),
  text: z.string(),
});
export type PassageDTO = z.infer<typeof PassageSchema>;

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

export const StreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("meta"), requestId: z.string(), requestedModel: z.string() }),
  z.object({ type: z.literal("sources"), passages: z.array(PassageSchema) }),
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({ type: z.literal("fallback"), from: z.string(), to: z.string(), reason: ErrorCodeSchema }),
  z.object({ type: z.literal("reset"), reason: ErrorCodeSchema }),
  z.object({
    type: z.literal("done"),
    answeredBy: z.string(),
    requestedModel: z.string(),
    usage: UsageSchema,
    costUSD: z.number().nonnegative(),
    pricingVersion: z.string(),
    /** Figures in the answer found in no passage (figure check, TRD §4.6). Empty = all figures sourced. */
    unverifiedFigures: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("error"),
    code: ErrorCodeSchema,
    message: z.string(),
    retryAfterSec: z.number().int().positive().optional(),
  }),
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;

/** Public model catalog served by GET /api/models — no vendor secrets. */
export interface PublicModel {
  id: string;
  displayName: string;
  providerName: string;
  description: string;
  contextWindow: number;
  pricing: { inputPerMTok: number; outputPerMTok: number };
  available: boolean;
}
export interface ModelsResponse {
  defaultModelId: string;
  pricingVersion: string;
  models: PublicModel[];
}
