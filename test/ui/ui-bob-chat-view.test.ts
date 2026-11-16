// Bob's own place in the left column's sub-menu: his chat alone fills the page, with no stage, no floating window and no
// "Ask Bob" button; another view brings the folded button back.
//
// Run with `npm run test:file -- test/ui/ui-bob-chat-view.test.ts`.
import assert from "node:assert/strict";
import test from "node:test";
import { signIn } from "../dev-nodes.js";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("Bob's place shows his chat alone, and leaving it folds the chat back into the button", { timeout: 300_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const login = await signIn(environment, node);
  await page.context().addCookies(login.cookie.split("; ").map(cookie => ({ name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1), url: node.url })));
  await page.goto(node.url);
  await page.waitForFunction(() => !document.body.classList.contains("booting"));
  await page.getByTestId("projects-open-control-center-button").click();
  await page.locator("body.bob-desk.view-control").waitFor();
  assert.equal(await page.getByTestId("control-chat-input").isVisible(), false, "the page opens with the chat folded");

  await page.locator(".ws-places").getByTestId("control-tab-bob-chat").click();
  await page.getByTestId("control-chat-input").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("bob-fab-chat").isVisible(), false, "no Ask Bob button while his chat is the page");
  const chat = (await page.getByTestId("control-chat").boundingBox())!;
  const column = (await page.getByTestId("workspace-side").boundingBox())!;
  assert.ok(chat.x >= column.x + column.width - 1, "the chat sits beside the left column, not over it");
  assert.ok(chat.width > 700, `the chat fills the page (${chat.width}px)`);

  await page.locator(".ws-places").getByTestId("control-tab-automations").click();
  await page.getByTestId("bob-fab-chat").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("control-chat-input").isVisible(), false, "another view folds the chat back");
});
