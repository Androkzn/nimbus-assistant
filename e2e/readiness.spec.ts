import { expect, test, type Page } from "@playwright/test";
import { manifest } from "../src/readiness/manifest";
import { STAGE_INFO, type ReadinessEvent } from "../src/readiness/schema";

/**
 * Readiness report page (docs/requirements/06_Readiness_Report.md §6). Runs against the production build
 * with the mock LLM. The runner endpoint is always stubbed here, so no test can spawn a gate run; the
 * live probes go to the real server under test.
 */

const RUNNER = "**/api/readiness/run";
const FREE_PROBES = ["health", "models", "blank", "oversize", "unknown-model", "offtopic-guard", "stream-headers", "bundle-keys"];
const FINAL = /^(ready|not-ready|incomplete)$/;
const GROUPS = [...new Set(manifest.requirements.map((r) => r.group))];

/** Stubs /api/readiness/run and records every request method. GET answers like production unless `stream` is given. */
async function stubRunner(page: Page, stream?: ReadinessEvent[]): Promise<string[]> {
  const calls: string[] = [];
  await page.route(RUNNER, async (route) => {
    const method = route.request().method();
    calls.push(method);
    if (method === "GET") return route.fulfill({ json: { available: Boolean(stream), running: false } });
    if (method === "POST" && stream) {
      return route.fulfill({ status: 200, contentType: "application/x-ndjson", body: stream.map((e) => JSON.stringify(e)).join("\n") + "\n" });
    }
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });
  return calls;
}

const feedItem = (page: Page, id: string) => page.locator(`[data-testid="feed-item"][data-result-id="${id}"]`);

test.describe("Readiness report", () => {
  test("RDY-003: a recorded run replays labelled recorded with its date and build; every brief item gets a status", async ({ page }) => {
    const calls = await stubRunner(page);
    await page.goto("/readiness?mode=replay&speed=instant&probes=0");

    await expect(page.getByTestId("verdict")).toHaveAttribute("data-verdict", FINAL, { timeout: 15_000 });

    const banner = page.getByTestId("mode-banner");
    await expect(banner).toHaveAttribute("data-mode", "replay");
    await expect(banner).toContainText("Recorded");
    await expect(banner).toContainText(/\d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} UTC/);
    await expect(banner).toContainText(/build \S+/);

    for (const group of GROUPS) {
      await expect(page.getByRole("heading", { level: 3, name: group, exact: true })).toBeVisible();
    }
    const rows = page.locator("[data-requirement-id]");
    await expect(rows).toHaveCount(manifest.requirements.length);
    for (const row of await rows.all()) {
      await expect(row.locator("[data-status]").first()).toHaveAttribute("data-status", /^(passed|failed|skipped|pending)$/);
    }

    // I7: everything in a replay is labelled recorded — nothing here ran now.
    await expect(page.getByTestId("feed-item").first()).toBeVisible();
    await expect(page.locator('[data-testid="feed-item"][data-source="live"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="feed-item"][data-source="recorded"]').first()).toBeVisible();
    expect(calls, "an explicit replay never touches the runner").toEqual([]);
  });

  test("RDY-003: live probes run for real against the server and are labelled live", async ({ page }) => {
    const calls = await stubRunner(page);
    await page.goto("/readiness?mode=probes");

    await expect(page.getByTestId("verdict")).toHaveAttribute("data-verdict", FINAL, { timeout: 30_000 });
    await expect(page.getByTestId("mode-banner")).toHaveAttribute("data-mode", "probes");
    await expect(page.getByTestId("mode-banner")).toContainText("Live");

    for (const id of FREE_PROBES) {
      const item = feedItem(page, `probe::${id}`);
      await expect(item, `probe ${id}`).toHaveAttribute("data-status", "passed");
      await expect(item, `probe ${id}`).toHaveAttribute("data-source", "live");
    }
    // The real-answer probe is opt-in: by default it spends nothing and says so.
    await expect(feedItem(page, "probe::grounded-answer")).toHaveAttribute("data-status", "skipped");
    await expect(page.getByTestId("stage-probes")).toHaveAttribute("data-status", "passed");
    expect(calls, "a probe-only run never touches the runner").toEqual([]);
  });

  test("RDY-005: the page never starts a local run unless asked; where the runner is unavailable it replays, then probes live", async ({ page }) => {
    const calls = await stubRunner(page);

    await page.goto("/readiness");
    await expect(page.getByTestId("verdict")).toHaveAttribute("data-verdict", "idle");
    await expect(page.getByTestId("start-run")).toHaveText(/Replay recorded run/);

    // The header button's URL, on a deployment without the runner (GET → unavailable).
    await page.goto("/readiness?autostart=1&speed=instant");
    await expect(page.getByTestId("verdict")).toHaveAttribute("data-verdict", FINAL, { timeout: 30_000 });
    await expect(page.getByTestId("mode-banner")).toHaveAttribute("data-mode", "replay");
    await expect(page.getByTestId("mode-banner")).toContainText("Live probes");

    // Recorded gates stay recorded; only the probes, which ran now, are live.
    await expect(feedItem(page, "probe::health")).toHaveAttribute("data-source", "live");
    await expect(page.locator('[data-testid="feed-item"][data-source="live"]:not([data-result-id^="probe::"])')).toHaveCount(0);

    expect(calls).toContain("GET");
    expect(calls, "no POST, so no gate run was spawned").not.toContain("POST");
  });

  test("RDY-002: a local run streams the runner's events as live, then the probes, then one verdict", async ({ page }) => {
    const at = new Date().toISOString();
    const result = {
      id: "src/readiness/stub.test.ts::stubbed runner result",
      stage: "unit" as const,
      file: "src/readiness/stub.test.ts",
      fullName: "stubbed runner result",
      status: "passed" as const,
      durationMs: 12,
      source: "live" as const,
    };
    const calls = await stubRunner(page, [
      {
        type: "run-start",
        meta: { runId: "2026-10-07-00-00-00", mode: "local", startedAt: at, platform: "node v22 · test", environment: "local working tree", build: "e2e0000" },
        stages: [STAGE_INFO.unit],
      },
      { type: "stage-start", stage: "unit", at },
      { type: "test-start", stage: "unit", id: result.id, file: result.file, fullName: result.fullName },
      { type: "test-result", result },
      { type: "stage-end", stage: "unit", status: "passed", durationMs: 40, counts: { passed: 1, failed: 0, skipped: 0 }, source: "live", at },
      { type: "run-end", status: "passed", durationMs: 50, at },
    ]);

    await page.goto("/readiness?autostart=1");
    await expect(page.getByTestId("verdict")).toHaveAttribute("data-verdict", FINAL, { timeout: 30_000 });
    await expect(page.getByTestId("mode-banner")).toHaveAttribute("data-mode", "local");
    await expect(feedItem(page, result.id)).toHaveAttribute("data-source", "live");
    await expect(feedItem(page, "probe::health")).toHaveAttribute("data-status", "passed");
    await expect(page.getByTestId("stage-unit")).toHaveAttribute("data-status", "passed");
    // A result no check claims is reported, not silently dropped.
    await expect(page.getByTestId("unclaimed")).toContainText("stubbed runner result");
    expect(calls).toEqual(["GET", "POST"]);
  });
});
