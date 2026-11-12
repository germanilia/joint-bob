import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { waitInPage } from "./wait-in-page.js";

test("disabling unavailable Kiro allows Settings saves and survives reopening", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#loginDialog[open]").waitFor({ state: "hidden" });
  await waitInPage(page, async () => (await import("/app/state.js")).state.preferencesLoaded);
  await page.evaluate(async () => {
    const { api } = await import("/app/api.js");
    const settings = await api("/api/settings");
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ runtimes: { kiro: { ...settings.runtimes.kiro, executable: "/nonexistent/kiro-cli" } } }) });
  });
  const saveState = page.getByTestId("settings-save-state");
  const open = async () => {
    await page.getByTestId("settings-open-button").click();
    await page.locator("#settingsDialog[open]").waitFor();
    await page.getByTestId("settings-tab-engines").click();
    await page.locator('#settingsForm[data-ready="true"]').waitFor();
    await page.getByTestId("harness-tab-kiro").click();
  };
  /** Any change saves every node setting, so picking another Kiro reasoning level is a save. */
  const changeKiroThinking = async () => {
    const thinking = page.getByTestId("settings-kiro-default-thinking");
    const other = await thinking.evaluate((select: HTMLSelectElement) => [...select.options].find((option) => !option.selected)!.value);
    await thinking.selectOption(other);
  };
  await open();
  await changeKiroThinking();
  await page.locator('[data-testid="settings-save-state"][data-state="failed"]').waitFor();
  await saveState.getByText("Not saved: Fix unavailable custom paths: Kiro executable", { exact: true }).waitFor();
  assert.equal(await page.locator(".toast", { hasText: "Fix unavailable custom paths" }).count(), 0, "a problem found before sending shows only on the save line");
  await page.getByTestId("settings-kiro-enabled").uncheck();
  assert.equal(await page.getByTestId("settings-kiro-executable-input").isDisabled(), true);
  await page.locator('[data-testid="settings-save-state"][data-state="saved"]').waitFor();
  const saved = await page.evaluate(async () => (await fetch("/api/settings")).json());
  assert.equal(saved.kiroEnabled, false);
  assert.equal(saved.runtimeOverrides.kiro.executable, "/nonexistent/kiro-cli");
  const harnesses = await page.evaluate(async () => (await fetch("/api/harnesses")).json());
  assert.equal(harnesses.harnesses.find((h: { id: string }) => h.id === "kiro").unavailableReason, "Kiro is disabled on this node");
  await page.getByTestId("settings-cancel-button").click();
  await page.locator("#settingsDialog[open]").waitFor({ state: "hidden" });
  await open();
  assert.equal(await page.getByTestId("settings-kiro-enabled").isChecked(), false);
  // With Kiro off, its unavailable path no longer stops other changes from saving.
  await changeKiroThinking();
  await page.locator('[data-testid="settings-save-state"][data-state="saved"]').waitFor();
  await page.getByTestId("settings-cancel-button").click();
  await page.locator("#settingsDialog[open]").waitFor({ state: "hidden" });
});
