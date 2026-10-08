import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { manifest } from "../src/readiness/manifest";
import { PROBE_IDS, STAGE_INFO, type ReadinessEvent } from "../src/readiness/schema";

/**
 * Readiness report page (docs/requirements/06_Readiness_Report.md §6). Runs against the production build
 * with the mock LLM. The runner endpoint is stubbed for the whole browser context (popups included), so no
 * test can spawn a gate run even where the runner is available (next dev); the live probes go to the real
 * server under test.
 */

/** The runner endpoint, with or without its query (?answers=0 when "Include live answers" is unticked). */
const RUNNER = /\/api\/readiness\/run(\?.*)?$/;
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
    // A deployment has no local runner: it runs the live checks against itself, never a replay.
    await expect(popup.getByTestId("mode-banner")).toHaveAttribute("data-mode", "probes");
    await expect(popup.getByTestId("stage-live-eval")).toHaveAttribute("data-status", "skipped");

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

    const filters = page.getByRole("group", { name: "Filter checks" }).getByRole("button");
    await expect(filters.first()).toHaveAttribute("data-testid", "filter-all");
    await expect(filters.last()).toHaveAttribute("data-testid", "filter-recorded");
    await expect(page.getByTestId("filter-all")).toHaveAttribute("aria-pressed", "true");
    // A replay cannot run the live answer eval: the box is shown off and disabled, saying why.
    await expect(page.getByTestId("include-answer")).toBeDisabled();
    await expect(page.getByTestId("include-answer")).not.toBeChecked();
    await expect(page.getByText("Runs only in a local run; this page replays the recorded eval")).toBeVisible();

    // The tabs count checks, the headline's unit ("N of 174 checks complete"); the list groups them by requirement.
    const progress = await page.locator('[aria-valuetext$="checks complete"]').getAttribute("aria-valuetext");
    const checksTotal = progress?.match(/of (\d+) checks/)?.[1];
    expect(checksTotal).toBeTruthy();
    await expect(page.getByTestId("filter-all")).toHaveText(new RegExp(`^All\\s*${checksTotal}$`));
    await expect(page.getByTestId("trace-summary")).toHaveText(`Showing ${checksTotal} checks across ${manifest.requirements.length} requirements`);

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
    // The real-answer probe always runs. "Include live answers" (off by default) switches the live answer eval here too.
    await expect(feedItem(page, "probe::grounded-answer")).toHaveAttribute("data-status", "passed");
    await expect(page.getByTestId("include-answer")).toBeEnabled();
    await expect(page.getByTestId("include-answer")).not.toBeChecked();
    await expect(page.getByTestId("stage-live-eval")).toHaveAttribute("data-status", "skipped");
    await expect(page.getByTestId("stage-probes")).toHaveAttribute("data-status", "passed");

    // A visible tooltip can still be painted under the next card; the hovered card must stack above its neighbours.
    const zIndex = (id: string) => page.getByTestId(id).evaluate((el) => Number(getComputedStyle(el).zIndex));
    await page.getByTestId("stat-requirements").hover();
    await expect(page.locator('[role="tooltip"]').filter({ hasText: "main release-readiness measure" })).toBeVisible();
    expect(await zIndex("stat-requirements")).toBeGreaterThan(await zIndex("stat-tests"));
    // Page position, not viewport position: hovering a card below the fold scrolls the page, which is not a layout shift.
    const pageTop = (id: string) => page.getByTestId(id).evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
    const pipelineBefore = await pageTop("pipeline");
    const timeBefore = await page.getByTestId("stat-time").boundingBox();
    await page.getByTestId("stat-time").hover();
    await expect(page.locator('[role="tooltip"]').filter({ hasText: "slow checks and release-gate delays" })).toBeVisible();
    const pipelineAfter = await pageTop("pipeline");
    const timeAfter = await page.getByTestId("stat-time").boundingBox();
    expect(pipelineAfter).toBe(pipelineBefore);
    expect(timeAfter?.width).toBe(timeBefore?.width);
    expect(timeAfter?.height).toBe(timeBefore?.height);
    await page.getByTestId("stat-cost").click();
    await page.getByTestId("stat-tests").hover();
    await expect(page.locator('[role="tooltip"]').filter({ hasText: "breadth of verification" })).toBeVisible();
    await expect(page.locator('[role="tooltip"]').filter({ hasText: "provider cost of measured" })).toBeHidden();
    expect(await zIndex("stat-tests")).toBeGreaterThan(await zIndex("stat-cost"));
    await page.getByTestId("stage-probes").hover();
    await expect(page.locator('[role="tooltip"]').filter({ hasText: "running deployment directly" })).toBeVisible();
    // Hidden tooltips still take part in layout: one anchored past the right edge scrolls the whole page sideways.
    const overflowX = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await page.mouse.move(0, 0);
    expect(await overflowX()).toBe(0);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await overflowX()).toBe(0);

    expect(calls, "a probe-only run never touches the runner").toEqual([]);
  });

  test("RDY-005: the page never starts a local run unless asked; where the runner is unavailable it runs the live checks", async ({ page }) => {
    const calls = await stubRunner(page.context());

    await page.goto("/readiness");
    await expect(page.getByTestId("verdict")).toHaveAttribute("data-verdict", "idle");
    await expect(page.getByTestId("start-run")).toHaveText(/Run live checks/);
    // Only the stages a deployment can run: no local gates, and no replay speed.
    await expect(page.getByTestId("stage-typecheck")).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Replay speed" })).toHaveCount(0);

    // The header button's URL, on a deployment without the runner (GET → unavailable).
    await page.goto("/readiness?autostart=1");
    await page.getByTestId("filter-all").click();
    await expect(page.getByTestId("verdict")).toHaveAttribute("data-verdict", FINAL, { timeout: 30_000 });
    await expect(page.getByTestId("mode-banner")).toHaveAttribute("data-mode", "probes");

    // Everything here ran now, against this server: nothing is recorded.
    await expect(feedItem(page, "probe::health")).toHaveAttribute("data-source", "live");
    await expect(page.locator('[data-testid="feed-item"][data-source="recorded"]')).toHaveCount(0);

    expect(calls).toContain("GET");
    expect(calls, "no POST, so no gate run was spawned").not.toContain("POST");
  });

  test("RDY-002: before a local run, the live answer eval card follows the Include live answers checkbox", async ({ page }) => {
    await stubRunner(page.context(), []);
    await page.goto("/readiness");
    const card = page.getByTestId("stage-live-eval");
    await expect(page.getByTestId("include-answer")).not.toBeChecked();
    await expect(card).toHaveAttribute("data-status", "skipped");
    await expect(card).toContainText("Skipped");
    await page.getByTestId("include-answer").check();
    await expect(card).toHaveAttribute("data-status", "pending");
    await expect(card).toContainText("Queued");
    await page.getByTestId("include-answer").uncheck();
    await expect(card).toHaveAttribute("data-status", "skipped");
  });

  test("RDY-002: a local run streams the runner's events as live, then the probes, then one verdict", async ({ page }) => {
    const at = new Date().toISOString();
    // A product path: results of the report's own tests (src/readiness/…) are ignored by the page.
    const result = {
      id: "src/server/stub.test.ts::stubbed runner result",
      stage: "unit" as const,
      file: "src/server/stub.test.ts",
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
      { type: "stage-total", stage: "unit", total: 1 },
      { type: "test-start", stage: "unit", id: result.id, file: result.file, fullName: result.fullName },
      { type: "test-result", result },
      { type: "stage-end", stage: "unit", status: "passed", durationMs: 40, counts: { passed: 1, failed: 0, skipped: 0 }, source: "live", at },
      { type: "run-end", status: "passed", durationMs: 50, at },
    ]);

    const firstPost = page.waitForRequest((r) => r.url().includes("/api/readiness/run") && r.method() === "POST");
    await page.goto("/readiness?autostart=1");
    // "Include live answers" is off by default, so the runner is asked to skip the live answer eval.
    expect(new URL((await firstPost).url()).searchParams.get("answers")).toBe("0");
    await page.getByTestId("filter-all").click();
    await expect(page.getByTestId("verdict")).toHaveAttribute("data-verdict", FINAL, { timeout: 30_000 });
    await expect(page.getByTestId("mode-banner")).toHaveAttribute("data-mode", "local");
    await expect(page.getByTestId("include-answer")).not.toBeChecked();
    await expect(page.getByText("Uses real tokens: live answer eval (~170 answers, about $0.50)", { exact: true })).toBeVisible();
    await expect(feedItem(page, result.id)).toHaveAttribute("data-source", "live");
    await expect(feedItem(page, "probe::health")).toHaveAttribute("data-status", "passed");
    await expect(page.getByTestId("stage-unit")).toHaveAttribute("data-status", "passed");
    // A stage that announced its total shows progress against it; a single-result stage shows no count at all.
    await expect(page.getByTestId("stage-probes-counts")).toContainText(` / ${PROBE_IDS.length} passed`);
    await expect(page.getByTestId("stage-unit-counts")).not.toContainText("passed");
    // A result no check claims is reported, not silently dropped.
    await expect(page.getByTestId("unclaimed")).toContainText("stubbed runner result");
    expect(calls).toEqual(["GET", "POST"]);

    // Ticked, the next local run asks the runner for the live answer eval (real tokens).
    await page.getByTestId("include-answer").check();
    const secondPost = page.waitForRequest((r) => r.url().includes("/api/readiness/run") && r.method() === "POST");
    await page.getByTestId("start-run").click();
    expect(new URL((await secondPost).url()).searchParams.get("answers")).toBeNull();
    // The probe question is not part of the switch: it still runs.
    await expect(page.getByTestId("verdict")).toHaveAttribute("data-verdict", FINAL, { timeout: 30_000 });
    await expect(feedItem(page, "probe::grounded-answer")).toHaveAttribute("data-status", "passed");
  });
});
