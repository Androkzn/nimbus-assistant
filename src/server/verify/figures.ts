/**
 * Hallucination tripwire for the most damaging error class on a sales call: an invented figure
 * (price, percentage, SLA time, version, limit). Every number in the answer must also appear in a
 * passage the model was given, or in the user's own question. Deterministic and cheap; it runs after
 * the answer has streamed and is shown next to the answer, logged, and checked by the live eval.
 *
 * It cannot prove a sentence is true — a correct number in the wrong row still passes — but it turns
 * "the model made up 99.9 % uptime" from a silent failure into a visible, measurable one.
 */
const CITATION = /\[\d{1,2}(?:\s*[,;]\s*\d{1,2})*\]/g;
/** "passage 5", "passages 5 and 6": a passage named in prose is a citation too, not a figure (NKA-RET-015). */
const PASSAGE_REFERENCE = /\bpassages?\s+\d{1,2}(?:(?:\s*,\s*|\s+and\s+|\s*&\s*)\d{1,2})*(?![\d.]|,\d)/gi;
const LIST_MARKER = /^\s*\d+[.)]\s/gm;
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

/** "10,000" → "10000", "2.0" → "2", "08" → "8": one spelling per value. */
function canonical(raw: string): string {
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? String(n) : raw;
}

function numbersIn(text: string): Set<string> {
  return new Set((text.match(NUMBER) ?? []).map(canonical));
}

/** Figures in `answer` that appear in none of `sources` (passage texts, the question, today's date). */
export function unverifiedFigures(answer: string, sources: string[]): string[] {
  const known = numbersIn(sources.join("\n"));
  const body = answer.replace(CITATION, " ").replace(PASSAGE_REFERENCE, " ").replace(LIST_MARKER, " ");
  const missing = new Set<string>();
  for (const match of body.match(NUMBER) ?? []) {
    const raw = match.replace(/,+$/, "");
    if (!known.has(canonical(raw))) missing.add(raw);
  }
  return [...missing];
}
