import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Isolation rule I1 (06_Readiness_Report.md §2): the readiness report reads the product; the product never
 * imports the report. The header button links to /readiness by URL, which is not an import.
 */

const TOOLING_DIRS = ["src/readiness", "src/components/readiness", "src/app/readiness", "src/app/api/readiness"];

const inTooling = (repoPath: string) => TOOLING_DIRS.some((dir) => repoPath === dir || repoPath.startsWith(`${dir}/`));

/** Every module specifier a file imports: import/export-from, import type, dynamic import(), require(). Comments and strings are ignored. */
function specifiers(source: string): string[] {
  return ts.preProcessFile(source, true, true).importedFiles.map((f) => f.fileName);
}

/** Repo-relative path a specifier points at, or null for a package import. */
function target(fromFile: string, specifier: string): string | null {
  if (specifier.startsWith("@/")) return path.posix.join("src", specifier.slice(2));
  if (specifier.startsWith("./") || specifier.startsWith("../")) return path.posix.join(path.posix.dirname(fromFile), specifier);
  if (specifier.startsWith("src/")) return path.posix.normalize(specifier);
  return null;
}

function toolingImports(file: string, source: string): string[] {
  return specifiers(source).filter((s) => {
    const resolved = target(file, s);
    return resolved !== null && inTooling(resolved);
  });
}

const productFiles = readdirSync("src", { recursive: true, encoding: "utf8" })
  .map((f) => `src/${f.split(path.sep).join("/")}`)
  .filter((f) => /\.tsx?$/.test(f) && !inTooling(f))
  .sort();

describe("RDY-007 / I1: the chat app never imports the readiness report", () => {
  it("RDY-007 / I1: the scanner catches every import form and ignores links, comments and strings", () => {
    const fixture = [
      'import { manifest } from "@/readiness/manifest";',
      'import type { ReadinessEvent } from "../readiness/schema";',
      'export * from "@/components/readiness/Panel";',
      'const Page = dynamic(() => import("@/app/readiness/page"));',
      'const route = require("../app/api/readiness/run/route");',
      'import { ok } from "@/server/config/models";',
      '// import { no } from "@/readiness/commented-out";',
      'const href = "/readiness?autostart=1";',
    ].join("\n");
    expect(toolingImports("src/components/Header.tsx", fixture)).toEqual([
      "@/readiness/manifest",
      "../readiness/schema",
      "@/components/readiness/Panel",
      "@/app/readiness/page",
      "../app/api/readiness/run/route",
    ]);
  });

  it("RDY-007 / I1: scans the whole product tree, not a handful of files", () => {
    for (const f of ["src/server/chat/handleChat.ts", "src/shared/contracts.ts", "src/client/stream.ts", "src/components/ChatApp.tsx", "src/app/layout.tsx"]) {
      expect(productFiles).toContain(f);
    }
    expect(productFiles.some((f) => inTooling(f))).toBe(false);
  });

  it("RDY-007 / I1: no file under src/ outside the readiness folders imports from them", () => {
    const violations = productFiles.flatMap((file) => toolingImports(file, readFileSync(file, "utf8")).map((s) => `${file} → ${s}`));
    expect(violations, "product code must not import the readiness report (spec I1); link to /readiness instead").toEqual([]);
  });
});
