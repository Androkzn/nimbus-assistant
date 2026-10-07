import "server-only";
import { handleChat } from "@/server/chat/handleChat";

export const runtime = "nodejs";
export const maxDuration = 60;

export function POST(req: Request): Promise<Response> {
  return handleChat(req);
}
