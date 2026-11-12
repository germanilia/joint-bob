import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

test("Bob keeps background notices beside the chat and conversation results in the reply", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bob-chat-updates-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  const browser = await launchChrome({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    page.setDefaultTimeout(30_000);
    const base = { projectId: null, projectName: null, importance: "fyi", actions: [], createdAt: "2026-11-12T15:15:00Z", resolvedAt: null };
    const messages = [
      { ...base, id: "question", role: "user", text: "Find the personal assistant conversation", via: null },
      { ...base, id: "background", role: "bob", text: '"auto model selector" waits for you.', via: "Review check · Bob decided", importance: "needs-you" },
      { ...base, id: "answer", role: "bob", text: "Found adding new personal assistant", via: "The decision model could not answer, so Bob's agent decided", actions: [{ id: "open", label: "Open: adding new personal assistant", data: { open: { projectId: "p1", conversationId: "assistant", title: "adding new personal assistant" } } }] },
    ];
    await page.route("**/api/control-center/bob/messages?*", (route) => route.fulfill({ json: { messages } }));
    await page.goto(node.url, { waitUntil: "domcontentloaded" });
    await page.locator("#loginDialog[open]").waitFor();
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator("#loginDialog[open]").waitFor({ state: "detached" });
    await page.getByTestId("projects-open-control-center-button").click();
    const chat = page.locator("#controlChatMessages");
    const updates = page.locator("#controlChatUpdates");
    await chat.locator('[data-id="answer"]').waitFor();
    assert.equal(await chat.locator('[data-id="background"]').count(), 0);
    assert.equal(await updates.locator('[data-id="background"]').count(), 1);
    assert.equal(await updates.locator('[data-id="answer"]').count(), 0);
    const open = chat.locator("button[data-open]");
    assert.equal(await open.textContent(), "Open: adding new personal assistant");
    await open.waitFor({ state: "visible" });
    assert.equal(await open.isVisible(), true);
    assert.equal(await page.locator("#controlChatUpdateCount").innerText(), "(1)");
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const chatBox = await chat.boundingBox();
    const updatesBox = await updates.boundingBox();
    assert.ok(chatBox && updatesBox && updatesBox.x >= chatBox.x + chatBox.width - 1, "desktop updates are beside chat");
    await page.setViewportSize({ width: 390, height: 844 });
    const drawer = page.getByTestId("control-chat-updates");
    await drawer.locator("summary").click();
    assert.equal(await drawer.getAttribute("open"), null, "phone updates collapse without hiding the chat");
    assert.equal(await chat.locator('[data-id="answer"]').isVisible(), true);
  } finally {
    await browser.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
