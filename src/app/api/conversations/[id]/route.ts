import { NextResponse } from "next/server";
import { chatOwner, setChatOwnerCookie } from "@/server/chat/identity";
import { deleteConversation, getConversation, saveConversation } from "@/server/chat/history";
import type { StoredTurn } from "@/shared/history";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const owner = chatOwner(request);
  const result = await getConversation(owner.id, (await context.params).id);
  if (!result) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  const response = NextResponse.json(result);
  if (owner.setCookie) setChatOwnerCookie(response.headers, owner.id);
  return response;
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const owner = chatOwner(request);
  const body = (await request.json().catch(() => null)) as { turns?: unknown } | null;
  if (!body || !Array.isArray(body.turns)) return NextResponse.json({ error: "Conversation turns are required." }, { status: 400 });
  try {
    const saved = await saveConversation(owner.id, (await context.params).id, body.turns as StoredTurn[]);
    const response = NextResponse.json(saved);
    if (owner.setCookie) setChatOwnerCookie(response.headers, owner.id);
    return response;
  } catch {
    return NextResponse.json({ error: "Conversation could not be saved." }, { status: 400 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const owner = chatOwner(request);
  const deleted = await deleteConversation(owner.id, (await context.params).id);
  if (!deleted) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  const response = NextResponse.json({ deleted: true });
  if (owner.setCookie) setChatOwnerCookie(response.headers, owner.id);
  return response;
}
