import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { backToList, dismissAddress, editorTab, fillSetup, newAutomation, openAutomationRow, openProjectAutomations, saveAutomation, signInToApp } from "./automation-editor-driver.js";

test("cleanup opts into isolated runs, disables preserved files and survives reopening", { timeout: 180_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signInToApp(page, node.url, environment.username, environment.password);
  await openProjectAutomations(page);
  for (const trigger of ["schedule", "webhook"]) {
    await newAutomation(page);
    if (trigger === "webhook") await page.getByTestId("automation-trigger-webhook").click();
    await fillSetup(page, `Cleanup ${trigger}`, "Check the project");
    await editorTab(page, "run");
    const cleanup = page.getByTestId("automation-cleanup-after-run");
    assert.equal(await cleanup.isChecked(), false);
    await page.getByTestId("automation-worktree").uncheck();
    await page.getByTestId("automation-preserve-files").check();
    await cleanup.check();
    assert.equal(await page.getByTestId("automation-worktree").isChecked(), true);
    assert.equal(await page.getByTestId("automation-worktree").isDisabled(), true);
    assert.equal(await page.getByTestId("automation-preserve-files").isChecked(), false);
    assert.equal(await page.getByTestId("automation-preserve-files").isDisabled(), true);
    await saveAutomation(page);
    if (trigger === "webhook") await dismissAddress(page);
    await backToList(page);
    await openAutomationRow(page, `Cleanup ${trigger}`);
    await editorTab(page, "run");
    assert.equal(await cleanup.isChecked(), true);
    await cleanup.uncheck();
    assert.equal(await page.getByTestId("automation-worktree").isDisabled(), false);
    await saveAutomation(page);
    await backToList(page);
    await openAutomationRow(page, `Cleanup ${trigger}`);
    await editorTab(page, "run");
    assert.equal(await cleanup.isChecked(), false);
    await backToList(page);
  }
});

test("webhook and schedule editors default to worktrees and persist the per-item opt-out", { timeout: 180_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signInToApp(page, node.url, environment.username, environment.password);
  await openProjectAutomations(page);

  // A schedule: the Run tab starts with a fresh worktree, and turning it off survives saving and reopening.
  await newAutomation(page);
  await fillSetup(page, "Isolated schedule", "Check the project");
  await editorTab(page, "run");
  await page.getByTestId("automation-worktree").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("automation-worktree").isChecked(), true);
  assert.equal(await page.getByTestId("automation-preserve-files").isDisabled(), true);
  await page.getByTestId("automation-worktree").uncheck();
  assert.equal(await page.getByTestId("automation-preserve-files").isDisabled(), false);
  await saveAutomation(page);
  await backToList(page);
  await openAutomationRow(page, "Isolated schedule");
  await editorTab(page, "run");
  assert.equal(await page.getByTestId("automation-worktree").isChecked(), false);
  await page.getByTestId("automation-worktree").check();
  await saveAutomation(page);
  await backToList(page);
  await openAutomationRow(page, "Isolated schedule");
  await editorTab(page, "run");
  assert.equal(await page.getByTestId("automation-worktree").isChecked(), true);
  await backToList(page);

  // A webhook: the same default and the same persisted opt-out.
  await newAutomation(page);
  await page.getByTestId("automation-trigger-webhook").click();
  await fillSetup(page, "Isolated webhook", "Check the call");
  await editorTab(page, "run");
  await page.getByTestId("automation-worktree").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("automation-worktree").isChecked(), true);
  assert.equal(await page.getByTestId("automation-preserve-files").isDisabled(), true);
  await page.getByTestId("automation-worktree").uncheck();
  assert.equal(await page.getByTestId("automation-preserve-files").isDisabled(), false);
  await saveAutomation(page);
  await dismissAddress(page);
  await backToList(page);
  await openAutomationRow(page, "Isolated webhook");
  await editorTab(page, "run");
  assert.equal(await page.getByTestId("automation-worktree").isChecked(), false);
  await page.getByTestId("automation-worktree").check();
  await saveAutomation(page);
  await backToList(page);
  await openAutomationRow(page, "Isolated webhook");
  await editorTab(page, "run");
  assert.equal(await page.getByTestId("automation-worktree").isChecked(), true);
});
