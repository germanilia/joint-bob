// A list's page is the reader's choice. The conversations of a project (the desktop's Projects place) are drawn again
// on every background refresh, and the chat controls announce "activeConversationChanged" on every redraw of theirs,
// about once a second while an agent works: neither may take the list back to its first page. Only another project,
// another search or another filter starts again on the first page.
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
  // A short window: the project's few conversations take more than one page.
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

const label = () => page.getByTestId("session-list-page-label").textContent();

/** The titles of the rows in sight: the page really shown, not only what the pager says. */
function shownTitles(): Promise<string[]> {
  return page.locator("#sessionList > .list-row").evaluateAll((rows) => {
    const list = document.querySelector<HTMLElement>("#sessionList");
    const frame = list.getBoundingClientRect();
    const clip = parseFloat((list.style.clipPath.match(/inset\(0(?:px)? 0(?:px)? ([\d.]+)px/) ?? [])[1] ?? "0");
    return rows.filter((row) => {
      const box = row.getBoundingClientRect();
      return box.height > 0 && box.top >= frame.top - 1 && box.bottom <= frame.bottom - clip + 1;
    }).map((row) => row.querySelector(".session-card > strong").textContent);
  });
}

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

test("the conversations' page stays through background refreshes", async () => {
  await page.getByTestId("session-list-pager").waitFor();
  const first = await label();
  assert.match(first ?? "", /^1–\d+ of \d+$/, `the list starts on its first page (${first})`);
  const firstTitles = await shownTitles();
  assert.ok(firstTitles.length >= 1, "rows are in sight");

  await page.getByTestId("session-list-page-next").click();
  await frames();
  const second = await label();
  assert.notEqual(second, first, "Next shows the second page");
  const secondTitles = await shownTitles();
  assert.ok(secondTitles.length >= 1 && secondTitles.every((title) => !firstTitles.includes(title)), `other rows are in sight: ${secondTitles}`);

  for (const cycle of [1, 2, 3]) {
    await refreshCycle();
    assert.equal(await label(), second, `refresh ${cycle}: the pager still says the second page`);
    assert.deepEqual(await shownTitles(), secondTitles, `refresh ${cycle}: the second page's rows are still in sight`);
  }
  // A second and a half of nothing at all: no timer takes the page back either.
  await page.waitForTimeout(1_500);
  assert.equal(await label(), second, "the page stays while nothing happens");
  assert.deepEqual(await shownTitles(), secondTitles);
});

test("another search starts on the first page, and Previous still works after refreshes", async () => {
  await page.getByTestId("session-list-page-previous").click();
  await frames();
  const first = await label();
  assert.match(first ?? "", /^1–/);
  await page.getByTestId("session-list-page-next").click();
  await frames();
  assert.doesNotMatch((await label()) ?? "", /^1–/, "on the second page again");
  await page.getByTestId("conversation-list-search-input").fill("a");
  await frames();
  await page.waitForTimeout(400);
  const searched = await label();
  assert.ok(!searched || /^1–/.test(searched), `a search shows its first page (${searched})`);
  await page.getByTestId("conversation-list-search-input").fill("");
  await frames();
});

test("another project starts on its first page", async () => {
  await page.getByTestId("session-list-page-next").click();
  await frames();
  assert.doesNotMatch((await label()) ?? "", /^1–/);
  await page.locator(".project-card", { hasText: "Joint Bob" }).first().click();
  await page.locator("#projectName", { hasText: "Joint Bob" }).waitFor();
  await page.locator("#sessionList .session-card").first().waitFor();
  await frames();
  const other = await label();
  assert.ok(!other || /^1–/.test(other), `the other project's list starts at its top (${other})`);
});
