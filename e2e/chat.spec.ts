import { expect, test, type Page } from "@playwright/test";

async function ask(page: Page, question: string) {
  await page.getByTestId("composer").fill(question);
  await page.getByTestId("send").click();
}

const lastAnswer = (page: Page) => page.getByTestId("answer").last();

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("model-select")).not.toHaveValue("");
});

test("NKA-MDL-001: every model option shows its provider and a short description", async ({ page }) => {
  const select = page.getByTestId("model-select");
  const providers = await select.locator("optgroup").evaluateAll((groups) => groups.map((g) => g.getAttribute("label")));
  expect(providers).toEqual(expect.arrayContaining(["Anthropic Claude", "OpenAI", "Google Gemini"]));
  for (const text of await select.locator("option").allTextContents()) {
    expect(text).toMatch(/ — \S.{10,}/); // "<model> — <description from config>"
  }
  await expect(page.getByTestId("model-description")).toHaveText(/^(Anthropic Claude|OpenAI|Google Gemini) · \S/); // selected model: provider + description
});

test("NKA-CHAT-004: blank message cannot be sent", async ({ page }) => {
  await expect(page.getByTestId("send")).toBeDisabled();
  await page.getByTestId("composer").fill("    ");
  await expect(page.getByTestId("send")).toBeDisabled();
});

test("NKA-CHAT-001 / USG-001: streamed answer with sources, model badge and usage", async ({ page }) => {
  await ask(page, "What's the P1 SLA for Vault Enterprise?");
  const answer = lastAnswer(page);
  await expect(answer).toHaveAttribute("data-status", "done");
  await expect(answer.getByTestId("answer-text")).toContainText("[1]");
  await expect(answer.getByTestId("answered-by")).toContainText("Answered by");
  await expect(answer.getByTestId("usage-line")).toContainText(/in [\d,]+ · out [\d,]+ tokens · est\. \$/);
  await expect(answer.getByTestId("cited-sources")).toContainText("vault.md · Support SLA"); // visible without opening anything
  await expect(answer.getByTestId("figure-check")).toHaveAttribute("data-ok", "true");
  await answer.getByTestId("sources").locator("summary").click();
  await expect(answer.getByTestId("sources")).toContainText("vault.md · Support SLA");
});

test("NKA-GRD-011: an off-topic question is answered without calling any model", async ({ page }) => {
  await ask(page, "hi");
  const answer = lastAnswer(page);
  await expect(answer).toHaveAttribute("data-status", "done");
  await expect(answer.getByTestId("answer-text")).toContainText("couldn't find this in the NimbusStack knowledge base");
  await expect(answer.getByTestId("answered-by")).toContainText("No AI call");
  await expect(answer.getByTestId("usage-line")).toContainText("in 0 · out 0 tokens");
});

test("NKA-USG-007 / E7: switching to a smaller-window model updates the warning immediately", async ({ page }) => {
  // The live catalog has only ~1M-token windows, so stub one small-window model to make E7 visible.
  await page.route("**/api/models", async (route) => {
    const real = await (await route.fetch()).json();
    real.models.push({ ...real.models[0], id: "tiny-window", displayName: "Tiny window (test stub)", contextWindow: 1700 });
    await route.fulfill({ json: real });
  });
  await page.goto("/");
  const meter = page.getByTestId("context-meter");
  await expect(meter).toHaveAttribute("data-level", "ok");
  await page.getByTestId("model-select").selectOption("tiny-window");
  await expect(meter).toHaveAttribute("data-level", "amber"); // ~1,500 / 1,700 tokens, before anything is sent
  await page.getByTestId("composer").fill("x".repeat(400));
  await expect(meter).toHaveAttribute("data-level", "red");
  await page.getByTestId("model-select").selectOption("gemini-flash-lite");
  await expect(meter).toHaveAttribute("data-level", "ok");
});

test("NKA-USG-003 / CHAT-003: totals add up, New Conversation resets", async ({ page }) => {
  await ask(page, "Relay pricing");
  await expect(lastAnswer(page)).toHaveAttribute("data-status", "done");
  await ask(page, "Vault pricing");
  await expect(lastAnswer(page)).toHaveAttribute("data-status", "done");
  await expect(page.getByTestId("session-totals")).toContainText("2 answers");
  await page.getByTestId("new-conversation").click();
  await expect(page.getByTestId("answer")).toHaveCount(0);
  await expect(page.getByTestId("session-totals")).toContainText("0 answers");
});

test("NKA-MDL-003: switching model keeps history; next reply from the new model", async ({ page }) => {
  await ask(page, "Does Pulse integrate with Salesforce?");
  await expect(lastAnswer(page)).toHaveAttribute("data-status", "done");
  await page.getByTestId("model-select").selectOption("openai-luna");
  await ask(page, "what about its SLA?");
  await expect(lastAnswer(page)).toHaveAttribute("data-status", "done");
  await expect(page.getByTestId("question")).toHaveCount(2);
  await expect(lastAnswer(page).getByTestId("answered-by")).toContainText("GPT-5.6 Luna");
  await lastAnswer(page).getByTestId("sources").locator("summary").click();
  await expect(lastAnswer(page).getByTestId("sources")).toContainText("pulse.md · Support SLA"); // E1
});

test("NKA-MDL-004: primary fails → backup answers, labelled", async ({ page }) => {
  await ask(page, "Relay pricing #fail-primary");
  const answer = lastAnswer(page);
  await expect(answer).toHaveAttribute("data-status", "done");
  await expect(answer.getByTestId("fallback-note")).toContainText("backup answered");
});

test("NKA-MDL-005: mid-stream failure shows only the backup's answer", async ({ page }) => {
  await ask(page, "Relay pricing #fail-midstream");
  const answer = lastAnswer(page);
  await expect(answer).toHaveAttribute("data-status", "done");
  const text = await answer.getByTestId("answer-text").innerText();
  // The mock prefixes each answer with its model id; only one model may appear.
  expect(text.match(/\((gemini|openai|claude)-[a-z-]+\)/g)).toHaveLength(1);
});

test("NKA-MDL-006: all providers rate-limited → clear message, no stack trace", async ({ page }) => {
  await ask(page, "Relay pricing #rate-limit-all");
  const error = lastAnswer(page).getByTestId("answer-error");
  await expect(error).toContainText(/rate-limited right now\. Wait about \d+ seconds/);
  await expect(error).not.toContainText(/Error:|at .*\.ts/);
  await expect(page.getByTestId("send")).toBeVisible(); // not frozen
});

test("NKA-USG-005: context meter re-rates on model switch", async ({ page }) => {
  const meter = page.getByTestId("context-meter");
  await page.getByTestId("model-select").selectOption("gemini-flash");
  await expect(meter).toContainText("1,048,576 tokens");
  await page.getByTestId("model-select").selectOption("claude-haiku");
  await expect(meter).toContainText("1,000,000 tokens");
  await expect(meter).toHaveAttribute("data-level", "ok");
});

test("NKA-USG-006: export downloads usage as CSV and JSON", async ({ page }) => {
  await ask(page, "Ledger pricing");
  await expect(lastAnswer(page)).toHaveAttribute("data-status", "done");
  const [csv] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-csv").click()]);
  expect(csv.suggestedFilename()).toBe("nimbus-usage.csv");
  const [json] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-json").click()]);
  expect(json.suggestedFilename()).toBe("nimbus-usage.json");
});
