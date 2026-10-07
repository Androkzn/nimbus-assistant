#!/usr/bin/env node
/**
 * Security gate (BRD BR-20, brief auto-fail): no API key may reach the browser.
 * Scans every file the browser can download (.next/static) for vendor key shapes and for the
 * literal values of the provider key env vars when they are set. Exits non-zero on any hit.
 *
 *   node scripts/scan-client-bundle.mjs            # scan the current build
 *   node scripts/scan-client-bundle.mjs --self-test # prove the scanner catches a planted key
 */
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PATTERNS = [
  { name: "Anthropic key", re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "OpenAI key", re: /sk-(?!ant-)(proj-)?[A-Za-z0-9_-]{32,}/ },
  { name: "Google API key", re: /AIza[0-9A-Za-z_-]{35}/ },
];
const ENV_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

export function scan(dir, env = process.env) {
  const literals = ENV_VARS.map((name) => ({ name, value: env[name]?.trim() })).filter((v) => v.value && v.value.length >= 12);
  const hits = [];
  for (const file of walk(dir)) {
    const text = readFileSync(file, "utf8");
    for (const { name, re } of PATTERNS) if (re.test(text)) hits.push(`${path.relative(dir, file)}: ${name} pattern`);
    for (const { name, value } of literals) if (text.includes(value)) hits.push(`${path.relative(dir, file)}: value of ${name}`);
  }
  return hits;
}

if (process.argv.includes("--self-test")) {
  const dir = mkdtempSync(path.join(tmpdir(), "bundle-scan-"));
  writeFileSync(path.join(dir, "a.js"), `const k="sk-ant-api03-${"x".repeat(40)}";`);
  writeFileSync(path.join(dir, "b.js"), `const k="sk-proj-${"y".repeat(40)}";`);
  writeFileSync(path.join(dir, "c.js"), `const k="AIza${"z".repeat(35)}";`);
  writeFileSync(path.join(dir, "d.js"), `const k="${"q".repeat(30)}";`); // literal env value
  writeFileSync(path.join(dir, "clean.js"), `const ok="no secrets here";`);
  const hits = scan(dir, { OPENAI_API_KEY: "q".repeat(30) }).sort();
  const expected = ["a.js: Anthropic key pattern", "b.js: OpenAI key pattern", "c.js: Google API key pattern", "d.js: value of OPENAI_API_KEY"];
  if (JSON.stringify(hits) !== JSON.stringify(expected)) {
    console.error("self-test FAILED", { hits, expected });
    process.exit(1);
  }
  console.log("self-test passed: all 4 planted keys detected, clean file not flagged");
  process.exit(0);
}

const target = path.join(process.cwd(), ".next", "static");
try {
  statSync(target);
} catch {
  console.error(`No build found at ${target}. Run \`npm run build\` first.`);
  process.exit(1);
}
const hits = scan(target);
if (hits.length) {
  console.error("❌ API key material found in client bundle:\n" + hits.map((h) => `  - ${h}`).join("\n"));
  process.exit(1);
}
console.log(`✅ Client bundle clean: no API key patterns or key values in ${path.relative(process.cwd(), target)}`);
