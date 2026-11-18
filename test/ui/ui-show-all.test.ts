import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { type Browser, type Page } from "playwright-core";
import { launchChrome, WORKSPACE_COLUMN_KEY } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

let root: string;
let server: ChildProcess;
let browser: Browser;
let page: Page;
const errors: string[] = [];

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-show-all-"));
  const environment = await seedDevEnvironment(root, 1);
  const sessions = path.join(environment.home, ".pi", "sessions");
  const original = await readFile(path.join(sessions, "short-one.jsonl"), "utf8");
  // More than both the phone's ten-per-project limit and one 40-row scroll chunk.
  for (let index = 0; index < 55; index++) {
    const transcript = original.replaceAll("short-one", `archive-${index}`).replaceAll("Short one", `Earlier archive ${index}`);
    await writeFile(path.join(sessions, `archive-${index}.jsonl`), transcript);
  }
  server = await startDevNode(environment, environment.nodes[0]);
  browser = await launchChrome({ headless: true, env: { ...process.env, HOME: environment.home } });
  const context = await browser.newContext({ viewport: { width: 2560, height: 1000 }, serviceWorkers: "block", reducedMotion: "reduce" });
  await context.addInitScript((key) => {
    localStorage.setItem(key, "inbox");
    localStorage.setItem("joint-bob-inbox-range", "latest-10");
  }, WORKSPACE_COLUMN_KEY);
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(environment.nodes[0].url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor();
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByTestId("workspace-show-all-earlier").click();
  await page.getByTestId("workspace-group-page").waitFor();
  await page.getByTestId("workspace-group-page-row").first().waitFor();
}, { timeout: 120_000 });

after(async () => {
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

test("Show all ignores the phone's range and reaches every Earlier conversation through scrolling", async () => {
  const count = Number(await page.getByTestId("workspace-group-tab-earlier").locator("b").innerText());
  assert.ok(count >= 55, `all 55 archive conversations are counted, got ${count}`);
  assert.equal(await page.getByTestId("inboxPage-range").isVisible(), false, "Show all has no range cutoff");
  const list = page.getByTestId("workspace-group-list");
  for (let chunk = 0; chunk < 3; chunk++) {
    await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }
  assert.equal(await page.getByTestId("workspace-group-page-row").filter({ hasText: /Earlier archive \d+/ }).count(), 55);
});

test("free-text search finds older titles, matches project names, and combines with project filters", async () => {
  const search = page.getByTestId("inboxPage-search");
  await search.fill("  EARLIER archive 54  ");
  const rows = page.getByTestId("workspace-group-page-row");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="workspace-group-page-row"]').length === 1);
  assert.match(await rows.innerText(), /Earlier archive 54/);
  await search.fill("internal assistant");
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="workspace-group-tab-earlier"] b')!.textContent) >= 55);
  await page.getByTestId("inboxPage-projects-trigger").click();
  await page.getByTestId("inboxPage-projects-options").getByRole("option", { name: "Joint Bob", exact: true }).click();
  await page.keyboard.press("Escape");
  assert.equal(await rows.count(), 0, "search intersects the project choice");
  assert.match(await page.getByTestId("workspace-group-list").innerText(), /Nothing matches the filters/);
  await search.fill("");
  await rows.first().waitFor();
  await page.getByTestId("inboxPage-projects-trigger").click();
  await page.getByTestId("inboxPage-projects-clear").click();
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
});

test("header, search, filters and list share a centered column on wide and narrow desktops", async () => {
  for (const width of [2560, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const boxes = await page.evaluate(() => ["#workspaceGroupPage", ".ws-page-head", '[data-testid="inboxPage-tools"]', "#workspaceGroupList"].map((selector) => {
      const box = document.querySelector(selector)!.getBoundingClientRect();
      return { x: box.x, width: box.width, center: box.x + box.width / 2 };
    }));
    const [panel, header, tools, list] = boxes;
    for (const box of [header, tools, list]) {
      assert.ok(Math.abs(box.center - panel.center) < 2, `content centered at ${width}px: ${JSON.stringify(boxes)}`);
      assert.ok(Math.abs(box.x - list.x) < 2 && Math.abs(box.width - list.width) < 2, "all content shares the same column");
    }
  }
});
