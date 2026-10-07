import type { ErrorCode } from "@/shared/contracts";
import { isMockMode, type Env } from "../config/models";

/**
 * Fault injection, so fallback (brief E8/E9) can be demonstrated and E2E-tested without
 * breaking a real provider. Enabled only with LLM_MODE=mock or ALLOW_FAULT_INJECTION=1.
 * Usage: add a marker to the question, e.g. "What is Relay's P1 SLA? #fail-primary".
 */
export const FAULTS = ["fail-primary", "fail-midstream", "rate-limit-all", "auth-primary"] as const;
export type Fault = (typeof FAULTS)[number];

const MARKER = new RegExp(`#(${FAULTS.join("|")})\\b`, "g");

export function faultInjectionEnabled(env: Env = process.env): boolean {
  return isMockMode(env) || env.ALLOW_FAULT_INJECTION === "1";
}

export function extractFaults(text: string, env: Env = process.env): { text: string; faults: Fault[] } {
  if (!faultInjectionEnabled(env)) return { text, faults: [] };
  const faults = [...text.matchAll(MARKER)].map((m) => m[1] as Fault);
  return { text: text.replace(MARKER, "").replace(/\s{2,}/g, " ").trim(), faults };
}

export interface InjectedFault {
  when: "before-first-token" | "mid-stream";
  code: ErrorCode;
  retryAfterSec?: number;
}

/** Which fault, if any, hits attempt number `attempt` (0 = the user's selected model). */
export function faultForAttempt(faults: Fault[], attempt: number): InjectedFault | null {
  if (faults.includes("rate-limit-all")) return { when: "before-first-token", code: "rate_limited", retryAfterSec: 30 };
  if (attempt !== 0) return null;
  if (faults.includes("fail-primary")) return { when: "before-first-token", code: "unavailable" };
  if (faults.includes("auth-primary")) return { when: "before-first-token", code: "auth" };
  if (faults.includes("fail-midstream")) return { when: "mid-stream", code: "unavailable" };
  return null;
}
