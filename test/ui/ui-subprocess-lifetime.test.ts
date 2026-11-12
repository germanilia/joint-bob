import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("Settings edits and reloads the bounded subprocess lifetime", { timeout: 120_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByTestId("settings-open-button").click();
  await page.locator('#settingsForm[data-ready="true"]').waitFor();
  const minutes = page.getByTestId("settings-subprocess-max-lifetime-minutes");
  const saveState = page.getByTestId("settings-save-state");
  assert.equal(await minutes.inputValue(), "360");
  for (const invalid of ["0", "1.5", "10081"]) {
    await minutes.fill(invalid);
    assert.equal(await minutes.evaluate((input: HTMLInputElement) => input.checkValidity()), false);
  }
  // A number saves when it is left; an invalid one is refused on the save line and nothing is sent.
  await minutes.press("Tab");
  await page.locator('[data-testid="settings-save-state"][data-state="failed"]').waitFor();
  assert.match(await saveState.innerText(), /^Not saved: /);
  assert.equal(await page.evaluate(async () => (await (await fetch("/api/settings")).json()).subprocessMaxLifetimeMinutes), 360);
  await minutes.fill("120");
  await minutes.press("Tab");
  await page.locator('[data-testid="settings-save-state"][data-state="saved"]').waitFor();
  assert.equal(await page.evaluate(async () => (await (await fetch("/api/settings")).json()).subprocessMaxLifetimeMinutes), 120);
  await page.reload();
  await page.getByTestId("settings-open-button").click();
  await page.locator('#settingsForm[data-ready="true"]').waitFor();
  assert.equal(await minutes.inputValue(), "120");
});
