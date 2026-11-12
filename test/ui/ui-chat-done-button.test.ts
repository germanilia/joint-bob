import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type Browser } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

/** Closing a conversation out is the action people reach for most from inside it, so
    it sits on the conversation's header line itself, not in a menu. (The phone's own menu has it in its dock.) */
test("the chat More menu closes a conversation out without a nested menu", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-chat-done-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  let browser: Browser | undefined;
  try {
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    page.setDefaultTimeout(30_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(node.url);
    // A loaded server can take a while to paint the sign-in dialog under load.
    await page.locator("#loginDialog[open], .project-card").first().waitFor({ timeout: 60_000 });
    if (await page.locator("#loginDialog[open]").count()) {
      await page.getByTestId("login-username-input").fill(environment.username);
      await page.getByTestId("login-password-input").fill(environment.password);
      await page.getByTestId("login-submit-button").click();
    }
    await page.getByText("Internal Assistant", { exact: true }).click();

    const row = page.locator("#sessionList .list-row").filter({ has: page.locator("strong", { hasText: "Short one" }) }).first();
    await row.locator("button").first().click();
    await page.locator("#sessionTitle").filter({ hasText: "Short one" }).waitFor();

    // On the desktop workspace Mark done is on the conversation's title line itself; a narrow window keeps its icon
    // (and its name for assistive technology), so the label is read from the button's text, not what is painted.
    const doneButton = page.getByTestId("chat-done-button");
    assert.equal(await page.getByTestId("chat-head-actions").getByTestId("chat-done-button").count(), 1, "Mark done is in the header, not in a menu");
    // Beside the two columns of Projects and the details the header is narrow at 1440 px too: the icon alone shows.
    assert.equal(await doneButton.locator(".chat-action-label").textContent(), "Mark done");
    await page.getByTestId("chat-activity-toggle").click();
    await page.getByTestId("activity-panel").waitFor({ state: "hidden" });
    assert.equal(await doneButton.innerText(), "Mark done", "with the details closed the button has room for its name");
    await page.getByTestId("chat-activity-toggle").click();
    await page.setViewportSize({ width: 720, height: 844 });
    assert.equal(await doneButton.locator(".chat-action-label").textContent(), "Mark done");
    await doneButton.click();
    const description = page.getByTestId("conversation-feedback-description");
    assert.equal(await description.isVisible(), false, "not important needs no explanation");
    for (const rating of ["good", "bad"]) {
      await page.getByTestId(`conversation-feedback-${rating}`).check();
      assert.equal(await description.isVisible(), true);
      assert.equal(await description.getAttribute("required"), null, "both descriptions are optional");
    }
    await page.keyboard.press("Escape");
    await page.getByTestId("conversation-feedback-dialog").waitFor({ state: "detached" });
    assert.equal(await doneButton.locator(".chat-action-label").textContent(), "Mark done", "cancelling leaves the conversation active");
    await doneButton.click();
    await page.getByTestId("conversation-feedback-submit").click();
    await page.locator(".toast-message").first().waitFor();
    assert.equal(await page.locator(".toast-message").first().innerText(), "Conversation marked done");

    assert.equal(await page.locator("body").evaluate(body => body.classList.contains("view-sessions")), true, "Done returns to the conversation list on mobile");
    assert.equal(await page.locator("#sessionTitle").textContent(), "Select a conversation", "Done closes the chat");
    assert.equal(await doneButton.isDisabled(), true, "there is no active conversation left to close");
    await page.getByTestId("show-done-conversations-toggle").check();
    await row.locator(".session-done-badge").waitFor();
    await row.locator("button").first().click();
    await page.locator("#sessionTitle").filter({ hasText: "Short one" }).waitFor();
    assert.equal(await doneButton.locator(".chat-action-label").textContent(), "Mark not done", "a reopened done conversation can still be marked not done");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
