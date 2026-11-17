import assert from "node:assert/strict";
import test from "node:test";
import { signIn } from "../dev-nodes.js";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("Bob's page keeps theme and Settings in the workspace footer, not repeated in the top bar", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const login = await signIn(environment, node);
  await page.context().addCookies(login.cookie.split("; ").map(cookie => ({ name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1), url: node.url })));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(node.url);
  await page.waitForFunction(() => !document.body.classList.contains("booting"));
  await page.getByTestId("projects-open-control-center-button").click();
  await page.locator("body.bob-desk.view-control").waitFor();

  const theme = page.getByTestId("workspace-person-button");
  const settings = page.getByTestId("settings-open-button");
  const exit = page.getByTestId("control-center-close-button");
  const refresh = page.getByTestId("control-center-refresh");
  await theme.waitFor({ state: "visible" });
  await settings.waitFor({ state: "visible" });
  assert.equal(await page.locator("#controlCenterPanel > .panel-bar .bob-head-theme, #controlCenterPanel > .panel-bar .bob-head-app-settings").count(), 0, "the top bar has no theme or Settings button");
  for (const button of [exit, refresh]) {
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
