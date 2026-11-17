// Shared steps for the browser tests that drive the full-page automation editor (control center, Automations tab).
import assert from "node:assert/strict";
import type { Page } from "playwright-core";

export async function signInToApp(page: Page, url: string, username: string, password: string) {
  await page.goto(url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(username);
  await page.locator("#loginPasswordInput").fill(password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length >= 2 && !document.body.classList.contains("booting"));
  await page.waitForFunction(async () => (await import("/app/state.js")).state.preferencesLoaded);
  await page.waitForTimeout(500);
}

/** The project's row menu → Automations: the control center's Automations tab, filtered to that project. */
export async function openProjectAutomations(page: Page, projectName = "Internal Assistant") {
  await page.locator(`[aria-label="Actions for ${projectName}"]`).click();
  await page.getByTestId("project-automations-button").click();
  await page.getByTestId("automations-new-automation").waitFor();
}

/** The editor fills its tabs after it appears, and the auto reply settings load last: typing or saving before that fails or is overwritten. */
export async function editorReady(page: Page) {
  await page.getByTestId("automation-editor").waitFor();
  await page.locator('[data-testid="automation-tab-setup"][aria-selected="true"]').waitFor();
  await page.waitForFunction(() => (document.querySelector('[data-testid="automation-autoreply-harness"]') as HTMLSelectElement | null)?.options.length, undefined, { timeout: 15_000 });
}

export async function newAutomation(page: Page) {
  await page.getByTestId("automations-new-automation").click();
  await editorReady(page);
}

export const editorTab = (page: Page, id: "setup" | "trigger" | "run" | "context" | "history") => page.getByTestId(`automation-tab-${id}`).click();

/** Saves and waits for the success line or the address page; any other status line fails with its text. */
export async function saveAutomation(page: Page) {
  await page.getByTestId("automation-save").click();
  await page.waitForFunction(() => /created|saved/i.test(document.querySelector('[data-testid="automation-status"]')?.textContent ?? "") || document.querySelector('[data-testid="automation-address"]') || (document.querySelector('[data-testid="automation-status"]')?.textContent ?? "") !== "").catch(async (error) => {
    throw new Error(`${error.message}\nstatus: "${await page.getByTestId("automation-status").textContent()}" save disabled: ${await page.getByTestId("automation-save").isDisabled()} summary: ${await page.getByTestId("automation-summary").textContent()}`);
  });
  if (!await page.getByTestId("automation-address").count()) assert.match((await page.getByTestId("automation-status").textContent()) ?? "", /created|saved/i, "saving failed");
}

/** A webhook shows its secret address once after it is saved; Done goes on to the editor. */
export async function dismissAddress(page: Page) {
  await page.getByTestId("automation-address").first().waitFor();
  await page.getByTestId("automation-address-done").click();
  await page.getByTestId("automation-setup-name").waitFor({ state: "visible" });
}

export async function backToList(page: Page) {
  await page.getByTestId("automation-back").click();
  await page.getByTestId("automations-list").waitFor();
}

export async function openAutomationRow(page: Page, name: string) {
  const row = page.locator('[data-testid="automation-row"]', { hasText: name });
  await row.first().waitFor({ timeout: 10_000 });
  await row.first().getByTestId("automation-edit").click();
  await editorReady(page);
}

/** Fills the Setup tab of a new automation. */
export async function fillSetup(page: Page, name: string, instructions: string) {
  await page.getByTestId("automation-setup-name").fill(name);
  await page.getByTestId("automation-setup-instructions").fill(instructions);
}
