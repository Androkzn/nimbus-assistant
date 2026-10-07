/**
 * Sliding-window limiter per client key (BRD BR-26: a public, login-free URL spends real API budget).
 * In-memory, so it is per server instance — a documented limitation; production would use Redis.
 */
export function createRateLimiter({ max, windowMs, now = () => Date.now() }: { max: number; windowMs: number; now?: () => number }) {
  const hits = new Map<string, number[]>();
  return {
    check(key: string): { ok: true } | { ok: false; retryAfterSec: number } {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((ts) => t - ts < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((recent[0] + windowMs - t) / 1000)) };
      }
      recent.push(t);
      hits.set(key, recent);
      return { ok: true };
    },
  };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;
