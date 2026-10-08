import type { TestResult } from "@/readiness/schema";
import { SourceBadge, StatusPill } from "./badges";
import { shortFile } from "./format";

const DOCS = "https://github.com/Androkzn/nimbus-assistant/blob/main/docs/requirements";

const STEPS: { name: string; file: string; what: string }[] = [
  { name: "Discovery", file: "00_KB_Discovery.md", what: "What the 10 client documents actually say, where they disagree, and what they never cover." },
  { name: "BRD", file: "01_BRD.md", what: "Every brief item as a numbered business requirement (BR-xx) with its priority." },
  { name: "TRD", file: "02_TRD.md", what: "The technical contract that satisfies each BR: wire format, retrieval, fallback, limits." },
  { name: "Acceptance matrix", file: "04_Acceptance_Matrix.md", what: "One checkable criterion per row (NKA-xxx), each traced to the brief and the BRD." },
  { name: "Evidence", file: "06_Readiness_Report.md", what: "Automated checks claim test results; this page maps every result back up the chain." },
];

export function MethodPanel({ unclaimed, requirementCount, checkCount }: { unclaimed: TestResult[]; requirementCount: number; checkCount: number }) {
  return (
    <section aria-labelledby="method-heading" className="rounded-2xl border border-border bg-surface p-5 shadow-[0_1px_2px_rgb(15_23_42/0.04)] sm:p-6">
      <h2 id="method-heading" className="font-display text-[17px] font-bold tracking-[-0.01em] text-text">
        How readiness is decided
      </h2>

      <ol className="mt-4 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-5">
        {STEPS.map((s, i) => (
          <li key={s.name} className="relative min-w-0 rounded-xl border border-border bg-surface-2 p-3.5">
            <p className="flex items-center gap-2">
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-navy font-mono text-[10.5px] font-semibold text-on-navy dark:bg-navy-3">
                {i + 1}
              </span>
              <a
                href={`${DOCS}/${s.file}`}
                target="_blank"
                rel="noreferrer"
                className="text-[13.5px] font-semibold text-orange-ink underline-offset-2 hover:text-orange-ink-hover hover:underline"
              >
                {s.name}
                <span className="sr-only"> (opens {s.file} on GitHub)</span>
              </a>
            </p>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">{s.what}</p>
            {i < STEPS.length - 1 && (
              <span aria-hidden className="absolute top-1/2 -right-2 z-10 hidden -translate-y-1/2 text-muted lg:block">
                →
              </span>
            )}
          </li>
        ))}
      </ol>

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <blockquote className="rounded-xl border-l-4 border-orange bg-orange-soft px-4 py-3 text-[14px] leading-relaxed text-text">
            A requirement is <strong>Verified</strong> only by a passing automated check — never by code reading.
          </blockquote>
          <dl className="mt-4 grid gap-x-4 gap-y-2.5 text-[13px] sm:grid-cols-[auto_minmax(0,1fr)]">
            <dt>
              <StatusPill status="passed" kind="requirement" size="xs" />
            </dt>
            <dd className="text-muted">At least one of its checks passed and none failed.</dd>
            <dt>
              <StatusPill status="failed" kind="requirement" size="xs" />
            </dt>
            <dd className="text-muted">Any of its checks failed. The redacted reason is on the failing test.</dd>
            <dt>
              <StatusPill status="pending" kind="requirement" size="xs" />
            </dt>
            <dd className="text-muted">No result from this run yet. Never counted as verified.</dd>
            <dt>
              <SourceBadge source="live" size="xs" />
            </dt>
            <dd className="text-muted">Ran now, against this server or this working tree.</dd>
            <dt>
              <SourceBadge source="recorded" size="xs" />
            </dt>
            <dd className="text-muted">Read from a committed report, shown with its date and build — never presented as live.</dd>
          </dl>
        </div>
        <div className="min-w-0 space-y-3 text-[13px] leading-relaxed text-muted">
          <p>
            The manifest (<code className="font-mono text-[12px] text-text">src/readiness/manifest.ts</code>) lists {requirementCount} requirements and{" "}
            {checkCount} automated checks. Its test fails CI if an acceptance row has no brief item, a
            requirement has no check, a check matches no real test, or a test is claimed by no check.
          </p>
          <p>
            The live answer eval spends real tokens, so it is shown from the latest committed report and labelled recorded. The live
            probes always run from this browser, for real.
          </p>
          <div data-testid="unclaimed">
            <p className="font-semibold text-text">Unclaimed results</p>
            {unclaimed.length === 0 ? (
              <p>None — every result in this run is claimed by at least one check.</p>
            ) : (
              <>
                <p className="text-[var(--rdy-warn)]">
                  {unclaimed.length} {unclaimed.length === 1 ? "result is" : "results are"} not claimed by any check. They count toward no
                  requirement:
                </p>
                <ul className="mt-1.5 space-y-1">
                  {unclaimed.slice(0, 12).map((r) => (
                    <li key={r.id} className="truncate font-mono text-[11.5px] text-text" title={r.id}>
                      {shortFile(r.file)} · {r.fullName}
                    </li>
                  ))}
                  {unclaimed.length > 12 && <li className="text-[12px]">and {unclaimed.length - 12} more</li>}
                </ul>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
