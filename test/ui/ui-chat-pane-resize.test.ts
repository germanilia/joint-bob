// The conversation must not jump while its reader types. The transcript pane changes height when the message box
// grows with a draft of several lines; the / and @ suggestion lists must not take room from it at all on the desktop.
// At the bottom the newest line stays pinned to the bottom with the same gap under it; scrolled up, nothing moves.
// No live update happens in this test, so a pane that waits for the next one to pin itself fails here.
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

const PROJECT_NAME = "Internal Assistant";
const CONVERSATION_TITLE = "Scroll follow reference";

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let server: ChildProcess;
let browser: Browser;
let page: Page;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-pane-resize-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  server = await startDevNode(environment, node);
  browser = await launchChrome({ headless: process.env.HEADED !== "1" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
  page = await context.newPage();
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 20_000 });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByText(PROJECT_NAME, { exact: true }).waitFor({ timeout: 20_000 });
  await page.locator(".project-card", { hasText: PROJECT_NAME }).first().click();
  await page.locator(".session-card", { hasText: CONVERSATION_TITLE }).first().click();
  await page.getByText("Scroll reference turn 18 of 18", { exact: false }).waitFor({ timeout: 20_000 });
  await frames();
}, { timeout: 120_000 });

after(async () => {
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

interface Pane { scrollTop: number; scrollHeight: number; clientHeight: number; fromBottom: number; gapUnderLast: number; firstTop: number; inputHeight: number }

function pane(): Promise<Pane> {
  return page.evaluate(() => {
    const box = document.querySelector<HTMLElement>("#messages");
    const frame = box.getBoundingClientRect();
    return {
      scrollTop: box.scrollTop,
      scrollHeight: box.scrollHeight,
      clientHeight: box.clientHeight,
      fromBottom: box.scrollHeight - box.scrollTop - box.clientHeight,
      gapUnderLast: Math.round(frame.bottom - box.lastElementChild.getBoundingClientRect().bottom),
      firstTop: Math.round(box.querySelector(".message").getBoundingClientRect().top),
      inputHeight: document.querySelector<HTMLElement>("[data-testid='chat-message-input']").offsetHeight,
    };
  });
}

async function frames(): Promise<void> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** Types into the message box as a person does; Shift+Enter starts a new line. */
async function type(lines: string[]): Promise<void> {
  const input = page.getByTestId("chat-message-input");
  await input.click();
  for (const [index, line] of lines.entries()) {
    if (index) await page.keyboard.press("Shift+Enter");
    await page.keyboard.type(line);
  }
  await frames();
}

async function clearDraft(): Promise<void> {
  await page.getByTestId("chat-message-input").fill("");
  await page.keyboard.press("Escape");
  await frames();
}

test("at the bottom, a draft that grows the message box keeps the newest line pinned with the same gap", async () => {
  await page.evaluate(() => { const box = document.querySelector<HTMLElement>("#messages"); box.scrollTop = box.scrollHeight; });
  await frames();
  const start = await pane();
  assert.ok(start.scrollHeight > start.clientHeight * 2, "the transcript overflows the pane");
  assert.ok(start.fromBottom < 1, `starts at the bottom (${start.fromBottom}px away)`);

  await type(["first line", "second line", "third line", "fourth line", "fifth line"]);
  const grown = await pane();
  assert.ok(grown.inputHeight > start.inputHeight + 40, `the message box grew (${start.inputHeight} → ${grown.inputHeight})`);
  assert.ok(grown.clientHeight < start.clientHeight - 40, "the pane gave the room");
  assert.ok(grown.fromBottom < 1, `the pane is still at the bottom, ${grown.fromBottom}px away`);
  assert.equal(grown.gapUnderLast, start.gapUnderLast, "the gap under the newest line did not change");
  assert.equal(await page.getByTestId("chat-jump-to-bottom-button").isHidden(), true, "no jump-to-bottom button while pinned");

  await clearDraft();
  const back = await pane();
  assert.ok(back.fromBottom < 1, `still at the bottom after the draft is cleared, ${back.fromBottom}px away`);
  assert.equal(back.gapUnderLast, start.gapUnderLast, "the gap is the same after the draft is cleared");
  assert.equal(back.scrollTop, start.scrollTop, "the view is where it started");
});

test("the / and @ suggestions float over the thread: the pane keeps its height and position", async () => {
  await page.evaluate(() => { const box = document.querySelector<HTMLElement>("#messages"); box.scrollTop = box.scrollHeight; });
  await frames();
  const start = await pane();
  for (const key of ["/", "@"]) {
    await type([key]);
    await page.getByTestId("chat-command-autocomplete").waitFor({ timeout: 10_000 });
    await frames();
    const open = await pane();
    assert.equal(open.clientHeight, start.clientHeight, `${key}: the suggestions take no height from the transcript`);
    assert.equal(open.scrollTop, start.scrollTop, `${key}: the transcript did not scroll`);
    assert.equal(open.gapUnderLast, start.gapUnderLast, `${key}: the gap under the newest line did not change`);
    const list = await page.getByTestId("chat-command-autocomplete").boundingBox();
    const input = await page.getByTestId("chat-message-input").boundingBox();
    assert.ok(list && input && list.y + list.height <= input.y + 1 && list.y >= 0, `${key}: the list sits above the message box, inside the window`);
    await clearDraft();
  }
});

test("scrolled up, typing moves nothing", async () => {
  await page.evaluate(() => { document.querySelector<HTMLElement>("#messages").scrollTop = 400; });
  await frames();
  const start = await pane();
  assert.ok(start.fromBottom > 200, "the reader is away from the bottom");

  await type(["a", "b", "c", "d", "e"]);
  const grown = await pane();
  assert.ok(grown.inputHeight > start.inputHeight + 40, "the message box grew");
  assert.equal(grown.scrollTop, start.scrollTop, "a growing draft does not scroll a reader who scrolled up");
  assert.equal(grown.firstTop, start.firstTop, "the messages stay where they were");
  await clearDraft();

  await type(["/"]);
  await page.getByTestId("chat-command-autocomplete").waitFor({ timeout: 10_000 });
  const listed = await pane();
  assert.equal(listed.scrollTop, start.scrollTop, "the suggestions do not scroll a reader who scrolled up");
  assert.equal(listed.firstTop, start.firstTop, "the messages stay where they were under the suggestions");
  await clearDraft();
  const end = await pane();
  assert.equal(end.scrollTop, start.scrollTop, "and nothing moved after the draft is cleared");
});
