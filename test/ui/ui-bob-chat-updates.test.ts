import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

test("Bob keeps background notices out of the chat and answers, whoever wrote them, in it", async () => {
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
      { ...base, id: "organize", role: "bob", text: 'Start a conversation in "Joint Bob" with this message?', via: "Organize · waiting for you", importance: "needs-you" },
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
    await page.locator("body.view-control.bob-desk").waitFor();
    await page.getByTestId("control-tab-my-dashboard").click();
    await page.locator("#controlView-my-dashboard").waitFor({ state: "visible" });
    const chat = page.locator("#controlChatMessages");
    const updates = page.locator("#controlChatUpdates");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("bob-chat-wanted")));
    await chat.locator('[data-id="answer"]').waitFor();
    assert.equal(await chat.locator('[data-id="background"]').count(), 0);
    assert.equal(await updates.locator('[data-id="background"]').count(), 1);
    assert.equal(await updates.locator('[data-id="answer"]').count(), 0);
    const open = chat.locator("button[data-open]");
    assert.equal(await open.textContent(), "Open: adding new personal assistant");
    await open.waitFor({ state: "visible" });
    assert.equal(await open.isVisible(), true);
    assert.equal(await page.locator("#controlChatUpdateCount").innerText(), "(1)");
    assert.equal(await chat.locator('[data-id="organize"]').count(), 1, "an Organize answer to the person is in the chat");
    assert.equal(await updates.locator('[data-id="organize"]').count(), 0);
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

test("Bob's window shows that a sent message is being worked on, then the answer, in the chat alone", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bob-chat-send-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  const browser = await launchChrome({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    page.setDefaultTimeout(30_000);
    const timeline: unknown[] = [];
    const base = { projectId: null, projectName: null, importance: "fyi", actions: [], resolvedAt: null };
    const user = { ...base, id: "u1", role: "user", text: "start a conversation to fix the chat window", via: null, createdAt: "2026-11-15T19:06:47Z" };
    const reply = { ...base, id: "r1", role: "bob", text: 'Start a conversation in "Joint Bob" with this message?', via: "Organize · waiting for you", importance: "needs-you", createdAt: "2026-11-15T19:07:00Z" };
    await page.route("**/api/control-center/bob/messages?*", (route) => route.fulfill({ json: { messages: timeline } }));
    await page.route("**/api/control-center/bob/message", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      timeline.push(user, reply);
      await route.fulfill({ json: { action: "answer", user, reply, projectId: null } });
    });
    await page.goto(node.url, { waitUntil: "domcontentloaded" });
    await page.locator("#loginDialog[open]").waitFor();
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator("#loginDialog[open]").waitFor({ state: "detached" });
    await page.getByTestId("projects-open-control-center-button").click();
    await page.locator("body.view-control.bob-desk").waitFor();
    await page.getByTestId("control-tab-my-dashboard").click();
    await page.locator("#controlView-my-dashboard").waitFor({ state: "visible" });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("bob-chat-wanted")));
    await page.getByTestId("control-chat-input").fill(user.text);
    await page.getByTestId("control-chat-send").click();
    const pending = page.getByTestId("control-chat-pending");
    await pending.waitFor({ state: "visible" });
    assert.match(await pending.innerText(), /Working on/);
    const answer = page.locator('#controlChatMessages [data-id="r1"]');
    await answer.waitFor({ state: "visible" });
    assert.equal(await pending.count(), 0, "the working line goes once Bob answered");
    const [chat, box] = [page.getByTestId("control-chat"), await answer.boundingBox()];
    const windowBox = await chat.boundingBox();
    assert.ok(box && windowBox && box.y >= windowBox.y && box.y + box.height <= windowBox.y + windowBox.height, "the answer is inside the window, in view");
    assert.equal(await page.getByTestId("control-chat-updates").isVisible(), false);
  } finally {
    await browser.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("every scroll box in Bob's window has the thin styled scrollbar, and boxes that hide theirs still do", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bob-chat-scrollbars-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  const browser = await launchChrome({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    page.setDefaultTimeout(30_000);
    await page.goto(node.url, { waitUntil: "domcontentloaded" });
    await page.locator("#loginDialog[open]").waitFor();
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator("#loginDialog[open]").waitFor({ state: "detached" });
    await page.getByTestId("projects-open-control-center-button").click();
    await page.locator("body.view-control.bob-desk").waitFor();
    await page.getByTestId("control-tab-my-dashboard").click();
    await page.locator("#controlView-my-dashboard").waitFor({ state: "visible" });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("bob-chat-wanted")));
    const bars = await page.evaluate(() => ["#controlChatMessages", "#controlChatInput", "#controlChatAttachments", "#controlTabs"].map((selector) => {
      const style = getComputedStyle(document.querySelector(selector)!);
      return { selector, width: style.scrollbarWidth, color: style.scrollbarColor };
    }));
    for (const bar of bars.slice(0, 3)) {
      assert.equal(bar.width, "thin", `${bar.selector} has a thin scrollbar`);
      assert.notEqual(bar.color, "auto", `${bar.selector} has a colored scrollbar`);
    }
    assert.equal(bars[3].width, "none", "the tab strip still hides its own");
    assert.equal(await page.getByTestId("control-chat-input").evaluate((box) => getComputedStyle(box).overflowX), "hidden", "the composer never scrolls sideways (Safari drew a bar under it)");
  } finally {
    await browser.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("a reloaded page still says Bob is working on a message, until he has answered", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bob-chat-reload-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  const browser = await launchChrome({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    page.setDefaultTimeout(30_000);
    await page.goto(node.url, { waitUntil: "domcontentloaded" });
    await page.locator("#loginDialog[open]").waitFor();
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator("#loginDialog[open]").waitFor({ state: "detached" });
    await page.getByTestId("projects-open-control-center-button").click();
    await page.locator("body.view-control.bob-desk").waitFor();
    await page.getByTestId("control-tab-my-dashboard").click();
    await page.locator("#controlView-my-dashboard").waitFor({ state: "visible" });
    // The real server: send a message from the chat and, while it is answered, read the chat again as a reloaded page does.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("bob-chat-wanted")));
    await page.getByTestId("control-chat-input").fill("how many conversations are running?");
    await page.getByTestId("control-chat-send").click();
    await page.getByTestId("control-chat-pending").waitFor({ state: "visible" });
    const read = () => page.evaluate(async () => (await (await fetch("/api/control-center/bob/messages?")).json()).working as Array<{ text: string }>);
    const midway = await read();
    assert.equal(midway.length, 1, "the server lists the message it is answering");
    assert.equal(midway[0].text, "how many conversations are running?");
    await page.locator('#controlChatMessages [data-importance]').first().waitFor({ state: "visible" });
    await page.getByTestId("control-chat-pending").waitFor({ state: "detached" });
    assert.equal((await read()).length, 0, "and stops listing it once answered");
  } finally {
    await browser.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("the page shows the server's working line after a reload and drops it when Bob is done", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bob-chat-working-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  const browser = await launchChrome({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    page.setDefaultTimeout(30_000);
    let working = [{ id: "w1", text: "start a conversation to fix the chat window", startedAt: Date.now() - 4000 }];
    let messages: unknown[] = [];
    await page.route("**/api/control-center/bob/messages?*", (route) => route.fulfill({ json: { messages, working } }));
    await page.goto(node.url, { waitUntil: "domcontentloaded" });
    await page.locator("#loginDialog[open]").waitFor();
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator("#loginDialog[open]").waitFor({ state: "detached" });
    await page.getByTestId("projects-open-control-center-button").click();
    await page.locator("body.view-control.bob-desk").waitFor();
    await page.getByTestId("control-tab-my-dashboard").click();
    await page.locator("#controlView-my-dashboard").waitFor({ state: "visible" });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("bob-chat-wanted")));
    const line = page.getByTestId("control-chat-pending");
    await line.waitFor({ state: "visible" });
    assert.match(await line.innerText(), /Working on “start a conversation to fix the chat window”/);
    // Bob answers: the page asks again by itself and the line gives way to the answer.
    working = [];
    messages = [{ id: "r1", role: "bob", text: "Done.", via: null, importance: "fyi", projectId: null, projectName: null, actions: [], createdAt: "2026-11-15T19:07:00Z", resolvedAt: null }];
    await page.locator('#controlChatMessages [data-id="r1"]').waitFor({ state: "visible" });
    assert.equal(await line.count(), 0);
  } finally {
    await browser.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
