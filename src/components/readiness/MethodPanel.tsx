import type { TestResult } from "@/readiness/schema";
import { SourceBadge, StatusPill } from "./badges";
import { shortFile } from "./format";

const DOCS = "https://github.com/Androkzn/nimbus-assistant/blob/main/docs/requirements";

const STEPS: { name: string; file: string; what: string }[] = [
  { name: "Discovery", file: "00_KB_Discovery.md", what: "Sets the approved knowledge boundary: what the client documents say, where they disagree, and what they never cover." },
  { name: "BRD", file: "01_BRD.md", what: "Defines numbered business outcomes, priorities, users, and risk independently of implementation." },
  { name: "TRD", file: "02_TRD.md", what: "Defines contracts for retrieval, grounding, fallback, limits, security, storage, and observability." },
  { name: "Acceptance matrix", file: "04_Acceptance_Matrix.md", what: "Makes each outcome observable through a precise criterion traced to the brief and BRD." },
  { name: "Evidence", file: "06_Readiness_Report.md", what: "Connects checks and test results back to the requirement chain so the release decision is explainable." },
];

const PRINCIPLES = [
  {
    title: "Requirements are the control plane",
    text: "The brief defines the outcome. Code, prompts, models, and tools are replaceable choices; the required behavior is not.",
  },
  {
    title: "The agent is bounded by evidence",
    text: "Approved documents, retrieval, citations, guards, and fallback rules constrain what the assistant may claim.",
  },
  {
    title: "Plan, execute, validate, recover",
    text: "The workflow turns each failure into the next action: understand, implement, validate, and recover from evidence.",
  },
  {
    title: "Evidence drives the release decision",
    text: "Deterministic checks prove behavior; live and recorded evaluations add model quality, cost, and deployment evidence without hiding provenance.",
  },
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

      <div className="mt-5 rounded-xl border border-border bg-surface-2 p-4">
        <h3 className="font-display text-[15px] font-bold text-text">Why this architecture works</h3>
        <ul className="mt-3 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          {PRINCIPLES.map((principle) => (
            <li key={principle.title} className="rounded-lg border border-border bg-surface px-3 py-2.5">
              <h4 className="text-[12.5px] font-semibold leading-snug text-text">{principle.title}</h4>
              <p className="mt-1 text-[12px] leading-relaxed text-muted">{principle.text}</p>
            </li>
          ))}
        </ul>
      </div>

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
            With &quot;Include live answers&quot; ticked (it is off by default), a local run asks the real providers the golden
            questions and spends real tokens; unticked, the eval is skipped. A replay shows the eval from the recorded run, labelled recorded. The live probes
            always run from this browser, for real.
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
