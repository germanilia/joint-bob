// The phone (Paper · Editorial, phase 5): Home with the greeting and the three groups, the tabs Inbox · Bob · Projects ·
// Settings, the New button, a conversation's chips and its details sheet. Every action the old phone menu and its Tools
// submenu offered must still be reachable. Spec: "Layout › Phone" in docs/superpowers/specs/2026-11-10-ui-redo-paper-design.md.
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
const view = () => page.evaluate(() => ["projects", "sessions", "chat", "board", "control"].find((name) => document.body.classList.contains(`view-${name}`)));

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
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-phone-"));
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
  // A person who never chose starts on Home (launchChrome starts the suite in Projects only when the key is missing).
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

test("Home greets by the time of day, counts what waits and shows the three groups over the tabs", async () => {
  await page.getByTestId("phone-home").waitFor();
  // The name joins the greeting once the account has loaded.
  await page.getByTestId("phone-greeting").filter({ hasText: /^Good (morning|afternoon|evening), / }).waitFor();
  await page.getByTestId("workspace-group-count-review").filter({ hasText: /^[1-9]\d*$/ }).waitFor();
  const review = await page.getByTestId("workspace-group-count-review").innerText();
  assert.match(await page.getByTestId("phone-counts").innerText(), new RegExp(`^\\d+ needs? you · \\d+ running · ${review} to review$`));
  assert.ok(await page.locator('[data-testid="workspace-group-review"] [data-testid="workspace-group-row"]').count() >= 1);
  // Earlier lists every other conversation too.
  await page.getByTestId("workspace-group-count-earlier").filter({ hasText: /^[1-9]\d*$/ }).waitFor();
  assert.equal(await page.locator("#projectsPanel").isVisible(), false, "the project list waits behind Projects");
  assert.equal(await page.getByTestId("phone-tab-inbox").getAttribute("aria-current"), "page");
  for (const id of ["phone-tab-inbox", "phone-tab-bob", "phone-tab-projects", "phone-tab-settings", "phone-new-button", "phone-search-input", "focus-controls-button"]) {
    assert.equal(await page.getByTestId(id).isVisible(), true, `${id} is on Home`);
  }
  // Every conversation of a group is listed in one scroll (up to the first chunk of 40), with no Show all.
  assert.equal(await page.locator('[data-testid="workspace-group-review"] [data-testid="workspace-group-row"]').count(), Math.min(Number(review), 40), "every To review conversation is listed");
  assert.equal(await page.locator('[data-testid^="workspace-show-all-"]').count(), 0, "Home has no Show all");
  assert.deepEqual(await phoneProblems(), []);
});

test("New offers the desktop's New menu, and search opens the workspace search", async () => {
  await page.getByTestId("phone-new-button").tap();
  await page.getByTestId("workspace-new-menu").waitFor();
  for (const id of ["workspace-new-conversation", "workspace-new-note", "workspace-new-project"]) assert.equal(await page.getByTestId(id).isVisible(), true, `${id} is offered`);
  const sheet = await page.getByTestId("workspace-new-menu").boundingBox();
  assert.ok(sheet && Math.round(sheet.y + sheet.height) === 844 && sheet.width === 390, `New rises as a sheet: ${JSON.stringify(sheet)}`);
  await page.keyboard.press("Escape");
  await page.getByTestId("workspace-new-menu").waitFor({ state: "hidden" });
  await page.getByTestId("phone-search-input").tap();
  await page.locator("#spotlightDialog[open]").waitFor();
  await page.keyboard.press("Escape");
  await page.locator("#spotlightDialog[open]").waitFor({ state: "detached" });
});

test("a conversation opened on Home goes back to Home, and its details sheet holds every action", async () => {
  await page.locator('[data-testid="workspace-group-review"] [data-testid="workspace-group-row"]').first().tap();
  await page.locator("body.view-chat").waitFor();
  await page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>("#messageInput")!.disabled);
  assert.equal(await page.getByTestId("phone-tabs").isVisible(), false, "a conversation has no tabs");
  for (const id of ["phone-chip-harness", "phone-chip-model", "phone-chip-node"]) assert.equal(await page.getByTestId(id).isVisible(), true, `${id} is under the title`);
  await page.getByTestId("phone-chip-harness").tap();
  // A tap acts once the double-tap window has passed, so wait for the list.
  await page.getByTestId("phone-chip-harness-option").first().waitFor();
  assert.ok(await page.getByTestId("phone-chip-harness-option").count() >= 1, "the agent chip lists the agents");
  await page.keyboard.press("Escape");
  await page.getByTestId("focus-controls-button").tap();
  await page.locator("#focusControls").waitFor();
  for (const id of ["focus-activity", "focus-files", "focus-git", "focus-tasks", "focus-harness", "focus-model", "focus-effort", "focus-node", "focus-auto-respond", "focus-notify", "focus-mark-done", "focus-add-secret",
    "focus-tool-chat-open-terminal-button", "focus-tool-chat-open-browser-button", "focus-tool-chat-rename-button", "focus-tool-chat-share-button", "focus-tool-chat-cron-button", "focus-tool-chat-more-dashboard-button", "focus-tool-chat-session-menu-button",
    "focus-new-conversation", "focus-new-note", "focus-recents", "focus-running", "focus-reviews", "focus-projects", "focus-conversations", "focus-control-center", "focus-usage-open", "focus-settings"]) {
    assert.equal(await page.getByTestId(id).count(), 1, `${id} is in the details sheet`);
  }
  assert.equal(await page.getByTestId("focus-notify").getAttribute("role"), "switch");
  assert.equal(await page.getByTestId("focus-mark-done").isVisible(), true, "Mark done stays in sight at the foot of the sheet");
  await page.getByTestId("focus-close").tap();
  await page.locator("#focusControls").waitFor({ state: "hidden" });
  assert.deepEqual(await phoneProblems(), []);
  await page.getByTestId("chat-back-button").tap();
  await page.getByTestId("phone-home").waitFor();
  assert.equal(await view(), "projects");
});

test("the tabs reach Bob, Projects and Settings, and Settings keeps them on its list", async () => {
  await page.getByTestId("phone-tab-bob").tap();
  await page.locator("body.view-control").waitFor();
  assert.equal(await page.getByTestId("phone-tab-bob").getAttribute("aria-current"), "page");
  assert.equal(await page.getByTestId("control-chat").isVisible(), true, "Bob's chat fills the page");
  await page.getByTestId("phone-tab-projects").tap();
  await page.locator("body.view-projects .project-card").first().waitFor();
  assert.equal(await page.getByTestId("phone-home").isVisible(), false);
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().tap();
  await page.locator("body.view-sessions #sessionList .session-card").first().waitFor();
  assert.equal(await page.getByTestId("phone-tab-projects").getAttribute("aria-current"), "page");
  assert.equal(await page.getByTestId("notes-tab").isVisible(), true, "a project keeps its Notes");
  await page.getByTestId("phone-tab-settings").tap();
  await page.locator("#settingsDialog[open]").waitFor();
  await page.waitForFunction(() => document.querySelector("#phoneTabs")!.parentElement!.id === "settingsDialog");
  assert.equal(await page.getByTestId("phone-tab-settings").isVisible(), true, "the section list carries the tabs");
  await page.getByTestId("settings-tab-account").tap();
  // A section has its own way back instead of the tabs.
  await page.getByTestId("phone-tabs").waitFor({ state: "hidden" });
  await page.getByTestId("settings-back-button").tap();
  await page.getByTestId("phone-tab-inbox").tap();
  await page.locator("#settingsDialog[open]").waitFor({ state: "detached" });
  await page.getByTestId("phone-home").waitFor();
  assert.deepEqual(pageErrors, []);
});

test("desktop keeps its workspace: no phone tabs, Home or chips", async () => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await frames();
  for (const id of ["phone-tabs", "phone-home", "phone-new-button", "phone-chips"]) assert.equal(await page.getByTestId(id).isVisible(), false, `${id} is phone-only`);
  assert.equal(await page.getByTestId("workspace-side").isVisible(), true);
  await page.setViewportSize({ width: 390, height: 844 });
});
