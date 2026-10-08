/**
 * Playwright reporter for the readiness runner (spec 06 §4): one `test-result` per test when its final attempt
 * ends (a retried test reports once, as flaky or failed), plus `test-start` on its first attempt. Events go to the
 * runner as tagged NDJSON lines on stdout — see lib.mjs, wire protocol.
 *
 *   npx playwright test --reporter=./scripts/readiness/playwright-reporter.mjs,html
 *
 * It prints nothing for humans, so Playwright keeps its own terminal reporter alongside (printsToStdio → false).
 */
import path from "node:path";
import { logEvent, playwrightIdentity, stageTotalEvent, taggedEmitter, testResultEvent, testStartEvent } from "./lib.mjs";

const STAGE = "e2e";

/** @param {ReadonlyArray<{ message?: string, value?: string }>} errors */
const errorText = (errors) => errors.map((e) => e.message ?? e.value ?? "").join("\n");

/** Final outcome → schema status. "expected" covers a `test.fail()` that failed as declared. */
const OUTCOME_STATUS = /** @type {const} */ ({ expected: "passed", flaky: "passed", unexpected: "failed", skipped: "skipped" });

export default class ReadinessPlaywrightReporter {
  /** @param {{ write?: (chunk: string) => void }} [options] */
  constructor(options = {}) {
    this.emit = taggedEmitter(options.write);
    this.root = process.cwd();
  }

  printsToStdio() {
    return false;
  }

  /** @param {{ configFile?: string, rootDir: string }} config @param {{ allTests: () => ReadonlyArray<unknown> }} [suite] */
  onBegin(config, suite) {
    // Paths are reported relative to the repo (where playwright.config.ts lives), e.g. "e2e/chat.spec.ts".
    this.root = config.configFile ? path.dirname(config.configFile) : this.root;
    // Every test reports once (its final attempt), so the collected count is the stage's total.
    if (suite) this.emit(stageTotalEvent(STAGE, suite.allTests().length));
  }

  /** @param {any} test @param {{ retry: number }} result */
  onTestBegin(test, result) {
    if (result.retry === 0) this.emit(testStartEvent(STAGE, playwrightIdentity(test, this.root)));
  }

  /** @param {any} test @param {{ status: string, retry: number, duration: number, errors: ReadonlyArray<{ message?: string }> }} result */
  onTestEnd(test, result) {
    const identity = playwrightIdentity(test, this.root);
    const willRetry = (result.status === "failed" || result.status === "timedOut") && result.retry < test.retries;
    if (willRetry) {
      this.emit(logEvent(STAGE, `retrying (attempt ${result.retry + 2}): ${identity.fullName}`));
      return;
    }
    const outcome = /** @type {keyof typeof OUTCOME_STATUS} */ (test.outcome());
    // An interrupted run (Stop, SIGINT) ends tests mid-way: not a verdict on the app.
    const status = result.status === "interrupted" ? "skipped" : (OUTCOME_STATUS[outcome] ?? "failed");
    this.emit(
      testResultEvent({
        stage: STAGE,
        ...identity,
        status,
        durationMs: result.duration,
        error: status === "failed" ? errorText(result.errors) : undefined,
        detail: {
          flaky: outcome === "flaky" ? true : undefined,
          retries: result.retry || undefined,
          interrupted: result.status === "interrupted" ? true : undefined,
        },
      }),
    );
  }

  /** Errors outside any test, e.g. the web server failing to start. @param {{ message?: string, value?: string }} error */
  onError(error) {
    this.emit(logEvent(STAGE, `error: ${errorText([error])}`));
  }
}
