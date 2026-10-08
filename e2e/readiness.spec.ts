import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { manifest } from "../src/readiness/manifest";
import { STAGE_INFO, type ReadinessEvent } from "../src/readiness/schema";

/**
 * Readiness report page (docs/requirements/06_Readiness_Report.md §6). Runs against the production build
 * with the mock LLM. The runner endpoint is stubbed for the whole browser context (popups included), so no
 * test can spawn a gate run even where the runner is available (next dev); the live probes go to the real
 * server under test.
 */

const RUNNER = "**/api/readiness/run";
const FREE_PROBES = ["health", "models", "blank", "oversize", "unknown-model", "offtopic-guard", "stream-headers", "bundle-keys"];
const FINAL = /^(ready|not-ready|incomplete)$/;
const GROUPS = [...new Set(manifest.requirements.map((r) => r.group))];

/**
 * Stubs /api/readiness/run for every page of the context and records each request method. GET answers
 * "unavailable" like production unless a runner `stream` is given; a POST is never forwarded.
 */
async function stubRunner(context: BrowserContext, stream?: ReadinessEvent[]): Promise<string[]> {
  const calls: string[] = [];
  await context.route(RUNNER, async (route) => {
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
  test("RDY-004: readiness failures never create Knowledge base issues", async ({ page }) => {
    const response = await page.request.post("/api/dev/knowledge-base/reports/readiness", {
      data: { runId: "e2e-check", failedChecks: ["probe::health"], failedStages: ["probes"] },
    });
    expect(response.status()).toBe(410);
  });

  test("RDY-001: the header's Readiness test button opens the report in its own window", async ({ page }) => {
    const calls = await stubRunner(page.context());
    await page.goto("/");

    const [popup] = await Promise.all([page.waitForEvent("popup"), page.getByTestId("readiness-link").click()]);
    await popup.waitForLoadState();
    const url = new URL(popup.url());
    expect(url.pathname + url.search).toBe("/readiness?autostart=1");
    await expect(popup.getByTestId("verdict")).toHaveAttribute("data-verdict", FINAL, { timeout: 30_000 });
    await expect(popup.getByTestId("mode-banner")).toHaveAttribute("data-mode", "replay");

    // The chat stays where it was.
    expect(new URL(page.url()).pathname).toBe("/");
    expect(calls).toContain("GET");
    expect(calls, "no POST, so no gate run was spawned").not.toContain("POST");
  });

  test("RDY-003: a recorded run replays labelled recorded with its date and build; every brief item gets a status", async ({ page }) => {
    const calls = await stubRunner(page.context());
    await page.goto("/readiness?mode=replay&speed=instant&probes=0");

    await expect(page.getByTestId("verdict")).toHaveAttribute("data-verdict", FINAL, { timeout: 15_000 });

    const banner = page.getByTestId("mode-banner");
    await expect(banner).toHaveAttribute("data-mode", "replay");
    await expect(banner).toContainText("Recorded");
    await expect(banner).toContainText(/\d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} UTC/);
    await expect(banner).toContainText(/build \S+/);

    const filters = page.getByRole("group", { name: "Filter results" }).getByRole("button");
    await expect(filters.first()).toHaveAttribute("data-testid", "filter-all");
    await expect(filters.last()).toHaveAttribute("data-testid", "filter-recorded");
    await expect(page.getByTestId("filter-all")).toHaveAttribute("aria-pressed", "true");

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
    const calls = await stubRunner(page.context());
    await page.goto("/readiness?mode=probes");
    await page.getByTestId("filter-all").click();

    await expect(page.getByTestId("verdict")).toHaveAttribute("data-verdict", FINAL, { timeout: 30_000 });
    await expect(page.getByTestId("mode-banner")).toHaveAttribute("data-mode", "probes");
    await expect(page.getByTestId("mode-banner")).toContainText("Live");

    for (const id of FREE_PROBES) {
      const item = feedItem(page, `probe::${id}`);
      await expect(item, `probe ${id}`).toHaveAttribute("data-status", "passed");
      await expect(item, `probe ${id}`).toHaveAttribute("data-source", "live");
    }
    // Every report includes the real-answer probe so the live deployment has grounded evidence.
    await expect(feedItem(page, "probe::grounded-answer")).toHaveAttribute("data-status", "passed");
    await expect(page.getByTestId("include-answer")).toHaveCount(0);
    await expect(page.getByTestId("stage-probes")).toHaveAttribute("data-status", "passed");

    await page.getByTestId("stat-requirements").hover();
    await expect(page.locator('[role="tooltip"]').filter({ hasText: "main release-readiness measure" })).toBeVisible();
    const pipelineBefore = await page.getByTestId("pipeline").boundingBox();
    const timeBefore = await page.getByTestId("stat-time").boundingBox();
    await page.getByTestId("stat-time").hover();
    await expect(page.locator('[role="tooltip"]').filter({ hasText: "slow checks and release-gate delays" })).toBeVisible();
    const pipelineAfter = await page.getByTestId("pipeline").boundingBox();
    const timeAfter = await page.getByTestId("stat-time").boundingBox();
    expect(pipelineAfter?.y).toBe(pipelineBefore?.y);
    expect(timeAfter?.width).toBe(timeBefore?.width);
    expect(timeAfter?.height).toBe(timeBefore?.height);
    await page.getByTestId("stat-cost").click();
    await page.getByTestId("stat-tests").hover();
    await expect(page.locator('[role="tooltip"]').filter({ hasText: "breadth of verification" })).toBeVisible();
    await expect(page.locator('[role="tooltip"]').filter({ hasText: "provider cost of measured" })).toBeHidden();
    await page.getByTestId("stage-probes").hover();
    await expect(page.locator('[role="tooltip"]').filter({ hasText: "running deployment directly" })).toBeVisible();

    expect(calls, "a probe-only run never touches the runner").toEqual([]);
  });

  test("RDY-005: the page never starts a local run unless asked; where the runner is unavailable it replays, then probes live", async ({ page }) => {
    const calls = await stubRunner(page.context());

    await page.goto("/readiness");
    await expect(page.getByTestId("verdict")).toHaveAttribute("data-verdict", "idle");
    await expect(page.getByTestId("start-run")).toHaveText(/Replay recorded run/);

    // The header button's URL, on a deployment without the runner (GET → unavailable).
    await page.goto("/readiness?autostart=1&speed=instant");
    await page.getByTestId("filter-all").click();
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
    const calls = await stubRunner(page.context(), [
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
    await page.getByTestId("filter-all").click();
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
