import { loadCorpus, PRODUCTS, type Chunk, type Product } from "../kb/corpus";
import {
  carriedTopic,
  detectTopics,
  detectVersion,
  expandQuery,
  isCrossProduct,
  isElliptical,
  hasNearMatch,
  productsInScope,
  tokenize,
  type HistoryMessage,
} from "./query";

export interface Passage {
  n: number;
  chunk: Chunk;
  score: number;
}

export interface RetrievalResult {
  passages: Passage[];
  products: Product[];
  inheritedProducts: boolean;
  /** Topic carried from the previous question when this one only names a product ("And for Vault?"). */
  carriedTopic: string | null;
  /** True when nothing in the corpus scores meaningfully — a hint to the prompt, not a refusal. */
  noMatch: boolean;
  /** True when a pricing question names tier labels the documents do not use. */
  unsupportedPricingTier: boolean;
  /** True when a release question gives only a major version, such as "v4". */
  ambiguousReleaseVersion: boolean;
  /** True when an API troubleshooting question uses an HTTP status not documented in the corpus. */
  unsupportedTroubleshootingStatus: boolean;
  /** True when an SLA question uses a priority outside the documented P1–P4 range. */
  unsupportedPriority: boolean;
}

const MAX_PASSAGES = 10;
const K1 = 1.2;
const B = 0.75;
/** A chunk is "relevant" if it scores at least this share of the best chunk. */
const RELATIVE_FLOOR = 0.2;
/** Below this absolute best score the question likely has nothing to do with the corpus. */
const NO_MATCH_SCORE = 2.5;

interface Index {
  chunks: Chunk[];
  docTokens: string[][];
  df: Map<string, number>;
  avgLen: number;
}

let index: Index | null = null;

function getIndex(): Index {
  if (index) return index;
  const chunks = loadCorpus();
  const docTokens = chunks.map((c) => tokenize(c.text));
  const df = new Map<string, number>();
  for (const tokens of docTokens) for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  const avgLen = docTokens.reduce((sum, t) => sum + t.length, 0) / docTokens.length;
  index = { chunks, docTokens, df, avgLen };
  return index;
}

function bm25(queryTokens: string[], docTokens: string[], idx: Index): number {
  const tf = new Map<string, number>();
  for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  const n = idx.chunks.length;
  let score = 0;
  for (const q of new Set(queryTokens)) {
    const f = tf.get(q);
    if (!f) continue;
    const df = idx.df.get(q) ?? 0;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * docTokens.length) / idx.avgLen));
  }
  return score;
}

/**
 * Retrieval-first grounding (TRD §4.1). Deterministic and offline: the same question always
 * yields the same passages, which is what makes the retrieval eval a reliable CI gate.
 */
export function retrieve(question: string, history: HistoryMessage[] = []): RetrievalResult {
  const idx = getIndex();
  const { products, inherited } = productsInScope(question, history);
  const topic = isElliptical(question) ? carriedTopic(history) : null;
  const queryText = topic ? `${question} ${topic}` : question;
  const version = detectVersion(queryText);
  const unsupportedPricingTier = detectTopics(queryText).includes("pricing") && hasNearMatch(queryText, ["professional", "company"]);
  const ambiguousReleaseVersion = detectTopics(queryText).includes("release") && /\bv\d+\b/i.test(queryText) && !version;
  const status = queryText.match(/\b([1-5]\d{2})\b/)?.[1];
  const unsupportedTroubleshootingStatus = Boolean(status && !/^(?:403|429)$/.test(status) && /\b(?:api|error|troubleshoot|check)\b/i.test(queryText));
  const priority = queryText.match(/\b(?:priority|p)\s*(\d+)\b/i)?.[1];
  const unsupportedPriority = Boolean(priority && !/^[1-4]$/.test(priority) && /\b(?:sla|priority|support)\b/i.test(queryText));
  const queryTokens = [...expandQuery(queryText), ...products];

  const scored = idx.chunks.map((chunk, i) => {
    let score = bm25(queryTokens, idx.docTokens[i], idx);
    if (products.length > 0 && chunk.product) score *= products.includes(chunk.product) ? 1.5 : 0.6;
    if (version && chunk.version === version) score *= 3;
    return { chunk, score };
  });
  const ranked = [...scored].sort((a, b) => b.score - a.score);
  const best = ranked[0]?.score ?? 0;
  const relevant = ranked.filter((r) => r.score > 0 && r.score >= best * RELATIVE_FLOOR);

  const picked: { chunk: Chunk; score: number }[] = [];
  const add = (entry: { chunk: Chunk; score: number } | undefined) => {
    if (entry && !picked.some((p) => p.chunk.id === entry.chunk.id)) picked.push(entry);
  };

  const singleProduct = products.length === 1 && !isCrossProduct(question);
  const signOnQuestion = detectTopics(question).includes("signOn");
  const topicScope = products.length > 0 ? products : isCrossProduct(question) && signOnQuestion ? PRODUCTS : [];

  // Cross-product identity questions must not be allowed to select a generic pricing chunk as the
  // representative passage for a product. Seed one sign-on passage per product before the normal
  // BM25 expansion; this keeps every product's answer evidence in the prompt even after a long chat
  // history has mentioned other topics repeatedly.
  if (signOnQuestion && topicScope.length > 0) {
    const signOn = /saml|single\s+sign|oidc|openid|federated|identity|access[- ]and[- ]sign/i;
    for (const product of topicScope) add(scored.find((r) => r.chunk.product === product && signOn.test(r.chunk.text)));
  }

  if (singleProduct) {
    relevant.filter((r) => r.chunk.product === products[0]).slice(0, 4).forEach(add);
    relevant.filter((r) => !picked.includes(r)).slice(0, 2).forEach(add);
  } else {
    // Per-product coverage: the best relevant chunk of every product in scope (brief Q5).
    const scope = products.length > 1 ? products : PRODUCTS;
    for (const p of scope) add(relevant.find((r) => r.chunk.product === p));
    relevant.slice(0, 3).forEach(add);
    // Table questions across products (Q6 "P1 SLA") need the same section from every product.
    const section = picked[0]?.chunk.section;
    if (section) for (const p of scope) add(relevant.find((r) => r.chunk.product === p && r.chunk.section === section));
  }

  addConflictCompanions(picked, queryText, scored);

  const passages = picked.slice(0, MAX_PASSAGES).map((p, i) => ({ n: i + 1, chunk: p.chunk, score: p.score }));
  return {
    passages,
    products,
    inheritedProducts: inherited,
    carriedTopic: topic,
    noMatch: best < NO_MATCH_SCORE,
    unsupportedPricingTier,
    ambiguousReleaseVersion,
    unsupportedTroubleshootingStatus,
    unsupportedPriority,
  };
}

/**
 * Brief E4: when an answer touches a topic where documents are known to drift (sign-on, pricing),
 * pull in the same product's release notes and the company-wide section on that topic, so both
 * sides of a disagreement reach the model.
 */
function addConflictCompanions(
  picked: { chunk: Chunk; score: number }[],
  question: string,
  scored: { chunk: Chunk; score: number }[],
): void {
  const topics = detectTopics(question);
  const patterns: RegExp[] = [];
  const companyIds: string[] = [];
  if (topics.includes("signOn")) {
    patterns.push(/saml|sign-in|sign-on|single sign|oidc/i);
    companyIds.push("security-overview.md#identity");
  }
  if (topics.includes("pricing")) patterns.push(/pric/i);
  if (patterns.length === 0) return;

  const productsPicked = new Set(picked.map((p) => p.chunk.product).filter(Boolean));
  for (const entry of scored) {
    const { chunk } = entry;
    const isReleaseNote = chunk.version !== null && productsPicked.has(chunk.product);
    const body = chunk.text.slice(chunk.text.indexOf("\n") + 1);
    if (isReleaseNote && patterns.some((re) => re.test(body)) && !picked.some((p) => p.chunk.id === chunk.id)) {
      picked.push(entry);
    }
  }
  for (const id of companyIds) {
    const entry = scored.find((s) => s.chunk.id === id);
    if (entry && !picked.some((p) => p.chunk.id === id)) picked.push(entry);
  }
}
