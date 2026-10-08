import { z } from "zod";

/**
 * Readiness report — shared contract (docs/requirements/06_Readiness_Report.md §4).
 * Producers: scripts/readiness/run.mjs (local gates), src/readiness/probes.ts (live probes in the browser),
 * src/readiness/replay.ts (recorded runs). Consumer: the /readiness page.
 * Showcase-only: nothing in the chat path imports from src/readiness (spec §2, I1).
 */

export const STAGE_IDS = ["typecheck", "lint", "unit", "build", "bundle-scan", "e2e", "live-eval", "probes"] as const;
export const StageIdSchema = z.enum(STAGE_IDS);
export type StageId = z.infer<typeof StageIdSchema>;

export const StatusSchema = z.enum(["pending", "running", "passed", "failed", "skipped"]);
export type Status = z.infer<typeof StatusSchema>;

/** Run now, or read from a committed report. Recorded evidence is never relabelled as live (spec I7). */
export const SourceSchema = z.enum(["live", "recorded"]);
export type Source = z.infer<typeof SourceSchema>;

export const LayerSchema = z.enum(["static", "unit", "integration", "retrieval-eval", "contract", "e2e", "security", "live-eval", "live-probe"]);
export type Layer = z.infer<typeof LayerSchema>;

export const RunMetaSchema = z.object({
  /** Timestamp id, e.g. "2026-10-07-21-30-00". */
  runId: z.string(),
  mode: z.enum(["local", "replay", "probes"]),
  startedAt: z.string(),
  /** "node v22.15.0 · darwin arm64", or a browser summary for probe-only runs. */
  platform: z.string(),
  /** "local working tree", or the origin probed. */
  environment: z.string(),
  /** Git short SHA, with "+dirty" when the working tree has uncommitted changes. */
  build: z.string(),
  branch: z.string().optional(),
  goldenVersion: z.string().optional(),
  pricingVersion: z.string().optional(),
  corpusHash: z.string().optional(),
  promptHash: z.string().optional(),
});
export type RunMeta = z.infer<typeof RunMetaSchema>;

export const StageInfoSchema = z.object({
  id: StageIdSchema,
  title: z.string(),
  command: z.string().optional(),
  layer: LayerSchema,
  description: z.string(),
});
export type StageInfo = z.infer<typeof StageInfoSchema>;

const Iso = z.string();
const DetailSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

export const TestResultSchema = z.object({
  /** Stable key — see spec §4 table. */
  id: z.string(),
  stage: StageIdSchema,
  file: z.string(),
  /** Describe chain + title joined with " › " (gates/probes: their title). */
  fullName: z.string(),
  status: z.enum(["passed", "failed", "skipped"]),
  durationMs: z.number().nonnegative(),
  source: SourceSchema,
  /** Short failure reason: redacted, ≤ 500 chars, never app message text or env values. */
  error: z.string().max(500).optional(),
  /** Extra evidence for the report, e.g. { model, ttftMs, costUSD, reportPath }. */
  detail: DetailSchema.optional(),
});
export type TestResult = z.infer<typeof TestResultSchema>;

export const CountsSchema = z.object({
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type Counts = z.infer<typeof CountsSchema>;

export const ReadinessEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run-start"), meta: RunMetaSchema, stages: z.array(StageInfoSchema) }),
  z.object({ type: z.literal("stage-start"), stage: StageIdSchema, at: Iso }),
  /** Optional: lets the page show a test as running before its result arrives. */
  z.object({ type: z.literal("test-start"), stage: StageIdSchema, id: z.string(), file: z.string(), fullName: z.string() }),
  z.object({ type: z.literal("test-result"), result: TestResultSchema }),
  /** Optional, sparse, redacted, ≤ 300 chars. */
  z.object({ type: z.literal("log"), stage: StageIdSchema, line: z.string().max(300) }),
  z.object({
    type: z.literal("stage-end"),
    stage: StageIdSchema,
    status: StatusSchema,
    durationMs: z.number().nonnegative(),
    counts: CountsSchema,
    source: SourceSchema,
    at: Iso,
    /** e.g. "recorded 2026-10-07 20:41 UTC · build 091ba66" or why a stage was skipped. */
    note: z.string().optional(),
  }),
  z.object({ type: z.literal("run-end"), status: z.enum(["passed", "failed"]), durationMs: z.number().nonnegative(), at: Iso }),
]);
export type ReadinessEvent = z.infer<typeof ReadinessEventSchema>;

/** Canonical stage descriptions — producers send these in run-start; the page falls back to them. */
export const STAGE_INFO: Record<StageId, StageInfo> = {
  typecheck: {
    id: "typecheck",
    title: "Typecheck",
    command: "npm run typecheck",
    layer: "static",
    description: "TypeScript strict across server, browser and the shared wire contract, with route types generated first as on a fresh clone.",
  },
  lint: { id: "lint", title: "Lint", command: "npm run lint", layer: "static", description: "ESLint with the React hooks and purity rules." },
  unit: {
    id: "unit",
    title: "Unit · integration · retrieval eval",
    command: "npm test",
    layer: "unit",
    description: "Vitest: pure logic, the /api/chat handler driven by mock models, the wire contract, and the offline retrieval eval.",
  },
  build: { id: "build", title: "Production build", command: "next build", layer: "static", description: "The app compiles for production exactly as it is deployed." },
  "bundle-scan": {
    id: "bundle-scan",
    title: "Client bundle secret scan",
    command: "npm run scan:bundle",
    layer: "security",
    description: "Every JavaScript file a browser can download is scanned for API-key patterns and for the real key values.",
  },
  e2e: {
    id: "e2e",
    title: "Browser E2E",
    command: "npm run e2e",
    layer: "e2e",
    description: "Playwright drives the production build with the deterministic mock model: streaming, sources, fallback, usage, export.",
  },
  "live-eval": {
    id: "live-eval",
    title: "Live answer eval",
    command: "npm run eval:live",
    layer: "live-eval",
    description: "Golden questions answered by the real providers and graded by deterministic checks. Shown from the latest committed report; re-run on demand because it spends real tokens.",
  },
  probes: {
    id: "probes",
    title: "Live probes",
    command: "this browser → the running app",
    layer: "live-probe",
    description: "Requests sent from this page to the running app right now: health, model catalog, input validation, off-topic guard, stream headers, served-JS key scan, and optionally one real grounded answer.",
  },
};

export const PROBE_IDS = ["health", "models", "blank", "oversize", "unknown-model", "offtopic-guard", "stream-headers", "bundle-keys", "grounded-answer"] as const;
export type ProbeId = (typeof PROBE_IDS)[number];

/** Parse one NDJSON line; throws on a line that breaks the contract. */
export function parseEvent(line: string): ReadinessEvent {
  return ReadinessEventSchema.parse(JSON.parse(line));
}
