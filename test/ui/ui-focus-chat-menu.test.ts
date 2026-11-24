import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { api, signIn } from "../dev-nodes.js";
import type { UserPins } from "../../src/user-pins.js";

test("the phone conversation header has a menu button that holds Dashboard and Pin", { timeout: 180_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  const session = await signIn(environment, node);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card").first().click();
  await page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>("#messageInput")!.disabled);

  // The header shows a menu (⋯) button, not the old dashboard shortcut.
  const menuButton = page.getByTestId("focus-controls-button");
  await menuButton.waitFor();
  assert.equal(await page.locator("#chatTopbar #focusControlsButton").count(), 1, "the shared menu handle lives in the conversation header");
  assert.equal(await page.getByTestId("chat-menu-button").count(), 0, "no duplicate conversation menu button");
  assert.equal(await page.getByTestId("chat-dashboard-button").count(), 0);
  assert.equal(await menuButton.locator("circle").count(), 3, "the button is the three-dot menu icon");

  // It opens the conversation's sheet, which lists Dashboard under This conversation.
  await menuButton.click();
  await page.locator("#focusControls").waitFor();
  const dashboardTool = page.getByTestId("focus-tool-chat-more-dashboard-button");
  await dashboardTool.waitFor();

  // Conversation actions offers Pin, and pinning from there is saved.
  await page.getByTestId("focus-tool-chat-session-menu-button").click();
  await page.locator("#rowMenu:popover-open").waitFor();
  assert.deepEqual((await page.locator("#rowMenu button").allInnerTexts()).slice(0, 1), ["Pin"]);
  await page.getByTestId("session-pin-menu-button").click();
  await page.waitForFunction(async () => (await (await fetch("/api/pins")).json()).conversations.length === 1);
  const pins = await api<UserPins>(node, session, "GET", "/pins");
  assert.equal(pins.body.conversations.length, 1);

  // Dashboard from the same sheet opens the conversation's dashboard.
  await menuButton.click();
  await page.locator("#focusControls").waitFor();
  await page.getByTestId("focus-tool-chat-more-dashboard-button").click();
  await page.locator("#dashboardDialog[open]").waitFor();
});
