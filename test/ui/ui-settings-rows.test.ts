import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

async function openSettingsTab(page: import("playwright-core").Page, tab: string) {
  await page.evaluate(async (id) => (await import("/app/settings.js")).openSettings(id), tab);
  await page.locator('#settingsForm[data-ready="true"]').waitFor();
}

test("labels and commands are lists of editable rows that save as they change", { timeout: 24_000_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  page.setDefaultTimeout(45_000);
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().waitFor();

  await openSettingsTab(page, "labels");
  const saved = page.locator('[data-testid="settings-save-state"][data-state="saved"]');
  const text = page.getByTestId("settings-conversation-labels");
  const before = (await text.inputValue()).split("\n").filter(Boolean);
  await page.getByTestId("label-add").click();
  await page.getByTestId("label-name-input").last().fill("Spike");
  await saved.waitFor();
  assert.deepEqual((await text.inputValue()).split("\n").filter(Boolean), [...before, "Spike"], "a new row is written to the saved list");
  await page.getByTestId("label-name-input").last().fill("Spike two");
  await page.getByTestId("label-icon-input").last().fill("🧪");
  assert.equal(await page.getByTestId("label-icon-input").last().getAttribute("aria-label"), "Icon for Spike two");
  assert.ok((await text.inputValue()).split("\n").includes("Spike two"), "renaming a row renames the label");
  await page.getByTestId("label-remove").last().click();
  assert.deepEqual((await text.inputValue()).split("\n").filter(Boolean), before, "removing a row removes the label");
  await page.getByTestId("labels-text-details").evaluate((details) => { (details as HTMLDetailsElement).open = true; });
  await text.fill([...before, "From text"].join("\n"));
  await text.blur();
  await page.getByTestId("label-name-input").last().waitFor();
  assert.equal(await page.getByTestId("label-name-input").last().inputValue(), "From text", "editing the text redraws the rows");

  await openSettingsTab(page, "commands");
  await page.getByTestId("add-saved-command").click();
  await page.locator("#savedCommandsList input").fill("Review changes");
  await page.locator("#savedCommandsList textarea").fill("Review my changes, do not send this yet.");
  await saved.waitFor();
  const row = page.locator("#savedCommandsList > .saved-command-row");
  await page.locator("#savedCommandsList textarea").blur();
  const box = await row.boundingBox();
  assert.ok(box && box.height < 70, `a command is one line, not a form (height ${box?.height})`);
  assert.equal(await page.getByTestId("saved-command-share").isVisible(), true, "Share is the row's own action");
  assert.equal(await page.getByTestId("saved-command-remove").isVisible(), false, "Remove waits in the ⋯ menu");
  await row.locator(".long-row-more").click();
  await page.getByTestId("saved-command-remove").click();
  await row.waitFor({ state: "detached" });
});
