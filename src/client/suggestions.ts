/**
 * Suggestion bubbles above the composer (BR-27). Each bubble is a fixed question that demonstrates one
 * item of the client brief — a representative question (Q1–Q6) or an edge case (E1–E6) — so a tap shows
 * the assistant doing what was asked for, including the one rule: E2 bubbles ask what the documents do
 * not cover and get the honest "not in the knowledge base". Every bubble has a golden-set case with the
 * same brief id (enforced by suggestions.test.ts), so each one is graded by the live eval.
 */
const PRODUCTS = ["relay", "vault", "pulse", "ledger"] as const;
type Product = (typeof PRODUCTS)[number];

export interface Suggestion {
  q: string;
  /** Brief item this bubble demonstrates: Q1–Q6 or E1–E10. */
  req: string;
  /** What it shows, for the tooltip. */
  why: string;
}

const BY_PRODUCT: Record<Product, Suggestion[]> = {
  relay: [
    { q: "How much is Relay Pro?", req: "E4", why: "documents disagree: $49 vs $59 for new contracts" },
    { q: "A client is getting a 403 on the Relay API. What should they check first?", req: "Q4", why: "troubleshooting, in the documented order" },
    { q: "What new features were released in v4.2 of Relay?", req: "Q3", why: "release notes for one version" },
    { q: "What is the Relay Enterprise P1 SLA?", req: "E6", why: "one table value — 15 minutes, not the 30 minutes in the next row" },
  ],
  vault: [
    { q: "Which Vault tiers support SAML?", req: "E4", why: "documents disagree: Pro and Enterprise vs Enterprise only" },
    { q: "Does Vault integrate with Salesforce? What version is required?", req: "Q2", why: "one fact plus a version requirement" },
    { q: "What are the key differences between Vault Pro and Enterprise?", req: "Q1", why: "tier comparison" },
    { q: "What's Vault's uptime SLA?", req: "E2", why: "not in the documents — the answer says so and invents nothing" },
  ],
  pulse: [
    { q: "Does Pulse do single sign-on?", req: "E5", why: "loosely worded — finds OIDC, and that SAML is not available" },
    { q: "Does Pulse integrate with Salesforce? What version is required?", req: "Q2", why: "one fact plus a version requirement" },
    { q: "What new features were released in Pulse 4.2?", req: "E2", why: "there is no Pulse 4.2 — the answer says so" },
    { q: "What's the P1 SLA for Pulse's entry-level tier?", req: "E6", why: "the entry tier is Growth, not Starter" },
  ],
  ledger: [
    { q: "What's the Ledger Enterprise P1 SLA?", req: "E6", why: "one table value — 30 minutes, not Relay's 15" },
    { q: "Does Ledger do single sign-on?", req: "E5", why: "loosely worded — Ledger calls it federated login" },
    { q: "Does Ledger integrate with Salesforce?", req: "Q2", why: "not yet — it is on the roadmap" },
  ],
};

/** E1: a follow-up that doesn't name the product, answered for the product of the previous question. */
export const FOLLOW_UP_SLA: Suggestion = { q: "What about its SLA?", req: "E1", why: "follow-up without the product name" };

/** The empty screen's bubbles: one per product, each showing a different rule (E4, E4, E5, E6). */
export const STARTERS: Suggestion[] = PRODUCTS.map((p) => BY_PRODUCT[p][0]);

/** Every bubble the app can show — the set the golden-set test covers. */
export const ALL_SUGGESTIONS: Suggestion[] = [...PRODUCTS.flatMap((p) => BY_PRODUCT[p]), FOLLOW_UP_SLA];

const normalize = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const ABOUT_SLA = /\b(sla|p[1-4]|priority|response time)\b/i;

function productsIn(text: string): Product[] {
  return PRODUCTS.filter((p) => new RegExp(`\\b${p}\\b`, "i").test(text));
}

/**
 * Next bubbles. After an answer about one product (not already about its SLA), the first bubble is the E1
 * follow-up; then that product's other bubbles (or, when the question named none, the products the answer
 * covers, alternating); then the starters. Questions already asked are skipped.
 */
export function nextQuestions({
  asked,
  lastQuestion = "",
  lastAnswer = "",
  limit = 3,
}: {
  asked: string[];
  lastQuestion?: string;
  lastAnswer?: string;
  limit?: number;
}): Suggestion[] {
  if (asked.length === 0) return [...STARTERS]; // all four on the empty screen: one per product
  const fromQuestion = productsIn(lastQuestion);
  const products = fromQuestion.length > 0 ? fromQuestion : productsIn(lastAnswer);
  const candidates: Suggestion[] = [];
  if (fromQuestion.length === 1 && !ABOUT_SLA.test(lastQuestion)) candidates.push(FOLLOW_UP_SLA);
  const longest = Math.max(0, ...products.map((p) => BY_PRODUCT[p].length));
  for (let i = 0; i < longest; i++) for (const p of products) if (BY_PRODUCT[p][i]) candidates.push(BY_PRODUCT[p][i]);
  const done = new Set(asked.map(normalize));
  const out: Suggestion[] = [];
  for (const s of [...candidates, ...STARTERS]) {
    if (out.length === limit) break;
    if (!done.has(normalize(s.q)) && !out.some((o) => o.q === s.q)) out.push(s);
  }
  return out;
}
