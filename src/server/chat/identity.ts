import "server-only";

export const CHAT_OWNER_COOKIE = "nimbus_chat_owner";

function cookieValue(request: Request): string | null {
  const cookies = request.headers.get("cookie") ?? "";
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${CHAT_OWNER_COOKIE}=([^;]+)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function chatOwner(request: Request): { id: string; setCookie: boolean } {
  const existing = cookieValue(request);
  if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return { id: existing, setCookie: false };
  return { id: crypto.randomUUID(), setCookie: true };
}

export function setChatOwnerCookie(headers: Headers, ownerId: string): void {
  headers.append("set-cookie", `${CHAT_OWNER_COOKIE}=${encodeURIComponent(ownerId)}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`);
}
