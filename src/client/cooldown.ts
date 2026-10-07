/**
 * Rate-limit countdowns (BR-21 provider limits, BR-26 this app's own limit). The server states the wait once
 * ("wait about N seconds"); the browser keeps that number live so the copy and the button never disagree.
 */

/** Absolute deadline for a relative wait, so countdowns survive re-renders and remounts. */
export function deadlineIn(seconds: number, now: number = Date.now()): number {
  return now + seconds * 1000;
}

export function secondsLeft(untilMs: number, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((untilMs - now) / 1000));
}

/** "45s" under a minute, "2:47" from a minute up. */
export function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const WAIT = /\b([Ww]ait(?: about)?) \d+ seconds?/;

/** Rewrites the server's "Wait about N seconds" with the time actually left; once it's up, just "Try again". */
export function liveWaitCopy(message: string, left: number): string {
  if (left > 0) return message.replace(WAIT, (_m, verb: string) => `${verb} ${left} second${left === 1 ? "" : "s"}`);
  return message.replace(/\b[Ww]ait(?: about)? \d+ seconds? and try again/, "Try again");
}
