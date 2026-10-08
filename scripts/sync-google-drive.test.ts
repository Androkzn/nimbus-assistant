import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const script = path.resolve("scripts/sync-google-drive.mjs");
const servers: ReturnType<typeof createServer>[] = [];

function response(res: ServerResponse, body: unknown, status = 200, contentType = "application/json") {
  res.writeHead(status, { "content-type": contentType });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function startDriveMock(files: Array<{ id: string; name: string; mimeType: string; content?: string; parents?: string[] }>) {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.at(-1) === "files" && req.method === "GET") {
      const folderId = url.searchParams.get("q")?.match(/'([^']+)' in parents/)?.[1];
      return response(res, { files: files.filter((file) => (file.parents ?? ["root"]).includes(folderId ?? "")) });
    }
    const id = parts.at(-1);
    const file = files.find((item) => item.id === id);
    if (!file) return response(res, { error: "not found" }, 404);
    return response(res, file.content ?? "", 200, "text/markdown");
  });
  servers.push(server);
  return new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

function runSync(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe("Google Drive knowledge-base sync", () => {
  it("downloads nested markdown files and activates an atomic snapshot", async () => {
    const port = await startDriveMock([
      { id: "relay", name: "relay.md", mimeType: "text/markdown", content: "# Relay\n\n## Features\n\nAPI gateway.", parents: ["root"] },
      { id: "release-folder", name: "Release notes", mimeType: "application/vnd.google-apps.folder", parents: ["root"] },
      { id: "relay-release", name: "relay-release-notes.md", mimeType: "text/markdown", content: "# Relay releases\n\n## 4.2 (2026-06-10)\n\nSAML support.", parents: ["release-folder"] },
    ]);
    const root = mkdtempSync(path.join(os.tmpdir(), "nimbus-drive-sync-"));
    const output = path.join(root, "knowledge-base");
    const result = await runSync(["--folder", "root", "--output", output, "--activate"], {
      ...process.env,
      GOOGLE_DRIVE_ACCESS_TOKEN: "test-token",
      GOOGLE_DRIVE_API_BASE_URL: `http://127.0.0.1:${port}/drive/v3`,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Activated 2 Drive knowledge-base files");
    expect(readFileSync(path.join(output, "relay.md"), "utf8")).toContain("API gateway");
    expect(readFileSync(path.join(output, "relay-release-notes.md"), "utf8")).toContain("4.2 (2026-06-10)");
    expect(JSON.parse(readFileSync(path.join(output, ".drive-kb-manifest.json"), "utf8")).files).toHaveLength(2);
  });

  it("rejects unsupported files without replacing the last working snapshot", async () => {
    const port = await startDriveMock([{ id: "bad", name: "manual.pdf", mimeType: "application/pdf", parents: ["root"] }]);
    const root = mkdtempSync(path.join(os.tmpdir(), "nimbus-drive-sync-"));
    const output = path.join(root, "knowledge-base");
    const existing = path.join(output, "existing.md");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(output, { recursive: true });
    writeFileSync(existing, "last known good\n", "utf8");
    const result = await runSync(["--folder", "root", "--output", output, "--activate"], {
      ...process.env,
      GOOGLE_DRIVE_ACCESS_TOKEN: "test-token",
      GOOGLE_DRIVE_API_BASE_URL: `http://127.0.0.1:${port}/drive/v3`,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unsupported Drive files");
    expect(readFileSync(existing, "utf8")).toBe("last known good\n");
  });
});
