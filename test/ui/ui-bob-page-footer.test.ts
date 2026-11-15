import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("Bob's page puts the theme and Settings buttons in its top bar, next to Exit", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => !document.body.classList.contains("booting"));
  await page.locator("body.bob-desk.view-control").waitFor();

  const theme = page.locator(".bob-head-theme");
  const settings = page.locator(".bob-head-app-settings");
  const exit = page.getByTestId("control-center-close-button");
  await theme.waitFor({ state: "visible" });
  await settings.waitFor({ state: "visible" });
  const bar = (await page.locator("#controlCenterPanel > .panel-bar").boundingBox())!;
  const exitBox = (await exit.boundingBox())!;
  for (const button of [theme, settings]) {
    const box = (await button.boundingBox())!;
    assert.ok(box.y >= bar.y && box.y + box.height <= bar.y + bar.height, "the button is in the top bar");
    assert.ok(box.x + box.width <= exitBox.x, "the button sits to the left of Exit");
  }
  assert.equal(await page.locator("#workspaceFoot").isVisible(), false, "the footer stays hidden on this page");
  for (const button of [theme, settings, exit, page.getByTestId("control-center-refresh")]) {
    assert.ok((await button.boundingBox())!.width <= 40, "the top-bar button is an icon, not a text button");
  }
  // The team context and Bob's settings are in Bob's chat header, not in the top bar.
  assert.equal(await page.locator("#controlCenterPanel > .panel-bar .team-context-label").count(), 0);
  assert.equal(await page.locator(".control-chat-head .team-context-label").count(), 1);
  assert.equal(await page.getByTestId("control-chat-settings-button").evaluate((node) => node.closest(".control-chat-head") !== null), true);

  await theme.click();
  await page.locator("dialog[open]").first().waitFor();
  await page.keyboard.press("Escape");
  await settings.click();
  await page.locator("#settingsDialog[open]").waitFor();
});
