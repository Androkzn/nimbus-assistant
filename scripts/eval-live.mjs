#!/usr/bin/env node
/**
 * Live answer eval (TRD §9): runs the golden set against a running app (local or deployed) with
 * real providers, grades every answer with deterministic checks, and writes a JSON + HTML report.
 * The HTML report is rewritten after every case, so it can be watched while the run is in flight.
 *
 *   npm run eval:live -- --base-url http://localhost:3000 --models gemini-flash-lite,openai-luna --open
 *
 * Checks per case: mustInclude / mustNotInclude patterns, "not in KB" phrase, citations present and
 * pointing at a shown passage, and whether the selected model answered (vs a fallback).
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gradeAnswer, readChatStream } from "../src/readiness/grade.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, all) => {
    if (arg.startsWith("--")) acc.push([arg.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "true" : all[i + 1]]);
    return acc;
  }, []),
);
const baseUrl = (args["base-url"] ?? process.env.EVAL_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const golden = JSON.parse(readFileSync("evals/golden-set.json", "utf8"));
const cases = args.cases ? golden.cases.filter((c) => args.cases.split(",").includes(c.id)) : golden.cases;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const sh = (cmd) => {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "local";
  }
};

const corpusHash = createHash("sha256")
  .update(readdirSync("knowledge-base").sort().map((f) => readFileSync(path.join("knowledge-base", f), "utf8")).join("\n"))
  .digest("hex")
  .slice(0, 10);
const promptHash = createHash("sha256").update(readFileSync("src/server/prompt/build.ts", "utf8")).digest("hex").slice(0, 10);

const catalog = await fetch(`${baseUrl}/api/models`)
  .then((r) => r.json())
  .catch(() => null);
if (!Array.isArray(catalog?.models)) {
  console.error(`${baseUrl}/api/models did not return a model catalog — is the NimbusStack assistant running there?`);
  process.exit(2);
}
const models = args.models ? args.models.split(",") : catalog.models.filter((m) => m.available).map((m) => m.id);
const nameOf = (id) => catalog.models.find((m) => m.id === id)?.displayName ?? id;

const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
const outDir = path.join("evals", "reports", stamp);
mkdirSync(outDir, { recursive: true });
const meta = {
  startedAt: new Date().toISOString(),
  platform: `node ${process.version}`,
  environment: baseUrl,
  build: sh("git rev-parse --short HEAD"),
  corpusHash,
  promptHash,
  goldenVersion: golden.version,
  pricingVersion: catalog.pricingVersion,
  models,
};
const results = [];

async function runCase(modelId, c) {
  const started = Date.now();
  let ttftMs = null;
  let answer = { text: "", done: null, error: null, sources: [], fallbacks: [] };
  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nimbus-test-run": "live-eval",
        ...(process.env.EVAL_BYPASS_TOKEN ? { "x-eval-token": process.env.EVAL_BYPASS_TOKEN } : {}),
      },
      body: JSON.stringify({ modelId, messages: [...(c.history ?? []), { role: "user", content: c.question }] }),
    });
    if (!res.ok) {
      answer.error = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
    } else {
      answer = readChatStream((await res.text()).split("\n"));
      if (answer.text) ttftMs = Date.now() - started;
    }
  } catch (e) {
    answer.error = String(e);
  }
  const { verdict, failed, warnings } = gradeAnswer(c, answer, golden.notInKbPattern, modelId);
  const done = answer.done;
  return {
    caseId: c.id,
    brief: c.brief,
    question: c.question,
    model: modelId,
    verdict,
    failed,
    warnings,
    answeredBy: done?.answeredBy ?? null,
    fallbacks: answer.fallbacks,
    ttftMs,
    totalMs: Date.now() - started,
    usage: done?.usage ?? null,
    costUSD: done?.costUSD ?? 0,
    answer: answer.text,
  };
}

function summary() {
  return models.map((m) => {
    const rows = results.filter((r) => r.model === m);
    const ttfts = rows.map((r) => r.ttftMs).filter((v) => v != null).sort((a, b) => a - b);
    return {
      model: m,
      done: rows.length,
      pass: rows.filter((r) => r.verdict === "pass").length,
      fallback: rows.filter((r) => r.verdict === "fallback").length,
      fail: rows.filter((r) => r.verdict === "fail").length,
      p50TtftMs: ttfts.length ? ttfts[Math.floor(ttfts.length / 2)] : null,
      costUSD: rows.reduce((s, r) => s + r.costUSD, 0),
    };
  });
}

const PILL = {
  pass: ["#1a7f37", "#dafbe1", "✓ PASS"],
  fail: ["#cf222e", "#ffebe9", "✗ FAIL"],
  fallback: ["#9a6700", "#fff8c5", "↪ FALLBACK"],
  pending: ["#57606a", "#f6f8fa", "○ PENDING"],
};
const pill = (v) => `<span class="badge" style="color:${PILL[v][0]};background:${PILL[v][1]}">${PILL[v][2]}</span>`;

function writeReport(finished) {
  const sum = summary();
  const metaRow = [meta.platform, `environment ${meta.environment}`, `build ${meta.build}`, `corpus ${meta.corpusHash}`, `prompt ${meta.promptHash}`, `golden v${meta.goldenVersion}`, `pricing ${meta.pricingVersion}`]
    .map((m) => `<span class="pill">${esc(m)}</span>`)
    .join(" · ");
  const head = models.map((m) => `<th>${esc(nameOf(m))}</th>`).join("");
  const body = cases
    .map((c) => {
      const cells = models
        .map((m) => {
          const r = results.find((x) => x.caseId === c.id && x.model === m);
          if (!r) return `<td>${pill("pending")}</td>`;
          return `<td>${pill(r.verdict)}<div class="muted">${r.ttftMs ?? "–"} ms · $${r.costUSD.toFixed(5)}${r.verdict === "fallback" ? ` · answered by ${esc(r.answeredBy)}` : ""}</div>${
            r.failed.length ? `<ul class="fails">${r.failed.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""
          }${r.warnings?.length ? `<ul class="warns">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}<details><summary>answer</summary><pre>${esc(r.answer || "(none)")}</pre></details></td>`;
        })
        .join("");
      return `<tr><td><b>${esc(c.id)}</b><div class="muted">${esc(c.brief)}</div></td><td class="q">${esc(c.question)}</td>${cells}</tr>`;
    })
    .join("");
  const sumRows = sum
    .map(
      (s) =>
        `<tr><td><b>${esc(nameOf(s.model))}</b></td><td>${s.pass}/${cases.length}</td><td>${s.fallback}</td><td>${s.fail}</td><td>${s.p50TtftMs ?? "–"} ms</td><td>$${s.costUSD.toFixed(4)}</td></tr>`,
    )
    .join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
${finished ? "" : '<meta http-equiv="refresh" content="3"/>'}<title>Live answer eval — NimbusStack Assistant</title>
<style>body{font:14px/1.45 -apple-system,system-ui,sans-serif;margin:24px;color:#1f2328}h1{font-size:20px;margin:0 0 6px}
.badge{font-size:11px;font-weight:600;padding:2px 6px;border-radius:10px;white-space:nowrap}.pill{background:#eaeef2;border-radius:4px;padding:0 4px;font-weight:600}
table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #d0d7de;padding:6px 8px;vertical-align:top;text-align:left}th{background:#f6f8fa}
.muted{color:#57606a;font-size:12px}.q{max-width:260px}.fails{margin:4px 0 0;padding-left:16px;color:#cf222e;font-size:12px}.warns{margin:4px 0 0;padding-left:16px;color:#9a6700;font-size:12px}pre{white-space:pre-wrap;font-size:12px;max-width:420px}</style></head>
<body><h1>Live answer eval — NimbusStack Product Assistant ${finished ? "" : "(running…)"}</h1><div class="muted">${metaRow}</div>
<p class="muted">Started ${esc(meta.startedAt)} · ${results.length}/${cases.length * models.length} answers graded</p>
<table><tr><th>Model</th><th>Pass</th><th>Fallback</th><th>Fail</th><th>p50 time to first word</th><th>Cost</th></tr>${sumRows}</table>
<table><tr><th>Case</th><th>Question</th>${head}</tr>${body}</table></body></html>`;
  writeFileSync(path.join(outDir, "index.html"), html);
  writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ meta, summary: sum, results }, null, 2));
}

writeReport(false);
console.log(`Live report: ${path.resolve(outDir, "index.html")}`);
if (args.open === "true") sh(`open "${path.resolve(outDir, "index.html")}"`);

// Under the readiness runner: one tagged line per graded answer (without the answer text), so its report shows
// each result as it lands. The tag keeps these lines apart from the human-readable output.
const readinessTag = process.env.READINESS_EVENT_TAG;
const reportPath = path.join(outDir, "results.json");
if (readinessTag) console.log(`${readinessTag}${JSON.stringify({ type: "stage-total", stage: "live-eval", total: models.length * cases.length })}`);

for (const m of models) {
  for (const c of cases) {
    const r = await runCase(m, c);
    results.push(r);
    writeReport(false);
    if (readinessTag) console.log(`${readinessTag}${JSON.stringify({ type: "eval-result", reportPath, environment: baseUrl, row: { ...r, answer: undefined } })}`);
    console.log(`${r.verdict.padEnd(8)} ${m.padEnd(18)} ${c.id.padEnd(13)} ${r.ttftMs ?? "–"}ms ${[...r.failed, ...r.warnings].join("; ")}`);
  }
}
writeReport(true);
console.table(summary().map((s) => ({ ...s, costUSD: Number(s.costUSD.toFixed(5)) })));
const failures = results.filter((r) => r.verdict === "fail").length;
console.log(`Report: ${path.resolve(outDir, "index.html")}`);
process.exitCode = failures ? 1 : 0;
