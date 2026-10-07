import type { Suggestion } from "@/client/suggestions";

/** Tappable suggested questions above the composer (BR-27). One line that scrolls sideways on phones. */
export function SuggestionChips({ questions, onAsk, disabled }: { questions: Suggestion[]; onAsk: (q: string) => void; disabled: boolean }) {
  if (questions.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Suggested questions"
      className="mb-2 flex items-center gap-2 overflow-x-auto [scrollbar-width:none] sm:flex-wrap sm:overflow-visible"
    >
      <span className="shrink-0 text-[11px] font-bold tracking-[0.16em] text-orange-ink uppercase">Ask more</span>
      {questions.map((s) => (
        <button
          key={s.q}
          type="button"
          data-testid="suggestion"
          data-req={s.req}
          title={`Brief ${s.req}: ${s.why}`}
          onClick={() => onAsk(s.q)}
          disabled={disabled}
          className="shrink-0 rounded-full border border-orange-line bg-surface px-3 py-1.5 text-[13px] font-medium whitespace-nowrap text-text shadow-sm transition-colors hover:border-orange-strong hover:bg-orange-soft hover:text-orange-ink disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-orange-line disabled:hover:bg-surface disabled:hover:text-text"
        >
          {s.q}
        </button>
      ))}
    </div>
  );
}
