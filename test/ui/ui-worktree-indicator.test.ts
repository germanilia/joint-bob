import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("the open conversation shows its worktree on desktop and phone, never on a project conversation", { timeout: 120_000 }, async t => {
  const { page, node, environment } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.waitForFunction(async () => (await import("/app/state.js")).state.preferencesLoaded);
  await page.locator(".project-card", { hasText: "Joint Bob" }).first().click();
  await page.locator(".session-card").first().click();
  await page.waitForFunction(async () => Boolean((await import("/app/state.js")).state.activeSessionId));
  await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    const session = state.sessions.find(item => item.id === state.activeSessionId);
    session.worktree = { id: "tree", name: "Parser <fix>", color: "blue" };
    const { renderChatSessionControls } = await import("/app/chat-controls.js");
    renderChatSessionControls();
    document.body.classList.remove("view-projects", "view-sessions", "view-control");
    document.body.classList.add("view-chat");
  });
  const badge = page.getByTestId("conversation-worktree-indicator");
  await badge.waitFor({ state: "visible" });
  assert.equal(await badge.textContent(), "Worktree: Parser <fix>");
  assert.equal(await badge.locator("fix").count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await badge.isVisible());
  await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    state.activeSessionId = "ordinary";
    state.sessions = [{ id: "ordinary" }];
    (await import("/app/chat-controls.js")).renderChatSessionControls();
  });
  await badge.waitFor({ state: "hidden" });
});
