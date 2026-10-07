import { PRODUCTS, type Product } from "../kb/corpus";

const STOPWORDS = new Set(
  "a an and are as at be by can do does for from has have how i if in is it its of on or our that the their them they this to was we what when where which who why will with you your about any there".split(" "),
);

/**
 * Synonym groups (TRD §4.1). If any phrase of a group occurs in the question, every phrase of
 * the group joins the query. This is what lets "single sign-on" reach Ledger's "Federated login".
 */
export const SYNONYM_GROUPS: Record<string, string[]> = {
  signOn: ["sso", "single sign-on", "single sign on", "saml", "federated login", "federated sign-in", "oidc", "openid connect", "sign-in", "identity"],
  forbidden: ["403", "forbidden"],
  rateLimit: ["429", "rate limit", "rate limited", "too many requests", "ratelimit"],
  sla: ["sla", "response time", "support sla", "first human reply", "priority"],
  pricing: ["price", "pricing", "cost", "costs", "how much", "charge", "fee", "tier", "tiers", "plan", "per seat"],
  release: ["release", "released", "new features", "what's new", "whats new", "release notes", "new"],
  // No "connect": it matched "OpenID Connect" and pulled sign-on passages into integration answers,
  // which then reported a disagreement that does not exist (found by external review, 2026-10-07).
  integration: ["integrate", "integrates", "integration", "integrations", "sync"],
};

/**
 * What staff call the products when they don't use the name (brief E1/E5: plain English).
 * Taken from each product doc's own one-line description.
 */
export const PRODUCT_ALIASES: Record<Product, string[]> = {
  relay: ["api gateway", "gateway", "event router", "webhook", "webhooks"],
  vault: ["secrets manager", "secret manager", "secrets management", "secret store"],
  pulse: ["product analytics", "analytics"],
  ledger: ["billing", "invoicing", "usage-based billing", "usage billing", "metering"],
};

export type Topic = keyof typeof SYNONYM_GROUPS;

/** Lower-case word/number tokens; keeps version numbers like "4.2" and "2.0" intact. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+(?:\.[0-9]+)*/g) ?? [])
    .map((t) => (t.length > 4 && t.endsWith("s") && !/^\d/.test(t) ? t.slice(0, -1) : t))
    // Single letters ("s" from "what's") carry no meaning but match everywhere.
    .filter((t) => (t.length > 1 || /\d/.test(t)) && !STOPWORDS.has(t));
}

/** Conservative typo support: only short, unique one-edit matches are eligible for normalization. */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    for (let j = 0; j <= b.length; j++) prev[j] = next[j];
  }
  return prev[b.length];
}

export function hasNearMatch(text: string, candidates: string[], maxEdits = 1): boolean {
  return tokenize(text).some((token) => token.length >= 4 && candidates.some((candidate) => editDistance(token, candidate) <= maxEdits));
}

/** Normalise phrasings the corpus writes differently ("priority 1" → "p1", "v4.2" → "4.2"). */
export function normalize(question: string): string {
  return question
    .toLowerCase()
    .replace(/priority\s*([1-4])\b/g, "p$1 priority")
    .replace(/\bv(\d+\.\d+)\b/g, "$1");
}

export function detectTopics(question: string): Topic[] {
  const q = normalize(question);
  return (Object.keys(SYNONYM_GROUPS) as Topic[]).filter((topic) =>
    SYNONYM_GROUPS[topic].some((phrase) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(phrase)}([^a-z0-9]|$)`).test(q)),
  );
}

export function expandQuery(question: string): string[] {
  const q = normalize(question);
  const extra = detectTopics(q).flatMap((topic) => SYNONYM_GROUPS[topic]);
  return [...tokenize(q), ...tokenize(extra.join(" "))];
}

export function detectProducts(text: string): Product[] {
  const lower = text.toLowerCase();
  const exact = PRODUCTS.filter((p) => [p, ...PRODUCT_ALIASES[p]].some((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`).test(lower)));
  const tokens = tokenize(text);
  const fuzzy = PRODUCTS.filter((p) => !exact.includes(p) && tokens.some((token) => token.length >= 4 && editDistance(token, p) <= 1));
  return [...exact, ...fuzzy];
}

/** A product release asked about ("v4.2", "4.2"). Protocol versions ("SAML 2.0", "TLS 1.2") are not releases. */
export function detectVersion(question: string): string | null {
  return normalize(question).match(/(?<!\b(?:saml|tls|ssl|oauth|http|api)\s?)\b(\d+\.\d+)\b/)?.[1] ?? null;
}

const CROSS_PRODUCT = /\b(which|what) (of )?(our|the|nimbusstack) products\b|\b(all|each|every|any) (of )?(our |the )?products?\b|\bproduct line\b/i;

export function isCrossProduct(question: string): boolean {
  return CROSS_PRODUCT.test(question);
}

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Products in scope for this turn. If the question names none and is not explicitly
 * cross-product, inherit the most recent product(s) named by the user earlier (brief E1).
 */
export function productsInScope(question: string, history: HistoryMessage[]): { products: Product[]; inherited: boolean } {
  const named = detectProducts(question);
  if (named.length > 0 || isCrossProduct(question)) return { products: named, inherited: false };
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== "user") continue;
    const earlier = detectProducts(msg.content);
    if (earlier.length > 0) return { products: earlier, inherited: true };
  }
  return { products: [], inherited: false };
}

const FOLLOW_UP = /^\s*(and|what about|how about|same for|what of)\b/i;
const PRODUCT_WORDS = new RegExp(
  `\\b(nimbus\\s+)?(${PRODUCTS.flatMap((p) => [p, ...PRODUCT_ALIASES[p]]).map(escapeRegExp).join("|")})\\b`,
  "gi",
);

/**
 * "And for Vault?" / "What about Pulse?" — names a product but no topic of its own, so the topic
 * comes from the previous question (brief E1: right product AND topic).
 */
export function isElliptical(question: string): boolean {
  const content = tokenize(question.replace(PRODUCT_WORDS, " "));
  if (content.length === 0) return true;
  return FOLLOW_UP.test(question) && detectTopics(question).length === 0 && content.length <= 2;
}

/** Previous user question with product names removed — the topic to carry into an elliptical follow-up. */
export function carriedTopic(history: HistoryMessage[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") return history[i].content.replace(PRODUCT_WORDS, " ").replace(/\s{2,}/g, " ").trim() || null;
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
