import { useEffect, useState } from "react";
import { secondsLeft } from "./cooldown";

/**
 * Whole seconds until `untilMs`, re-rendering once a second and stopping at zero; 0 without a deadline.
 * Counts against an absolute deadline, so a button that unmounts and comes back doesn't restart the wait.
 */
export function useCountdown(untilMs: number | null): number {
  const [left, setLeft] = useState(() => (untilMs === null ? 0 : secondsLeft(untilMs)));

  useEffect(() => {
    if (untilMs === null) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const s = secondsLeft(untilMs);
      setLeft(s);
      if (s > 0) timer = setTimeout(tick, 1000);
    };
    timer = setTimeout(tick, 0);
    return () => clearTimeout(timer);
  }, [untilMs]);

  return untilMs === null ? 0 : left;
}
