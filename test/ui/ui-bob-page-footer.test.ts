import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("Bob's page keeps the theme and Settings buttons in a footer row that does not cover the page", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => !document.body.classList.contains("booting"));
  await page.getByTestId("projects-open-control-center-button").click();
  await page.locator("body.bob-desk.view-control").waitFor();

  const theme = page.getByTestId("workspace-person-button");
  const settings = page.getByTestId("settings-open-button");
  await theme.waitFor({ state: "visible" });
  await settings.waitFor({ state: "visible" });
  const viewport = page.viewportSize()!;
  const panel = (await page.locator("#controlCenterPanel").boundingBox())!;
  for (const button of [theme, settings]) {
    const box = (await button.boundingBox())!;
    assert.ok(box.y >= panel.y + panel.height - 1, "the button sits below the control center, not over it");
    assert.ok(box.y + box.height <= viewport.height && box.x + box.width <= viewport.width, "the button is inside the window");
  }
  assert.equal(await page.locator("#workspaceSide").isVisible(), false, "the side list stays hidden");

  await theme.click();
  await page.locator("dialog[open]").first().waitFor();
  await page.keyboard.press("Escape");
  await settings.click();
  await page.locator("#settingsDialog[open]").waitFor();
});
