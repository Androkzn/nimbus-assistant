/** Link target used for citation markers; the answer renderer turns these links into source chips. */
export const CITE_PREFIX = "#cite-";

/**
 * Rewrites citation markers such as `[2]` or `[1, 3]` into markdown links (`[2](#cite-2)`), so the
 * renderer can show each one as a clickable chip that opens its source passage. Existing links
 * (`[1](…)`) and reference definitions (`[1]: …`) are left alone.
 */
export function linkCitations(markdown: string): string {
  return markdown.replace(/\[(\d{1,2}(?:\s*[,;]\s*\d{1,2})*)\](?![(:])/g, (_, list: string) =>
    list
      .split(/\s*[,;]\s*/)
      .map((n) => `[${n}](${CITE_PREFIX}${n})`)
      .join(""),
  );
}

/** Source number of a citation link, or null for an ordinary link. */
export function citationNumber(href: string | undefined): number | null {
  if (!href?.startsWith(CITE_PREFIX)) return null;
  const n = Number(href.slice(CITE_PREFIX.length));
  return Number.isInteger(n) && n > 0 ? n : null;
}
