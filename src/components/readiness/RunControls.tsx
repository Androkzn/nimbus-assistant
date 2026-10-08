import { StopIcon } from "@/components/icons";
import type { ReplaySpeed, RunMode, RunnerAvailability, RunSession } from "@/readiness/useReadinessRun";

const SPEEDS: { value: ReplaySpeed; label: string }[] = [
  { value: 1, label: "1×" },
  { value: 4, label: "4×" },
  { value: "instant", label: "Instant" },
];

/** What Start will run: the explicit mode, else a local run where the runner is free, else a replay. */
export function plannedMode(mode: RunMode | undefined, availability: RunnerAvailability | null): RunMode | undefined {
  return mode ?? (availability?.available && !availability.running ? "local" : availability ? "replay" : undefined);
}

function startLabel(session: RunSession, mode: RunMode | undefined, availability: RunnerAvailability | null): string {
  const again = session.phase !== "idle";
  const planned = plannedMode(mode, availability);
  if (planned === "local") return again ? "Re-run all gates" : "Run all gates locally";
  if (planned === "probes") return again ? "Re-run live checks" : "Run live checks";
  // A deployment (no explicit mode): the recorded gates plus the live checks, not a replay.
  if (planned === "replay" && !mode) return again ? "Re-run live checks" : "Run live checks";
  if (planned === "replay") return again ? "Replay again" : "Replay recorded run";
  return again ? "Re-run" : "Start";
}

/** "Include live answers" switches the live answer eval of a local run; the probe question always runs. */
const LIVE_EVAL_NOTE = "Uses real tokens: live answer eval (~170 answers, about $0.50)";
const LIVE_EVAL_REPLAY_NOTE = "Runs only in a local run; this page replays the recorded eval";
const LIVE_EVAL_REPLAY_DETAIL =
  "A deployment cannot run the live answer eval: about 170 real questions from a public page would bypass the rate limit that protects the provider budget. Open the report from a local run (npm run dev, then /readiness) to include live answers. Here, card 07 shows the eval from the recorded run.";
const LIVE_EVAL_DETAIL =
  "Runs the live answer eval: every golden question on every available model, about 170 real answers and about $0.50 per run. Off by default; tick it to include the eval. Applies to the next run.";

function startHint(mode: RunMode | undefined, availability: RunnerAvailability | null, probes: boolean): string {
  const planned = plannedMode(mode, availability) ?? "local";
  const tail = probes ? ", then the live probes against this server" : "";
  if (planned === "local") return `Runs typecheck, lint, tests, build, bundle scan and E2E on this machine${tail}.`;
  if (planned === "probes") return "Runs the live probes from this browser against this server, and the live answer eval when Include live answers is ticked.";
  if (!mode) return "Shows the latest local run's gates (recorded), then runs the live checks against this server.";
  return `Replays the last published local run, labelled recorded${tail}.`;
}

export function RunControls({
  session,
  mode,
  probes,
  availability,
  speed,
  onSpeed,
  includeAnswer,
  onIncludeAnswer,
  onStart,
  onStop,
}: {
  session: RunSession;
  mode: RunMode | undefined;
  probes: boolean;
  availability: RunnerAvailability | null;
  speed: ReplaySpeed;
  onSpeed: (s: ReplaySpeed) => void;
  includeAnswer: boolean;
  onIncludeAnswer: (v: boolean) => void;
  onStart: () => void;
  onStop: () => void;
}) {
  const active = session.phase === "connecting" || session.phase === "running";
  // Replay is opt-in (mode=replay); a deployment runs the live checks instead.
  const replayRelevant = mode === "replay";
  const planned = plannedMode(mode, availability);
  // A local run and a deployment's live checks can run the live answer eval; only an explicit replay (mode=replay)
  // shows the box off and disabled.
  const liveEvalLocal = planned === "local" || planned === "probes" || (planned === "replay" && !mode);
  const answerRelevant = liveEvalLocal || planned === "replay";

  return (
    <div className="flex w-full min-w-0 flex-wrap items-center gap-x-5 gap-y-3 sm:w-auto sm:flex-1 sm:justify-end">
      {replayRelevant && (
        <fieldset className="flex min-w-0 items-center gap-2" disabled={active}>
          <legend className="sr-only">Replay speed</legend>
          <span aria-hidden className="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">
            Replay
          </span>
          <span className="inline-flex rounded-lg border border-border bg-surface p-0.5">
            {SPEEDS.map((s) => (
              <button
                key={String(s.value)}
                type="button"
                aria-pressed={speed === s.value}
                aria-label={s.value === "instant" ? "Replay instantly" : `Replay at ${s.label}`}
                onClick={() => onSpeed(s.value)}
                className={`h-7 rounded-md px-2.5 text-[12.5px] font-semibold tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                  speed === s.value ? "bg-navy text-on-navy dark:bg-navy-3" : "text-muted hover:bg-orange-soft hover:text-orange-ink"
                }`}
              >
                {s.label}
              </button>
            ))}
          </span>
        </fieldset>
      )}
      {answerRelevant && (
        <label
          className="flex min-w-0 cursor-pointer items-center gap-2 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
          title={liveEvalLocal ? LIVE_EVAL_DETAIL : LIVE_EVAL_REPLAY_DETAIL}
        >
          <input
            type="checkbox"
            data-testid="include-answer"
            checked={liveEvalLocal && includeAnswer}
            disabled={active || !liveEvalLocal}
            onChange={(e) => onIncludeAnswer(e.target.checked)}
            className="h-4 w-4 shrink-0 accent-[var(--orange-strong)]"
          />
          <span className="min-w-0 text-[13px] leading-tight">
            <span className="font-semibold text-text">Include live answers</span>
            <span className="block text-[11.5px] text-muted">{liveEvalLocal ? LIVE_EVAL_NOTE : LIVE_EVAL_REPLAY_NOTE}</span>
          </span>
        </label>
      )}
      {active ? (
        <button
          type="button"
          data-testid="stop-run"
          onClick={onStop}
          title="Stop aborts everything in flight; a local run stops on the server too."
          className="inline-flex h-10 items-center gap-2 rounded-xl border border-navy bg-navy px-4 text-sm font-semibold text-on-navy transition-colors hover:border-orange hover:text-orange dark:border-navy-3 dark:bg-navy-3"
        >
          <StopIcon className="text-orange" />
          Stop
        </button>
      ) : (
        <button
          type="button"
          data-testid="start-run"
          onClick={onStart}
          title={startHint(mode, availability, probes)}
          className="inline-flex h-10 items-center gap-2 rounded-xl border border-orange bg-orange px-4 text-sm font-semibold text-navy transition-colors hover:border-orange-strong hover:bg-orange-strong"
        >
          <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden>
            {session.phase === "idle" ? (
              <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />
            ) : (
              <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
            )}
          </svg>
          {startLabel(session, mode, availability)}
        </button>
      )}
    </div>
  );
}

/** One line under the toolbar: what Start will do, or what Stop does. */
export function RunHint({
  session,
  mode,
  probes,
  availability,
}: {
  session: RunSession;
  mode: RunMode | undefined;
  probes: boolean;
  availability: RunnerAvailability | null;
}) {
  const active = session.phase === "connecting" || session.phase === "running";
  return (
    <p className="text-[12.5px] text-muted max-sm:hidden">
      {active ? "Stop aborts everything in flight; a local run stops on the server too." : startHint(mode, availability, probes)}
    </p>
  );
}
