import path from "node:path";
import { describe, expect, it } from "vitest";
import { ReadinessEventSchema, type ReadinessEvent } from "@/readiness/schema";
import { ROOT, decodeTagged, eventTag } from "./lib.mjs";
import PlaywrightReporter from "./playwright-reporter.mjs";
import VitestReporter from "./vitest-reporter.mjs";

/**
 * The reporters are driven with stand-ins for Vitest's and Playwright's reporter objects (only the fields they
 * read), and every line they write must decode to an event that parses with the shared contract.
 */
function capture() {
  const lines: string[] = [];
  const tag = eventTag();
  const events = (): ReadinessEvent[] =>
    lines.map((line) => {
      const decoded = decodeTagged(line, tag);
      if (!decoded) throw new Error(`not an event line: ${line}`);
      return ReadinessEventSchema.parse(decoded);
    });
  return { write: (chunk: string) => void lines.push(chunk), events };
}

const resultsOf = (events: ReadinessEvent[]) => events.flatMap((e) => (e.type === "test-result" ? [e.result] : []));

describe("Vitest reporter", () => {
  const mod = { type: "module", moduleId: path.join(ROOT, "src", "server", "x.test.ts"), errors: () => [] as { message: string }[] };
  const suite = { type: "suite", name: "retrieve", parent: mod, module: mod, errors: () => [] as { message: string }[] };
  const testCase = (id: string, name: string, state: string, errors?: { message: string }[]) => ({
    type: "test",
    id,
    name,
    parent: suite,
    module: mod,
    result: () => ({ state, errors }),
    diagnostic: () => ({ duration: 12.6, flaky: false, retryCount: 0 }),
  });

  it("streams test-start and one test-result per test as it finishes", () => {
    const out = capture();
    const reporter = new VitestReporter({ write: out.write });
    reporter.onInit({ config: { root: ROOT } });
    const failing = testCase("t1", "finds Relay pricing", "failed", [{ message: "expected 1 to be 2\nReceived: rendered answer text" }]);
    reporter.onTestCaseReady(failing);
    reporter.onTestCaseResult(failing);
    reporter.onTestCaseResult(testCase("t2", "skips", "skipped"));
    const events = out.events();
    expect(events[0]).toEqual({ type: "test-start", stage: "unit", id: "src/server/x.test.ts::retrieve › finds Relay pricing", file: "src/server/x.test.ts", fullName: "retrieve › finds Relay pricing" });
    expect(resultsOf(events)).toEqual([
      { id: "src/server/x.test.ts::retrieve › finds Relay pricing", stage: "unit", file: "src/server/x.test.ts", fullName: "retrieve › finds Relay pricing", status: "failed", durationMs: 13, source: "live", error: "expected 1 to be 2" },
      { id: "src/server/x.test.ts::retrieve › skips", stage: "unit", file: "src/server/x.test.ts", fullName: "retrieve › skips", status: "skipped", durationMs: 13, source: "live" },
    ]);
  });

  it("at the end, reports file-level and hook failures, tests the live hooks missed, and unhandled errors", () => {
    const out = capture();
    const reporter = new VitestReporter({ write: out.write });
    reporter.onInit({ config: { root: ROOT } });
    const seen = testCase("t1", "seen", "passed");
    reporter.onTestCaseResult(seen);
    const missed = testCase("t2", "missed", "passed");
    const broken = { ...mod, errors: () => [{ message: "Cannot find module './gone'" }] };
    const failingSuite = { ...suite, errors: () => [{ message: "beforeAll failed" }] };
    const children = { allSuites: () => [failingSuite], allTests: () => [seen, missed] };
    reporter.onTestRunEnd([{ ...broken, children }], [{ message: "late rejection" }]);
    const events = out.events();
    expect(resultsOf(events).map((r) => [r.id, r.status, r.error])).toEqual([
      ["src/server/x.test.ts::retrieve › seen", "passed", undefined],
      ["src/server/x.test.ts::(file-level error)", "failed", "Cannot find module './gone'"],
      ["src/server/x.test.ts::retrieve", "failed", "beforeAll failed"],
      ["src/server/x.test.ts::retrieve › missed", "passed", undefined],
    ]);
    expect(events.at(-1)).toEqual({ type: "log", stage: "unit", line: "unhandled error: late rejection" });
  });
});

describe("Playwright reporter", () => {
  const root = { type: "root", title: "" };
  const project = { type: "project", title: "chromium", parent: root };
  const file = { type: "file", title: "chat.spec.ts", parent: project };
  const location = { file: path.join(ROOT, "e2e", "chat.spec.ts") };
  const test = (title: string, outcome: string, retries = 0) => ({ title, parent: file, location, retries, outcome: () => outcome });

  it("reports each test once, on its final attempt, with Playwright's outcome", () => {
    const out = capture();
    const reporter = new PlaywrightReporter({ write: out.write });
    reporter.onBegin({ configFile: path.join(ROOT, "playwright.config.ts"), rootDir: path.join(ROOT, "e2e") });
    const flaky = test("NKA-MDL-004: primary fails → backup answers", "flaky", 1);
    reporter.onTestBegin(flaky, { retry: 0 });
    reporter.onTestEnd(flaky, { status: "failed", retry: 0, duration: 900, errors: [{ message: "Timed out" }] });
    reporter.onTestBegin(flaky, { retry: 1 });
    reporter.onTestEnd(flaky, { status: "passed", retry: 1, duration: 800, errors: [] });
    const failing = test("NKA-CHAT-004: blank message cannot be sent", "unexpected");
    reporter.onTestEnd(failing, { status: "failed", retry: 0, duration: 50, errors: [{ message: "Error: expect(locator).toBeDisabled() failed\n\nCall log:\n  - waiting" }] });
    reporter.onTestEnd(test("stopped", "skipped"), { status: "interrupted", retry: 0, duration: 5, errors: [] });
    reporter.onError({ message: "Error: Timed out waiting 60000ms from config.webServer." });

    const events = out.events();
    expect(events.filter((e) => e.type === "test-start")).toHaveLength(1);
    expect(events).toContainEqual({ type: "log", stage: "e2e", line: "retrying (attempt 2): NKA-MDL-004: primary fails → backup answers" });
    expect(resultsOf(events)).toEqual([
      { id: "e2e/chat.spec.ts::NKA-MDL-004: primary fails → backup answers", stage: "e2e", file: "e2e/chat.spec.ts", fullName: "NKA-MDL-004: primary fails → backup answers", status: "passed", durationMs: 800, source: "live", detail: { flaky: true, retries: 1 } },
      { id: "e2e/chat.spec.ts::NKA-CHAT-004: blank message cannot be sent", stage: "e2e", file: "e2e/chat.spec.ts", fullName: "NKA-CHAT-004: blank message cannot be sent", status: "failed", durationMs: 50, source: "live", error: "Error: expect(locator).toBeDisabled() failed" },
      { id: "e2e/chat.spec.ts::stopped", stage: "e2e", file: "e2e/chat.spec.ts", fullName: "stopped", status: "skipped", durationMs: 5, source: "live", detail: { interrupted: true } },
    ]);
    expect(events.at(-1)).toEqual({ type: "log", stage: "e2e", line: "error: Error: Timed out waiting 60000ms from config.webServer." });
  });
});
