import { SparklesIcon } from "./icons";

export function EmptyState() {
  return (
    <div className="flex min-h-[24rem] items-center justify-center px-6 pb-8 text-center">
      <div className="max-w-md">
        <div className="mx-auto mb-5 grid h-12 w-12 place-items-center rounded-2xl border border-orange-line bg-orange-soft text-orange-ink shadow-sm">
          <SparklesIcon className="h-6 w-6" />
        </div>
        <p className="mb-2 text-[11px] font-bold tracking-[0.18em] text-orange-ink uppercase">NimbusStack knowledge base</p>
        <h1 className="font-display text-2xl font-extrabold tracking-[-0.03em] text-text sm:text-3xl">What can I help you find?</h1>
        <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-muted">Ask about products, pricing, integrations, or SLAs. Answers are grounded in NimbusStack documents.</p>
      </div>
    </div>
  );
}
