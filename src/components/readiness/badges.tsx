import type { ReactNode, SVGProps } from "react";
import type { Layer, Source, Status } from "@/readiness/schema";
import styles from "./readiness.module.css";

/**
 * Status pills, source and layer badges. Status is always icon + word, never colour alone;
 * the colours follow the established report format (pass / fail / warning).
 */

export type Tone = "pass" | "fail" | "warn" | "run" | "idle";

export const TONE_CLASS: Record<Tone, string> = {
  pass: "text-[var(--rdy-pass)] bg-[var(--rdy-pass-bg)] border-[var(--rdy-pass-line)]",
  fail: "text-[var(--rdy-fail)] bg-[var(--rdy-fail-bg)] border-[var(--rdy-fail-line)]",
  warn: "text-[var(--rdy-warn)] bg-[var(--rdy-warn-bg)] border-[var(--rdy-warn-line)]",
  run: "text-[var(--rdy-run)] bg-[var(--rdy-run-bg)] border-[var(--rdy-run-line)]",
  idle: "text-[var(--rdy-idle)] bg-[var(--rdy-idle-bg)] border-[var(--rdy-idle-line)]",
};

export const TONE_TEXT: Record<Tone, string> = {
  pass: "text-[var(--rdy-pass)]",
  fail: "text-[var(--rdy-fail)]",
  warn: "text-[var(--rdy-warn)]",
  run: "text-[var(--rdy-run)]",
  idle: "text-[var(--rdy-idle)]",
};

export function toneOf(status: Status): Tone {
  switch (status) {
    case "passed":
      return "pass";
    case "failed":
      return "fail";
    case "skipped":
      return "warn";
    case "running":
      return "run";
    default:
      return "idle";
  }
}

export type StatusKind = "requirement" | "check" | "test" | "stage";

export function statusLabel(status: Status, kind: StatusKind): string {
  if (status === "passed") return kind === "requirement" ? "Verified" : "Passed";
  if (status === "failed") return "Failed";
  if (status === "running") return "Running";
  if (status === "skipped") return "Skipped";
  return kind === "test" || kind === "stage" ? "Queued" : "Pending";
}

function Svg({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}

export function StatusIcon({ status, className = "" }: { status: Status; className?: string }) {
  switch (status) {
    case "passed":
      return (
        <Svg className={className}>
          <path d="M20 6 9 17l-5-5" />
        </Svg>
      );
    case "failed":
      return (
        <Svg className={className}>
          <path d="M18 6 6 18M6 6l12 12" />
        </Svg>
      );
    case "skipped":
      return (
        <Svg className={className}>
          <path d="M5 12h14" />
        </Svg>
      );
    case "running":
      return (
        <Svg className={`animate-spin ${className}`} strokeWidth={2.4}>
          <path d="M21 12a9 9 0 1 1-6.2-8.56" />
        </Svg>
      );
    default:
      return (
        <Svg className={className} strokeWidth={2.2}>
          <circle cx="12" cy="12" r="7" strokeDasharray="3 3.2" />
        </Svg>
      );
  }
}

export function StatusPill({
  status,
  kind = "test",
  size = "sm",
  label,
}: {
  status: Status;
  kind?: StatusKind;
  size?: "xs" | "sm" | "md";
  label?: string;
}) {
  const tone = toneOf(status);
  const sizing =
    size === "md"
      ? "h-7 gap-1.5 px-2.5 text-xs"
      : size === "xs"
        ? "h-5 gap-1 px-1.5 text-[10px]"
        : "h-6 gap-1 px-2 text-[11px]";
  return (
    <span
      data-status={status}
      className={`inline-flex shrink-0 items-center rounded-full border font-semibold tracking-[0.04em] whitespace-nowrap uppercase transition-colors duration-300 ${sizing} ${TONE_CLASS[tone]}`}
    >
      <StatusIcon status={status} />
      {label ?? statusLabel(status, kind)}
    </span>
  );
}

/** Live = run now against this server; Recorded = read from a committed report (spec I7). */
export function SourceBadge({ source, size = "sm" }: { source: Source; size?: "xs" | "sm" }) {
  const sizing = size === "xs" ? "h-5 px-1.5 text-[10px]" : "h-6 px-2 text-[11px]";
  if (source === "live") {
    return (
      <span
        data-source="live"
        title="Run now, against this server"
        className={`inline-flex shrink-0 items-center gap-1.5 rounded-md bg-navy font-semibold tracking-[0.06em] whitespace-nowrap text-on-navy uppercase dark:bg-navy-3 ${sizing}`}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--rdy-live-dot)]" aria-hidden />
        Live
      </span>
    );
  }
  return (
    <span
      data-source="recorded"
      title="Read from a committed report, not run now"
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border border-dashed border-muted/60 font-semibold tracking-[0.06em] whitespace-nowrap text-muted uppercase ${sizing}`}
    >
      <Svg strokeWidth={2.2} className="h-3 w-3">
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3 2" />
      </Svg>
      Recorded
    </span>
  );
}

const LAYER_LABEL: Record<Layer, string> = {
  static: "static",
  unit: "unit",
  integration: "integration",
  "retrieval-eval": "retrieval eval",
  contract: "contract",
  e2e: "e2e",
  security: "security",
  "live-eval": "live eval",
  "live-probe": "live probe",
};

export function LayerBadge({ layer }: { layer: Layer }) {
  return (
    <span
      title={`Layer: ${LAYER_LABEL[layer]}`}
      className="inline-flex h-5 shrink-0 items-center rounded-md border border-border bg-surface-2 px-1.5 font-mono text-[10.5px] whitespace-nowrap text-muted"
    >
      {LAYER_LABEL[layer]}
    </span>
  );
}

/** A requirement / acceptance id, in mono. */
export function IdChip({ children, strong = false }: { children: ReactNode; strong?: boolean }) {
  return (
    <span
      className={`inline-flex h-5 shrink-0 items-center rounded-md px-1.5 font-mono text-[11px] whitespace-nowrap ${
        strong ? "bg-navy font-semibold text-on-navy dark:bg-navy-3" : "border border-border bg-surface text-muted"
      }`}
    >
      {children}
    </span>
  );
}

export function LiveDot({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`inline-block h-2 w-2 rounded-full bg-[var(--rdy-live-dot)] ${styles.pulse} ${className}`} />;
}
