/** Display helpers for the readiness report. Pure; no React. */

/** 0.4 s · 12.3 s · 2m 05s · 1h 02m */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const totalS = Math.round(s);
  const m = Math.floor(totalS / 60);
  const rem = totalS % 60;
  if (m < 60) return `${m}m ${String(rem).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "7 Oct 2026, 20:41 UTC" — always UTC so a recorded run reads the same everywhere. */
export function formatUtc(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

/** "http://localhost:3005" → "localhost:3005"; leaves non-URLs alone. */
export function shortOrigin(value: string | undefined): string {
  if (!value) return "—";
  try {
    const u = new URL(value);
    return u.host;
  } catch {
    return value;
  }
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The file part of a result for display: drop long repo prefixes but keep the spec name. */
export function shortFile(file: string): string {
  if (file.length <= 48) return file;
  const parts = file.split("/");
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : file;
}

/** The last segment of a " › " chain, the test's own title. */
export function leafName(fullName: string): string {
  const parts = fullName.split(" › ");
  return parts[parts.length - 1] ?? fullName;
}

/** The describe chain before the title, if any. */
export function parentName(fullName: string): string | undefined {
  const parts = fullName.split(" › ");
  return parts.length > 1 ? parts.slice(0, -1).join(" › ") : undefined;
}

/** Stable, URL-safe id fragment: "Edge cases (E1–E10)" → "edge-cases-e1-e10". */
export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** "Core requirements (R1–R5)" → ["Core requirements", "(R1–R5)"], so the parenthetical can stay on one line. */
export function splitParenthetical(name: string): [string, string | undefined] {
  const i = name.lastIndexOf(" (");
  return i > 0 && name.endsWith(")") ? [name.slice(0, i), name.slice(i + 1)] : [name, undefined];
}
