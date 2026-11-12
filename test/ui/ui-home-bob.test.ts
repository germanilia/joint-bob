// Desktop Home and Bob's page (Paper · Editorial, phase 6): Home's greeting, its Needs you cards with Answer, Push it
// on, Done and Open, the Running and Ready to review lists; Bob's page with his chat in the middle and "What Bob looks
// after" on the right, each row opening its tab and "‹ Bob's chat" coming back; the phone's Home with the same cards.
// The board is answered by the test, so the cards are known. Spec: docs/superpowers/specs/2026-11-10-ui-redo-paper-design.md.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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
const pushes: unknown[] = [];

const card = (id: string, column: string, extra: Record<string, unknown> = {}) => ({
  projectId: "p1", projectName: "Joint Bob", conversationId: id, sessionId: id, path: `/x/${id}`, title: `Conversation ${id}`, column,
  harnessId: "pi", agentId: "pi", agentLabel: "Pi", agentModel: null, executionNodeId: null, updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  turnRunning: column === "running", backgroundRunning: false, summary: null, activity: column === "running" ? "Running the tests" : null,
  autoRespondActive: false, startedBy: "you", pendingReviews: [], autoRespondStop: null, controlledBy: null, reviewCheck: null, ...extra,
});
const cards = [
  card("n1", "needs-you", { reviewCheck: { needsYou: true, reason: "Keep the ticket form link, or drop it?" } }),
  card("n2", "needs-you", { pendingReviews: [{ id: "r1", title: "Deploy", subject: "npm run deploy", detail: "", expiresAt: new Date(Date.now() + 600_000).toISOString() }] }),
  card("r1", "running"),
  card("v1", "review", { summary: "**Current state** Twelve files changed, tests pass." }),
];

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-home-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  server = await startDevNode(environment, node);
  browser = await launchChrome({ headless: process.env.HEADED !== "1" });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block", reducedMotion: "reduce" });
  page.setDefaultTimeout(20_000);
  await page.route("**/api/control-center/board*", (route) => route.fulfill({ json: { cards, projects: [{ id: "p1", name: "Joint Bob", color: null }] } }));
  await page.route("**/api/control-center/cards/push", async (route) => { pushes.push(route.request().postDataJSON()); await route.fulfill({ json: { ok: true } }); });
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 30_000 });
  await page.evaluate((key) => localStorage.setItem(key, "inbox"), WORKSPACE_COLUMN_KEY);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 30_000 });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#loginDialog[open]").waitFor({ state: "detached" });
});

after(async () => {
  await browser?.close();
  if (server) await stopDevNode(server);
  await rm(root, { recursive: true, force: true });
});

test("Home greets, counts, and shows Needs you as cards with their actions, then Running and Ready to review", async () => {
  await page.getByTestId("home-page").waitFor();
  assert.match(await page.getByTestId("home-greeting").innerText(), /^Good (morning|afternoon|evening)/);
  await page.waitForFunction(() => /2 need you · 1 running · 1 to review/.test(document.querySelector('[data-testid="home-counts"]')?.textContent ?? ""));
  const cardsShown = page.getByTestId("home-card");
  assert.equal(await cardsShown.count(), 2);
  const first = cardsShown.filter({ hasText: "Conversation n1" });
  assert.match(await first.innerText(), /Keep the ticket form link, or drop it\?/);
  for (const testid of ["home-card-answer", "home-card-push", "home-card-done", "home-card-open"]) assert.equal(await first.getByTestId(testid).isVisible(), true, testid);
  // A step Guardian holds is answered with its own two buttons.
  const held = cardsShown.filter({ hasText: "Conversation n2" });
  assert.equal(await held.getByTestId("home-card-allow").isVisible(), true);
  assert.equal(await held.getByTestId("home-card-block").isVisible(), true);
  // Push it on asks what to tell it, then pushes with those words.
  await first.getByTestId("home-card-push").click();
  await first.getByTestId("home-card-push-box").locator("textarea").fill("Keep it as an option");
  await first.getByTestId("home-card-push-send").click();
  await first.getByTestId("home-card-push-box").waitFor({ state: "detached" });
  assert.deepEqual(pushes.at(-1), { projectId: "p1", conversationId: "n1", note: "Keep it as an option" });
  assert.match(await page.getByTestId("home-run-list").innerText(), /Conversation r1[\s\S]*Running the tests/);
  assert.equal(await page.getByTestId("home-review-list").getByTestId("home-row-review").count(), 1);
  // Home fits the window: nothing in it scrolls.
  const overflow = await page.getByTestId("home-page").evaluate((home) => home.scrollHeight - home.clientHeight);
  assert.ok(overflow <= 1, `Home does not scroll (${overflow})`);
});

/** Waits until the account's preferences hold this view (saving is debounced). */
async function savedView(view: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await page.evaluate(async () => (await (await fetch("/api/preferences")).json()).controlCenter.view) === view) return;
    await page.waitForTimeout(100);
  }
  assert.fail(`the saved view never became ${view}`);
}

test("Bob's page: the stage toggles live conversations and the Dashboard, the right column stays, and the choice and folds are kept", async () => {
  // Wait for the page to finish opening, or its restore of the saved view takes it away from Bob again.
  await page.waitForFunction(() => /need you/.test(document.querySelector('[data-testid="home-counts"]')?.textContent ?? ""));
  await page.getByTestId("projects-open-control-center-button").click();
  await page.locator("body.view-control.bob-desk").waitFor();
  assert.equal(await page.getByTestId("control-chat-input").isVisible(), true);
  assert.equal(await page.getByTestId("control-chat-input").getAttribute("placeholder"), "Ask Bob, or give him a task…");
  const side = page.getByTestId("bob-side");
  await side.waitFor({ state: "visible" });
  for (const testid of ["control-tab-live", "control-tab-my-dashboard", "control-tab-automations", "control-tab-memory", "control-tab-dashboards", "bob-side-model", "bob-side-ask", "bob-side-pause"]) {
    assert.equal(await side.getByTestId(testid).isVisible(), true, testid);
  }
  for (const gone of ["control-tab-clusters", "control-tab-overview"]) assert.equal(await page.getByTestId(gone).count(), 0, `${gone} is gone`);
  assert.equal(await page.getByTestId("control-chat-monitor").isVisible(), true, "Monitoring stays reachable");

  // The board, its characters and scoreboard; the stage toggle shows the Dashboard and the column stays.
  await page.getByTestId("bob-stage-live").click();
  await page.getByTestId("control-center-card").first().waitFor();
  assert.equal(await page.getByTestId("control-score").isVisible(), true);
  assert.ok(await page.getByTestId("control-card-avatar").count() > 0);
  // The app's left column goes on Bob's page; it has the whole width.
  assert.equal(await page.getByTestId("workspace-side").isVisible(), false, "no left column on Bob's page");
  // Nothing on a card is cut: its top row and its buttons fit inside it.
  const clipped = await page.getByTestId("control-center-card").evaluateAll((cards) => cards.flatMap((card) => {
    const box = card.getBoundingClientRect();
    return [...card.querySelectorAll(".control-card-top > *, .control-card-actions > *")]
      .filter((part) => getComputedStyle(part).position !== "absolute")
      .filter((part) => { const own = part.getBoundingClientRect(); return own.right > box.right + 0.5 || own.bottom > box.bottom + 0.5; })
      .map((part) => `${card.getAttribute("data-key")}: ${part.textContent}`);
  }));
  assert.deepEqual(clipped, [], "every part of a card is inside it");
  if (process.env.BOB_PAGE_SHOT) await page.screenshot({ path: process.env.BOB_PAGE_SHOT });
  await page.getByTestId("bob-stage-my-dashboard").click();
  await page.locator("#controlView-my-dashboard").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("bob-stage-my-dashboard").getAttribute("aria-pressed"), "true");
  assert.equal(await side.isVisible(), true, "the column stays with another view open");
  await side.getByTestId("control-tab-automations").click();
  assert.equal(await side.isVisible(), true);
  await side.getByTestId("control-tab-live").click();
  await page.getByTestId("control-center-board").waitFor({ state: "visible" });

  // A lane folds into its scoreboard tile and opens from it again.
  await page.getByTestId("control-lane-fold-running").click();
  assert.equal(await page.getByTestId("control-score-running").getAttribute("aria-pressed"), "false");
  await page.getByTestId("control-score-running").click();
  assert.equal(await page.getByTestId("control-lane-fold-running").getAttribute("aria-expanded"), "true");

  // The chat and the column fold into round buttons and come back from them.
  await page.getByTestId("control-chat-fold").click();
  assert.equal(await page.getByTestId("control-chat-input").isVisible(), false);
  await page.getByTestId("bob-fab-chat").click();
  assert.equal(await page.getByTestId("control-chat-input").isVisible(), true);
  await page.getByTestId("bob-side-fold").click();
  assert.equal(await side.isVisible(), false);
  await page.getByTestId("bob-fab-side").click();
  assert.equal(await side.isVisible(), true);

  // The view opened last opens again after a reload.
  await page.getByTestId("bob-stage-my-dashboard").click();
  await savedView("my-dashboard");
  await page.reload();
  await page.locator("body.view-control.bob-desk").waitFor();
  await page.locator("#controlView-my-dashboard").waitFor({ state: "visible" });
  await page.getByTestId("bob-stage-live").click();
  await savedView("live");

  // Nothing here leaves Bob's page by itself; Esc twice does.
  await page.keyboard.press("Escape");
  await page.getByTestId("control-exit-prompt").waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page.locator("body.view-control").waitFor({ state: "detached" });
});

test("the phone's Home shows what needs you as the same cards", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("phone-tab-inbox").click();
  const phoneCard = page.getByTestId("workspace-groups").getByTestId("home-card").first();
  await phoneCard.waitFor();
  for (const testid of ["home-card-answer", "home-card-push", "home-card-done", "home-card-open"]) {
    // The list redraws as the board arrives: wait for the button, then measure it in the page.
    const button = phoneCard.getByTestId(testid);
    await button.waitFor();
    const height = await button.evaluate((element) => element.getBoundingClientRect().height);
    assert.ok(height >= 44, `${testid} is a 44 px target (${height})`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
});
