import type { RunMeta } from "@/readiness/schema";
import type { RunSession } from "@/readiness/useReadinessRun";
import { formatDuration, formatUtc, shortOrigin } from "./format";

/**
 * The header metadata row of the established report format (evals/reports/<stamp>/index.html):
 * platform · environment · build · branch · golden set · pricing · corpus · prompt · started at · elapsed.
 */
export function MetaRow({ meta, session, elapsedMs }: { meta: RunMeta | null; session: RunSession; elapsedMs?: number }) {
  const items: { label: string; value: string; mono?: boolean; title?: string }[] = [];
  const add = (label: string, value: string | undefined, mono = false, title?: string) => {
    if (value) items.push({ label, value, mono, title });
  };

  add("platform", meta?.platform);
  add("environment", meta?.mode === "probes" ? shortOrigin(meta.environment) : meta?.environment, false, meta?.environment);
  add("build", meta?.build, true);
  add("branch", meta?.branch, true);
  add("golden set", meta?.goldenVersion, true);
  add("pricing", meta?.pricingVersion, true);
  add("corpus", meta?.corpusHash, true);
  add("prompt", meta?.promptHash, true);
  add("started", meta ? formatUtc(meta.startedAt) : undefined);
  if (session.probeOrigin && meta?.mode !== "probes") add("probes →", shortOrigin(session.probeOrigin), true, session.probeOrigin);
  if (elapsedMs !== undefined && session.phase !== "idle") add("elapsed", formatDuration(elapsedMs));
  if (meta?.runId) add("run", meta.runId, true);

  if (items.length === 0) {
    return (
      <p className="text-[13px] text-muted" data-testid="meta-row">
        Run metadata — platform, environment, build, golden set, pricing, corpus and prompt fingerprints — appears here
        once a run starts.
      </p>
    );
  }

  return (
    <ul data-testid="meta-row" aria-label="Run metadata" className="flex flex-wrap items-center gap-x-1.5 gap-y-2 text-[12.5px]">
      {items.map((it, i) => (
        <li key={it.label} className="flex min-w-0 items-center gap-1.5">
          {i > 0 && (
            <span aria-hidden className="text-muted/60">
              ·
            </span>
          )}
          <span
            title={it.title}
            className="inline-flex min-w-0 items-baseline gap-1.5 rounded-md border border-border bg-surface px-2 py-[3px] shadow-[0_1px_0_rgb(15_23_42/0.03)]"
          >
            <span className="text-muted">{it.label}</span>
            <span className={`truncate font-semibold text-text tabular-nums ${it.mono ? "font-mono text-[12px]" : ""}`}>{it.value}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
