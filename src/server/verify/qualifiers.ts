import { citedNumbers } from "@/shared/citations";

const SLA_DEFINITION = /response time to first human reply/i;
const STATES_DEFINITION = /first (human )?(reply|response)|response time/i;

/**
 * An SLA time without its definition gets repeated to customers as a resolution promise ("P1: 30 minutes").
 * The documents define every SLA table as "Response time to first human reply". If an answer cites such a
 * table but doesn't say what the times measure, return the definition line to append — taken from the
 * cited passage, with its citation. Deterministic, because the lightest model drops it under a terse history.
 */
export function slaQualifier(answer: string, passages: { n: number; text: string }[]): string | null {
  if (STATES_DEFINITION.test(answer)) return null;
  const cited = citedNumbers(answer);
  const sla = passages.find((p) => cited.has(p.n) && SLA_DEFINITION.test(p.text));
  return sla ? `\n\n_SLA times are the response time to the first human reply, not a resolution time [${sla.n}]._` : null;
}

/** One line, whitespace collapsed and table cells trimmed, so a copied row matches its source row. */
const flat = (text: string) => text.replace(/\s*\|\s*/g, "|").replace(/\s+/g, " ").trim();

/**
 * Rule 5 asks for an [n] on every fact, but the lightest model sometimes copies a passage's table under a plain
 * heading and cites nothing (NKA-RET-013). If an answer cites no passage, return a source line citing the
 * passages it copied lines from word for word: the fewest that cover every copied line, so a row two tables
 * share is not credited to both. Only lines with a figure count. Null when the answer cites or copied nothing.
 */
export function sourceLine(answer: string, passages: { n: number; text: string }[]): string | null {
  if (citedNumbers(answer).size > 0) return null;
  const sources = passages.map((p) => ({ n: p.n, text: flat(p.text) }));
  let lines = answer.split("\n").map(flat).filter((line) => /\d/.test(line) && !/^[|:\- ]+$/.test(line));
  const cited: number[] = [];
  for (;;) {
    const best = sources
      .map((s) => ({ n: s.n, text: s.text, count: lines.filter((line) => s.text.includes(line)).length }))
      .reduce((a, b) => (b.count > a.count ? b : a), { n: 0, text: "", count: 0 });
    if (best.count === 0) break;
    cited.push(best.n);
    lines = lines.filter((line) => !best.text.includes(line));
  }
  return cited.length ? `\n\n_Source: ${cited.sort((a, b) => a - b).map((n) => `[${n}]`).join(" ")}._` : null;
}
