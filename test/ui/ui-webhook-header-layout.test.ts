import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("webhook header keeps identity left and actions right without overflow", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  if (await page.getByTestId("bob-head-app-settings").isVisible()) await page.getByTestId("bob-head-app-settings").click();
  else await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-webhooks").click();
  await page.waitForFunction(() => (document.querySelector("#webhooksProject") as HTMLSelectElement).options.length > 0 && !(document.querySelector("#webhooksNew") as HTMLButtonElement).disabled);
  await page.getByTestId("webhooks-new-button").click();
  await page.getByTestId("webhooks-name-input").fill("GH - [ISSUE TITLE]");
  await page.getByTestId("webhooks-save-button").click();
  await page.getByTestId("webhooks-reveal").waitFor({ state: "visible" });
  await page.getByTestId("webhooks-reveal-done-button").click();
  for (const width of [3124, 1440, 640, 390]) {
    await page.setViewportSize({ width, height: 1141 });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const boxes = await page.locator("#webhooksForm > .relay-head").evaluate((head) => {
      const crumb = head.querySelector(".webhooks-crumb")!;
      const actions = head.querySelector("#webhooksDetailActions")!;
      return { head: head.getBoundingClientRect().toJSON(), crumb: crumb.getBoundingClientRect().toJSON(), actions: actions.getBoundingClientRect().toJSON(), overflow: head.scrollWidth - head.clientWidth };
    });
    assert.ok(Math.abs(boxes.crumb.left - boxes.head.left) < 4, `identity starts at the left at ${width}px: ${JSON.stringify(boxes)}`);
    assert.ok(boxes.actions.right <= boxes.head.right + 1, `actions fit at ${width}px`);
    assert.ok(boxes.overflow <= 1, `header does not overflow at ${width}px`);
    if (width >= 1440) {
      assert.ok(Math.abs(boxes.actions.right - boxes.head.right) < 4, "desktop actions sit on the right");
      assert.ok(boxes.crumb.right <= boxes.actions.left, "identity and actions do not overlap");
    }
  }
});
