import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST() {
  // Readiness is verification evidence, not a Knowledge base finding source.
  // Keep the endpoint as a safe tombstone so an older browser bundle cannot
  // create issues during a rolling deployment.
  return NextResponse.json({ error: "Readiness runs do not create Knowledge base issues." }, { status: 410 });
}
