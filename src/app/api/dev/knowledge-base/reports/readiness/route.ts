import { NextResponse } from "next/server";
import { createReadinessReport, devPortalEnabled } from "@/server/dev-portal/db";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!devPortalEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { runId?: unknown; failedChecks?: unknown; failedStages?: unknown } | null;
  const report = body
    ? createReadinessReport({
        runId: typeof body.runId === "string" ? body.runId : "",
        failedChecks: Array.isArray(body.failedChecks) ? body.failedChecks.filter((item): item is string => typeof item === "string") : [],
        failedStages: Array.isArray(body.failedStages) ? body.failedStages.filter((item): item is string => typeof item === "string") : [],
      })
    : null;
  if (!report) return NextResponse.json({ error: "A run id and at least one failed live check or stage are required." }, { status: 400 });
  return NextResponse.json(report, { status: 201 });
}
