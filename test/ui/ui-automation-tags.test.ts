import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { backToList, editorReady, fillSetup, newAutomation, openProjectAutomations, saveAutomation } from "./automation-editor-driver.js";

test("settings manages workspace tags and automation forms keep manual tags separate", { timeout: 180_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.getByText("Internal Assistant", { exact: true }).waitFor();
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-automation-tags").click();
  await page.waitForFunction(() => document.querySelectorAll("#automationTagsWorkspace option").length > 0);
  await page.getByTestId("automation-tags-new-name").fill("Nightly review");
  await page.getByTestId("automation-tags-add").click();
  await page.waitForFunction(() => [...document.querySelectorAll("#automationTagsList input")].some(input => input.value === "Nightly review"));
  const tagId = await page.locator("#automationTagsWorkspace").evaluate(async select => {
    const workspaceId = select.value;
    const response = await fetch(`/api/workspaces/${workspaceId}/automation-tags`);
    return (await response.json()).tags[0].id;
  });
  await page.getByTestId("settings-cancel-button").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length >= 2 && !document.body.classList.contains("booting"));
  await page.waitForFunction(async () => (await import("/app/state.js")).state.preferencesLoaded);
  await page.waitForTimeout(500);
  await openProjectAutomations(page);
  await newAutomation(page);
  await fillSetup(page, "Tagged nightly", "Review the project");
  await page.getByTestId("automation-tags-managed").selectOption(tagId);
  await page.getByTestId("automation-tags-manual").fill("One-off");
  await page.getByTestId("automation-tags-add-manual").click();
  await saveAutomation(page);
  const saved = await page.evaluate(async () => {
    const body = await (await fetch("/api/automations")).json();
    return body.automations.find((item: { name: string }) => item.name === "Tagged nightly").tags;
  });
  assert.deepEqual(saved, { managedTagIds: [tagId], manualTags: ["One-off"] });
  await backToList(page);
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-automation-tags").click();
  await page.locator("#automationExecutionsSummary").waitFor();
  assert.match(await page.getByTestId("automation-executions-summary").innerText(), /Executions 0/);
});
