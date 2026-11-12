import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type Browser } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { reach } from "./workspace-menus.js";
import { seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";

// 701–1023 px is the desktop workspace now (the phone starts at 700 px): running work is a group in the left column
// and in its ⋯ menu, and the open conversation stays in the middle while the column changes.
test("a narrow window exposes running work and keeps the current conversation reachable", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-mobile-running-"));
  let server: ChildProcess | undefined;
  let browser: Browser | undefined;
  t.after(async () => {
    if (browser) await browser.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  });
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  server = await startDevNode(environment, node);
  browser = await launchChrome({ headless: true });
  const context = await browser.newContext({ viewport: { width: 720, height: 850 }, serviceWorkers: "block" });
  const session = await signIn(environment, node);
  await context.addCookies([{ name: node.cookieName, value: session.cookie.split("=")[1], url: node.url }]);
  const page = await context.newPage();

  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator(".project-card").first().waitFor();

  await page.locator(".project-card").first().click();
  await (await reach(page, "running-conversations-open-button")).click();
  await page.getByTestId("running-conversations-dialog").getByText("No conversations are running.").waitFor();
  await page.getByTestId("running-conversations-close-button").click();

  const conversation = page.locator("#sessionList .session-card").first();
  await conversation.waitFor();
  const title = await conversation.locator("strong").first().textContent();
  await conversation.click();
  await page.locator("#sessionTitle").getByText(title!, { exact: true }).waitFor();
  // Inbox shows the Running group; the conversation stays open beside it.
  await page.getByTestId("workspace-inbox-button").click();
  await page.getByTestId("workspace-group-running").waitFor();
  // The count reads "…" until the board has answered.
  await page.getByTestId("workspace-group-count-running").getByText("0", { exact: true }).waitFor();
  await page.locator("#sessionTitle").getByText(title!, { exact: true }).waitFor();
});

test("a narrow window reaches running work from the conversation and lines the label filter up with the search field", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-mobile-toolbar-"));
  let server: ChildProcess | undefined;
  let browser: Browser | undefined;
  t.after(async () => {
    if (browser) await browser.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  });
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  server = await startDevNode(environment, node);
  browser = await launchChrome({ headless: true });
  const session = await signIn(environment, node);

  const phone = await browser.newContext({ viewport: { width: 720, height: 850 }, serviceWorkers: "block" });
  await phone.addCookies([{ name: node.cookieName, value: session.cookie.split("=")[1], url: node.url }]);
  const page = await phone.newPage();
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator(".project-card").first().waitFor();
  await page.locator(".project-card").first().click();
  await page.locator("#sessionList .session-card").first().waitFor();

  // The label filter starts in the same lane as the search field (it shares its row with Mark all reviewed).
  const { search, labels } = await page.evaluate(() => ({
    search: document.querySelector("#sessionSearchInput")!.getBoundingClientRect().toJSON(),
    labels: document.querySelector("#conversationClassificationFilter")!.getBoundingClientRect().toJSON(),
  }));
  assert.ok(search && labels, "both filter controls must be laid out");
  assert.equal(Math.round(labels!.x), Math.round(search!.x));

  // From an open conversation, running work is one menu away in the left column; the chat toolbar's own copy (for
  // the phone) stays hidden on the desktop workspace.
  await page.locator("#sessionList .session-card").first().click();
  await page.locator("#messages .message").first().waitFor();
  assert.equal(await page.getByTestId("chat-running-conversations-open-button").isVisible(), false);
  await (await reach(page, "running-conversations-open-button")).click();
  await page.getByTestId("running-conversations-dialog").waitFor();
  await page.getByTestId("running-conversations-close-button").click();
  await page.setViewportSize({ width: 1440, height: 900 });
  assert.equal(await page.getByTestId("chat-running-conversations-open-button").isVisible(), false);
});
