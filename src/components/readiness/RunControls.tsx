import { StopIcon } from "@/components/icons";
import type { ReplaySpeed, RunMode, RunnerAvailability, RunSession } from "@/readiness/useReadinessRun";

const SPEEDS: { value: ReplaySpeed; label: string }[] = [
  { value: 1, label: "1×" },
  { value: 4, label: "4×" },
  { value: "instant", label: "Instant" },
];

function startLabel(session: RunSession, mode: RunMode | undefined, availability: RunnerAvailability | null): string {
  const again = session.phase !== "idle";
  const planned = mode ?? (availability?.available && !availability.running ? "local" : availability ? "replay" : undefined);
  if (planned === "local") return again ? "Re-run all gates" : "Run all gates locally";
  if (planned === "probes") return again ? "Re-run live probes" : "Run live probes";
  if (planned === "replay") return again ? "Replay again" : "Replay recorded run";
  return again ? "Re-run" : "Start";
}

function startHint(mode: RunMode | undefined, availability: RunnerAvailability | null, probes: boolean): string {
  const planned = mode ?? (availability?.available && !availability.running ? "local" : "replay");
  const tail = probes ? ", then the live probes against this server" : "";
  if (planned === "local") return `Runs typecheck, lint, tests, build, bundle scan and E2E on this machine${tail}.`;
  if (planned === "probes") return "Sends the live probes from this browser to this server.";
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
  const replayRelevant = mode === "replay" || (!mode && !(availability?.available && !availability.running));
  const answerRelevant = mode === "probes" || probes;

  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-5 gap-y-3 sm:justify-end">
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
          title="Off by default. Applies to the next run."
        >
          <input
            type="checkbox"
            data-testid="include-answer"
            checked={includeAnswer}
            disabled={active}
            onChange={(e) => onIncludeAnswer(e.target.checked)}
            className="h-4 w-4 shrink-0 accent-[var(--orange-strong)]"
          />
          <span className="min-w-0 text-[13px] leading-tight">
            <span className="font-semibold text-text">Include one real answer</span>
            <span className="block text-[11.5px] text-muted">one model call · about 1.5k tokens</span>
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
    <p className="text-[12.5px] text-muted">
      {active ? "Stop aborts everything in flight; a local run stops on the server too." : startHint(mode, availability, probes)}
    </p>
  );
}
