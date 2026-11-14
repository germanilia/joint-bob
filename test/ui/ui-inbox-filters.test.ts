// The Inbox's filters and multi-select on the phone's Home: project multi-select, Show (latest 10 per project by default),
// Select with Mark read and Delete. Code: public/app/inbox-filters.js, workspace.js.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { type Browser, type Page } from "playwright-core";
import { launchChrome, WORKSPACE_COLUMN_KEY } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "../dev-nodes.js";

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let server: ChildProcess;
let browser: Browser;
let page: Page;
const pageErrors: string[] = [];

/** A new answer after the last review puts a conversation under To review. */
async function answerAgain(name: string, secondsLater: number) {
  const file = path.join(environment.home, ".pi", "sessions", `${name}.jsonl`);
  const last = JSON.parse((await readFile(file, "utf8")).trim().split("\n").at(-1)!) as { id: string };
  const at = Date.now() + secondsLater * 1000;
  const user = { type: "message", id: `${name}-again-u`, parentId: last.id, timestamp: new Date(at - 30_000).toISOString(), message: { role: "user", content: [{ type: "text", text: "Check it once more." }], timestamp: at - 30_000 } };
  const answer = { type: "message", id: `${name}-again-a`, parentId: user.id, timestamp: new Date(at).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Checked: it works. Shall I push it?" }], timestamp: at } };
  await appendFile(file, `${JSON.stringify(user)}\n${JSON.stringify(answer)}\n`);
}

const frames = () => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

/** Controls under 44 px, text under 13 px and sideways scrolling on the visible screen. */
// A string, so the test's compiler adds no helpers the page does not have.
async function phoneProblems(): Promise<string[]> {
  return page.evaluate(`(() => {
    const out = [];
    const shown = (el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) return null;
      const hit = document.elementFromPoint(Math.min(innerWidth - 1, r.x + r.width / 2), r.y + r.height / 2);
      return hit && (el.contains(hit) || hit.contains(el)) ? r : null;
    };
    for (const el of document.querySelectorAll("button, a, select, input:not([type=hidden]), textarea, [role=button], [role=switch]")) {
      if (el.closest(".sr-only, #messages")) continue;
      const r = shown(el);
      if (r && (r.height < 43.5 || r.width < 43.5)) out.push("target " + (el.id || el.dataset.testid || el.className) + " " + Math.round(r.width) + "x" + Math.round(r.height));
    }
    for (const el of document.querySelectorAll("body *")) {
      if (el.closest("#messages, .sr-only, svg, .app-boot") || ![...el.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim())) continue;
      if (shown(el) && parseFloat(getComputedStyle(el).fontSize) < 13) out.push("text " + getComputedStyle(el).fontSize + " " + el.textContent.trim().slice(0, 20));
    }
    if (document.documentElement.scrollWidth > innerWidth) out.push("sideways " + document.documentElement.scrollWidth);
    return out;
  })()`);
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-inbox-filters-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  server = await startDevNode(environment, node);
  browser = await launchChrome({ headless: process.env.HEADED !== "1" });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: "block", reducedMotion: "reduce" });
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 30_000 });
  await page.evaluate((key) => localStorage.setItem(key, "unset"), WORKSPACE_COLUMN_KEY);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 30_000 });
  const baseline = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/reviews/pending" && response.ok());
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#loginDialog[open]").waitFor({ state: "detached" });
  await baseline;
  for (const [name, seconds] of [["short-one", 1], ["canvas-picker-readability", 2], ["terraform-state-locking", 3]] as const) await answerAgain(name, seconds);
  await page.reload({ waitUntil: "domcontentloaded" });
}, { timeout: 120_000 });

after(async () => {
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

/** A tap acts once the double-tap window has passed, so a text is waited for, not read at once. */
const textOf = (testid: string, text: string) => page.waitForFunction(([id, expected]) => document.querySelector(`[data-testid="${id}"]`)?.textContent === expected, [testid, text]);
const rows = (group: string) => page.locator(`[data-testid="workspace-group-${group}"] [data-testid="workspace-group-row"]`);

test("Home shows the filters, with the latest 10 conversations of each project by default", async () => {
  await page.getByTestId("workspace-group-count-review").filter({ hasText: /^[1-9]\d*( of \d+)?$/ }).waitFor();
  await page.getByTestId("inboxHome-tools").waitFor();
  assert.equal(await page.getByTestId("inboxHome-range").inputValue(), "latest-10");
  assert.equal(await page.getByTestId("inboxHome-projects-trigger").innerText(), "All projects");
  // No project has more than 10 rows on the board and in Earlier together under the default.
  const perProject = await page.evaluate(() => {
    const counts = new Map<string, number>();
    for (const group of ["running", "review", "earlier"]) {
      const names = [...document.querySelectorAll(`[data-testid="workspace-group-${group}"] [data-testid="workspace-group-row"]`)].map((row) => (row as HTMLElement).title.split(" · ").at(-1)!);
      const own = new Map<string, number>();
      for (const name of names) own.set(name, (own.get(name) ?? 0) + 1);
      for (const [name, count] of own) counts.set(name, Math.max(counts.get(name) ?? 0, count));
    }
    return [...counts.values()];
  });
  assert.ok(perProject.every((count) => count <= 10), `at most 10 per project in a group: ${perProject}`);
  await page.getByTestId("inboxHome-range").selectOption("all");
  assert.equal(await page.getByTestId("inboxHome-range").inputValue(), "all");
  await page.getByTestId("inboxHome-range").selectOption("latest-10");
  assert.deepEqual(await phoneProblems(), []);
});

test("the project multi-select narrows every group to the chosen projects", async () => {
  await page.getByTestId("inboxHome-range").selectOption("all");
  await page.getByTestId("inboxHome-projects-trigger").tap();
  const options = page.getByTestId("inboxHome-projects-options").locator("[role=option]");
  await options.first().waitFor();
  const name = (await options.first().innerText()).split("\n")[0].trim();
  await options.first().tap();
  await textOf("inboxHome-projects-trigger", name);
  await page.keyboard.press("Escape");
  await page.waitForFunction((project) => {
    const titles = [...document.querySelectorAll('[data-testid="workspace-group-row"]')].map((row) => (row as HTMLElement).title);
    return titles.length > 0 && titles.every((title) => title.endsWith(` · ${project}`));
  }, name);
  await page.getByTestId("inboxHome-projects-trigger").tap();
  await page.getByTestId("inboxHome-projects-clear").tap();
  await page.waitForFunction(() => document.querySelector('[data-testid="inboxHome-projects-trigger"]')!.textContent === "All projects");
});

test("Select turns the rows into a checklist that does not open them, and Cancel puts them back", async () => {
  await page.getByTestId("inboxHome-select").tap();
  await page.getByTestId("inboxHome-bar").waitFor();
  assert.equal(await page.getByTestId("inboxHome-mark-read").isDisabled(), true, "nothing is chosen yet");
  const first = rows("review").first();
  await first.tap();
  await textOf("inboxHome-selected-count", "1 selected");
  assert.equal(await first.getAttribute("aria-pressed"), "true");
  assert.equal(await page.evaluate(() => document.body.classList.contains("view-projects")), true, "pressing a row while selecting does not open it");
  await first.tap();
  await textOf("inboxHome-selected-count", "0 selected");
  await page.getByTestId("inboxHome-select").tap();
  await page.getByTestId("inboxHome-bar").waitFor({ state: "hidden" });
  assert.equal(await page.locator(".ws-check").count(), 0);
  assert.deepEqual(await phoneProblems(), []);
});

test("Mark read takes the chosen conversations out of To review", async () => {
  await page.getByTestId("inboxHome-range").selectOption("all");
  const before = await rows("review").count();
  assert.ok(before >= 1);
  await page.getByTestId("inboxHome-select").tap();
  await page.getByTestId("inboxHome-bar").waitFor();
  await page.locator(".ws-check").first().waitFor();
  await rows("review").first().tap();
  await textOf("inboxHome-selected-count", "1 selected");
  const marked = page.waitForResponse((response) => response.url().includes("/sessions/reviewed-all") && response.ok());
  await page.getByTestId("inboxHome-mark-read").tap();
  await marked;
  await page.waitForFunction((count) => document.querySelectorAll('[data-testid="workspace-group-review"] [data-testid="workspace-group-row"]').length < count, before);
  assert.equal(await page.getByTestId("inboxHome-bar").isHidden(), true, "select mode ends after the action");
});

test("Delete asks first, then removes the chosen conversations", async () => {
  await page.getByTestId("inboxHome-range").selectOption("all");
  const before = await rows("earlier").count();
  assert.ok(before >= 1);
  await page.getByTestId("inboxHome-select").tap();
  await page.getByTestId("inboxHome-bar").waitFor();
  await page.locator(".ws-check").first().waitFor();
  // The seeded Pi conversations have names, not UUIDs, and the delete route only takes UUIDs: choose one that has one.
  const keys = await rows("earlier").evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.key!));
  const key = keys.find((candidate) => /:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(candidate));
  assert.ok(key, `a conversation with a UUID is in Earlier: ${keys}`);
  await rows("earlier").and(page.locator(`[data-key="${key}"]`)).tap();
  await textOf("inboxHome-selected-count", "1 selected");
  await page.getByTestId("inboxHome-delete").tap();
  await page.locator("#confirmDialog[open]").waitFor();
  await page.locator("#confirmDialog").getByRole("button", { name: "Cancel" }).tap();
  await page.locator("#confirmDialog[open]").waitFor({ state: "detached" });
  assert.equal(await rows("earlier").count(), before, "cancelling deletes nothing");
  const deleted = page.waitForResponse((response) => response.request().method() === "DELETE" && response.url().includes("/sessions?") && response.ok());
  await page.getByTestId("inboxHome-delete").tap();
  await page.locator("#confirmDialog[open]").waitFor();
  await page.locator("#confirmDialog").getByRole("button", { name: "Delete" }).tap();
  await deleted;
  await page.waitForFunction((count) => document.querySelectorAll('[data-testid="workspace-group-earlier"] [data-testid="workspace-group-row"]').length < count, before);
  assert.deepEqual(pageErrors, []);
});

test("the Show all page on the desktop has the same filters and Select", async () => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByTestId("workspace-side").waitFor();
  const showAll = page.locator('[data-testid^="workspace-show-all-"]').first();
  await showAll.waitFor();
  await showAll.click();
  await page.getByTestId("workspace-group-page").waitFor();
  assert.equal(await page.getByTestId("inboxPage-tools").isVisible(), true);
  assert.equal(await page.getByTestId("inboxHome-tools").isVisible(), false, "the phone's toolbar stays on the phone");
  // One state for both toolbars: the earlier tests chose Everything.
  assert.equal(await page.getByTestId("inboxPage-range").inputValue(), "all");
  await page.getByTestId("inboxPage-range").selectOption("latest-10");
  assert.equal(await page.getByTestId("inboxHome-range").inputValue(), "latest-10");
  await page.getByTestId("inboxPage-select").click();
  await page.getByTestId("inboxPage-bar").waitFor();
  await page.locator('[data-testid="workspace-group-page-row"] .ws-check').first().waitFor();
  await page.getByTestId("inboxPage-select").click();
  await page.getByTestId("inboxPage-bar").waitFor({ state: "hidden" });
  assert.deepEqual(pageErrors, []);
});
