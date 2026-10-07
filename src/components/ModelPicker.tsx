"use client";

import { useEffect, useRef, useState } from "react";
import { siAnthropic, siGooglegemini } from "simple-icons";
import type { PublicModel } from "@/shared/contracts";
import { CheckIcon, ChevronDownIcon, OpenAIIcon } from "./icons";

type Brand = { path: string; hex: string; title: string };

const brandFor = (provider: string): Brand | null => {
  if (provider.toLowerCase().includes("anthropic")) return siAnthropic;
  if (provider.toLowerCase().includes("google")) return siGooglegemini;
  return null;
};

function ProviderMark({ provider, className = "" }: { provider: string; className?: string }) {
  const brand = brandFor(provider);
  if (!brand) return <OpenAIIcon className={className} aria-label="OpenAI" />;
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d={brand.path} />
    </svg>
  );
}

export function ModelPicker({
  value,
  groups,
  onChange,
}: {
  value: string;
  groups: [string, PublicModel[]][];
  onChange: (modelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const selected = groups.flatMap(([, models]) => models).find((model) => model.id === value);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function choose(model: PublicModel) {
    if (!model.available) return;
    onChange(model.id);
    setOpen(false);
  }

  return (
    <div ref={pickerRef} className="relative min-w-0 shrink-0">
      <label htmlFor="model" className="sr-only">
        AI model
      </label>
      {/* Keep a real select for keyboard users, browser autofill, and existing integrations. */}
      <select
        id="model"
        data-testid="model-select"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="pointer-events-none absolute inset-0 z-0 h-10 w-full cursor-pointer opacity-0"
        tabIndex={-1}
      >
        {groups.map(([provider, models]) => (
          <optgroup key={provider} label={provider}>
            {models.map((model) => (
              <option key={model.id} value={model.id} disabled={!model.available}>
                {model.displayName} — {model.description}
                {model.available ? "" : " (not configured)"}
              </option>
            ))}
          </optgroup>
        ))}
      </select>

      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`AI model: ${selected?.displayName ?? "Choose a model"}`}
        onClick={() => setOpen((current) => !current)}
        className="group relative z-10 flex h-10 min-w-[13rem] max-w-[17rem] items-center gap-2.5 rounded-xl border border-border bg-surface-2 px-3 text-left transition-[border-color,box-shadow,background-color] hover:border-orange-strong hover:bg-orange-soft focus-visible:border-orange-strong focus-visible:shadow-[0_0_0_3px_rgb(234_88_12/0.12)] sm:min-w-[15rem]"
      >
        {selected && <ProviderMark provider={selected.providerName} className="h-4 w-4 shrink-0 text-orange-ink" />}
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text">{selected?.displayName ?? "Choose a model"}</span>
        <ChevronDownIcon className={`h-4 w-4 shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Choose an AI model"
          className="absolute bottom-[calc(100%+0.6rem)] left-0 z-50 w-[min(26rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-border bg-surface p-1.5 shadow-[0_18px_50px_-18px_rgb(15_23_42/0.35)]"
        >
          <div className="flex items-center justify-between px-3 pb-2 pt-2">
            <span className="text-[10px] font-bold tracking-[0.16em] text-muted uppercase">Choose a model</span>
            <span className="text-[11px] text-muted">Provider icons included</span>
          </div>
          {groups.map(([provider, models]) => (
            <div key={provider} role="group" aria-label={provider} className="border-t border-border/70 py-1.5 first:border-t-0">
              <p className="flex items-center gap-2 px-3 py-1.5 text-[11px] font-semibold text-muted">
                <ProviderMark provider={provider} className="h-3.5 w-3.5 text-muted" />
                {provider}
              </p>
              {models.map((model) => {
                const isSelected = model.id === value;
                return (
                  <button
                    key={model.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    disabled={!model.available}
                    onClick={() => choose(model)}
                    className="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-orange-soft disabled:cursor-not-allowed disabled:opacity-45 aria-selected:bg-orange-soft"
                  >
                    <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md ${isSelected ? "bg-orange-strong text-white" : "bg-surface-2 text-muted"}`}>
                      {isSelected ? <CheckIcon className="h-3.5 w-3.5" /> : <ProviderMark provider={provider} className="h-3.5 w-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-[13px] font-semibold text-text">
                        {model.displayName}
                        {!model.available && <span className="text-[10px] font-medium text-muted">Not configured</span>}
                      </span>
                      <span className="mt-0.5 block text-xs leading-snug text-muted">{model.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
