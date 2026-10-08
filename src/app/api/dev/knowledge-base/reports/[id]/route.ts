import { NextResponse } from "next/server";
import { devPortalEnabled, updateReportAsync } from "@/server/dev-portal/db";
import type { KnowledgeReportCategory, KnowledgeReportSeverity, KnowledgeReportStatus } from "@/shared/knowledgeBase";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!devPortalEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { status?: unknown; severity?: unknown; category?: unknown; product?: unknown } | null;
  const report = body
    ? await updateReportAsync((await context.params).id, {
        status: body.status as KnowledgeReportStatus,
        severity: body.severity as KnowledgeReportSeverity,
        category: body.category as KnowledgeReportCategory,
        product: typeof body.product === "string" ? body.product : null,
      })
    : null;
  if (!report) return NextResponse.json({ error: "Valid issue type, priority, product and status are required." }, { status: 400 });
  return NextResponse.json(report);
}
