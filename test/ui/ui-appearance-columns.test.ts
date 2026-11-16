// Larger text must not push columns off the window: the presets zoom each column, and a zoomed column still has to
// fit the space the grid gave it beside its neighbours.
import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("every text size keeps the desktop columns inside the window and beside each other", { timeout: 180_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  // The app may open on Bob's page, whose Exit button leads to the workspace, or on the workspace itself.
  await page.addInitScript(() => localStorage.setItem("joint-bob-start-view", "last"));
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  const exit = page.getByTestId("control-center-close-button");
  await exit.or(page.getByTestId("workspace-projects-button")).first().waitFor();
  if (await exit.isVisible()) {
    await page.waitForTimeout(1500);
    await exit.click();
  }
  await page.getByTestId("workspace-projects-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator(".session-card", { hasText: "Thread-Based Agent Builder" }).first().click();
  await page.locator("#activityPanel").waitFor();
  // The Inbox column beside the open conversation: Home switches the column to it, and Esc closes Home back to the conversation.
  await page.getByTestId("workspace-home-button").click();
  await page.keyboard.press("Escape");
  await page.locator("body.ws-column-inbox.view-chat").waitFor();

  const problems: string[] = [];
  const sizes = [3440, 2560, 1720, 1100].flatMap(width => ["default", "large", "larger", "huge"].map(name => ({ width, name })));
  for (const { width, name } of sizes) {
    await page.setViewportSize({ width, height: 1143 });
    await page.getByTestId("workspace-person-button").click();
    await page.getByTestId(`appearance-preset-${name}`).click();
    await page.getByTestId("appearance-close-button").click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const boxes = await page.evaluate(() => {
      const found: { selector: string; left: number; right: number }[] = [];
      for (const selector of ["#projectsPanel", "#chatsPanel", "#chatPanel", "#activityPanel"]) {
        const el = document.querySelector<HTMLElement>(selector);
        if (!el || el.hidden || el.getClientRects().length === 0) continue;
        const r = el.getBoundingClientRect();
        found.push({ selector, left: Math.round(r.left), right: Math.round(r.right) });
      }
      const thread = document.querySelector<HTMLElement>("#chatPanel .messages")!.getBoundingClientRect();
      return { threadRight: Math.round(thread.right), viewport: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, found };
    });
    if (boxes.scrollWidth > boxes.viewport + 1) problems.push(`${width}px ${name}: page is ${boxes.scrollWidth}px wide in a ${boxes.viewport}px window`);
    for (const box of boxes.found) {
      if (box.right > boxes.viewport + 1) problems.push(`${width}px ${name}: ${box.selector} ends at ${box.right}px, past the ${boxes.viewport}px window`);
    }
    // The details column sits inside the conversation, so the siblings are the three columns.
    const siblings = boxes.found.filter(box => box.selector !== "#activityPanel");
    for (let i = 1; i < siblings.length; i++) {
      if (siblings[i].left < siblings[i - 1].right - 1) problems.push(`${width}px ${name}: ${siblings[i].selector} starts at ${siblings[i].left}px inside ${siblings[i - 1].selector}`);
    }
    const docked = boxes.found.find(box => box.selector === "#activityPanel");
    if (docked && docked.left < boxes.threadRight - 1) problems.push(`${width}px ${name}: #activityPanel (from ${docked.left}px) covers the thread (to ${boxes.threadRight}px)`);
    const chat = boxes.found.find(box => box.selector === "#chatPanel");
    const details = boxes.found.find(box => box.selector === "#activityPanel");
    if (chat && details && (details.left < chat.left - 1 || details.right > chat.right + 1)) problems.push(`${width}px ${name}: #activityPanel (${details.left}-${details.right}px) leaves #chatPanel (${chat.left}-${chat.right}px)`);
  }
  assert.deepEqual(problems, [], "columns must fit at every text size");
  assert.deepEqual(errors, [], "changing the text size does not cause browser errors");
});
