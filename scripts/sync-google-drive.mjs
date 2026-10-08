import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_FOLDER_ID = "1jZtIbeRwf58SPUkJxUkht_M8Os4UBlF6";
const DEFAULT_OUTPUT_DIR = path.join(process.cwd(), ".generated", "knowledge-base");
const GOOGLE_DOC = "application/vnd.google-apps.document";
const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";
const GOOGLE_FOLDER = "application/vnd.google-apps.folder";

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

/** Convert exported Google Docs HTML into the markdown shape used by the local corpus parser. */
export function htmlToMarkdown(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<h1[^>]*>/gi, "\n# ")
      .replace(/<h2[^>]*>/gi, "\n## ")
      .replace(/<h3[^>]*>/gi, "\n### ")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>|<\/div>|<\/h[1-3]>|<\/li>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

function safeName(name) {
  return name.replace(/[\\/]/g, "-").replace(/\s+/g, " ").trim();
}

function outputName(file, usedNames) {
  const base = safeName(file.name);
  const extension = path.extname(base).toLowerCase();
  const normalized = extension === ".md" || extension === ".markdown" ? `${base.slice(0, -extension.length)}.md` : `${base}.md`;
  if (!usedNames.has(normalized)) {
    usedNames.add(normalized);
    return normalized;
  }
  const unique = `${normalized.slice(0, -3)}--${file.id.slice(0, 8)}.md`;
  usedNames.add(unique);
  return unique;
}

function supportedFile(file) {
  const extension = path.extname(file.name).toLowerCase();
  return (
    extension === ".md" ||
    extension === ".markdown" ||
    extension === ".txt" ||
    extension === ".html" ||
    extension === ".htm" ||
    extension === ".csv" ||
    extension === ".tsv" ||
    file.mimeType === GOOGLE_DOC ||
    file.mimeType === GOOGLE_SHEET
  );
}

function authToken() {
  if (process.env.GOOGLE_DRIVE_ACCESS_TOKEN) return Promise.resolve(process.env.GOOGLE_DRIVE_ACCESS_TOKEN);
  let refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
  if (!refreshToken && process.platform === "darwin") {
    const service = process.env.GOOGLE_DRIVE_KEYCHAIN_SERVICE ?? "nimbus-assistant-google-drive";
    try {
      refreshToken = execFileSync("security", ["find-generic-password", "-s", service, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      // The caller receives the actionable configuration error below.
    }
  }
  if (!refreshToken || !process.env.GOOGLE_DRIVE_CLIENT_ID || !process.env.GOOGLE_DRIVE_CLIENT_SECRET) {
    throw new Error("Drive authentication is not configured. Set GOOGLE_DRIVE_ACCESS_TOKEN or a refresh token with client ID and secret.");
  }
  return fetch(process.env.GOOGLE_DRIVE_TOKEN_URL ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_DRIVE_CLIENT_ID,
      client_secret: process.env.GOOGLE_DRIVE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  }).then(async (response) => {
    if (!response.ok) throw new Error(`Drive token exchange failed (${response.status}).`);
    const body = await response.json();
    if (!body.access_token) throw new Error("Drive token exchange returned no access token.");
    return body.access_token;
  });
}

function apiUrl(resource, params = {}) {
  const base = process.env.GOOGLE_DRIVE_API_BASE_URL ?? "https://www.googleapis.com/drive/v3";
  const url = new URL(`${base.replace(/\/$/, "")}/${resource.replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

async function driveRequest(token, resource, params = {}, options = {}) {
  const response = await fetch(apiUrl(resource, params), { headers: { authorization: `Bearer ${token}`, ...(options.headers ?? {}) } });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200).replace(/\s+/g, " ");
    throw new Error(`Drive API ${response.status}: ${detail}`);
  }
  return response;
}

async function listChildren(token, folderId) {
  const files = [];
  let pageToken;
  do {
    const response = await driveRequest(token, "files", {
      q: `'${folderId}' in parents and trashed = false`,
      pageSize: "1000",
      fields: "nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,webViewLink)",
      orderBy: "name",
      includeItemsFromAllDrives: "true",
      supportsAllDrives: "true",
      spaces: "drive",
      ...(pageToken ? { pageToken } : {}),
    });
    const body = await response.json();
    files.push(...(body.files ?? []));
    pageToken = body.nextPageToken;
  } while (pageToken);
  return files;
}

async function collectFiles(token, folderId, parentPath = "", visited = new Set()) {
  if (visited.has(folderId)) return [];
  visited.add(folderId);
  const result = [];
  for (const file of await listChildren(token, folderId)) {
    if (file.mimeType === GOOGLE_FOLDER) {
      result.push(...(await collectFiles(token, file.id, path.join(parentPath, safeName(file.name)), visited)));
    } else {
      result.push({ ...file, parentPath });
    }
  }
  return result;
}

async function downloadMarkdown(token, file) {
  if (file.mimeType === GOOGLE_DOC) {
    const response = await driveRequest(token, `files/${file.id}/export`, { mimeType: "text/html" });
    return htmlToMarkdown(await response.text());
  }
  if (file.mimeType === GOOGLE_SHEET) {
    const response = await driveRequest(token, `files/${file.id}/export`, { mimeType: "text/csv" });
    return `# ${file.name}\n\n${await response.text()}`.trim();
  }
  const response = await driveRequest(token, `files/${file.id}`, { alt: "media" });
  const text = await response.text();
  return path.extname(file.name).toLowerCase() === ".html" || path.extname(file.name).toLowerCase() === ".htm" ? htmlToMarkdown(text) : text.trim();
}

async function syncDrive({ folderId, outputDir, activate }) {
  const token = await authToken();
  const files = await collectFiles(token, folderId);
  const unsupported = files.filter((file) => !supportedFile(file));
  if (unsupported.length > 0) throw new Error(`Unsupported Drive files: ${unsupported.map((file) => `${file.name} (${file.mimeType})`).join(", ")}`);
  if (files.length === 0) throw new Error("The Drive knowledge-base folder contains no supported files.");

  const parent = path.dirname(outputDir);
  const base = path.basename(outputDir);
  const staging = path.join(parent, `.${base}.staging-${process.pid}`);
  const previous = path.join(parent, `.${base}.previous`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  const usedNames = new Set();
  const manifestFiles = [];
  try {
    for (const file of files) {
      const content = await downloadMarkdown(token, file);
      if (!content.trim()) throw new Error(`Drive file is empty: ${file.name}`);
      const name = outputName(file, usedNames);
      writeFileSync(path.join(staging, name), `${content.trim()}\n`, "utf8");
      manifestFiles.push({
        id: file.id,
        name: file.name,
        sourcePath: file.parentPath || null,
        outputFile: name,
        mimeType: file.mimeType,
        modifiedTime: file.modifiedTime ?? null,
        md5Checksum: file.md5Checksum ?? null,
        webViewLink: file.webViewLink ?? null,
      });
    }
    const manifest = {
      schemaVersion: 1,
      source: "google-drive",
      folderId,
      syncedAt: new Date().toISOString(),
      files: manifestFiles,
    };
    writeFileSync(path.join(staging, ".drive-kb-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    if (activate) {
      rmSync(previous, { recursive: true, force: true });
      if (existsSync(outputDir)) renameSync(outputDir, previous);
      renameSync(staging, outputDir);
      rmSync(previous, { recursive: true, force: true });
    }
    return { files: manifestFiles, outputDir: activate ? outputDir : staging, activated: activate };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function run(argv = process.argv.slice(2)) {
  const folderId = argValue(argv, "--folder") ?? process.env.GOOGLE_DRIVE_FOLDER_ID ?? DEFAULT_FOLDER_ID;
  const outputDir = path.resolve(argValue(argv, "--output") ?? DEFAULT_OUTPUT_DIR);
  const activate = hasFlag(argv, "--activate");
  const result = await syncDrive({ folderId, outputDir, activate });
  console.log(`${result.activated ? "Activated" : "Staged"} ${result.files.length} Drive knowledge-base files at ${result.outputDir}.`);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
