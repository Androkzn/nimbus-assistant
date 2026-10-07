/** Source numbers an answer actually cites (`[2]`, `[1, 3]`); markdown links (`[1](…)`) and reference definitions excluded. */
export function citedNumbers(markdown: string): Set<number> {
  const cited = new Set<number>();
  for (const m of markdown.matchAll(/\[(\d{1,2}(?:\s*[,;]\s*\d{1,2})*)\](?![(:])/g)) {
    for (const n of m[1].split(/\s*[,;]\s*/)) cited.add(Number(n));
  }
  return cited;
}
