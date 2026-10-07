import type { SVGProps } from "react";

/** Minimal inline icon set (24px grid, stroke = currentColor) — no icon library needed. */
function Icon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}

export const PlusIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const ArrowUpIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </Icon>
);

export const ArrowDownIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M12 5v14M19 12l-7 7-7-7" />
  </Icon>
);

export const StopIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
  </svg>
);

export const ChevronDownIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);

export const ChevronRightIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="m9 6 6 6-6 6" />
  </Icon>
);

export const CopyIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </Icon>
);

export const CheckIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Icon>
);

export const AlertIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v4.5M12 16h.01" />
  </Icon>
);

export const CloseIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Icon>
);

export const ChartIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </Icon>
);

export const DownloadIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </Icon>
);

export const DocIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M9 13h6M9 17h4" />
  </Icon>
);

export const SwitchIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M7 4 3 8l4 4M3 8h13M17 20l4-4-4-4M21 16H8" />
  </Icon>
);

export const SparklesIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="m12 3-1.1 4.1L7 8.2l3.9 1.1L12 13.4l1.1-4.1L17 8.2l-3.9-1.1L12 3Z" />
    <path d="m19 13-.6 2.4L16 16l2.4.6L19 19l.6-2.4L22 16l-2.4-.6L19 13ZM5 14l-.5 1.8L3 16.3l1.5.5L5 18.5l.5-1.7 1.5-.5-1.5-.5L5 14Z" />
  </Icon>
);

/** OpenAI's six-lobed knot mark, kept inline so the picker has no remote image dependency. */
export const OpenAIIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" aria-hidden {...p}>
    <path
      d="M8.1 4.1a4.15 4.15 0 0 1 5.55-.95l1.7 1.18a4.15 4.15 0 0 1 5.75 3.8v2.08a4.15 4.15 0 0 1-.2 7.68l-1.93.73a4.15 4.15 0 0 1-7.04 2.53l-1.7-1.18a4.15 4.15 0 0 1-5.75-3.8v-2.08a4.15 4.15 0 0 1 .2-7.68l1.93-.73A4.15 4.15 0 0 1 8.1 4.1Z"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
    />
    <path d="m8.4 7.2 7.2 4.15v7.3M15.6 7.2 8.4 11.35v7.3M5.55 10.55l7.2 4.15 6.3-3.65M5.55 16.1l6.3-3.65v-7.3M18.45 13.45l-6.3 3.65v3.55" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
