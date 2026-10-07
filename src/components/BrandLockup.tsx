import Image from "next/image";
import logoIcon from "@/assets/logo-icon.png";

/**
 * The NimbusStack logo from `src/assets/logo-full.png`: its icon plus the wordmark as live text in the
 * same face (Open Sans) and colours. One component, so the header and the welcome panel can't drift
 * apart, and the wordmark stays sharp where the 118 px-tall PNG would blur.
 */
export function BrandLockup({ size }: { size: "header" | "hero" }) {
  const hero = size === "hero";
  return (
    <div className={`flex min-w-0 items-center ${hero ? "gap-4 sm:gap-5" : "gap-3"}`}>
      {/* Decorative: the wordmark beside it names the brand. Unoptimized keeps the small PNG's edges crisp. */}
      <Image
        src={logoIcon}
        alt=""
        className={`w-auto shrink-0 ${hero ? "h-12 sm:h-16" : "h-9"}`}
        priority
        unoptimized
      />
      <div className="min-w-0 font-brand leading-none">
        <p className={`tracking-[0.01em] ${hero ? "text-[1.85rem] sm:text-[2.5rem]" : "text-[19px]"}`}>
          <span className="text-on-navy">Nimbus</span>
          <span className="text-logo-orange">Stack</span>
        </p>
        <p
          className={`truncate text-on-navy-muted uppercase ${hero ? "mt-2 text-[10px] tracking-[0.2em] sm:text-xs sm:tracking-[0.24em]" : "mt-1 text-[9.5px] tracking-[0.24em] max-sm:hidden"}`}
        >
          Product knowledge assistant
        </p>
      </div>
    </div>
  );
}
