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
  // Bob's page draws the Live agents board as a list by default; this file checks the cards (the list: ui-control-list.test.ts).
  await page.addInitScript(() => localStorage.setItem("jointBobLiveLayout", "cards"));
  // The app opens on Bob; the tests below start from Home, so reopen the view that was left (the workspace column key below).
  await page.addInitScript(() => localStorage.setItem("joint-bob-start-view", "last"));
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

test("Home nav button sits above Inbox and Home lets you pick Activity, Automations, Clusters, and Dashboards", async () => {
  // Home button sits directly above Inbox in the left sidebar.
  const homeNav = page.getByTestId("workspace-nav-home-button");
  const inboxNav = page.getByTestId("workspace-inbox-button");
  assert.equal(await homeNav.isVisible(), true);
  const homeBox = (await homeNav.boundingBox())!;
  const inboxBox = (await inboxNav.boundingBox())!;
  assert.ok(homeBox.y + homeBox.height <= inboxBox.y + 2, `Home button (${homeBox.y}) sits above Inbox (${inboxBox.y})`);

  // Pressing Home from Projects or Bob's page brings the user back to Home.
  await page.getByTestId("workspace-projects-button").click();
  await page.getByTestId("home-page").waitFor({ state: "hidden" });
  await homeNav.click();
  await page.getByTestId("home-page").waitFor({ state: "visible" });
  assert.equal(await homeNav.getAttribute("aria-pressed"), "true");

  // Mock Automations, Clusters, and Dashboards data to verify each selectable Home module.
  const toggledAutomations: Array<{ url: string; body: unknown }> = [];
  let nightBuildEnabled = true;
  await page.route("**/api/control-center/automations", (route) => route.fulfill({
    json: {
      rows: [
        {
          id: "auto-1", kind: "schedule", name: "Nightly build", detail: "Runs tests", enabled: nightBuildEnabled, editable: true,
          projectName: "Joint Bob", projectIds: ["p1"], nodeId: "node-local", nodeName: "Ilia's MacBook", when: "Daily at 03:00",
          last: { state: nightBuildEnabled ? "failed" : "paused", at: new Date(Date.now() - 10 * 60_000).toISOString(), detail: "Exit code 1" },
        },
        {
          id: "auto-2", kind: "bob", name: "Morning report", detail: "", enabled: true, editable: true,
          projectName: "All projects", projectIds: [], nodeId: "node-local", nodeName: "Ilia's MacBook", when: "Daily at 08:00",
          last: { state: "ok", at: new Date(Date.now() - 30 * 60_000).toISOString(), detail: "Sent" },
        },
      ],
      projects: [{ id: "p1", name: "Joint Bob" }],
      errors: [],
      timezone: "UTC",
    },
  }));
  await page.route("**/api/control-center/automations/*/*/enabled", async (route) => {
    const body = route.request().postDataJSON() as { enabled: boolean };
    nightBuildEnabled = body.enabled;
    toggledAutomations.push({ url: route.request().url(), body });
    await route.fulfill({ json: { row: { id: "auto-1", enabled: nightBuildEnabled } } });
  });
  await page.route("**/api/cluster/node", (route) => route.fulfill({
    json: { node: { id: "node-local", name: "Ilia's MacBook", url: "https://macbook.tail.ts.net" } },
  }));
  await page.route("**/api/clusters", (route) => route.fulfill({
    json: {
      clusters: [{
        id: "cluster-1", name: "Contigos Prod", managerNodeId: "node-local", autoShareProjects: true, pendingDeliveries: 0,
        subscriptionPool: { name: "Team Pool" },
        members: [
          { nodeId: "node-local", name: "Ilia's MacBook", url: "https://macbook.tail.ts.net" },
          { nodeId: "node-ec2", name: "Contigos EC2", url: "https://ec2.tail.ts.net" },
        ],
      }],
    },
  }));
  await page.route("**/api/twins", (route) => route.fulfill({
    json: { relationships: [{ relationshipId: "twin-1", status: "active", peer: { nodeId: "node-ec2", name: "Contigos EC2", url: "https://ec2.tail.ts.net" } }] },
  }));
  await page.route("**/api/relays", (route) => route.fulfill({
    json: {
      relays: [{ id: "relay-1", origin: "https://relay.example.com", name: "Home Relay", status: "admitted", connected: true, onlinePeers: 2 }],
      local: null,
    },
  }));
  await page.route("**/api/cluster/inventory", (route) => route.fulfill({
    json: { local: { id: "node-local" }, remote: [{ peerId: "node-ec2", name: "Contigos EC2", url: "https://ec2.tail.ts.net", reachable: true }] },
  }));
  await page.route("**/api/control-center/dashboards/overview", (route) => route.fulfill({
    json: {
      accountId: "acct-1",
      dashboards: [{ id: "ov-1", title: "Daily Pulse", status: "ready", isDefault: true, changing: false, hostProjectId: "p1" }],
    },
  }));
  await page.route("**/api/dashboards?*", (route) => route.fulfill({
    json: {
      entity: { kind: "account", id: "acct-1" },
      label: "All my projects",
      hostProjectId: "p1",
      displayedId: "ov-1",
      dashboards: [{
        id: "ov-1", title: "Daily Pulse", entity: { kind: "account", id: "acct-1" }, hostProjectId: "p1",
        origin: "own", ownerNodeId: "node-local", canEdit: true, refreshMethod: "script", active: true, saved: true,
        approved: true, definitionDigest: "abc", hasDraft: false, draftHasPage: true, draftVersion: 1,
        lastRefresh: { ok: true, at: new Date(Date.now() - 5 * 60_000).toISOString() }, running: null,
      }],
    },
  }));
  await page.route("**/api/dashboards/ov-1?*", (route) => route.fulfill({
    json: {
      dashboard: {
        id: "ov-1", title: "Daily Pulse", entity: { kind: "account", id: "acct-1" }, hostProjectId: "p1",
        origin: "own", ownerNodeId: "node-local", canEdit: true, definitionDigest: "abc", saved: true, active: true,
        approved: true, running: null, refreshMethod: "script", hasDraft: false, draftHasPage: true,
        lastRefresh: { ok: true, at: new Date(Date.now() - 5 * 60_000).toISOString() },
      },
      messages: [],
      runLog: "",
    },
  }));
  await page.route("**/api/dashboards/ov-1/frame*", (route) => route.fulfill({
    contentType: "text/html",
    body: "<!doctype html><html><body><h1>Pulse OK</h1></body></html>",
  }));
  await page.route("**/api/control-center/dashboards", (route) => route.fulfill({
    json: {
      dashboards: [{
        id: "proj-dash-1", title: "Release Health", group: "project", projectId: "p1", projectName: "Joint Bob",
        hostProjectId: "p1", entity: { kind: "project", id: "p1" }, status: "ready", madeBy: "bob", refreshMethod: "script",
        publishedAt: new Date(Date.now() - 12 * 60_000).toISOString(), origin: "own", approved: true, canChange: true,
      }],
    },
  }));

  // Home already read the real (empty) lists before these routes existed; reload so every module reads the mocks.
  await page.reload();
  await page.getByTestId("home-page").waitFor({ state: "visible" });
  // Option C Glance Strip shows live summaries across all 4 modules; Focus Tabs jump into each.
  await page.getByTestId("home-glance-strip").waitFor({ state: "visible" });
  await page.getByTestId("home-tab-automations").click();
  await page.getByTestId("home-section-automations").waitFor({ state: "visible" });
  await page.getByTestId("home-automations-list").waitFor();
  assert.match(await page.getByTestId("home-section-automations").innerText(), /Nightly build[\s\S]*Failed/);
  // Toggling an automation switch calls the enabled API and refreshes its status.
  await page.getByTestId("home-automation-row").filter({ hasText: "Nightly build" }).getByTestId("home-automation-toggle").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="home-automation-row"][data-id="auto-1"] [data-testid="home-automation-toggle"]')?.getAttribute("aria-checked") === "false");
  assert.equal(toggledAutomations.length, 1);
  assert.deepEqual(toggledAutomations[0].body, { enabled: false });

  await page.getByTestId("home-glance-clusters").click();
  await page.getByTestId("home-section-clusters").waitFor({ state: "visible" });
  await page.getByTestId("home-cluster-card").waitFor();
  assert.match(await page.getByTestId("home-section-clusters").innerText(), /Contigos Prod[\s\S]*Contigos EC2[\s\S]*Home Relay/);

  await page.getByTestId("home-tab-dashboard").click();
  await page.getByTestId("home-section-dashboard").waitFor({ state: "visible" });
  await page.getByTestId("home-dashboard-frame").waitFor();
  assert.match(await page.getByTestId("home-dashboard-cards").innerText(), /Release Health/);

  // Editing the dashboard opens Joint Bob's interactive Dashboard Editor (creator mode).
  await page.getByTestId("home-dashboard-edit").click();
  await page.getByTestId("dashboard-creator").waitFor({ state: "visible" });
  await page.locator("#dashboardClose").click();
  await page.getByTestId("dashboard-creator").waitFor({ state: "hidden" });

  // Customize Home popover selects which modules appear in "All selected" and persists across reload.
  await page.getByTestId("home-customize-button").click();
  await page.getByTestId("home-customize-popover").waitFor({ state: "visible" });
  for (const id of ["automations", "clusters", "dashboard"]) await page.getByTestId(`home-toggle-${id}`).check();
  await page.keyboard.press("Escape");
  await page.getByTestId("home-customize-popover").waitFor({ state: "hidden" });

  // Home panel itself still does not overflow the viewport (inner section container scrolls).
  const customOverflow = await page.getByTestId("home-page").evaluate((home) => home.scrollHeight - home.clientHeight);
  assert.ok(customOverflow <= 1, `Home keeps outer overflow contained (${customOverflow})`);

  // Selection persists across reload.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("home-page").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("home-tab-all").getAttribute("aria-selected"), "true");
  await page.getByTestId("home-customize-button").click();
  for (const id of ["activity", "automations", "clusters", "dashboard"]) {
    assert.equal(await page.getByTestId(`home-toggle-${id}`).isChecked(), true, `${id} stays enabled after reload`);
  }

  // Deselecting everything shows the empty-selection prompt, and restoring Activity resets cleanly for later tests.
  for (const id of ["activity", "automations", "clusters", "dashboard"]) await page.getByTestId(`home-toggle-${id}`).uncheck();
  await page.keyboard.press("Escape");
  await page.getByTestId("home-empty-selection").waitFor({ state: "visible" });
  await page.getByTestId("home-empty-enable-activity").click();
  await page.getByTestId("home-empty-selection").waitFor({ state: "hidden" });
  await page.getByTestId("home-section-activity").waitFor({ state: "visible" });
  for (const route of ["**/api/control-center/automations", "**/api/control-center/automations/*/*/enabled", "**/api/cluster/node", "**/api/clusters", "**/api/twins", "**/api/relays", "**/api/cluster/inventory", "**/api/control-center/dashboards/overview", "**/api/dashboards?*", "**/api/dashboards/ov-1?*", "**/api/dashboards/ov-1/frame*", "**/api/control-center/dashboards"]) {
    await page.unroute(route);
  }
});

/** Waits until the account's preferences hold this view (saving is debounced). */
async function savedView(view: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await page.evaluate(async () => (await (await fetch("/api/preferences")).json()).controlCenter.view) === view) return;
    await page.waitForTimeout(100);
  }
  assert.fail(`the saved view never became ${view}`);
}

test("Bob's page: his chat is his own place, the head carries his switch and settings, his pages are a sub-menu, and the choice and the fold are kept", async () => {
  // Wait for the page to finish opening, or its restore of the saved view takes it away from Bob again.
  await page.waitForFunction(() => /need you/.test(document.querySelector('[data-testid="home-counts"]')?.textContent ?? ""));
  await page.getByTestId("projects-open-control-center-button").click();
  await page.locator("body.view-control.bob-desk.bob-chat-page").waitFor();
  // "Bob" opens his chat, which fills the page beside the left column: no "Ask Bob" button over it.
  assert.equal(await page.getByTestId("control-chat-input").isVisible(), true);
  assert.equal(await page.getByTestId("control-chat-input").getAttribute("placeholder"), "Ask Bob, or give him a task…");
  assert.equal(await page.getByTestId("bob-fab-chat").isVisible(), false);
  // The column stays, with the Inbox (what he watches) as its list.
  assert.equal(await page.getByTestId("workspace-side").isVisible(), true);
  assert.equal(await page.getByTestId("workspace-groups").isVisible(), true);
  // Bob is the first conversation of the column's list: the app's mark, his name and what he does, shaped like the rows under it.
  const bobRow = page.getByTestId("projects-open-control-center-button");
  assert.equal(await bobRow.locator(".ws-bob-mark").isVisible(), true, "the Joint Bob mark");
  assert.equal(await bobRow.locator(".ws-bob-line").innerText(), "Acts as you in every project");
  const bobBox = (await bobRow.boundingBox())!;
  const places = (await page.getByTestId("workspace-places").boundingBox())!;
  const groups = (await page.getByTestId("workspace-groups").boundingBox())!;
  assert.ok(bobBox.y >= places.y + places.height && bobBox.y + bobBox.height <= groups.y + 1, "under the places, right above the list");
  // Dashboard, Dashboards and Assistants are places of their own, beside Projects, Automations and Costs; his memory opens from his chat.
  const stage = page.locator(".ws-places");
  for (const testid of ["control-tab-my-dashboard", "control-tab-dashboards", "control-tab-assistants"]) {
    assert.equal(await stage.getByTestId(testid).isVisible(), true, testid);
    assert.equal((await stage.getByTestId(testid).boundingBox())!.x, (await page.getByTestId("workspace-projects-button").boundingBox())!.x, `${testid} is not indented under Bob`);
  }
  for (const testid of ["control-tab-live", "control-tab-automations", "control-tab-memory"]) assert.equal(await stage.getByTestId(testid).isVisible(), false, `${testid} is not a place`);
  await page.getByTestId("bob-memory-button").click();
  await page.locator("#controlView-memory").waitFor({ state: "visible" });
  await bobRow.click();
  await page.locator("body.bob-chat-page").waitFor();
  for (const gone of ["control-tab-clusters", "control-tab-overview", "bob-side", "control-center-board"]) assert.equal(await page.getByTestId(gone).count(), 0, `${gone} is gone`);
  // Bob's switch and his settings are in the head; the chat's own Monitoring button gives way to them.
  const pauseSwitch = page.getByTestId("bob-head-pause");
  assert.equal(await pauseSwitch.getAttribute("aria-checked"), "true");
  assert.equal(await page.getByTestId("control-chat-monitor").isVisible(), false);
  await pauseSwitch.click();
  await page.getByTestId("control-chat-paused").waitFor({ state: "visible" });
  assert.equal(await pauseSwitch.getAttribute("aria-checked"), "false");
  await pauseSwitch.click();
  await page.getByTestId("control-chat-paused").waitFor({ state: "hidden" });
  await page.getByTestId("control-chat-settings-button").click();
  await page.getByTestId("control-bob-harness").waitFor({ state: "visible" });
  await page.getByTestId("control-chat-settings-button").click();
  await page.getByTestId("control-chat-settings").waitFor({ state: "hidden" });
  // On his own page what he and the system raise sits beside the chat; the item filters stay out of the way.
  assert.equal(await page.evaluate(() => { const updates = document.querySelector("#controlChatUpdates")!; return updates.childElementCount === 0 ? updates.closest("details")!.getClientRects().length === 0 : updates.closest("details")!.getClientRects().length > 0; }), true, "his updates beside his chat when there are any");
  assert.equal(await page.getByTestId("control-chat-filters").isVisible(), false, "no item filters");
  if (process.env.BOB_PAGE_SHOT) await page.screenshot({ path: process.env.BOB_PAGE_SHOT });

  // Another of his pages folds the chat into the "Ask Bob" button; the column and the place stay.
  await stage.getByTestId("control-tab-my-dashboard").click();
  await page.locator("#controlView-my-dashboard").waitFor({ state: "visible" });
  assert.equal(await stage.getByTestId("control-tab-my-dashboard").getAttribute("aria-selected"), "true");
  assert.equal(await page.getByTestId("control-chat-input").isVisible(), false);
  // The button is a round icon with no text at the page's bottom left; its name is for readers and the hover.
  const fab = page.getByTestId("bob-fab-chat");
  await fab.waitFor();
  assert.doesNotMatch(await fab.innerText(), /Ask Bob/, "no words on the button");
  assert.equal(await fab.getAttribute("aria-label"), "Ask Bob");
  const round = (await fab.boundingBox())!;
  assert.equal(round.width, round.height, "the button is round");
  assert.ok(round.x < page.viewportSize()!.width / 2, `"Ask Bob" sits on the left of the page (${round.x})`);
  // It opens the chat as a window that floats over the page, and folds it back.
  await fab.click();
  assert.equal(await page.getByTestId("control-chat-input").isVisible(), true);
  assert.equal(await page.getByTestId("control-chat").evaluate((node) => getComputedStyle(node).position), "fixed");
  await page.getByTestId("control-chat-fold").click();
  assert.equal(await page.getByTestId("control-chat-input").isVisible(), false);
  // Automations is a place of its own; "Bob" brings back his chat.
  await page.getByTestId("workspace-automations-button").click();
  await page.locator("#controlView-automations, [data-view='automations'].control-view").first().waitFor({ state: "visible" });
  await page.getByTestId("projects-open-control-center-button").click();
  await page.locator("body.bob-chat-page").waitFor();

  // The view opened last opens again after a reload.
  await stage.getByTestId("control-tab-my-dashboard").click();
  await savedView("my-dashboard");
  await page.reload();
  await page.locator("body.view-control.bob-desk").waitFor();
  await page.locator("#controlView-my-dashboard").waitFor({ state: "visible" });
  await page.getByTestId("projects-open-control-center-button").click();
  await savedView("live");

  // Nothing here leaves Bob's page by itself; Esc twice does.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
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
  for (const width of [320, 360, 390]) {
    await page.setViewportSize({ width, height: 844 });
    // The list redraws as the board refreshes: measure again until every button is drawn, not caught mid-redraw.
    const measure = () => phoneCard.locator(".ws-wait-actions > button").evaluateAll((buttons) => buttons.map((button) => {
      const box = button.getBoundingClientRect();
      const card = button.closest(".ws-wait")!.getBoundingClientRect();
      return { label: button.getAttribute("aria-label"), fits: box.left >= card.left && box.right <= card.right && box.right <= innerWidth, width: box.width, icon: !!button.querySelector("svg"), textHidden: getComputedStyle(button.querySelector(".ws-wait-action-label") ?? button).display === "none" };
    }));
    let actions = await measure();
    for (let attempt = 0; attempt < 20 && actions.some((action) => action.width === 0); attempt += 1) {
      await page.waitForTimeout(100);
      actions = await measure();
    }
    assert.equal(actions.length, 5);
    for (const action of actions) {
      assert.ok(action.fits && action.width >= 44, `action fits at ${width}px: ${JSON.stringify(action)}`);
      assert.ok(action.label && action.icon && action.textHidden, `mobile action has a named icon: ${JSON.stringify(action)}`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("the phone's Needs you deck: every card is one swipe away, swiping does nothing to a card, a tap shows what exactly it needs", async () => {
  const waiting = Array.from({ length: 5 }, (_, index) => card(`d${index + 1}`, "needs-you", { title: `Deck card ${index + 1}`, reviewCheck: { needsYou: true, reason: `Question ${index + 1}: which plan?`, by: "Decision model 96%" } }));
  const calls: string[] = [];
  const answers: unknown[] = [];
  await page.route("**/api/control-center/board*", (route) => route.fulfill({ json: { cards: waiting, projects: [{ id: "p1", name: "Joint Bob", color: null }] } }));
  for (const action of ["push", "done", "reply"]) await page.route(`**/api/control-center/cards/${action}`, async (route) => { calls.push(action); if (action === "reply") answers.push(route.request().postDataJSON()); await route.fulfill({ json: { ok: true } }); });
  await page.route("**/api/control-center/cards/detail*", async (route) => {
    const conversationId = new URL(route.request().url()).searchParams.get("conversationId");
    await route.fulfill({ json: { request: "Please pick a plan", answer: `**Two plans** for ${conversationId}:\n\n- Plan A keeps the flag\n- Plan B removes it`, answerAt: null, answerCut: false, steps: [{ name: "Bash", target: "npm test", failed: false }] } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("control-center-changed")));
  await page.getByTestId("phone-tab-inbox").click();
  const deck = page.getByTestId("needs-deck");
  await deck.waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="needs-deck"] [data-testid="home-card"]').length === 5);
  assert.equal(await deck.getByTestId("home-card").count(), 5, "every needs-you item is in the deck");
  const position = page.getByTestId("needs-deck-position");
  assert.equal(await position.innerText(), "1 of 5");
  // The next card peeks in beside the first; nothing but the deck scrolls sideways.
  const geometry = await page.getByTestId("needs-deck-track").evaluate((track) => {
    const [first, second] = [...track.children].map((child) => child.getBoundingClientRect());
    return { firstWidth: first.width, secondLeft: second.left, view: innerWidth, page: document.documentElement.scrollWidth, scrollable: track.scrollWidth > track.clientWidth };
  });
  assert.ok(geometry.scrollable && geometry.secondLeft < geometry.view && geometry.firstWidth > geometry.view * 0.8, `the next card peeks in (${JSON.stringify(geometry)})`);
  assert.ok(geometry.page <= geometry.view, "the page does not scroll sideways");
  // Swiping (the arrow buttons, the keys) moves on without calling any card action.
  await page.getByTestId("needs-deck-next").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="needs-deck-position"]')?.textContent === "2 of 5");
  await page.getByTestId("needs-deck-track").focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.querySelector('[data-testid="needs-deck-position"]')?.textContent === "3 of 5");
  await page.getByTestId("needs-deck-previous").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="needs-deck-position"]')?.textContent === "2 of 5");
  assert.deepEqual(calls, [], "looking at cards changes nothing");
  // A background refresh keeps the card the reader is on.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("control-center-changed")));
  await page.waitForTimeout(1_200);
  assert.equal(await position.innerText(), "2 of 5");
  // A tap on the card shows exactly what it needs, without opening the conversation.
  await deck.getByTestId("home-card").nth(1).locator(".ws-wait-title").click();
  const sheet = page.getByTestId("need-sheet");
  await sheet.waitFor();
  assert.match(await sheet.getByTestId("need-sheet-ask").innerText(), /Question 2: which plan\?/);
  assert.match(await sheet.getByTestId("need-sheet-request").innerText(), /Please pick a plan/);
  assert.match(await sheet.getByTestId("need-sheet-last").innerText(), /Two plans for d2/);
  assert.equal(await sheet.getByTestId("need-sheet-last").locator("li").count(), 2, "the message is rendered as markdown");
  assert.match(await sheet.getByTestId("need-sheet-steps").innerText(), /npm test/);
  assert.equal(await page.locator("body.view-chat").count(), 0, "the conversation did not open");
  // Answer works right there.
  await sheet.getByTestId("need-sheet-answer").click();
  await sheet.getByTestId("need-sheet-box").locator("textarea").fill("Go with plan B");
  await sheet.getByTestId("need-sheet-send").click();
  await sheet.waitFor({ state: "detached" });
  assert.deepEqual(answers, [{ projectId: "p1", conversationId: "d2", message: "Go with plan B" }]);
  await page.setViewportSize({ width: 1440, height: 900 });
});
