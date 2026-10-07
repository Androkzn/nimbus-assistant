import { BrandLockup } from "./BrandLockup";
import { ChevronRightIcon } from "./icons";

/** The brief's six representative questions — one click runs each against the knowledge base. */
const EXAMPLES = [
  { q: "What are the key differences between the Pro and Enterprise pricing tiers?", kind: "Pricing comparison" },
  { q: "Does Vault integrate with Salesforce? What version is required?", kind: "Integration and version requirement" },
  { q: "What new features were released in v4.2 of Relay?", kind: "Release notes for one version" },
  { q: "A client is getting a 403 on the API. What should they check first?", kind: "Troubleshooting" },
  { q: "Which of our products support SSO via SAML 2.0?", kind: "One fact across every product" },
  { q: "What's the SLA for Priority 1 support tickets?", kind: "Table lookup, per support tier" },
];

export function EmptyState({ onAsk, disabled, providerCount }: { onAsk: (q: string) => void; disabled: boolean; providerCount: number }) {
  const stats = [
    { value: "4", strong: "products", rest: " covered: Relay, Vault, Pulse and Ledger" },
    { value: String(providerCount || 3), strong: "AI providers", rest: ", with automatic fallback" },
    { value: "1", strong: "rule", rest: ": every answer comes from the documents" },
  ];

  return (
    <div className="space-y-10 pb-2">
      <section className="brand-glow overflow-hidden rounded-3xl border border-navy-3 bg-navy px-6 py-8 text-on-navy shadow-[0_24px_48px_-24px_rgb(15_23_42/0.45)] sm:px-10 sm:py-10">
        <BrandLockup size="hero" />
        <h1 className="mt-5 font-display text-[2.1rem] leading-[1.06] font-extrabold tracking-tight sm:text-5xl">
          Product answers, <br className="hidden sm:block" />
          straight from the docs<span className="text-orange">.</span>
        </h1>
        <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-on-navy-muted">
          Pricing, integrations, release notes, troubleshooting and SLAs. Each answer is written only from NimbusStack&apos;s
          own documents and links to the passages it used.
        </p>
        <ul className="mt-8 hidden overflow-hidden rounded-2xl border border-navy-3 bg-navy-2/70 sm:grid sm:grid-cols-3">
          {stats.map((s) => (
            <li key={s.strong} className="border-navy-3 px-5 py-5 not-last:border-r">
              <span className="block font-display text-4xl font-extrabold text-orange">{s.value}</span>
              <span className="mt-2 block text-[13px] leading-snug text-on-navy-muted">
                <b className="font-semibold text-on-navy">{s.strong}</b>
                {s.rest}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="examples-heading">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[linear-gradient(180deg,var(--orange),var(--orange-strong))] font-display text-sm font-extrabold text-white shadow-md shadow-orange-strong/25"
          >
            Q
          </span>
          <div>
            <p className="text-[11px] font-bold tracking-[0.18em] text-orange-ink uppercase">Try asking</p>
            <h2 id="examples-heading" className="font-display text-xl font-bold tracking-tight">
              Questions Sales, Support and Training ask every day
            </h2>
          </div>
        </div>
        <ul className="mt-4 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
          {EXAMPLES.map((ex, i) => (
            <li key={ex.q}>
              <button
                type="button"
                onClick={() => onAsk(ex.q)}
                disabled={disabled}
                className="group flex w-full items-center gap-4 px-4 py-3.5 text-left transition-colors hover:bg-orange-soft focus-visible:-outline-offset-2 disabled:cursor-wait disabled:opacity-60 sm:px-5"
              >
                <span className="shrink-0 rounded-md border border-orange-line bg-orange-soft px-1.5 py-0.5 text-[11px] font-bold text-orange-ink tabular-nums">
                  Q{i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] leading-snug font-semibold text-text">{ex.q}</span>
                  <span className="mt-0.5 block text-xs text-muted">{ex.kind}</span>
                </span>
                <ChevronRightIcon className="shrink-0 text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-orange-ink" />
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
