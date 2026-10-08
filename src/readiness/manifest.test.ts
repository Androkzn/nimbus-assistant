import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import models from "../../config/models.json";
import golden from "../../evals/golden-set.json";
import { checksFor, GROUPS, manifest, type Check, type Manifest, type Requirement } from "./manifest";
import { PROBES } from "./probes";
import { PROBE_IDS, type TestResult } from "./schema";

/**
 * Traceability invariants (06_Readiness_Report.md §5): no acceptance row without a brief item, no brief item
 * without a check, no check without a real test, no test without a check. Sources of truth are read from disk
 * at test time, so editing the matrix, the golden set or a test title without the manifest fails here.
 */

// ─── Sources of truth ────────────────────────────────────────────────────────────────────────────

const MATRIX = readFileSync("docs/requirements/04_Acceptance_Matrix.md", "utf8");
const MATRIX_ROWS = [...MATRIX.matchAll(/^\| (NKA-[A-Z]+-\d{3}) \| ([^|]+?) \|/gm)].map(([, id, brief]) => ({ id, brief: brief.trim() }));
const SPEC = readFileSync("docs/requirements/06_Readiness_Report.md", "utf8");
const RDY_IDS = [...SPEC.slice(SPEC.indexOf("## 6.")).matchAll(/^\| (RDY-\d{3}) \|/gm)].map(([, id]) => id);
const GOLDEN: { id: string; brief: string; question: string }[] = golden.cases;

const { requirements, checks } = manifest;
const owners = (acceptanceId: string) => requirements.filter((r) => r.acceptance.includes(acceptanceId));
const coversRequirement = (c: Check, r: Requirement) => c.covers.some((id) => id === r.id || r.acceptance.includes(id));
const KNOWN_IDS = new Set([...requirements.map((r) => r.id), ...requirements.flatMap((r) => r.acceptance)]);
const duplicates = (ids: string[]) => ids.filter((id, i) => ids.indexOf(id) !== i);

/** The report's own tests: claimed file by file, because their titles belong to the tooling authors. */
const TOOLING = [/^src\/readiness\//, /^src\/components\/readiness\//, /^src\/app\/readiness\//, /^src\/app\/api\/readiness\//, /^scripts\/readiness\//, /^e2e\/readiness/];
const isTooling = (file: string) => TOOLING.some((re) => re.test(file));

// ─── Test titles, read statically from the test sources ─────────────────────────────────────────

/** Stands in for a generated part of a title: an each() placeholder or a template-literal `${…}`. */
const GENERATED = "…";
const SUITE_FNS = new Set(["describe", "suite"]);
const TEST_FNS = new Set(["it", "test"]);
const MODIFIERS = new Set(["each", "for", "skip", "only", "todo", "fails", "concurrent", "sequential", "skipIf", "runIf", "serial", "parallel", "fixme", "fail", "slow"]);

/** `it(…)`, `it.each(rows)(…)`, `test.describe.serial(…)` → suite or test; hooks, steps and everything else → null. */
function kindOf(call: ts.CallExpression): { kind: "suite" | "test"; printf: boolean } | null {
  const names: string[] = [];
  let callee: ts.Expression = call.expression;
  for (;;) {
    if (ts.isCallExpression(callee)) callee = callee.expression;
    else if (ts.isPropertyAccessExpression(callee)) {
      names.unshift(callee.name.text);
      callee = callee.expression;
    } else break;
  }
  if (!ts.isIdentifier(callee)) return null;
  const printf = names.includes("each") || names.includes("for");
  const modifiersOnly = (list: string[]) => list.every((n) => MODIFIERS.has(n));
  if (SUITE_FNS.has(callee.text) && modifiersOnly(names)) return { kind: "suite", printf };
  if (!TEST_FNS.has(callee.text)) return null;
  if (names[0] === "describe" && modifiersOnly(names.slice(1))) return { kind: "suite", printf }; // Playwright test.describe
  return modifiersOnly(names) ? { kind: "test", printf } : null;
}

function unwrap(e: ts.Expression): ts.Expression {
  return ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e;
}

/** `for (const c of cases) it(c.id, …)` → every `id: "…"` in the `cases` array literal of the same file. */
function titlesFromTable(item: string, prop: string, call: ts.Node): string[] | null {
  let table: string | null = null;
  for (let n: ts.Node | undefined = call.parent; n && !table; n = n.parent) {
    if (ts.isForOfStatement(n) && ts.isVariableDeclarationList(n.initializer) && ts.isIdentifier(n.expression)) {
      const bound = n.initializer.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === item);
      if (bound) table = n.expression.text;
    }
  }
  if (!table) return null;
  const findRows = (n: ts.Node): ts.ArrayLiteralExpression | undefined => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === table && n.initializer) {
      const init = unwrap(n.initializer);
      if (ts.isArrayLiteralExpression(init)) return init;
    }
    return ts.forEachChild(n, findRows);
  };
  const rows = findRows(call.getSourceFile());
  if (!rows) return null;
  return rows.elements.map((row) => {
    if (!ts.isObjectLiteralExpression(row)) return GENERATED;
    const field = row.properties.find((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === prop);
    return field && ts.isPropertyAssignment(field) && ts.isStringLiteralLike(field.initializer) ? field.initializer.text : GENERATED;
  });
}

function titlesOf(arg: ts.Expression | undefined, printf: boolean, call: ts.CallExpression): string[] {
  if (!arg) return [GENERATED];
  if (ts.isStringLiteralLike(arg)) {
    // Vitest each(): %s %d %i %f %j %o %O %c %# %$ and $field are filled in per row; %% is a literal %.
    return [printf ? arg.text.replace(/%%|%[sdifjoOc#$]|\$[A-Za-z_]\w*(?:\.\w+)*/g, (m) => (m === "%%" ? "%" : GENERATED)) : arg.text];
  }
  if (ts.isTemplateExpression(arg)) return [arg.head.text + arg.templateSpans.map((s) => GENERATED + s.literal.text).join("")];
  if (ts.isPropertyAccessExpression(arg) && ts.isIdentifier(arg.expression)) return titlesFromTable(arg.expression.text, arg.name.text, call) ?? [GENERATED];
  return [GENERATED];
}

/** Every test's fullName as the reporters build it (describe chain + title, joined with " › "); generated parts read "…". */
function testTitles(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node, chain: string[]): void => {
    const kind = ts.isCallExpression(node) ? kindOf(node) : null;
    if (kind && ts.isCallExpression(node)) {
      const own = titlesOf(node.arguments[0], kind.printf, node);
      const full = chain.flatMap((prefix) => own.map((title) => (prefix ? `${prefix} › ${title}` : title)));
      if (kind.kind === "test") found.push(...full);
      else node.arguments.slice(1).forEach((arg) => visit(arg, full));
      return;
    }
    ts.forEachChild(node, (child) => visit(child, chain));
  };
  visit(sf, [""]);
  return found;
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).map((f) => `${dir}/${f.split(path.sep).join("/")}`);
}

const TEST_FILES = [
  ...filesUnder("src").filter((f) => f.endsWith(".test.ts")),
  ...filesUnder("scripts").filter((f) => f.endsWith(".test.ts")),
  ...filesUnder("e2e").filter((f) => /\.(spec|test)\.ts$/.test(f)),
].sort();
const REPO_TESTS = TEST_FILES.filter((f) => !isTooling(f)).flatMap((file) =>
  testTitles(file, readFileSync(file, "utf8")).map((fullName) => ({ file, fullName })),
);

const asResult = ({ file, fullName }: { file: string; fullName: string }): TestResult => ({
  id: `${file}::${fullName}`,
  stage: file.startsWith("e2e/") ? "e2e" : "unit",
  file,
  fullName,
  status: "passed",
  durationMs: 0,
  source: "live",
});
const evalResult = (caseId: string, modelId: string): TestResult => ({
  id: `eval::${caseId}::${modelId}`,
  stage: "live-eval",
  file: "evals/reports/2026-10-07-21-16-33/results.json",
  fullName: `${caseId} — ${GOLDEN.find((c) => c.id === caseId)?.question ?? ""}`,
  status: "passed",
  durationMs: 0,
  source: "recorded",
});
const only = (check: Check): Manifest => ({ ...manifest, checks: [check] });
const list = (items: string[]) => items.map((i) => `  - ${i}`).join("\n");

// ─── Invariants ──────────────────────────────────────────────────────────────────────────────────

describe("test title extraction (used by the invariants below)", () => {
  it("resolves describe chains, each() placeholders, template literals and data-driven titles, and skips hooks and steps", () => {
    const source = [
      'describe("outer", () => {',
      '  it("plain", () => {});',
      '  it.each([[1, "a"]])("row %i is %s (100%%)", () => {});',
      '  describe(`nested ${x}`, () => { test.skip("deep", () => {}); });',
      "  beforeEach(() => {});",
      "});",
      'const cases: Case[] = [{ id: "CASE-1 first" }, { id: "CASE-2 second" }];',
      "for (const c of cases) it(c.id, () => {});",
      'test.describe("pw", () => { test("t", async () => { await test.step("a step", async () => {}); }); });',
      "test.beforeEach(async () => {});",
    ].join("\n");
    expect(testTitles("fixture.test.ts", source)).toEqual([
      "outer › plain",
      "outer › row … is … (100%)",
      "outer › nested … › deep",
      "CASE-1 first",
      "CASE-2 second",
      "pw › t",
    ]);
  });

  it("finds the repo's tests, including generated and data-driven titles", () => {
    const names = REPO_TESTS.map((t) => t.fullName);
    expect(REPO_TESTS.length).toBeGreaterThan(100);
    expect(names).toContain("POST /api/chat › NKA-CHAT-005: rejects a … message with 400 and never calls a provider");
    expect(names).toContain("retrieval eval (golden cases) › NKA-CHAT-008 E1 'and Ledger?' keeps the topic (pricing)");
    expect(names).toContain("NKA-USG-006: export downloads usage as CSV and JSON");
  });
});

describe("traceability manifest (06_Readiness_Report.md §5)", () => {
  it("RDY-004: reads the acceptance matrix and the readiness acceptance table", () => {
    expect(MATRIX_ROWS.length).toBeGreaterThan(50);
    expect(duplicates(MATRIX_ROWS.map((r) => r.id))).toEqual([]);
    expect(MATRIX_ROWS.map((r) => r.id)).toEqual(expect.arrayContaining(["NKA-GRD-001", "NKA-CHAT-007", "NKA-OPS-002"]));
    expect(RDY_IDS).toEqual(expect.arrayContaining(["RDY-001", "RDY-007"]));
  });

  it("RDY-004 (a): every acceptance row in 04_Acceptance_Matrix.md and 06 §6 is attached to a brief item", () => {
    const unattached = [...MATRIX_ROWS.map((r) => r.id), ...RDY_IDS].filter((id) => owners(id).length === 0);
    expect(unattached, `acceptance rows with no brief item — attach them in src/readiness/manifest.ts:\n${list(unattached)}`).toEqual([]);
  });

  it("RDY-004 (a): requirements list only acceptance ids that exist (NKA rows in the matrix, RDY rows in 06 §6)", () => {
    const known = new Set([...MATRIX_ROWS.map((r) => r.id), ...RDY_IDS]);
    const unknown = requirements.flatMap((r) => r.acceptance.filter((id) => !known.has(id)).map((id) => `${r.id} → ${id}`));
    expect(unknown).toEqual([]);
  });

  it("RDY-004 (a): each row is attached to every brief item its matrix 'Brief' column names", () => {
    const satisfied = (token: string, attached: Requirement[]) => {
      if (token === "—") return attached.some((r) => r.group === GROUPS.derived);
      if (token === "Deliv.") return attached.some((r) => r.group === GROUPS.deliverables);
      return attached.some((r) => r.id === (token === "Rule" ? "RULE" : token));
    };
    const wrong = MATRIX_ROWS.filter((row) => !row.brief.split("/").every((t) => satisfied(t.trim(), owners(row.id)))).map(
      (row) => `${row.id} (Brief ${row.brief}) is attached to ${owners(row.id).map((r) => r.id).join(", ") || "nothing"}`,
    );
    expect(wrong).toEqual([]);
  });

  it("RDY-004 (c): requirement ids and check ids are unique", () => {
    expect(duplicates(requirements.map((r) => r.id))).toEqual([]);
    expect(duplicates(checks.map((c) => c.id))).toEqual([]);
  });

  it("RDY-004 (b): every brief item is covered by at least one check", () => {
    const uncovered = requirements.filter((r) => !checks.some((c) => coversRequirement(c, r))).map((r) => r.id);
    expect(uncovered, `requirements with no evidence:\n${list(uncovered)}`).toEqual([]);
  });

  it("RDY-004 (c): every check covers at least one requirement, and only ids that exist", () => {
    const wrong = checks.flatMap((c) => [
      ...(requirements.some((r) => coversRequirement(c, r)) ? [] : [`${c.id} covers no requirement`]),
      ...c.covers.filter((id) => !KNOWN_IDS.has(id)).map((id) => `${c.id} covers unknown id ${id}`),
    ]);
    expect(wrong).toEqual([]);
  });

  it("RDY-004 (c): every check has a matcher and sits in the stage its evidence comes from", () => {
    const expectedStage = (c: Check): string | null => {
      if (c.match.file) return c.match.file.startsWith("e2e/") ? "e2e" : "unit";
      const id = c.match.id ?? "";
      if (id.startsWith("^gate::")) return id.slice("^gate::".length, -1);
      if (id.startsWith("^eval::")) return "live-eval";
      if (id.startsWith("^probe::")) return "probes";
      if (id.startsWith("^scripts/") || id.startsWith("^src/")) return "unit";
      return null;
    };
    const wrong = checks.filter((c) => expectedStage(c) !== c.stage).map((c) => `${c.id}: stage ${c.stage}, expected ${expectedStage(c) ?? "a matcher"}`);
    expect(wrong).toEqual([]);
  });

  it("RDY-004 (d): every file a check names exists", () => {
    // Readiness tooling tests are being written alongside this manifest; until they land, their file-level
    // checks stay pending on the page. Product test files must always exist.
    const missing = checks.flatMap((c) => (c.match.file && !isTooling(c.match.file) && !existsSync(c.match.file) ? [`${c.id} → ${c.match.file}`] : []));
    expect(missing).toEqual([]);
  });

  it("RDY-004 (d): every title matcher matches a real test in its file", () => {
    const dead = checks
      .filter((c) => c.match.file && c.match.name)
      .filter((c) => !REPO_TESTS.some((t) => t.file === c.match.file && checksFor(asResult(t), only(c)).length > 0))
      .map((c) => `${c.id}: /${c.match.name}/ matches no test in ${c.match.file}`);
    expect(dead).toEqual([]);
  });

  it("RDY-004 (e): no orphan tests — every test outside the readiness tooling is claimed by a check", () => {
    const orphans = REPO_TESTS.filter((t) => checksFor(asResult(t)).length === 0).map((t) => `${t.file} :: ${t.fullName}`);
    expect(orphans, `tests no check claims — add a check to src/readiness/manifest.ts:\n${list(orphans)}`).toEqual([]);
  });

  it("RDY-004 (e): no test is claimed by two checks, so no evidence is counted twice", () => {
    const doubled = REPO_TESTS.flatMap((t) => {
      const claimedBy = checksFor(asResult(t)).map((c) => c.id);
      return claimedBy.length > 1 ? [`${t.file} :: ${t.fullName} ← ${claimedBy.join(", ")}`] : [];
    });
    expect(doubled, `narrow the matchers in src/readiness/manifest.ts:\n${list(doubled)}`).toEqual([]);
  });

  it("RDY-004 (e): every readiness tooling test file is claimed by a check", () => {
    const unclaimed = TEST_FILES.filter(isTooling).filter((file) => checksFor(asResult({ file, fullName: "any test" })).length === 0);
    expect(unclaimed, `tooling test files no check claims — add a file-level check to src/readiness/manifest.ts:\n${list(unclaimed)}`).toEqual([]);
  });

  it("RDY-004 (f): every golden case has exactly one case check, and every live probe exactly one check", () => {
    const caseClaims = GOLDEN.map((c) => ({
      id: c.id,
      claimedBy: checksFor(evalResult(c.id, "claude-haiku"))
        .map((k) => k.id)
        .filter((id) => !id.startsWith("eval.provider.")),
    }));
    expect(caseClaims).toEqual(GOLDEN.map((c) => ({ id: c.id, claimedBy: [`eval.${c.id}`] })));

    const probeClaims = PROBE_IDS.map((id) => {
      const probe = PROBES.find((p) => p.id === id);
      const result: TestResult = { id: `probe::${id}`, stage: "probes", file: "https://nimbus.example", fullName: probe?.title ?? id, status: "passed", durationMs: 0, source: "live" };
      return checksFor(result).map((k) => k.id);
    });
    expect(probeClaims).toEqual(PROBE_IDS.map((id) => [`probe.${id}`]));
  });

  it("RDY-003: probe checks take their title and covers from PROBES, the probes' single source", () => {
    const probeChecks = checks.filter((c) => c.stage === "probes");
    expect(probeChecks.map((c) => ({ id: c.id, title: c.title, covers: c.covers }))).toEqual(
      PROBES.map((p) => ({ id: `probe.${p.id}`, title: p.title, covers: p.covers })),
    );
    // The health probe passes with a single provider, so it is never evidence for "two providers" (D3).
    expect(probeChecks.find((c) => c.id === "probe.health")?.covers).toEqual(["D1"]);
  });

  it("D3: each vendor in config/models.json has a live-eval check on one factual case, and only its own models count", () => {
    const vendors = [...new Set(models.models.map((m) => m.provider))];
    for (const provider of vendors) {
      const own = models.models.filter((m) => m.provider === provider);
      const check = checks.find((k) => k.id === `eval.provider.${provider}`);
      expect(check?.covers).toEqual(["D3"]);
      for (const m of models.models) {
        const claimed = checksFor(evalResult("NKA-RET-005", m.id)).some((k) => k.id === check?.id);
        expect(claimed, `${m.id} → eval.provider.${provider}`).toBe(own.includes(m));
      }
      expect(checksFor(evalResult("NKA-RET-004", own[0].id)).map((k) => k.id)).toEqual(["eval.NKA-RET-004"]);
    }
  });

  it("RDY-004 (f): every golden case has curated reviewer text, not the generic fallback", () => {
    const generic = checks.filter((c) => c.stage === "live-eval" && c.verifies.endsWith("passes its golden-set checks.")).map((c) => c.id);
    expect(generic, "add the case to EVAL_TEXT in src/readiness/manifest.ts").toEqual([]);
  });

  it("RDY-004 (f): a golden case claims its acceptance row only when the matrix row is about the same brief item", () => {
    const mismatched = GOLDEN.flatMap((c) => {
      const row = MATRIX_ROWS.find((r) => r.id === c.id);
      const caseBriefs = c.brief.split("/").map((b) => (b === "Rule" ? "RULE" : b));
      const rowBriefs = row ? row.brief.split("/").map((b) => (b.trim() === "Rule" ? "RULE" : b.trim())) : [];
      const expected = !!row && (row.brief === "—" || rowBriefs.some((b) => caseBriefs.includes(b)));
      const check = checks.find((k) => k.id === `eval.${c.id}`);
      const covered = !!check?.covers.includes(c.id);
      return covered === expected ? [] : [`${c.id}: golden brief ${c.brief}, matrix brief ${row?.brief ?? "(no row)"}, covers row: ${covered}`];
    });
    expect(mismatched).toEqual([]);
    // The one known drift, kept visible: golden NKA-GRD-012 is an off-topic probe (E2); matrix NKA-GRD-012 is the SLA definition (E6).
    expect(checks.find((k) => k.id === "eval.NKA-GRD-012")?.covers).toEqual(["E2"]);
  });

  it("RDY-002 (f): every check has a title and one plain-English 'verifies' sentence of at most 170 characters", () => {
    const wrong = checks.flatMap((c) => [
      ...(c.title.trim() ? [] : [`${c.id}: empty title`]),
      ...(c.verifies.trim() ? [] : [`${c.id}: empty verifies`]),
      ...(c.verifies.length > 170 ? [`${c.id}: verifies is ${c.verifies.length} characters`] : []),
    ]);
    expect(wrong).toEqual([]);
  });
});

describe("checksFor", () => {
  it("RDY-002: claims a Vitest result by file and title, whatever value an each() row filled in", () => {
    const result = asResult({ file: "src/server/chat/handleChat.test.ts", fullName: "POST /api/chat › NKA-CHAT-005: rejects a whitespace message with 400 and never calls a provider" });
    expect(checksFor(result).map((c) => c.id)).toEqual(["chat.blank"]);
  });

  it("RDY-002: claims gate, recorded eval and live probe results by id", () => {
    const byId = (id: string, stage: TestResult["stage"]) => checksFor({ ...asResult({ file: "x", fullName: "x" }), id, stage }).map((c) => c.id);
    expect(byId("gate::bundle-scan", "bundle-scan")).toEqual(["gate.bundle-scan"]);
    expect(byId("eval::NKA-RET-002::gemini-flash-lite", "live-eval")).toEqual(["eval.NKA-RET-002"]);
    expect(byId("eval::NKA-RET-005::gemini-flash-lite", "live-eval")).toEqual(["eval.NKA-RET-005", "eval.provider.google"]);
    expect(byId("probe::grounded-answer", "probes")).toEqual(["probe.grounded-answer"]);
  });

  it("RDY-002: claims nothing for the same title in another file or an unknown id", () => {
    expect(checksFor(asResult({ file: "src/server/other.test.ts", fullName: "POST /api/chat › rejects an unknown model id" }))).toEqual([]);
    expect(checksFor({ ...asResult({ file: "x", fullName: "x" }), id: "probe::health-extra" })).toEqual([]);
  });
});
