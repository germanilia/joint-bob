import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { api, signIn } from "../dev-nodes.js";
import { backToList, dismissAddress, editorTab, fillSetup, newAutomation, openAutomationRow, openProjectAutomations, saveAutomation, signInToApp } from "./automation-editor-driver.js";

test("automation pool picker defaults to the current pool and restores an explicit assignment", { timeout: 180_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  const auth = await signIn(environment, node);
  const profile = await api<{ profile: { id: string } }>(node, auth, "POST", "/provider-profiles", { label: "Synthetic automation", provider: "claude" });
  assert.equal(profile.status, 201);
  const created = await api<{ pool: { id: string } }>(node, auth, "POST", "/provider-profiles/pools", { name: "Synthetic pool", profileIds: [profile.body.profile.id], fallbackModels: {} });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const poolId = created.body.pool.id;
  await signInToApp(page, node.url, environment.username, environment.password);
  await openProjectAutomations(page);

  const picker = page.getByTestId("automation-pool");
  const pickerLoaded = () => page.waitForFunction(() => { const select = document.querySelector<HTMLSelectElement>('[data-testid="automation-pool"]'); return select && !select.disabled && select.options.length > 1; });

  // A schedule: a new automation uses the person's current pool until they choose one; the choice survives reopening, and clearing it does too.
  await newAutomation(page);
  await fillSetup(page, "Pool test", "Synthetic, never executed");
  await editorTab(page, "run");
  await pickerLoaded();
  assert.equal(await picker.inputValue(), "");
  assert.equal(await picker.locator("option").first().textContent(), "Use my current pool");
  await picker.selectOption(poolId);
  await saveAutomation(page);
  await backToList(page);
  await openAutomationRow(page, "Pool test");
  await editorTab(page, "run");
  await pickerLoaded();
  assert.equal(await picker.inputValue(), poolId);
  await picker.selectOption("");
  await saveAutomation(page);
  await backToList(page);
  await openAutomationRow(page, "Pool test");
  await editorTab(page, "run");
  await pickerLoaded();
  assert.equal(await picker.inputValue(), "");
  await backToList(page);

  // A webhook has the same picker and the same round trip.
  await newAutomation(page);
  await page.getByTestId("automation-trigger-webhook").click();
  await fillSetup(page, "Pool webhook", "Synthetic, never executed");
  await editorTab(page, "run");
  await pickerLoaded();
  assert.equal(await picker.inputValue(), "");
  await picker.selectOption(poolId);
  await saveAutomation(page);
  await dismissAddress(page);
  await backToList(page);
  await openAutomationRow(page, "Pool webhook");
  await editorTab(page, "run");
  await pickerLoaded();
  assert.equal(await picker.inputValue(), poolId);
  await picker.selectOption("");
  await saveAutomation(page);
  await backToList(page);
  await openAutomationRow(page, "Pool webhook");
  await editorTab(page, "run");
  await pickerLoaded();
  assert.equal(await picker.inputValue(), "");
});
