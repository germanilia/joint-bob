// The conversations of a project are one long list that scrolls (no pages: .agents/knowledge/list-scrolling.md), drawn in
// chunks as it is scrolled (app/long-scroll.js). The list is drawn again on every background refresh, and the chat controls
// announce "activeConversationChanged" on every redraw of theirs, about once a second while an agent works: neither may take
// the reader back to the top or shrink the drawn rows. Only another project, another search or another filter starts again
// at the top with the first chunk.
//
// Run with `npm run test:ui`.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { type Browser, type Page } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "../dev-nodes.js";

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let server: ChildProcess;
let browser: Browser;
let page: Page;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-page-stays-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  server = await startDevNode(environment, node);
  browser = await launchChrome({ headless: process.env.HEADED !== "1" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 560 }, reducedMotion: "reduce", serviceWorkers: "block" });
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor();
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card").first().waitFor();
  // A conversation is open, as it is when the reader pages through the others.
  await page.locator("#sessionList .session-card").first().click();
  await page.locator("body.view-chat").waitFor();
  await frames();
  // A long list: a hundred and twenty conversations, as the open project's.
  await many(120);
}, { timeout: 120_000 });

after(async () => {
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

async function frames(count = 3): Promise<void> {
  // One evaluate per frame: a helper function declared inside the page's function would not survive the test loader.
  for (let frame = 0; frame < count; frame++) await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
}


/** Every project lists `count` conversations (copies of its first), as the server answers; a refresh then keeps them. */
async function many(count: number): Promise<void> {
  await page.route("**/api/projects/*/sessions", async (route) => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    const response = await route.fetch();
    const json = await response.json() as { sessions: Array<Record<string, unknown>> };
    const [first] = json.sessions;
    if (first) {
      json.sessions = Array.from({ length: count }, (_, index) => ({
        ...first, id: `long-${index}`, conversationId: `long-${index}`, path: `${first.path}-long-${index}`, title: `Long list conversation ${index}`,
        updatedAt: new Date(Date.now() - index * 60_000).toISOString(),
      }));
    }
    await route.fulfill({ response, json });
  });
  await page.evaluate(async () => {
    const { refreshSessionsQuietly } = await import("/app/socket.js");
    await refreshSessionsQuietly();
  });
  await page.waitForFunction((total) => Number(document.querySelector("#sessionList")?.getAttribute("data-total")) >= total, count);
  await frames();
}

const list = () => page.locator("#sessionList");
const drawn = async () => ({
  rendered: Number(await list().getAttribute("data-rendered")),
  total: Number(await list().getAttribute("data-total")),
  rows: await page.locator("#sessionList .session-card").count(),
  top: await list().evaluate((element) => element.scrollTop),
});

/** One background refresh as the app does it: the list is drawn again and the chat controls announce their redraw. */
async function refreshCycle(): Promise<void> {
  await page.evaluate(async () => {
    const { renderSessions } = await import("/app/session-list.js");
    const { renderChatSessionControls } = await import("/app/chat-controls.js");
    renderSessions();
    renderChatSessionControls();
    window.dispatchEvent(new CustomEvent("running-refreshed"));
  });
  await frames();
  await page.waitForTimeout(700);
  await frames();
}

test("a long list has no pager, draws a first chunk and every conversation is reachable by scrolling", async () => {
  assert.equal(await page.getByTestId("session-list-pager").count(), 0, "no pager");
  assert.equal(await list().evaluate((element) => getComputedStyle(element).overflowY), "auto");
  const start = await drawn();
  assert.ok(start.total >= 120 && start.total <= 125, `the list has every conversation and its headings (${start.total})`);
  assert.equal(start.rendered, 40, "the first chunk is forty rows");
  assert.ok(start.rows <= 40);
  assert.equal(await page.locator("#sessionList .session-card").first().isVisible(), true);
  // Scrolling to the end draws the next chunk, until every row is there.
  let last = start.rendered;
  for (let step = 0; step < 6 && last < start.total; step++) {
    await list().evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await page.waitForFunction((before) => Number(document.querySelector("#sessionList")?.getAttribute("data-rendered")) > before, last, { timeout: 5_000 });
    last = (await drawn()).rendered;
  }
  assert.equal(last, start.total, "scrolling reached every conversation");
  await list().evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const end = await page.locator("#sessionList .session-card").last().evaluate((card) => {
    const list = document.querySelector("#sessionList")!.getBoundingClientRect(), box = card.getBoundingClientRect();
    return { text: card.textContent, inView: box.bottom <= list.bottom + 1 && box.top >= list.top - 1 };
  });
  assert.equal(end.inView, true, `the last conversation is in view at the end of the scroll (${end.text})`);
  assert.equal((await drawn()).rows >= 119, true, "every conversation has its row");
});

test("the place in the list and the drawn rows stay through background refreshes", async () => {
  await list().evaluate((element) => { element.scrollTop = 0; });
  await frames();
  await list().evaluate((element) => { element.scrollTop = 2_000; });
  await frames();
  const before = await drawn();
  assert.ok(before.rendered >= 80 && before.top > 1_500, `the reader is deep in the list (${JSON.stringify(before)})`);
  for (const cycle of [1, 2, 3]) {
    await refreshCycle();
    const after = await drawn();
    assert.equal(after.rendered, before.rendered, `refresh ${cycle}: the drawn rows are kept`);
    assert.ok(Math.abs(after.top - before.top) < 4, `refresh ${cycle}: the place is kept (${before.top} → ${after.top})`);
  }
  await page.waitForTimeout(1_500);
  assert.ok(Math.abs((await drawn()).top - before.top) < 4, "nothing takes the reader back while nothing happens");
});

test("another search starts at the top with the first chunk, and clearing it does too", async () => {
  await list().evaluate((element) => { element.scrollTop = 2_000; });
  await frames();
  await page.getByTestId("conversation-list-search-input").fill("conversation 1");
  await frames();
  await page.waitForTimeout(400);
  const searched = await drawn();
  assert.equal(searched.top, 0, "a search shows its top");
  assert.ok(searched.rendered <= 40, `a search draws its first chunk (${searched.rendered})`);
  await page.getByTestId("conversation-list-search-input").fill("");
  await frames();
  await page.waitForTimeout(400);
  const cleared = await drawn();
  assert.equal(cleared.top, 0);
  assert.equal(cleared.rendered, 40);
});

test("another project starts at the top", async () => {
  await list().evaluate((element) => { element.scrollTop = 1_000; });
  await frames();
  await page.locator(".project-card", { hasText: "Joint Bob" }).first().click();
  await page.locator("#projectName", { hasText: "Joint Bob" }).waitFor();
  await page.locator("#sessionList .session-card").first().waitFor();
  await frames();
  await page.waitForTimeout(400);
  assert.equal((await drawn()).top, 0, "the other project's list starts at its top");
});
