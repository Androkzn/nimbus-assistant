import type { Env } from "../config/models";
import type { GuardReason, RetrievalResult } from "../retrieval/retrieve";
import { createFindingReportAsync } from "../dev-portal/db";

export type FindingCategory = "out_of_scope" | "documentation_gap" | "clarification_needed";

export interface FindingRecord {
  schemaVersion: 1;
  observedAt: string;
  requestId: string;
  category: FindingCategory;
  reason: GuardReason;
  key: string;
  affectedProducts: string[];
  affectedArea: "answerability";
  severity: "low" | "medium";
  status: "new";
  proposedAction: string;
  /** User-visible evidence, normalized and capped before persistence. */
  question: string;
  analysis: string;
  evidence: {
    retrievalBestScore: number;
    retrievalFocusScore: number;
    passageCount: number;
    modelOutcome: string;
    unverifiedFigureCount: number;
    troubleshootingStatus: string | null;
  };
}

export type FindingSink = (record: FindingRecord, env: Env) => Promise<void>;

export function findingCategory(reason: GuardReason): FindingCategory {
  if (reason === "out_of_scope") return "out_of_scope";
  if (reason === "incomplete" || reason === "ambiguous_release") return "clarification_needed";
  return "documentation_gap";
}

function proposedAction(category: FindingCategory, reason: GuardReason): string {
  if (category === "out_of_scope") return "Track as an out-of-scope usage statistic; do not add unsupported content to the knowledge base.";
  if (category === "clarification_needed") return "Review the user journey and add clearer product/topic guidance; do not change the knowledge base until the intended scope is confirmed.";
  if (reason === "unsupported_troubleshooting_status") return "Review approved troubleshooting material for this HTTP status and add a grounded checklist if the product team confirms it.";
  if (reason === "unsupported_pricing_tier") return "Review the approved pricing terminology and add a documented tier only after product confirmation.";
  if (reason === "unsupported_priority") return "Review the approved support-priority matrix and document the missing priority only after confirmation.";
  return "Review the affected product/topic and add an approved knowledge-base section if the missing evidence is confirmed.";
}

function stableKey(retrieval: RetrievalResult, category: FindingCategory): string {
  const products = [...retrieval.products].sort().join(",") || "none";
  const status = retrieval.troubleshootingStatus ?? "none";
  return [category, retrieval.guardReason ?? "unknown", products, status].join("|");
}

function findingAnalysis(retrieval: RetrievalResult): string {
  const status = retrieval.troubleshootingStatus;
  if (retrieval.guardReason === "unsupported_troubleshooting_status" && status) {
    return `The question asks about HTTP ${status}, but the published troubleshooting documents cover HTTP 403 and 429 only. No approved checklist for HTTP ${status} was found, so the assistant refused to invent one.`;
  }
  if (retrieval.guardReason === "unsupported_pricing_tier") return "The question uses a pricing tier name that does not appear in the published pricing tables, so the assistant could not safely map it to a documented tier.";
  if (retrieval.guardReason === "ambiguous_release") return "The question gives only a major release version. The knowledge base requires an exact product release before it can answer reliably.";
  if (retrieval.guardReason === "unsupported_priority") return "The question uses an SLA priority outside the documented P1–P4 range, so the assistant could not provide a supported response.";
  if (retrieval.unknownProduct) return "The request names a product that does not appear in the published NimbusStack knowledge base, so the assistant did not invent a Salesforce integration.";
  if (retrieval.guardReason === "out_of_scope") return "No published passage matched this request and no NimbusStack product was in scope, so the assistant returned the knowledge-base fallback without calling a model.";
  if (retrieval.guardReason === "incomplete") return "A product was named without a topic, so the assistant asked for clarification instead of inventing an answer.";
  return "The retrieved passages did not provide enough approved evidence to answer this question without speculation.";
}

export function buildFinding(input: {
  requestId: string;
  observedAt: string;
  retrieval: RetrievalResult;
  modelOutcome: string;
  unverifiedFigureCount: number;
  question: string;
}): FindingRecord | null {
  const reason = input.retrieval.guardReason;
  if (!reason) return null;
  const category = findingCategory(reason);
  return {
    schemaVersion: 1,
    observedAt: input.observedAt,
    requestId: input.requestId,
    category,
    reason,
    key: stableKey(input.retrieval, category),
    affectedProducts: [...input.retrieval.products].sort(),
    affectedArea: "answerability",
    severity: category === "documentation_gap" ? "medium" : "low",
    status: "new",
    proposedAction: proposedAction(category, reason),
    // Keep irrelevant/off-topic usage privacy-safe; retain evidence for actionable findings.
    question: category === "out_of_scope" && !input.retrieval.unknownProduct ? "" : input.question.trim().replace(/\s+/g, " ").slice(0, 2000),
    analysis: findingAnalysis(input.retrieval),
    evidence: {
      retrievalBestScore: input.retrieval.retrievalBestScore,
      retrievalFocusScore: input.retrieval.retrievalFocusScore,
      passageCount: input.retrieval.passages.length,
      modelOutcome: input.modelOutcome,
      unverifiedFigureCount: input.unverifiedFigureCount,
      troubleshootingStatus: input.retrieval.troubleshootingStatus,
    },
  };
}

export async function persistFinding(finding: FindingRecord, env: Env): Promise<void> {
  void env;
  await createFindingReportAsync({
    key: finding.key,
    observedAt: finding.observedAt,
    category: finding.category,
    severity: finding.severity,
    proposedAction: finding.proposedAction,
    question: finding.question,
    analysis: finding.analysis,
    evidence: finding.evidence,
  });
}
