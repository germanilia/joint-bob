// Browser suite for the unified automation editor: one full page for a schedule or a webhook, with the Setup, Trigger,
// Run, Context and History tabs. It drives a real Chrome against a seeded node and fails on any page error.
//
//
// Run with `npm run test:file -- test/ui/ui-automations.test.ts`.
import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

async function signInAndOpen(page: Page, url: string, username: string, password: string) {
  await page.goto(url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(username);
  await page.locator("#loginPasswordInput").fill(password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length >= 2 && !document.body.classList.contains("booting"));
  await page.waitForFunction(async () => (await import("/app/state.js")).state.preferencesLoaded);
  await page.waitForTimeout(500);
  await page.getByTestId("projects-open-control-center-button").click();
  await page.getByTestId("control-tab-automations").waitFor({ state: "attached" });
  await page.getByTestId("workspace-automations-button").click();
}

let lastStatus = "";
/** The editor fills its tabs after it appears, and the auto reply settings load last: typing or saving before that fails or is overwritten. */
async function ready(page: Page) {
  await page.locator('[data-testid="automation-tab-setup"][aria-selected="true"]').waitFor();
  await page.waitForFunction(() => (document.querySelector('[data-testid="automation-autoreply-harness"]') as HTMLSelectElement | null)?.options.length, undefined, { timeout: 8000 }).catch(async (error) => {
    throw new Error(`${error.message}\nstatus: ${await page.getByTestId("automation-status").textContent()}\nharnesses: ${JSON.stringify(await page.evaluate(async () => { const { api } = await import("/app/api.js"); return (await api("/api/harnesses")).harnesses.map((h: any) => [h.id, h.runtimeConfigured]); }))}`);
  });
}
const tab = (page: Page, id: string) => page.getByTestId(`automation-tab-${id}`).click();
const visible = (page: Page, id: string) => page.getByTestId(id).filter({ visible: true });

async function newAutomation(page: Page) {
  await page.getByTestId("automations-new-automation").click();
  await page.getByTestId("automation-editor").waitFor();
  // The editor fills its tabs after it appears; typing before that would be overwritten.
  await ready(page);
}

/** Saves and waits for the success line or the address page; any other status line fails with its text. */
async function save(page: Page) {
  await page.getByTestId("automation-save").click();
  const status = page.getByTestId("automation-status");
  await page.waitForFunction(() => /created|saved/i.test(document.querySelector('[data-testid="automation-status"]')?.textContent ?? "") || document.querySelector('[data-testid="automation-address"]') || (document.querySelector('[data-testid="automation-status"]')?.textContent ?? "") !== "");
  const text = (await status.textContent()) ?? "";
  lastStatus = text;
  if (!await page.getByTestId("automation-address").count()) assert.match(text, /created|saved/i, `saving failed: ${text}`);
}

async function backToList(page: Page) {
  await page.getByTestId("automation-back").click();
  await page.getByTestId("automations-list").waitFor();
}

async function openRow(page: Page, name: string) {
  const row = page.locator('[data-testid="automation-row"]', { hasText: name });
  await row.first().waitFor({ timeout: 8000 }).catch(async (error) => {
    throw new Error(`${error.message}\nlast saved status: ${lastStatus}\nrows: ${await page.getByTestId("automation-name").allTextContents()}\napi: ${JSON.stringify(await page.evaluate(async () => { const { api } = await import("/app/api.js"); const { state } = await import("/app/state.js"); const a = await api("/api/automations"); const b = await api("/api/control-center/automations"); return { filter: state.controlCenter.filter, autos: a.automations.map((x: any) => [x.name, x.target.projectId]), rows: b.rows.map((r: any) => [r.name, r.projectIds]), projects: (await api("/api/automations/projects")).projects }; }))}\nlist text: ${(await page.getByTestId("automations-list").textContent())?.slice(0, 400)}`);
  });
  await row.first().getByTestId("automation-edit").click();
  await ready(page);
}

test("the automation editor creates, edits and switches schedules and webhooks without a page error", { timeout: 240_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  // Browser-reported resource failures carry no URL; the vendor bundles are not built in a test checkout. API failures are checked below by URL.
  page.on("console", (message) => { if (message.type() === "error" && !/Failed to load resource|vendor\/xterm/.test(message.text())) problems.push(`console: ${message.text()}`); });
  page.on("response", (response) => {
    const { pathname } = new URL(response.url());
    if (pathname.startsWith("/api/") && response.status() >= 400) problems.push(`${response.status()} ${response.request().method()} ${pathname}`);
  });

  await signInAndOpen(page, node.url, environment.username, environment.password);

  // (a) A new schedule: every few hours.
  await newAutomation(page);
  assert.equal(await page.getByTestId("automation-trigger-schedule").getAttribute("aria-checked"), "true", "a new automation starts as a schedule");
  assert.equal(await page.getByTestId("automation-tab-history").isHidden(), true, "a new automation has no History yet");
  await page.getByTestId("automation-setup-name").fill("Hourly check");
  await page.getByTestId("automation-setup-instructions").fill("Look at the build");
  await tab(page, "trigger");
  await page.getByTestId("automation-frequency-hourly").click();
  await page.getByTestId("automation-interval-hours").fill("3");
  await page.getByTestId("automation-time").fill("06:30");
  await save(page);
  assert.equal(await page.getByTestId("automation-editor-state").isVisible(), true, "a saved automation shows its state");
  await backToList(page);
  await openRow(page, "Hourly check");
  await tab(page, "trigger");
  assert.equal(await page.getByTestId("automation-frequency-hourly").getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByTestId("automation-interval-hours").inputValue(), "3");
  assert.equal(await page.getByTestId("automation-time").inputValue(), "06:30");
  await backToList(page);

  // Every few minutes round-trips with its interval.
  await newAutomation(page);
  await page.getByTestId("automation-setup-name").fill("Quarter hour");
  await page.getByTestId("automation-setup-instructions").fill("Ping");
  await tab(page, "trigger");
  await page.getByTestId("automation-frequency-minutely").click();
  await page.getByTestId("automation-interval-minutes").fill("15");
  await save(page);
  await backToList(page);
  await openRow(page, "Quarter hour");
  await tab(page, "trigger");
  assert.equal(await page.getByTestId("automation-frequency-minutely").getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByTestId("automation-interval-minutes").inputValue(), "15");
  await backToList(page);

  // (b) A new webhook: its address shows once.
  await newAutomation(page);
  await page.getByTestId("automation-trigger-webhook").click();
  assert.equal(await page.getByTestId("automation-trigger-webhook").getAttribute("aria-checked"), "true");
  await page.getByTestId("automation-setup-name").fill("Issue hook");
  await page.getByTestId("automation-setup-instructions").fill("Triage the call");
  await save(page);
  await page.getByTestId("automation-address").first().waitFor();
  assert.equal(await page.getByTestId("automation-address").count(), 1, "the address shows once");
  const firstAddress = (await page.getByTestId("automation-address").textContent()) ?? "";
  assert.match(firstAddress, /\/hooks\//);
  await page.getByTestId("automation-address-done").click();
  await page.getByTestId("automation-setup-name").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("automation-editor-kind").textContent(), "⚡ webhook");
  await tab(page, "trigger");
  assert.equal(await visible(page, "automation-new-address").count(), 1, "the Trigger tab shows the address card");
  assert.equal(await page.getByTestId("automation-address").count(), 0, "the address is not shown again");

  // (c) Switch the webhook to a schedule: a warning, then it saves; switching back makes a new address.
  await tab(page, "setup");
  assert.equal(await page.getByTestId("automation-trigger-warning").isHidden(), true);
  await page.getByTestId("automation-trigger-schedule").click();
  assert.match(await page.getByTestId("automation-trigger-warning").textContent() ?? "", /removes this automation's webhook address/);
  await tab(page, "trigger");
  assert.equal(await page.getByTestId("automation-frequency-daily").isVisible(), true);
  await save(page);
  assert.equal(await page.getByTestId("automation-editor-kind").textContent(), "⏱ schedule");
  await tab(page, "setup");
  assert.equal(await page.getByTestId("automation-trigger-warning").isHidden(), true, "the warning goes once saved");
  await page.getByTestId("automation-trigger-webhook").click();
  assert.match(await page.getByTestId("automation-trigger-warning").textContent() ?? "", /secret address/);
  await save(page);
  await page.getByTestId("automation-address").first().waitFor();
  const secondAddress = (await page.getByTestId("automation-address").textContent()) ?? "";
  assert.match(secondAddress, /\/hooks\//);
  assert.notEqual(secondAddress, firstAddress, "switching back makes a new address");
  await page.getByTestId("automation-address-done").click();

  // (d) Run tab.
  await tab(page, "run");
  await page.getByTestId("automation-harness").waitFor({ state: "visible" });
  assert.ok(await page.getByTestId("automation-harness").locator("option").count() >= 2, "harnesses fill");
  await page.getByTestId("automation-autoreply-switch").waitFor({ state: "attached" });
  assert.equal(await page.getByTestId("automation-autoreply-instructions").isHidden(), true, "auto reply starts off");
  await page.getByTestId("automation-autoreply-switch").check();
  assert.equal(await page.getByTestId("automation-autoreply-instructions").isVisible(), true, "the switch reveals the responder fields");
  assert.equal(await page.getByTestId("automation-autoreply-harness").isVisible(), true);
  assert.ok(await page.getByTestId("automation-autoreply-model").locator("option").count() >= 1, "responder models fill");
  assert.ok(await page.getByTestId("automation-model").locator("option").count() >= 1);
  assert.ok(await page.getByTestId("automation-reasoning").locator("option").count() >= 1);
  assert.equal(await page.getByTestId("automation-pool-picker").count() + await page.locator('[data-testid^="automation-pool"]').count() > 0, true, "the subscription pool picker is present");
  await page.getByTestId("automation-autoreply-switch").uncheck();

  // (e) Context tab, for a saved automation.
  await tab(page, "context");
  await page.getByTestId("automation-secret-accounts").waitFor();
  await page.getByTestId("automation-secret-search-input").fill("zzzz-no-such-account");
  assert.equal(await page.getByTestId("automation-secret-account-checkbox").count(), 0);
  await page.getByTestId("automation-secret-search-input").fill("");
  await page.getByTestId("automation-context-segment-skills").click();
  await page.getByTestId("automation-skill-available").waitFor({ state: "visible" });
  await page.getByTestId("automation-skill-add-button").click();
  await page.getByTestId("automation-skill-panel").waitFor({ state: "visible" });
  await page.getByTestId("automation-context-segment-memory").click();
  await page.getByTestId("automation-memory-enabled-toggle").waitFor({ state: "visible" });
  await page.getByTestId("automation-context-segment-files").click();
  await page.getByTestId("automation-resource-drop").waitFor({ state: "visible" });

  // (f) History.
  await tab(page, "history");
  await page.waitForFunction(() => document.querySelector('[data-testid="automation-tab-history"]')?.getAttribute("aria-selected") === "true");
  await page.getByText("No runs yet.").first().waitFor();
  await backToList(page);

  // (e) again: a new automation stages files and says to create it first for skills and memory.
  await newAutomation(page);
  await tab(page, "context");
  await page.getByTestId("automation-context-segment-files").click();
  await page.getByTestId("automation-resource-drop").waitFor({ state: "visible" });
  await page.getByTestId("automation-context-segment-skills").click();
  await page.getByText("Create the automation first, then add files, skills and memory.").filter({ visible: true }).first().waitFor();
  await page.getByTestId("automation-context-segment-memory").click();
  await page.getByText("Create the automation first, then add files, skills and memory.").filter({ visible: true }).first().waitFor();
  await tab(page, "run");
  await page.getByTestId("automation-target-conversation").click();
  await page.getByTestId("automation-conversation").waitFor({ state: "visible" });
  await page.getByTestId("automation-target-assistant").waitFor({ state: "hidden" });

  assert.deepEqual(problems, [], `the editor raised errors:\n${problems.join("\n")}`);
});
