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
