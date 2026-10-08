/**
 * Vitest reporter for the readiness runner (spec 06 §4): streams one `test-result` per test as it finishes
 * (and a `test-start` as it begins) to the runner, as tagged NDJSON lines on stdout — see lib.mjs, wire protocol.
 *
 *   npx vitest run --reporter=./scripts/readiness/vitest-reporter.mjs
 *
 * Also reports what has no test case of its own: a file that fails to load, a failing beforeAll/afterAll, and
 * unhandled errors — so a red stage always has a visible reason.
 */
import { logEvent, repoPath, resultId, stageTotalEvent, taggedEmitter, testResultEvent, testStartEvent, vitestIdentity } from "./lib.mjs";

const STAGE = "unit";
/** fullName for failures that belong to a file rather than a test (import error, file-level hook). */
const FILE_LEVEL = "(file-level error)";

/** @param {ReadonlyArray<{ name?: string, message?: string }> | undefined} errors */
const errorText = (errors) => (errors ?? []).map((e) => (e.message ? e.message : String(e.name ?? e))).join("\n");

export default class ReadinessVitestReporter {
  /** @param {{ write?: (chunk: string) => void }} [options] */
  constructor(options = {}) {
    this.emit = taggedEmitter(options.write);
    this.root = process.cwd();
    /** Tests already reported, so the end-of-run sweep only adds what the live hooks missed. */
    this.reported = new Set();
  }

  /** @param {{ config: { root: string } }} vitest */
  onInit(vitest) {
    this.root = vitest.config.root ?? this.root;
  }

  /** @param {ReadonlyArray<unknown>} specifications one per test file */
  onTestRunStart(specifications) {
    this.uncollected = specifications.length;
    this.collected = 0;
  }

  /**
   * Files are collected one by one as workers pick them up, so the stage total is announced once the last file
   * is in — never a partial count that would later grow. (`vitest list` is no shortcut: it under-counts.)
   * @param {any} testModule
   */
  onTestModuleCollected(testModule) {
    if (this.uncollected === undefined) return;
    this.collected += [...testModule.children.allTests()].length;
    this.uncollected -= 1;
    if (this.uncollected === 0) this.emit(stageTotalEvent(STAGE, this.collected));
  }

  /** @param {any} testCase */
  onTestCaseReady(testCase) {
    this.emit(testStartEvent(STAGE, vitestIdentity(testCase, this.root)));
  }

  /** @param {any} testCase */
  onTestCaseResult(testCase) {
    const result = testCase.result();
    if (result.state === "pending") return;
    this.reported.add(testCase.id);
    this.emit(
      testResultEvent({
        stage: STAGE,
        ...vitestIdentity(testCase, this.root),
        status: result.state,
        durationMs: testCase.diagnostic()?.duration ?? 0,
        error: result.state === "failed" ? errorText(result.errors) : undefined,
        detail: testCase.diagnostic()?.flaky ? { flaky: true, retries: testCase.diagnostic().retryCount } : undefined,
      }),
    );
  }

  /**
   * @param {ReadonlyArray<any>} testModules
   * @param {ReadonlyArray<{ name?: string, message?: string }>} unhandledErrors
   */
  onTestRunEnd(testModules, unhandledErrors) {
    for (const mod of testModules) {
      const file = repoPath(this.root, mod.moduleId);
      // A file that failed to import, or a file-level hook that threw: no test case carries the reason.
      if (mod.errors().length) this.emitFailure({ id: resultId(file, FILE_LEVEL), file, fullName: FILE_LEVEL }, mod.errors());
      for (const suite of mod.children.allSuites()) {
        if (suite.errors().length) this.emitFailure(vitestIdentity(suite, this.root), suite.errors());
      }
      for (const testCase of mod.children.allTests()) {
        if (!this.reported.has(testCase.id) && testCase.result().state !== "pending") this.onTestCaseResult(testCase);
      }
    }
    for (const err of unhandledErrors) this.emit(logEvent(STAGE, `unhandled error: ${errorText([err])}`));
  }

  /**
   * @param {{ id: string, file: string, fullName: string }} identity
   * @param {ReadonlyArray<{ name?: string, message?: string }>} errors
   */
  emitFailure(identity, errors) {
    this.emit(testResultEvent({ stage: STAGE, ...identity, status: "failed", error: errorText(errors) }));
  }
}
