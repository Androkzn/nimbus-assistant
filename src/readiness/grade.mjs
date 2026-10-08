/**
 * Grading of one live answer against its golden case (TRD §9). Shared by `npm run eval:live` (Node) and the
 * readiness page's in-browser live answer eval, so both apply exactly the same rules. Plain JS: Node runs it as is.
 */

/** "(?i)…" is the golden set's case-insensitive marker. @param {string} p */
export const pattern = (p) => (p.startsWith("(?i)") ? new RegExp(p.slice(4), "i") : new RegExp(p));

/**
 * The parts of a /api/chat NDJSON stream the grader needs.
 * @param {string[]} lines
 */
export function readChatStream(lines) {
  let text = "";
  /** @type {any} */ let done = null;
  /** @type {string | null} */ let error = null;
  /** @type {{ n: number }[]} */ let sources = [];
  /** @type {unknown[]} */ const fallbacks = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const ev = JSON.parse(line);
    if (ev.type === "delta") text += ev.text;
    else if (ev.type === "reset") text = "";
    else if (ev.type === "sources") sources = ev.passages;
    else if (ev.type === "fallback") fallbacks.push(ev);
    else if (ev.type === "done") done = ev;
    else if (ev.type === "error") error = `${ev.code}: ${ev.message}`;
  }
  return { text, done, error, sources, fallbacks };
}

/**
 * pass, fail, or fallback (a backup model answered, so the model under evaluation was not evaluated).
 * @param {{ expectNotInKb?: boolean, noCitationRequired?: boolean, mustInclude?: string[], mustNotInclude?: string[], shouldInclude?: string[] }} c
 * @param {{ text: string, done: any, error: string | null, sources: { n: number }[] }} answer
 * @param {string} notInKbPattern
 * @param {string} modelId
 */
export function gradeAnswer(c, answer, notInKbPattern, modelId) {
  const { text, done, error, sources } = answer;
  /** @type {string[]} */ const failed = [];
  if (!done) failed.push(`no answer (${error ?? "stream ended early"})`);
  // Brief E2: the answer must *clearly* say it is not in the knowledge base (any clear phrasing).
  if (c.expectNotInKb && !pattern(notInKbPattern).test(text)) failed.push("does not clearly say the answer is not in the knowledge base");
  for (const p of c.mustInclude ?? []) if (!pattern(p).test(text)) failed.push(`missing /${p}/`);
  for (const p of c.mustNotInclude ?? []) if (pattern(p).test(text)) failed.push(`must not contain /${p}/`);
  // Figure check (server-side, TRD §4.6): any number that appears in no retrieved passage fails the case.
  if (done?.unverifiedFigures?.length) failed.push(`figures not in sources: ${done.unverifiedFigures.join(", ")}`);
  // Soft checks: better answers include these, but the brief does not require them (see case.note).
  const warnings = (c.shouldInclude ?? []).filter((p) => !pattern(p).test(text)).map((p) => `nice-to-have missing /${p}/`);
  // A clear "not in the knowledge base" answer has nothing to cite.
  const saysNotInKb = pattern(notInKbPattern).test(text);
  if (!c.expectNotInKb && !c.noCitationRequired && !saysNotInKb) {
    const cited = [...text.matchAll(/\[(\d+)(?:\s*,\s*(\d+))*\]/g)].flatMap((m) => (m[0].match(/\d+/g) ?? []).map(Number));
    if (cited.length === 0) failed.push("no citations");
    const bad = cited.filter((n) => !sources.some((s) => s.n === n));
    if (bad.length) failed.push(`cites passages not shown: ${[...new Set(bad)].join(", ")}`);
  }
  // "kb-guard" = the off-topic guard answered with no model call: the intended path, not a fallback.
  const verdict = failed.length ? "fail" : done && done.answeredBy !== modelId && done.answeredBy !== "kb-guard" ? "fallback" : "pass";
  return { verdict, failed, warnings };
}
