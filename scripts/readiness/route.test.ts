import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "../../src/app/api/readiness/run/route";
import { LOCK_FILE } from "./lib.mjs";

/**
 * /api/readiness/run handler contract (spec 06 I3, I5; RDY-005), with no dev server and no real run: the handler
 * resolves the runner from process.cwd(), so cwd points at a temp project whose scripts/readiness/run.mjs is a fake.
 */
let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "readiness-route-"));
  mkdirSync(path.join(root, "scripts", "readiness"), { recursive: true });
  vi.spyOn(process, "cwd").mockReturnValue(root);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const fakeRunner = (source: string) => writeFileSync(path.join(root, "scripts", "readiness", "run.mjs"), source);
const post = (signal?: AbortSignal) => POST(new Request("http://localhost/api/readiness/run", { method: "POST", signal }));

describe("unavailable (RDY-005)", () => {
  it("POST is a 404 on Vercel, even with READINESS_RUNNER=1, and GET says why", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("READINESS_RUNNER", "1");
    expect(post().status).toBe(404);
    const res = GET();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ available: false, running: false, reason: expect.stringMatching(/Vercel/) });
  });

  it("POST is a 404 in a production server without READINESS_RUNNER", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("READINESS_RUNNER", "");
    expect(post().status).toBe(404);
  });
});

describe("available (READINESS_RUNNER=1)", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("READINESS_RUNNER", "1");
  });

  it("409 while another run holds the lock, and GET reports it running", async () => {
    mkdirSync(path.join(root, "readiness"), { recursive: true });
    writeFileSync(path.join(root, LOCK_FILE), JSON.stringify({ pid: process.pid, runId: "other", startedAt: new Date().toISOString() }));
    const res = post();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: expect.stringMatching(/already in progress/) });
    expect(await GET().json()).toEqual({ available: true, running: true });
  });

  it("streams the runner's NDJSON lines (and nothing else) as application/x-ndjson", async () => {
    fakeRunner(`
      if (!process.argv.includes("--stream")) process.exit(3);
      process.stdout.write('{"type":"stage-start","stage":"lint","at":"t"}\\nnot an event\\n');
      setTimeout(() => process.stdout.write('{"type":"run-end","status":"passed","durationMs":1,"at":"t"}'), 20);
    `);
    const res = post();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe('{"type":"stage-start","stage":"lint","at":"t"}\n{"type":"run-end","status":"passed","durationMs":1,"at":"t"}\n');
  });

  it("closing the page (request aborted) sends the runner SIGTERM, so its cleanup runs", async () => {
    const marker = path.join(root, "got-sigterm");
    fakeRunner(`
      import { writeFileSync } from "node:fs";
      process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(marker)}, "1"); process.exit(143); });
      process.stdout.write('{"type":"stage-start","stage":"build","at":"t"}\\n');
      setInterval(() => {}, 1000);
    `);
    const controller = new AbortController();
    const res = post(controller.signal);
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 5000 });
    await reader.cancel().catch(() => {});
  });
});
