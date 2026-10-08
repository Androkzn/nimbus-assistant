import { NextResponse } from "next/server";
import { createQuestionReportAsync, devPortalEnabled, likelyKnowledgeGap } from "@/server/dev-portal/db";
import { retrieveAsync } from "@/server/retrieval/retrieve";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!devPortalEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { question?: unknown } | null;
  const report = body && typeof body.question === "string" ? await createQuestionReportAsync({ question: body.question, category: likelyKnowledgeGap(body.question) ? "knowledge-gap" : "irrelevant", analysis: await analyzeGap(body.question) }) : null;
  if (!report) return NextResponse.json({ error: "This question is not an eligible knowledge-base gap." }, { status: 400 });
  return NextResponse.json(report, { status: 201 });
}

async function analyzeGap(question: string): Promise<string> {
  const result = await retrieveAsync(question);
  const status = question.match(/\b([1-5]\d{2})\b/)?.[1];
  if (result.unsupportedTroubleshootingStatus && status) return `The question asks about HTTP ${status}, but the published troubleshooting documents cover HTTP 403 and 429 only. No approved checklist for HTTP ${status} was found, so the assistant refused to invent one.`;
  if (result.unsupportedPricingTier) return "The question uses a pricing tier name that does not appear in the published pricing tables, so the assistant could not safely map it to a documented tier.";
  if (result.ambiguousReleaseVersion) return "The question gives only a major release version. The knowledge base requires an exact product release such as 4.2 before it can answer reliably.";
  if (result.unsupportedPriority) return "The question uses an SLA priority outside the documented P1–P4 range, so the assistant could not provide a supported response.";
  if (result.noMatch) return "No published passage matched the question strongly enough to support a grounded answer. The assistant therefore returned the knowledge-base fallback instead of guessing.";
  return "The retrieved passages did not provide enough approved evidence to answer this question without speculation.";
}
