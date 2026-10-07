/** Link target used for citation markers; the answer renderer turns these links into source chips. */
export const CITE_PREFIX = "#cite-";

const CITATION_MARKER = /\[(\d{1,2}(?:\s*[,;]\s*\d{1,2})*)\](?![(:])/g;
const SOURCE_APPENDIX = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*{2}|__)?(?:cited sources?|sources|references)(?:\*{2}|__)?\s*:?[^\n]*[\s\S]*$/im;

/** Remove a bibliography the model may append; the answer card renders retrieved sources itself. */
export function stripSourceAppendix(markdown: string): string {
  return markdown.replace(SOURCE_APPENDIX, "").trimEnd();
}

/** Keep only citation markers that point at passages actually returned with the answer. */
export function sanitizeAnswerText(markdown: string, available?: ReadonlySet<number>): string {
  const withoutAppendix = stripSourceAppendix(markdown);
  if (!available) return withoutAppendix;
  return withoutAppendix.replace(CITATION_MARKER, (_, list: string) => {
    const valid = list.split(/\s*[,;]\s*/).filter((n) => available.has(Number(n)));
    return valid.map((n) => `[${n}]`).join("");
  });
}

/**
 * Rewrites citation markers such as `[2]` or `[1, 3]` into markdown links (`[2](#cite-2)`), so the
 * renderer can show each one as a clickable chip that opens its source passage. Existing links
 * (`[1](…)`) and reference definitions (`[1]: …`) are left alone.
 */
export function linkCitations(markdown: string): string {
  return markdown.replace(CITATION_MARKER, (_, list: string) =>
    list
      .split(/\s*[,;]\s*/)
      .map((n) => `[${n}](${CITE_PREFIX}${n})`)
      .join(""),
  );
}

/** Which retrieved passages an answer came from (shared with the server, which uses it for the SLA qualifier). */
export { citedNumbers } from "@/shared/citations";

/** Source number of a citation link, or null for an ordinary link. */
export function citationNumber(href: string | undefined): number | null {
  if (!href?.startsWith(CITE_PREFIX)) return null;
  const n = Number(href.slice(CITE_PREFIX.length));
  return Number.isInteger(n) && n > 0 ? n : null;
}
