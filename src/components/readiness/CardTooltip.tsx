export interface TooltipDetail {
  label: string;
  text: string;
}

export function CardTooltip({ label, explanation, details = [] }: { label: string; explanation: string; details?: TooltipDetail[] }) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none invisible absolute top-[calc(100%+8px)] left-0 z-50 w-80 rounded-lg border border-border bg-navy px-3 py-3 text-left text-[12px] leading-relaxed text-on-navy opacity-0 shadow-lg transition-opacity group-hover:visible group-hover:opacity-100"
    >
      <span className="block font-semibold text-white">{label}</span>
      <span className="mt-0.5 block text-on-navy-muted">{explanation}</span>
      {details.length > 0 && (
        <span className="mt-2 grid gap-1.5 border-t border-white/15 pt-2">
          {details.map((detail) => (
            <span key={detail.label} className="block">
              <span className="font-semibold text-white">{detail.label}: </span>
              <span className="text-on-navy-muted">{detail.text}</span>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
