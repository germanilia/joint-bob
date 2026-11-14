import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { nativeUiFixture, openBobChat } from "./native-ui-fixture.js";

const card = (overrides: Record<string, unknown>) => ({
  projectId: "p1", projectName: "Joint Bob", sessionId: "c1", path: "/c1", harnessId: "claude", agentId: "claude", agentLabel: "Claude", agentModel: null, executionNodeId: null,
  turnRunning: false, backgroundRunning: false, summary: null, activity: null, autoRespondActive: false, pendingReviews: [], autoRespondStop: null, controlledBy: null, ...overrides,
});
const BOARD = {
  projects: [{ id: "p1", name: "Joint Bob", color: "violet" }, { id: "p2", name: "DAK Live" }],
  cards: [
    card({ conversationId: "c1", sessionId: "c1", title: "Deploy the release", column: "needs-you", updatedAt: "2026-11-05T10:00:00Z", summary: "**Goal** — Ship 2.300.\n**Current state** — Waiting on the deploy step.",
      pendingReviews: [{ id: "r1", title: "Claude wants to run a command", subject: "npm run deploy", detail: "Production step · 98%", expiresAt: "2026-11-05T10:10:00Z" }] }),
    card({ conversationId: "c2", sessionId: "c2", title: "Mobile menu", column: "running", updatedAt: "2026-11-05T09:00:00Z", turnRunning: true, summary: "Running the UI tests", activity: "Bash · npm run test:ui" }),
    card({ projectId: "p2", projectName: "DAK Live", conversationId: "c3", sessionId: "c3", title: "Review counter", column: "review", harnessId: "pi", agentId: "pi", agentLabel: "Pi", updatedAt: "2026-11-05T08:00:00Z",
      summary: "**Current state** — Fixed and tested.", reviewCheck: { verdict: "done", reason: "", by: "Decision model 94%", pushes: 0, pushPending: false, needsYou: false } }),
  ],
};
const PAST = [{
  projectId: "p1", projectName: "Joint Bob", conversationId: "c9", sessionId: "c9", path: "/c9", harnessId: "claude", agentLabel: "Claude", agentModel: null, title: "Costs dashboard timeout",
  doneAt: "2026-11-01T10:00:00Z", updatedAt: "2026-11-01T10:00:00Z", summary: "Difficulty grouping no longer scans every turn for each request.",
}];
const SYSTEM = [{
  id: "decision-model", severity: "warn", title: "The decision model has no key", short: "Bob answers with his own agent", where: "Bob's settings", why: "Without a key Bob is slower.",
  steps: ["Attach a secret named `TYPESAFE_AI_API_KEY` to a project.", "Open Bob's settings.", "Press Check again."], action: { label: "Open Bob's settings", open: "bob-settings" },
}];

type Mocked = typeof window & { __board: typeof BOARD; __system: unknown[]; __sent: unknown[]; __deleted: string[]; __pins: unknown[]; __decided?: unknown };

/** Signs in and puts a scripted board, past list, system messages and pin/delete routes in front of the node. */
async function openList(t: Parameters<typeof nativeUiFixture>[0]) {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.addInitScript(() => localStorage.setItem("jointBobLiveLayout", "list"));
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length === 3 && !document.body.classList.contains("booting"));
  await page.waitForFunction(async () => (await import("/app/state.js")).state.preferencesLoaded);
  await page.waitForTimeout(500);
  await page.evaluate(`(() => {
    const originalFetch = window.fetch;
    window.__board = ${JSON.stringify(BOARD)};
    window.__system = ${JSON.stringify(SYSTEM)};
    window.__sent = []; window.__deleted = []; window.__pins = [];
    window.fetch = async (...args) => {
      const url = new URL(String(args[0]), location.href);
      const method = (args[1] && args[1].method) || 'GET';
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.pathname === '/api/control-center/board') return json(window.__board);
      if (url.pathname === '/api/control-center/past') return json({ conversations: ${JSON.stringify(PAST)} });
      if (url.pathname === '/api/control-center/system') return json({ messages: window.__system });
      if (url.pathname === '/api/control-center/cards/detail') {
        return json({ request: 'Ship ' + url.searchParams.get('conversationId'), answer: 'The **deploy** is ready.', answerCut: false, steps: [{ name: 'Bash', target: 'npm run build', failed: false }, { name: 'Edit', target: 'package.json', failed: true }] });
      }
      if (url.pathname === '/api/control-center/cards/reply') { window.__sent.push(JSON.parse(args[1].body)); return json({ ok: true }); }
      if (url.pathname === '/api/control-center/guardian/decide') { window.__decided = JSON.parse(args[1].body); return json({ ok: true }); }
      if (url.pathname === '/api/pins' && method === 'GET') return json({ projectIds: [], conversations: window.__pins });
      if (url.pathname === '/api/pins' && method === 'PUT') {
        const change = JSON.parse(args[1].body);
        window.__pins = window.__pins.filter((pin) => pin.sessionId !== change.sessionId);
        if (change.pinned) window.__pins.push({ projectId: change.projectId, engine: change.engine, sessionId: change.sessionId });
        return json({ projectIds: [], conversations: window.__pins });
      }
      if (url.pathname === '/api/projects/p1/sessions' && method === 'DELETE') { window.__deleted.push(url.search); return json({ ok: true }); }
      return originalFetch(...args);
    };
  })()`);
  await page.getByTestId("projects-open-control-center-button").click();
  await page.getByTestId("control-tab-live").click();
  await page.getByTestId("control-list").waitFor();
  await page.getByTestId("control-sys-row").waitFor();
  return { page, environment, node };
}

/** The rows as drawn, system messages included, by their keys. */
const keys = (page: Page) => page.getByTestId("control-list-rows").locator("[data-key]").evaluateAll((nodes) => nodes.map((row) => row.getAttribute("data-key")));

test("the list: system messages first, rows by project, the panel's tabs, search, scopes, and the buttons next to each other", { timeout: 120_000 }, async (t) => {
  const { page } = await openList(t);
  assert.equal(await page.getByTestId("control-center-card").count(), 0, "the list draws no cards");

  // System messages come first, in colour, with how to fix them; the board's rows follow by project in name order.
  assert.equal(await page.getByTestId("control-sys-row").count(), 1);
  assert.equal(await page.getByTestId("control-list-rows").evaluate((rows) => (rows.firstElementChild as HTMLElement).dataset.testid), "control-sys-head");
  assert.deepEqual(await keys(page), ["system:decision-model", "p2:c3", "p1:c1", "p1:c2"]);
  assert.deepEqual(await page.getByTestId("control-list-project").evaluateAll((heads) => heads.map((head) => head.querySelector("b")!.textContent)), ["DAK Live", "Joint Bob"]);
  assert.equal(await page.locator('[data-key="p1:c1"]').getAttribute("data-column"), "needs-you");
  assert.match(await page.locator('[data-key="p1:c1"]').textContent() ?? "", /Claude wants to run a command · npm run deploy/, "the row says what it waits for");
  assert.match(await page.locator('[data-key="p1:c2"]').textContent() ?? "", /Bash · npm run test:ui/);
  assert.match(await page.getByTestId("control-list-summary").textContent() ?? "", /1 Needs you.*1 Running.*1 To review.*★ 0 finished while watching/);

  // The first conversation that needs the person opens; what it waits for is part of its Summary tab.
  const preview = page.getByTestId("control-list-preview");
  assert.match(await preview.locator("h2").textContent() ?? "", /Deploy the release/);
  const summaryTab = page.getByTestId("control-list-tab-summary");
  assert.match(await summaryTab.getByTestId("control-list-need").textContent() ?? "", /npm run deploy/);
  assert.match(await summaryTab.getByTestId("control-list-summary-text").textContent() ?? "", /Ship 2\.300/);
  assert.equal(await page.getByTestId("control-list-message").count(), 0, "the message box belongs to the Chat tab");

  // Chat and Steps are tabs of their own, and the chosen tab stays when another row is opened.
  await page.getByTestId("control-list-tab-button-chat").click();
  await page.getByTestId("control-list-thread").getByText("The deploy is ready.").waitFor();
  assert.match(await page.getByTestId("control-list-thread").textContent() ?? "", /You asked[\s\S]*Ship c1/);
  assert.equal(await page.getByTestId("control-list-message").count(), 1);
  await page.getByTestId("control-list-tab-button-steps").click();
  assert.equal(await page.getByTestId("control-list-steps").locator("li.failed").count(), 1);
  await page.locator('[data-key="p1:c2"]').click();
  assert.equal(await page.getByTestId("control-list-tab-button-steps").getAttribute("aria-selected"), "true");
  await page.getByTestId("control-list-tab-button-summary").click();

  // Open and New conversation sit in the same row and look different.
  const [openBox, newBox] = await Promise.all([page.getByTestId("control-list-open").boundingBox(), page.getByTestId("control-board-tool-new-conversation").boundingBox()]);
  assert.ok(openBox && newBox && Math.abs(openBox.y - newBox.y) < 4, "Open ↗ and + New conversation are in one row");
  assert.notEqual(await page.getByTestId("control-list-open").evaluate((node) => getComputedStyle(node).backgroundColor), await page.getByTestId("control-board-tool-new-conversation").evaluate((node) => getComputedStyle(node).backgroundColor));

  // Search: a typo still finds it, a word that is nowhere finds nothing, and searching reaches the past ones too.
  await page.getByTestId("control-list-search").fill("deplyo");
  assert.deepEqual(await keys(page), ["p1:c1"]);
  assert.match(await page.getByTestId("control-list-found").textContent() ?? "", /1 result for “deplyo”/);
  await page.getByTestId("control-list-search").fill("difficulty");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="control-list-rows"] [data-key]').length === 1);
  assert.deepEqual(await keys(page), ["p1:c9"], "the text of a past conversation is searched");
  await page.getByTestId("control-list-search").fill("kokoro");
  assert.equal(await page.getByTestId("control-list-empty").count(), 1);
  await page.getByTestId("control-list-search").press("Escape");
  assert.equal(await page.getByTestId("control-list-search").inputValue(), "");
  assert.deepEqual(await keys(page), ["system:decision-model", "p2:c3", "p1:c1", "p1:c2"], "clearing the search goes back to the inbox");

  // Scopes and grouping by date.
  await page.getByTestId("control-list-scope-past").click();
  assert.deepEqual(await keys(page), ["system:decision-model", "p1:c9"]);
  assert.equal(await page.locator('[data-key="p1:c9"]').getAttribute("data-column"), "done");
  await page.getByTestId("control-list-scope-all").click();
  await page.getByTestId("control-list-group-date").click();
  assert.deepEqual(await keys(page), ["system:decision-model", "p1:c1", "p1:c2", "p2:c3", "p1:c9"], "by date, the newest first");
  assert.ok(await page.getByTestId("control-list-day").count() >= 1);
  await page.getByTestId("control-list-group-project").click();
  await page.getByTestId("control-list-scope-inbox").click();

  // Arrow keys move through the rows.
  await page.locator('[data-key="p1:c2"]').focus();
  await page.keyboard.press("ArrowUp");
  assert.equal(await page.locator('[data-key="p1:c1"]').evaluate((row) => row.classList.contains("selected")), true);

  // The switch brings the cards back, and back again.
  await page.getByTestId("control-layout-cards").click();
  await page.getByTestId("control-center-card").first().waitFor();
  assert.equal(await page.getByTestId("control-list").count(), 0);
  await page.getByTestId("control-layout-list").click();
  await page.getByTestId("control-list").waitFor();
});

test("a system message says how to fix it and leaves when its cause is gone", { timeout: 90_000 }, async (t) => {
  const { page } = await openList(t);
  await page.locator('[data-key="system:decision-model"]').click();
  const panel = page.getByTestId("control-list-preview");
  assert.equal(await panel.getAttribute("data-kind"), "system");
  assert.equal(await panel.getByTestId("control-sys-steps").locator("li").count(), 3);
  assert.equal(await panel.getByTestId("control-sys-steps").locator("code").first().textContent(), "TYPESAFE_AI_API_KEY");
  assert.equal(await page.getByTestId("control-list-open").isHidden(), true, "a system message has nothing to open");
  assert.ok(await page.getByTestId("control-sys-action").isVisible());
  // Still broken: Check again keeps it. Fixed: it leaves by itself and the first conversation opens.
  await page.getByTestId("control-sys-check").click();
  await page.waitForTimeout(300);
  assert.equal(await page.getByTestId("control-sys-row").count(), 1);
  await page.evaluate(() => { (window as unknown as Mocked).__system = []; });
  await page.getByTestId("control-sys-check").click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="control-sys-row"]').length === 0);
  assert.match(await page.getByTestId("control-list-preview").locator("h2").textContent() ?? "", /Deploy the release/);
});

test("pin, star, folders and delete: kept conversations are marked, deleting is undoable, and a kept one asks twice", { timeout: 120_000 }, async (t) => {
  const { page } = await openList(t);
  const tool = (name: string) => page.getByTestId("control-list-preview").getByTestId(`control-list-${name}`);

  await page.locator('[data-key="p1:c2"]').click();
  // Star: kept with the account, marked "Kept", counted by the star scope.
  await tool("star").click();
  await page.getByTestId("control-list-kept").waitFor();
  assert.deepEqual(await page.evaluate(async () => (await import("/app/state.js")).state.controlCenter.stars), ["claude:c2"]);
  assert.match(await page.getByTestId("control-list-scope-starred").textContent() ?? "", /1/);
  // Pin: it moves to a Pinned group at the top, with the pin saved through the account's pin route.
  await tool("pin").click();
  await page.getByTestId("control-list-pinned-head").waitFor();
  assert.deepEqual(await keys(page), ["system:decision-model", "p1:c2", "p2:c3", "p1:c1"]);
  assert.deepEqual(await page.evaluate(() => (window as unknown as Mocked).__pins), [{ projectId: "p1", engine: "claude", sessionId: "c2" }]);
  // Folder: a new name puts it in a folder, which then filters the list.
  await tool("folder").click();
  await page.getByTestId("control-pop-input").fill("Releases");
  await page.getByTestId("control-pop-input").press("Enter");
  assert.match(await page.locator('[data-key="p1:c2"] .control-list-folder').textContent() ?? "", /Releases/);
  await page.getByTestId("control-list-scope-folder").click();
  await page.getByTestId("control-pop-choice").filter({ hasText: "Releases" }).click();
  assert.deepEqual(await keys(page), ["system:decision-model", "p1:c2"]);
  await page.getByTestId("control-list-scope-inbox").click();

  // Delete: the row goes at once; Undo brings it back; otherwise the conversation is deleted when the Undo runs out.
  await page.locator('[data-key="p2:c3"]').click();
  await tool("delete").click();
  assert.deepEqual(await keys(page), ["system:decision-model", "p1:c2", "p1:c1"]);
  await page.getByTestId("control-list-undo").click();
  assert.deepEqual(await keys(page), ["system:decision-model", "p1:c2", "p2:c3", "p1:c1"]);
  assert.deepEqual(await page.evaluate(() => (window as unknown as Mocked).__deleted), []);
  await page.locator('[data-key="p1:c1"]').click();
  await tool("delete").click();
  await page.waitForFunction(() => (window as unknown as Mocked).__deleted.length === 1, undefined, { timeout: 15_000 });
  assert.match((await page.evaluate(() => (window as unknown as Mocked).__deleted))[0]!, /sessionId=c1&engine=claude/);

  // A kept conversation is not deleted by one press: it says so and waits for a second.
  await page.locator('[data-key="p1:c2"]').click();
  await tool("delete").click();
  assert.match(await page.locator(".toast-message").last().textContent() ?? "", /“Mobile menu” is pinned\. Press delete again/);
  assert.equal(await page.getByTestId("control-list-undo").count(), 0);
  assert.ok((await keys(page)).includes("p1:c2"));
});

test("Ask Bob can be dragged, and Bob's chat opens as a window of its own", { timeout: 90_000 }, async (t) => {
  const { page } = await openList(t);
  const fab = page.getByTestId("bob-fab-chat");
  const before = await fab.boundingBox();
  assert.ok(before);
  await page.mouse.move(before.x + 20, before.y + 20);
  await page.mouse.down();
  await page.mouse.move(before.x + 220, before.y - 120, { steps: 8 });
  await page.mouse.up();
  const moved = await fab.boundingBox();
  assert.ok(moved && Math.abs(moved.x - before.x - 200) < 4 && Math.abs(moved.y - before.y + 140) < 24, "the button follows the pointer");
  assert.equal(await page.evaluate(() => document.body.classList.contains("bob-chat-folded")), true, "a drag does not open the chat");
  assert.ok(await page.evaluate(() => localStorage.getItem("jointBobFabPos")), "where it was left is kept");

  await openBobChat(page);
  const chat = page.getByTestId("control-chat");
  assert.equal(await chat.evaluate((node) => getComputedStyle(node).position), "fixed", "the chat floats over the page");
  const opened = await chat.boundingBox();
  assert.ok(opened && opened.width >= 340);
  // Its head moves it; the window stays inside the page.
  await page.mouse.move(opened.x + 120, opened.y + 20);
  await page.mouse.down();
  await page.mouse.move(opened.x + 20, opened.y + 90, { steps: 6 });
  await page.mouse.up();
  const dragged = await chat.boundingBox();
  assert.ok(dragged && dragged.x < opened.x - 50 && dragged.y > opened.y + 40);
  assert.ok(await page.evaluate(() => localStorage.getItem("jointBobChatBox")), "its place is kept");
});
