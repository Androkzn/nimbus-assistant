import { NextResponse } from "next/server";
import { chatOwner, setChatOwnerCookie } from "@/server/chat/identity";
import { listConversations } from "@/server/chat/history";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const owner = chatOwner(request);
  const response = NextResponse.json(await listConversations(owner.id));
  if (owner.setCookie) setChatOwnerCookie(response.headers, owner.id);
  return response;
}
