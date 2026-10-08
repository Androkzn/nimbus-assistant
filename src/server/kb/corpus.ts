import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export const PRODUCTS = ["relay", "vault", "pulse", "ledger"] as const;
export type Product = (typeof PRODUCTS)[number];

/** One retrievable unit: an H2 section of a knowledge-base document, tables kept whole. */
export interface Chunk {
  id: string;
  file: string;
  product: Product | null;
  docTitle: string;
  /** "updated" date of the document, or the release date for a release-notes section. */
  docDate: string | null;
  section: string;
  /** Release version for release-notes sections, e.g. "4.2". */
  version: string | null;
  /** Header line + section body. This is what is scored and what the model sees. */
  text: string;
}

const REPOSITORY_KB_DIR = path.join(process.cwd(), "knowledge-base");
const GENERATED_KB_DIR = path.join(process.cwd(), ".generated", "knowledge-base");

/** Prefer the validated Drive snapshot staged during a deployment build. */
export function corpusDirectory(): string {
  if (process.env.NIMBUS_KB_DIR) return path.resolve(process.env.NIMBUS_KB_DIR);
  return existsSync(GENERATED_KB_DIR) ? GENERATED_KB_DIR : REPOSITORY_KB_DIR;
}

export function corpusSource(): { kind: "google-drive" | "repository"; revision: string | null } {
  const directory = corpusDirectory();
  const manifestPath = path.join(directory, ".drive-kb-manifest.json");
  if (!existsSync(manifestPath)) return { kind: "repository", revision: null };
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { syncedAt?: string; files?: Array<{ id: string; modifiedTime?: string | null; md5Checksum?: string | null }> };
    const revision = manifest.files?.map((file) => `${file.id}:${file.modifiedTime ?? ""}:${file.md5Checksum ?? ""}`).sort().join("|") ?? null;
    return { kind: "google-drive", revision };
  } catch {
    return { kind: "google-drive", revision: null };
  }
}

function productFromFile(file: string): Product | null {
  const prefix = file.split(/[-.]/)[0];
  return (PRODUCTS as readonly string[]).includes(prefix) ? (prefix as Product) : null;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Split one markdown document into section chunks. Pure — unit-tested against the real corpus. */
export function parseDocument(file: string, markdown: string): Chunk[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const titleLine = lines.find((l) => l.startsWith("# "));
  const docTitle = titleLine ? titleLine.slice(2).trim() : file;
  const docDate = markdown.match(/updated (\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
  const product = productFromFile(file);

  const sections: { heading: string; body: string[] }[] = [{ heading: "Overview", body: [] }];
  for (const line of lines) {
    if (line.startsWith("# ")) continue;
    if (line.startsWith("## ")) {
      sections.push({ heading: line.slice(3).trim(), body: [] });
    } else {
      sections[sections.length - 1].body.push(line);
    }
  }

  return sections
    .map(({ heading, body }) => ({ heading, body: body.join("\n").trim() }))
    .filter(({ body }) => body.length > 0)
    .map(({ heading, body }) => {
      // Release-notes headings look like "4.2 (2026-06-10)".
      const release = heading.match(/^(\d+\.\d+)\s*\((\d{4}-\d{2}-\d{2})\)$/);
      const version = release?.[1] ?? null;
      const date = release?.[2] ?? docDate;
      const header = `${docTitle} — ${heading}${date ? ` (${release ? "released" : "updated"} ${date})` : ""}`;
      return {
        id: `${file}#${slug(heading)}`,
        file,
        product,
        docTitle,
        docDate: date,
        section: heading,
        version,
        text: `${header}\n${body}`,
      };
    });
}

let cache: Chunk[] | null = null;

/** Load and chunk every knowledge-base document once per process. */
export function loadCorpus(): Chunk[] {
  if (cache) return cache;
  const directory = corpusDirectory();
  cache = readdirSync(directory)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .flatMap((file) => parseDocument(file, readFileSync(path.join(directory, file), "utf8")));
  return cache;
}
