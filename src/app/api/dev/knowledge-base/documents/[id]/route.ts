import { NextResponse } from "next/server";
import { deleteDocument, devPortalEnabled, updateDocument } from "@/server/dev-portal/db";
import { resetCorpusCache } from "@/server/kb/corpus";
import type { KnowledgeDocumentStatus } from "@/shared/knowledgeBase";

export const runtime = "nodejs";

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!devPortalEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { title?: unknown; product?: unknown; content?: unknown; status?: unknown } | null;
  const document = body
    ? updateDocument((await context.params).id, {
        title: typeof body.title === "string" ? body.title : "",
        product: typeof body.product === "string" ? body.product : null,
        content: typeof body.content === "string" ? body.content : "",
        status: body.status as KnowledgeDocumentStatus,
      })
    : null;
  if (!document) return NextResponse.json({ error: "A title, content and valid status are required." }, { status: 400 });
  resetCorpusCache();
  return NextResponse.json(document);
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  if (!devPortalEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const deleted = deleteDocument((await context.params).id);
  if (!deleted) return NextResponse.json({ error: "Document not found." }, { status: 404 });
  resetCorpusCache();
  return NextResponse.json({ deleted: true });
}
