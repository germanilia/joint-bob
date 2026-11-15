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

type Mocked = typeof window & { __board: typeof BOARD; __system: unknown[]; __sent: unknown[]; __deleted: string[]; __pins: unknown[]; __decided?: unknown; __past?: unknown[] };

/** Signs in and puts a scripted board, past list, system messages and pin/delete routes in front of the node. */
async function openList(t: Parameters<typeof nativeUiFixture>[0], past: unknown[] = PAST) {
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
      if (url.pathname === '/api/control-center/past') return json({ conversations: window.__past ?? ${JSON.stringify(past)} });
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
  // On Bob's page the tab is the conversation's own chat (its queued messages, controls and image paste come with it), laid over the tab's body; the plain thread and box are for narrow screens.
  await page.locator("body.control-inline").waitFor();
  assert.equal(await page.getByTestId("control-list-thread").count(), 0);
  assert.equal(await page.getByTestId("control-list-message").count(), 0);
  const anchor = await page.getByTestId("control-list-tab-chat").boundingBox();
  const frame = await page.evaluate(() => ["x", "y", "w", "h"].map((name) => document.body.style.getPropertyValue(`--bob-pop-${name}`)));
  assert.ok(anchor && frame.join() === [anchor.x, anchor.y, anchor.width, anchor.height].map((value) => `${Math.round(value)}px`).join(), "the chat is placed on the tab's body");
  // The chat's side panel keeps its buttons; the summary and the steps are the list's own tabs, so they are not shown twice.
  assert.equal(await page.evaluate(() => ["activitySummary", "activityStepsToggle"].some((id) => getComputedStyle(document.getElementById(id)!).display !== "none")), false);
  // A browser opened from the chat takes the right half of the page: one column, not a window floating over a halved page.
  await page.evaluate(async () => { (await import("/app/browser-panel.js" as string)).claimBrowserPanel(() => {}); });
  const halves = await page.evaluate(() => {
    const browser = document.getElementById("browserPanel")!;
    const [browserBox, pageBox] = [browser, document.getElementById("controlCenterPanel")!].map((node) => node.getBoundingClientRect().toJSON());
    return { position: getComputedStyle(browser).position, browser: browserBox, page: pageBox, width: innerWidth };
  });
  assert.equal(halves.position, "static");
  assert.ok(halves.browser.left >= halves.page.right && halves.width - halves.browser.right < 40, `the browser fills the column right of the page: ${JSON.stringify(halves)}`);
  assert.ok(Math.abs(halves.browser.top - halves.page.top) < 2 && Math.abs(halves.browser.bottom - halves.page.bottom) < 2, "and has the page's height");
  // The head keeps its way out on half a page.
  assert.ok(await page.locator("#controlCenterPanel > .panel-bar button", { hasText: "Exit" }).isVisible());
  await page.waitForFunction(() => { const chat = document.getElementById("chatPanel")!.getBoundingClientRect(); return chat.right <= document.getElementById("browserPanel")!.getBoundingClientRect().left; });
  assert.equal(await page.getByTestId("activity-panel").isVisible(), false, "the side panel folds while the browser shares the row");
  await page.evaluate(async () => { (await import("/app/browser-panel.js" as string)).releaseBrowserPanel(); });
  await page.getByTestId("control-list-tab-button-steps").click();
  assert.equal(await page.evaluate(() => document.body.classList.contains("control-inline")), false, "other tabs leave the chat");
  assert.equal(await page.getByTestId("control-list-steps").locator("li.failed").count(), 1);
  await page.locator('[data-key="p1:c2"]').click();
  assert.equal(await page.getByTestId("control-list-tab-button-steps").getAttribute("aria-selected"), "true");
  await page.getByTestId("control-list-tab-button-summary").click();

  // Terminal, Git, Folders and Story are one press away, under the title.
  assert.deepEqual(await page.getByTestId("control-list-tools").locator("button").evaluateAll((nodes) => nodes.map((node) => node.textContent)), ["Terminal", "Git", "Folders", "Story"]);

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

// A conversation that was reviewed and not marked done is on no lane of the board: the Inbox still lists it, and the search finds it.
test("an open conversation that was reviewed stays in the Inbox and is found by the search", { timeout: 90_000 }, async (t) => {
  const reviewed = { ...PAST[0], conversationId: "c7", sessionId: "c7", path: "/c7", title: "Tenant 16", doneAt: null, updatedAt: "2026-11-04T10:00:00Z", executionNodeId: null, summary: "Summary verification fixed." };
  const { page } = await openList(t, [...PAST, reviewed]);
  await page.locator('[data-key="p1:c7"]').waitFor();
  assert.deepEqual(await keys(page), ["system:decision-model", "p2:c3", "p1:c1", "p1:c2", "p1:c7"], "after what runs or waits in its project, and without the done one");
  assert.equal(await page.locator('[data-key="p1:c7"]').getAttribute("data-column"), "reviewed");
  assert.match(await page.locator('[data-key="p1:c7"]').textContent() ?? "", /Reviewed/);
  await page.getByTestId("control-list-search").fill("tenant16");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="control-list-rows"] [data-key]').length === 1);
  assert.deepEqual(await keys(page), ["p1:c7"]);
  await page.getByTestId("control-list-search").press("Escape");
  await page.getByTestId("control-list-scope-past").click();
  assert.deepEqual(await keys(page), ["system:decision-model", "p1:c9"], "Past holds only what was marked done");
  // Its panel is an open conversation's: the state, and Done to close it.
  await page.getByTestId("control-list-scope-inbox").click();
  await page.locator('[data-key="p1:c7"]').click();
  assert.equal(await page.getByTestId("control-list-preview").getByTestId("control-list-state").textContent(), "Reviewed");
});

// Reviewed while it is chosen, a conversation leaves the board and comes back as Reviewed a moment later: the panel stays on it.
test("the chosen conversation stays chosen when it is reviewed and leaves the board", { timeout: 90_000 }, async (t) => {
  const { page } = await openList(t);
  await page.locator('[data-key="p2:c3"]').click();
  assert.match(await page.getByTestId("control-list-preview").locator("h2").textContent() ?? "", /Review counter/);
  await page.evaluate(async (pastNow) => {
    const mocked = window as Mocked;
    const [left] = mocked.__board.cards.splice(2, 1);
    mocked.__past = [...pastNow, { ...left, doneAt: null }];
    await (await import("/app/control-center.js" as string)).refreshControlCenter();
  }, PAST);
  await page.locator('[data-key="p2:c3"][data-column="reviewed"]').waitFor();
  assert.match(await page.locator('[data-key="p2:c3"]').getAttribute("class") ?? "", /selected/);
  assert.match(await page.getByTestId("control-list-preview").locator("h2").textContent() ?? "", /Review counter/, "the panel did not jump to the conversation that needs you");
});

// The Chat tab only shows the conversation: one that waits for review stays "To review" (reviewed, it would leave the board under the reader).
test("reading a conversation in the Chat tab does not mark it reviewed; opening it does", { timeout: 90_000 }, async (t) => {
  const { page } = await openList(t);
  // A real conversation of a project that is not open yet: the Chat tab opens its project, then it.
  const waiting = await page.evaluate(async () => {
    const { state } = await import("/app/state.js" as string);
    const { api } = await import("/app/api.js" as string);
    for (const project of state.projects) {
      const session = (await api(`/api/projects/${encodeURIComponent(project.id)}/sessions`)).sessions.find((candidate: { running?: boolean; updatedAt?: string }) => !candidate.running && candidate.updatedAt);
      if (session) return { projectId: project.id as string, id: session.id as string, conversationId: (session.conversationId ?? session.id) as string, path: session.path as string, harnessId: session.harnessId as string };
    }
    throw new Error("the fixture has no conversation");
  });
  const marked: string[] = [];
  await page.route(`**/api/projects/${waiting.projectId}/sessions`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const session of body.sessions) if (session.path === waiting.path) session.reviewState = "needs_review";
    await route.fulfill({ response, json: body });
  });
  await page.route(`**/api/projects/${waiting.projectId}/sessions/reviewed`, async (route) => { marked.push(route.request().postData() ?? ""); await route.fulfill({ json: { ok: true } }); });
  await page.evaluate(async (target) => {
    const mocked = window as Mocked;
    mocked.__board.cards.push({ ...mocked.__board.cards[2], projectId: target.projectId, conversationId: target.conversationId, sessionId: target.id, path: target.path, harnessId: target.harnessId, title: "Waits for review" });
    await (await import("/app/control-center.js" as string)).refreshControlCenter();
  }, waiting);
  const row = page.locator(`[data-key="${waiting.projectId}:${waiting.conversationId}"]`);
  await row.click();
  await page.getByTestId("control-list-tab-button-chat").click();
  await page.locator("body.control-inline.control-popup").waitFor();
  await page.waitForFunction(async (id) => (await import("/app/state.js" as string)).state.activeSessionId === id, waiting.id);
  await page.waitForTimeout(1_000);
  assert.deepEqual(marked, [], "looking at it in the list does not mark it reviewed");
  assert.match(await row.getAttribute("class") ?? "", /selected/);

  await page.getByTestId("control-list-open").click();
  for (let waited = 0; !marked.length && waited < 50; waited += 1) await page.waitForTimeout(100);
  assert.equal(marked.length, 1, "opened for real, it is reviewed as before");
  // Opening reloads the project's conversations: a routed request still in flight must not fail the test when the page closes.
  await page.unrouteAll({ behavior: "ignoreErrors" });
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
