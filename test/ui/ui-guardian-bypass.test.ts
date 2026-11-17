import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { backToList, dismissAddress, editorTab, fillSetup, newAutomation, openAutomationRow, openProjectAutomations, saveAutomation, signInToApp } from "./automation-editor-driver.js";

test("scheduled and webhook automation Guardian checkboxes default off and survive editing", { timeout: 120_000 }, async t => {
  const { page, node, environment } = await nativeUiFixture(t);
  await signInToApp(page, node.url, environment.username, environment.password);
  await openProjectAutomations(page);

  await newAutomation(page);
  await fillSetup(page, "Trusted daily task", "Summarize local fixtures");
  await editorTab(page, "run");
  const bypass = page.getByTestId("automation-bypass-guardian");
  await bypass.waitFor({ state: "visible" });
  assert.equal(await bypass.isChecked(), false);
  await bypass.check();
  await saveAutomation(page);
  await backToList(page);
  await openAutomationRow(page, "Trusted daily task");
  await editorTab(page, "run");
  assert.equal(await bypass.isChecked(), true);
  await bypass.uncheck();
  await saveAutomation(page);
  await backToList(page);
  await openAutomationRow(page, "Trusted daily task");
  await editorTab(page, "run");
  assert.equal(await bypass.isChecked(), false);
  await backToList(page);

  await newAutomation(page);
  await page.getByTestId("automation-trigger-webhook").click();
  await fillSetup(page, "Trusted incoming task", "Triage the call");
  await editorTab(page, "run");
  await bypass.waitFor({ state: "visible" });
  assert.equal(await bypass.isChecked(), false);
  await bypass.check();
  await saveAutomation(page);
  await dismissAddress(page);
  await editorTab(page, "run");
  assert.equal(await bypass.isChecked(), true);
  assert.equal(await page.evaluate(async () => {
    const body = await (await fetch("/api/automations")).json();
    return body.automations.find((item: { name: string }) => item.name === "Trusted incoming task").bypassGuardian;
  }), true);
});
