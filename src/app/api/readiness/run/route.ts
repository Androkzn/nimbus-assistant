import "server-only";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { liveLockHolder, RUN_LOCK_FILE, runnerAvailability } from "@/readiness/runner-gate";

/**
 * /api/readiness/run — local readiness runs (docs/requirements/06_Readiness_Report.md §3; I3, I5).
 *   GET  → { available, running, reason? }
 *   POST → 404 unless available (never on Vercel); 409 while a run is in progress; otherwise spawns
 *          `node scripts/readiness/run.mjs --stream` and streams its NDJSON ReadinessEvents.
 * Closing the page aborts the request, which stops the runner; its own cleanup restores the files Next rewrote.
 * Showcase-only: imports nothing from the chat path (src/server).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const productionDeployment = process.env.NIMBUS_DEV_PORTAL !== "1" && (process.env.NEXT_PUBLIC_VERCEL_ENV === "production" || process.env.VERCEL_ENV === "production");
/** After SIGTERM the runner stops its current stage and restores files; force-kill only if it hangs. */
const KILL_AFTER_MS = 30_000;

/** The run this server process started, if any (the lock file covers runs started elsewhere, e.g. the CLI). */
let active: ChildProcess | null = null;

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

function runInProgress(root: string): boolean {
  if (active && active.exitCode === null && active.signalCode === null) return true;
  let lockText: string | null = null;
  try {
    lockText = readFileSync(path.join(root, RUN_LOCK_FILE), "utf8");
  } catch {
    // no lock file: nothing running
  }
  return liveLockHolder(lockText, isAlive) !== null;
}

export function GET(): Response {
  if (productionDeployment) return new Response("Not Found", { status: 404, headers: NO_STORE });
  const { available, reason } = runnerAvailability(process.env);
  return Response.json({ available, running: available && runInProgress(process.cwd()), ...(reason ? { reason } : {}) }, { headers: NO_STORE });
}

export function POST(req: Request): Response {
  if (productionDeployment) return new Response("Not Found", { status: 404, headers: NO_STORE });
  if (!runnerAvailability(process.env).available) return new Response("Not Found", { status: 404, headers: NO_STORE });
  const root = process.cwd();
  if (runInProgress(root)) {
    return Response.json({ error: "A readiness run is already in progress on this machine." }, { status: 409, headers: NO_STORE });
  }

  // "Include live answers" unticked (?answers=0, the default): skip the live answer eval, so the run spends no provider tokens.
  const skipLiveEval = new URL(req.url).searchParams.get("answers") === "0";
  // stderr carries the runner's human-readable progress: shown in the `next dev` terminal.
  const child = spawn(process.execPath, [path.join(root, "scripts", "readiness", "run.mjs"), "--stream", ...(skipLiveEval ? ["--skip-live-eval"] : [])], {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  active = child;

  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, KILL_AFTER_MS).unref();
  };
  req.signal.addEventListener("abort", stop, { once: true });

  const encoder = new TextEncoder();
  /** False once the stream is closed, errored or cancelled by the client: nothing may be enqueued after that. */
  let open = true;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let pending = "";
      const send = (line: string) => {
        // The runner prints only NDJSON on stdout in --stream mode; anything else is dropped, not forwarded.
        if (open && line.startsWith("{")) controller.enqueue(encoder.encode(`${line}\n`));
      };
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        const lines = (pending + chunk).split("\n");
        pending = lines.pop() ?? "";
        lines.forEach(send);
      });
      child.once("close", () => {
        if (active === child) active = null;
        if (!open) return;
        send(pending);
        open = false;
        controller.close();
      });
      child.once("error", (err) => {
        if (active === child) active = null;
        if (open) {
          open = false;
          controller.error(err);
        }
      });
    },
    cancel() {
      open = false;
      stop();
    },
  });

  return new Response(body, { headers: { "content-type": "application/x-ndjson; charset=utf-8", ...NO_STORE } });
}
