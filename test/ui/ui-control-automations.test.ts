import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { backToList, dismissAddress, editorReady, editorTab } from "./automation-editor-driver.js";

const BASE = "/api/control-center/automations";

/** The page's own API client, so the test acts as the signed-in person. */
function call<T = unknown>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  return page.evaluate(async ({ method, path, body }) => {
    const { api } = await import("/app/api.js");
    return api(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }, { method, path, body }) as Promise<T>;
}

/** The row with this text, wherever it is in the pages. Looks from the first page on. */
async function findRow(page: Page, text: string) {
  const row = page.locator('[data-testid="automation-row"]', { hasText: text });
  for (let step = 0; step < 8; step += 1) {
    const previous = page.getByTestId("automations-page-previous");
    if (await previous.count() && await previous.isEnabled()) { await previous.click(); await page.waitForTimeout(80); } else break;
  }
  for (let step = 0; step < 8; step += 1) {
    if (await row.count()) return row.first();
    const next = page.getByTestId("automations-page-next");
    if (!await next.count() || await next.isDisabled()) break;
    await next.click();
    await page.waitForTimeout(80);
  }
  throw new Error(`No row says "${text}"`);
}

/** The input of one automation: a daily schedule at 02:00 UTC in a project. */
const schedule = (projectId: string, name: string, extra: { prompt?: string; enabled?: boolean } = {}) => ({
  name, target: { kind: "project", projectId }, context: extra.prompt ?? `Do ${name}`, trigger: "schedule", enabled: extra.enabled ?? true,
  schedule: { frequency: "daily", hour: 2, minute: 0, weekday: 1, timezone: "UTC" },
});
type Stored = { id: string; name: string; trigger: string; enabled: boolean; context: string; schedule: { frequency: string; weekday: number; hour: number; minute: number } };
const stored = async (page: Page) => (await call<{ automations: Stored[] }>(page, "GET", "/api/automations")).automations;

test("the Automations tab lists every scheduled task, webhook and Bob report, filters by project, pages, and opens the full editor to edit or add one", { timeout: 180_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const [alpha, beta] = node.projects;
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length >= 2 && !document.body.classList.contains("booting"));
  await page.waitForFunction(async () => (await import("/app/state.js")).state.preferencesLoaded);
  await page.waitForTimeout(500);

  // What exists before the person opens the tab: tasks in two projects, a webhook, and enough tasks to need a second page.
  const nightly = (await call<{ automation: { id: string } }>(page, "POST", "/api/automations", schedule(alpha.id, "Nightly release check", { prompt: "Run the release gate, report only" }))).automation;
  const slow = (await call<{ automation: { id: string } }>(page, "POST", "/api/automations", schedule(beta.id, "DB slow query report", { enabled: false }))).automation;
  await call(page, "POST", "/api/automations", { name: "GitHub issues", target: { kind: "project", projectId: alpha.id }, context: "Triage the issue", trigger: "webhook" });
  for (let index = 1; index <= 16; index += 1) await call(page, "POST", "/api/automations", schedule(alpha.id, `Zz filler ${String(index).padStart(2, "0")}`));
  const TOTAL = 19;

  await page.getByTestId("projects-open-control-center-button").click();
  await page.getByTestId("control-tab-automations").waitFor({ state: "attached" });
  // The count shows on the tab as soon as the control center opens.
  await page.waitForFunction((expected) => document.querySelector('[data-testid="control-tab-automations"] .control-tab-badge')?.textContent === String(expected), TOTAL);
  await page.getByTestId("workspace-automations-button").click();
  await page.getByTestId("automation-row").first().waitFor();

  // It pages to the height it has and never scrolls.
  const rowsOnPage = await page.getByTestId("automation-row").count();
  assert.ok(rowsOnPage >= 3 && rowsOnPage < TOTAL, `a page holds some of the rows, got ${rowsOnPage}`);
  const fits = await page.getByTestId("automations-list").evaluate((list) => list.scrollHeight <= list.clientHeight + 1 && getComputedStyle(list).overflowY !== "scroll");
  assert.equal(fits, true, "the list fits its box");
  assert.match(await page.getByTestId("automations-page-label").textContent() ?? "", new RegExp(`^1–${rowsOnPage} of ${TOTAL}$`));
  const firstPage = await page.getByTestId("automation-row").first().getAttribute("data-id");
  await page.getByTestId("automations-page-next").click();
  await page.waitForFunction((label) => document.querySelector('[data-testid="automations-page-label"]')?.textContent !== label, `1–${rowsOnPage} of ${TOTAL}`);
  assert.notEqual(await page.getByTestId("automation-row").first().getAttribute("data-id"), firstPage, "the next page shows other rows");
  await page.getByTestId("automations-page-previous").click();
  await page.waitForFunction((id) => document.querySelector('[data-testid="automation-row"]')?.getAttribute("data-id") === id, firstPage);

  // The project filter is the project focus: choosing a project here narrows this table and Bob's other pages.
  await page.getByTestId(`automations-filter-${beta.id}`).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="automation-row"]').length === 1);
  assert.equal(await page.getByTestId("automation-name").first().textContent(), "DB slow query report");
  assert.equal(await page.getByTestId("automation-kind").first().textContent(), "schedule");
  assert.equal(await page.getByTestId("automation-last").first().textContent(), "paused");
  assert.equal(await page.getByTestId("automation-toggle").first().getAttribute("aria-checked"), "false");
  assert.equal(await page.locator('.control-tab-badge').first().textContent(), "1", "the badge follows the filter");
  // The project chosen here focuses Bob's other pages too (the memory, the dashboards).
  assert.deepEqual(await page.evaluate(async () => (await import("/app/state.js")).state.controlCenter.filter), [beta.id]);
  await page.getByTestId("workspace-automations-button").click();
  await page.getByTestId("automations-filter-all").click();
  await page.waitForFunction((total) => document.querySelector('[data-testid="control-tab-automations"] .control-tab-badge')?.textContent === String(total), TOTAL);
  await page.getByTestId(`automations-filter-${alpha.id}`).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="automation-row"]').length > 3);
  await page.getByTestId("automations-filter-all").click();

  // Turning a task off is the existing update: the automations API agrees.
  await (await findRow(page, "Nightly release check")).getByTestId("automation-toggle").click();
  await page.waitForFunction((id) => document.querySelector(`[data-id="${id}"] [data-testid="automation-toggle"]`)?.getAttribute("aria-checked") === "false", nightly.id);
  assert.equal((await stored(page)).find((item) => item.id === nightly.id)!.enabled, false);
  await (await findRow(page, "Nightly release check")).getByTestId("automation-toggle").click();
  await page.waitForFunction((id) => document.querySelector(`[data-id="${id}"] [data-testid="automation-toggle"]`)?.getAttribute("aria-checked") === "true", nightly.id);

  // Edit opens the full editor, which starts from what is stored and changes only what the person changes.
  await (await findRow(page, "Nightly release check")).getByTestId("automation-edit").click();
  await editorReady(page);
  assert.equal(await page.getByTestId("automation-setup-name").inputValue(), "Nightly release check");
  assert.equal(await page.getByTestId("automation-setup-instructions").inputValue(), "Run the release gate, report only");
  assert.equal(await page.getByTestId("automation-setup-project").inputValue(), alpha.id, "a task stays in its project");
  await editorTab(page, "trigger");
  assert.equal(await page.getByTestId("automation-frequency-daily").getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByTestId("automation-time").inputValue(), "02:00");
  await editorTab(page, "setup");
  await page.getByTestId("automation-setup-name").fill("Weekly release check");
  await editorTab(page, "trigger");
  await page.getByTestId("automation-frequency-weekly").click();
  await page.getByTestId("automation-weekday").selectOption("5");
  await page.getByTestId("automation-time").fill("03:30");
  await page.getByTestId("automation-save").click();
  await page.waitForFunction(() => /saved/i.test(document.querySelector('[data-testid="automation-status"]')?.textContent ?? ""));
  await backToList(page);
  await (await findRow(page, "Weekly release check")).waitFor();
  assert.equal(await (await findRow(page, "Weekly release check")).locator(".automation-when").textContent(), "Fri 03:30");
  const changed = (await stored(page)).find((item) => item.id === nightly.id)!;
  assert.deepEqual([changed.name, changed.context, changed.schedule.frequency, changed.schedule.weekday, changed.schedule.hour, changed.schedule.minute], ["Weekly release check", "Run the release gate, report only", "weekly", 5, 3, 30]);

  // An edit of something that was deleted meanwhile says so.
  await (await findRow(page, "Weekly release check")).getByTestId("automation-edit").click();
  await editorReady(page);
  await call(page, "DELETE", `${BASE}/schedule/${nightly.id}`);
  await page.getByTestId("automation-setup-name").fill("Weekly release check, edited");
  await page.getByTestId("automation-save").click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="automation-status"]')?.textContent ?? "") !== "");
  assert.doesNotMatch(await page.getByTestId("automation-status").textContent() ?? "", /saved|created/i, "saving something that is gone does not claim success");
  await backToList(page);
  await page.getByTestId("automation-row").first().waitFor();

  // A scheduled automation made in the editor, in another project than the one the list started on.
  await page.getByTestId("automations-new-automation").click();
  await editorReady(page);
  await page.getByTestId("automation-setup-name").fill("Log check");
  await page.getByTestId("automation-setup-project").selectOption(beta.id);
  await page.getByTestId("automation-setup-instructions").fill("Look for new errors in the logs");
  await editorTab(page, "trigger");
  await page.getByTestId("automation-frequency-hourly").click();
  await page.getByTestId("automation-time").fill("09:15");
  await page.getByTestId("automation-save").click();
  await page.waitForFunction(() => /created|saved/i.test(document.querySelector('[data-testid="automation-status"]')?.textContent ?? ""));
  await backToList(page);
  const logCheck = (await call<{ automations: Array<Stored & { target: { projectId: string } }> }>(page, "GET", "/api/automations")).automations.find((item) => item.name === "Log check")!;
  assert.deepEqual([logCheck.target.projectId, logCheck.schedule.frequency, logCheck.schedule.minute], [beta.id, "hourly", 15]);

  // A webhook made in the editor shows its secret address once.
  await page.getByTestId("automations-new-automation").click();
  await editorReady(page);
  await page.getByTestId("automation-trigger-webhook").click();
  await page.getByTestId("automation-setup-name").fill("Stripe test events");
  await page.getByTestId("automation-setup-project").selectOption(alpha.id);
  await page.getByTestId("automation-setup-instructions").fill("Read only, report to me");
  await page.getByTestId("automation-save").click();
  await page.getByTestId("automation-address").first().waitFor();
  assert.match(await page.getByTestId("automation-address").textContent() ?? "", /\/hooks\//);
  await dismissAddress(page);
  await backToList(page);
  assert.equal((await stored(page)).some((item) => item.name === "Stripe test events" && item.trigger === "webhook" && item.context === "Read only, report to me"), true, "the automations API lists it");

  // Bob's reports: the evening report starts at 19:00 and covers every project when none is chosen.
  await page.getByTestId("automations-new-bob").click();
  await page.getByTestId("automation-form-report").selectOption("evening");
  assert.equal(await page.getByTestId("automation-form-time").inputValue(), "19:00");
  await page.getByTestId("automation-form-save").click();
  await page.getByTestId("automation-form").waitFor({ state: "hidden" });
  await page.getByTestId("automations-filter-all").click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="automation-row"][data-kind="bob"] [data-testid="automation-name"]')].some((name) => name.textContent === "Evening report"));
  const bobRow = page.locator('[data-testid="automation-row"][data-kind="bob"]').first();
  assert.equal(await bobRow.getByTestId("automation-kind").textContent(), "Bob");
  assert.match(await bobRow.innerText(), /All projects[\s\S]*Daily 19:00 · Bob's chat/);
  // Bob's report shows under any project filter.
  await page.getByTestId(`automations-filter-${beta.id}`).click();
  await page.locator('[data-testid="automation-row"][data-kind="bob"]').first().waitFor();
  await page.getByTestId("automations-filter-all").click();

  // Send now puts the report in Bob's chat.
  await bobRow.getByTestId("automation-send").click();
  await page.waitForFunction(async () => (await (await fetch("/api/control-center/bob/messages?importance=reports")).json()).messages.some((message: { via: string }) => /Evening report · sent now/.test(message.via)));

  // Delete asks twice, then removes it from the system that owns it.
  const filler = await findRow(page, "Zz filler 01");
  await filler.getByTestId("automation-delete").click();
  assert.equal((await filler.getByTestId("automation-delete").textContent())?.trim(), "Delete?");
  assert.equal(await page.locator('[data-testid="automation-row"]', { hasText: "Zz filler 01" }).count(), 1, "the first press only asks");
  await filler.getByTestId("automation-delete").click();
  await page.waitForFunction(() => ![...document.querySelectorAll('[data-testid="automation-name"]')].some((name) => name.textContent === "Zz filler 01"));
  assert.equal((await stored(page)).some((item) => item.name === "Zz filler 01"), false);

  // Edit on any row opens that automation's full editor.
  await page.getByTestId("automations-filter-all").click();
  await (await findRow(page, "Log check")).getByTestId("automation-edit").click();
  await editorReady(page);
  assert.equal(await page.getByTestId("automation-setup-name").inputValue(), "Log check");
  assert.equal(await page.getByTestId("automation-editor-kind").textContent(), "⏱ schedule");
});

test("machines that could not be read are one line with their names, and the full messages under Details", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const errors = [
    "Idos-MacBook-Pro-3.local: Not answering; showing what it reported 15 min ago",
    "Idos-MacBook-Pro-3.local: Not answering; showing what it reported 30 h ago",
    "Contigos EC2: Webhook owner did not respond",
  ];
  await page.route(`**${BASE}`, (route) => route.request().method() === "GET" ? route.fulfill({ json: { rows: [], projects: [], errors, timezone: "UTC" } }) : route.continue());
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length >= 2 && !document.body.classList.contains("booting"));
  await page.waitForFunction(async () => (await import("/app/state.js")).state.preferencesLoaded);
  await page.waitForTimeout(500);
  await page.getByTestId("projects-open-control-center-button").click();
  await page.getByTestId("control-tab-automations").waitFor({ state: "attached" });
  await page.getByTestId("workspace-automations-button").click();
  const problems = page.getByTestId("automations-problems");
  await problems.waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("automations-problems-line").innerText(), "Idos-MacBook-Pro-3.local and Contigos EC2 could not be read. Some rows show what was last reported. Details");
  assert.equal(await problems.locator("li").first().isVisible(), false, "the messages wait under Details");
  await page.getByTestId("automations-problems-line").click();
  assert.deepEqual(await problems.locator("li").allInnerTexts(), errors);
});
