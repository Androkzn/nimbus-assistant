import type { RequirementView, Summary } from "@/readiness/coverage";
import type { RunSession } from "@/readiness/useReadinessRun";
import type { Tone } from "./badges";

export type VerdictKind = "ready" | "not-ready" | "incomplete" | "running" | "idle";

export interface Verdict {
  kind: VerdictKind;
  label: string;
  tone: Tone;
  sentence: string;
}

function ids(views: RequirementView[], max = 4): string {
  const list = views.slice(0, max).map((v) => v.requirement.id);
  return views.length > max ? `${list.join(", ")} and ${views.length - max} more` : list.join(", ");
}

/**
 * The page's verdict. READY only when the run finished, nothing failed and every brief requirement has
 * passing evidence from this run — a requirement without evidence is never counted as verified.
 */
export function verdictOf(summary: Summary, session: RunSession, coverage: RequirementView[]): Verdict {
  const { requirements, checks } = summary;
  if (session.phase === "idle") {
    return { kind: "idle", label: "Idle", tone: "idle", sentence: "Nothing has run yet. Start a run to stream every gate." };
  }
  if (session.phase === "connecting" || session.phase === "running") {
    const done = Math.max(0, checks.total - checks.pending);
    const failedNote = checks.failed > 0 ? ` ${checks.failed} failed so far.` : "";
    return {
      kind: "running",
      label: "Running",
      tone: "run",
      sentence: `${done} of ${checks.total} checks complete — each test appears below as it finishes.${failedNote}`,
    };
  }
  const failed = coverage.filter((v) => v.status === "failed");
  if (failed.length > 0 || summary.status === "failed") {
    return {
      kind: "not-ready",
      label: "Not ready",
      tone: "fail",
      sentence:
        failed.length > 0
          ? `${failed.length} ${failed.length === 1 ? "requirement" : "requirements"} failed: ${ids(failed)}. The redacted reason is on each failed check below.`
          : "A gate failed. See the pipeline for the stage and its reason.",
    };
  }
  if (session.phase === "stopped") {
    return { kind: "incomplete", label: "Stopped", tone: "warn", sentence: "Stopped before every check finished, so there is no verdict. Re-run to get one." };
  }
  if (session.phase === "error") {
    return { kind: "incomplete", label: "Incomplete", tone: "warn", sentence: `${session.error ?? "The run did not finish."} No verdict.` };
  }
  const unproven = coverage.filter((v) => v.status !== "passed");
  if (unproven.length > 0) {
    return {
      kind: "incomplete",
      label: "Incomplete",
      tone: "warn",
      sentence: `Nothing failed, but ${unproven.length} ${unproven.length === 1 ? "requirement has" : "requirements have"} no passing evidence from this run: ${ids(unproven)}.`,
    };
  }
  return {
    kind: "ready",
    label: "Ready",
    tone: "pass",
    sentence: `All ${requirements.total} brief requirements are verified by passing automated checks.`,
  };
}
