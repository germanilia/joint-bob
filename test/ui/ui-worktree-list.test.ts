import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("new conversations offer a checked worktree checkbox with a per-conversation opt-out", { timeout: 120_000 }, async t => {
  const { page, node, environment } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.waitForFunction(async () => (await import("/app/state.js")).state.preferencesLoaded);
  await page.locator(".project-card", { hasText: "Joint Bob" }).first().click();
  await page.locator(".session-card").first().waitFor();
  await page.getByTestId("session-create-button").click();
  const checkbox = page.getByTestId("new-session-new-worktree-checkbox");
  await checkbox.waitFor();
  assert.equal(await checkbox.isChecked(), true);
  await checkbox.uncheck();
  assert.equal(await page.getByTestId("new-session-worktree-select").inputValue(), "", "unchecking starts in the project folder");
  await page.getByTestId("new-session-next-button").click();
  await page.getByTestId("new-session-next-button").click();
  assert.equal(await page.getByTestId("new-session-worktree-select").inputValue(), "", "wizard navigation preserves the opt-out");
  await page.getByTestId("new-session-name-cancel-button").click();
  await page.getByTestId("session-create-button").click();
  await checkbox.waitFor({ state: "visible" });
  assert.equal(await checkbox.isChecked(), true, "the opt-out is per conversation");
  await page.getByTestId("new-session-name-cancel-button").click();
  await page.evaluate(async () => {
    const { api } = await import("/app/api.js");
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ newConversationWorktree: false }) });
  });
  await page.getByTestId("session-create-button").click();
  await checkbox.waitFor({ state: "visible" });
  assert.equal(await checkbox.isChecked(), false, "an explicit Settings opt-out is respected");
  await checkbox.check();
  assert.equal(await page.getByTestId("new-session-worktree-select").inputValue(), "new");
  await page.getByTestId("new-session-name-cancel-button").click();
});
