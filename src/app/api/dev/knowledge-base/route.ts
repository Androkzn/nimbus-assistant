import { NextResponse } from "next/server";
import { createReportAsync, devPortalEnabled, getKnowledgeBaseAsync } from "@/server/dev-portal/db";
import type { KnowledgeReportCategory, KnowledgeReportSeverity } from "@/shared/knowledgeBase";

export const runtime = "nodejs";

export async function GET() {
  if (!devPortalEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(await getKnowledgeBaseAsync(), { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  if (!devPortalEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { title?: unknown; product?: unknown; severity?: unknown; category?: unknown; summary?: unknown } | null;
  const report = body
    ? await createReportAsync({
        title: typeof body.title === "string" ? body.title : "",
        product: typeof body.product === "string" ? body.product : null,
        severity: body.severity as KnowledgeReportSeverity,
        category: body.category as KnowledgeReportCategory,
        summary: typeof body.summary === "string" ? body.summary : "",
      })
    : null;
  if (!report) return NextResponse.json({ error: "Title, summary and a valid severity are required." }, { status: 400 });
  return NextResponse.json(report, { status: 201 });
}
