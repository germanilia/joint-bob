// What the control center's board did, now in the left column's Inbox: the system messages, a row's own menu (star and pin),
// the retention rule on Delete, Bob's own page with his updates beside his chat, and the "Ask Bob" window on his other pages.
//
// Run with `npm run test:file -- test/ui/ui-inbox-board.test.ts`.
import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture, openBobChat } from "./native-ui-fixture.js";

const card = (overrides: Record<string, unknown>) => ({
  projectId: "p1", projectName: "Joint Bob", sessionId: "c1", path: "/c1", harnessId: "claude", agentId: "claude", agentLabel: "Claude", agentModel: null, executionNodeId: null,
  turnRunning: false, backgroundRunning: false, summary: null, activity: null, autoRespondActive: false, pendingReviews: [], autoRespondStop: null, controlledBy: null, ...overrides,
});
const BOARD = {
  projects: [{ id: "p1", name: "Joint Bob", color: "violet" }, { id: "p2", name: "Billing", color: "blue" }],
  cards: [
    card({ conversationId: "c2", sessionId: "c2", title: "Mobile menu", column: "review", updatedAt: "2026-11-05T09:00:00Z", summary: "Fixed and tested." }),
    card({ projectId: "p2", projectName: "Billing", conversationId: "c3", sessionId: "c3", path: "/c3", title: "Invoice totals", column: "review", updatedAt: "2026-11-05T08:00:00Z", summary: "Rounded per line." }),
  ],
};
const SYSTEM = [
  { id: "decision-model", severity: "warn", title: "The decision model has no key", short: "Bob answers with his own agent", where: "Bob's settings", why: "Without a key Bob is slower.",
    steps: ["Attach a secret named `TYPESAFE_AI_API_KEY` to a project.", "Open Bob's settings.", "Press Check again."], action: { label: "Open Bob's settings", open: "bob-settings" } },
  { id: "guardian", severity: "warn", title: "Guardian is off", short: "Production steps are not checked", where: "Settings → Guardian", why: "An agent can deploy without asking.",
    steps: ["Open Settings → Guardian.", "Turn Guardian on."], action: { label: "Open Guardian settings", open: "settings-guardian" } },
];

type Mocked = typeof window & { __system: unknown[]; __pins: Array<{ sessionId: string }>; __deleted: string[] };

async function open(t: Parameters<typeof nativeUiFixture>[0]) {
  const { page, environment, node } = await nativeUiFixture(t);
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
    window.__system = ${JSON.stringify(SYSTEM)};
    window.__pins = []; window.__deleted = [];
    window.fetch = async (...args) => {
      const url = new URL(String(args[0]), location.href);
      const method = (args[1] && args[1].method) || 'GET';
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.pathname === '/api/control-center/board') return json(${JSON.stringify(BOARD)});
      if (url.pathname === '/api/control-center/system') return json({ messages: window.__system });
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
  await page.locator("body.view-control.bob-chat-page").waitFor();
  return page;
}

test("the system messages are one line above the Inbox that opens each of them, and they leave when their cause is gone", { timeout: 120_000 }, async (t) => {
  const page = await open(t);
  // Read again at once (the page reads them every minute, and when the board changes).
  await page.evaluate(async () => (await import("/app/inbox-system.js")).refreshSystemStrip(true));
  const line = page.getByTestId("inbox-system-line");
  await line.waitFor();
  assert.equal(await line.locator("b").textContent(), "2 things to fix");
  const places = (await page.getByTestId("workspace-places").boundingBox())!;
  const groups = (await page.getByTestId("workspace-groups").boundingBox())!;
  const box = (await line.boundingBox())!;
  assert.ok(box.y >= places.y + places.height - 1 && box.y + box.height <= groups.y + 1, "under the places, above the Inbox");

  await line.click();
  const dialog = page.getByTestId("inbox-system-dialog");
  await dialog.waitFor();
  assert.equal(await dialog.getByTestId("inbox-system-message").count(), 2);
  assert.equal(await dialog.getByTestId("control-sys-steps").first().locator("code").first().textContent(), "TYPESAFE_AI_API_KEY");
  // Still broken: Check again keeps them. One fixed: it leaves, and the line names the one left.
  await dialog.getByTestId("control-sys-check").first().click();
  await page.waitForTimeout(300);
  assert.equal(await dialog.getByTestId("inbox-system-message").count(), 2);
  await page.evaluate(() => { const mocked = window as unknown as Mocked; mocked.__system = mocked.__system.slice(1); });
  await dialog.getByTestId("control-sys-check").first().click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="inbox-system-message"]').length === 1);
  assert.equal(await line.locator("b").textContent(), "Guardian is off");
  // Its button opens the screen with the fix, and the dialog makes way.
  await dialog.getByTestId("control-sys-action").click();
  await dialog.waitFor({ state: "hidden" });
  await page.keyboard.press("Escape");
  // Everything fixed: the line goes.
  await page.evaluate(async () => {
    (window as unknown as Mocked).__system = [];
    await (await import("/app/inbox-system.js")).refreshSystemStrip(true);
  });
  await line.waitFor({ state: "detached" });
});

test("a row's own menu stars and pins it, and Delete in the Inbox leaves a starred conversation alone", { timeout: 120_000 }, async (t) => {
  const page = await open(t);
  const row = page.getByTestId("workspace-group-review").getByTestId("workspace-group-row").filter({ hasText: "Mobile menu" });
  await row.click({ button: "right" });
  await page.getByTestId("inbox-row-star").click();
  assert.deepEqual(await page.evaluate(async () => (await import("/app/state.js")).state.controlCenter.stars), ["claude:c2"]);
  await row.click({ button: "right" });
  assert.equal(await page.getByTestId("inbox-row-star").textContent(), "Unstar");
  await page.getByTestId("inbox-row-pin").click();
  await page.waitForFunction(() => (window as unknown as Mocked).__pins.length === 1);
  assert.deepEqual(await page.evaluate(() => (window as unknown as Mocked).__pins), [{ projectId: "p1", engine: "claude", sessionId: "c2" }]);

  // Pinned and starred conversations are never removed by accident: Delete skips them and says so.
  await page.getByTestId("workspace-show-all-review").click();
  await page.getByTestId("inboxPage-select").click();
  await page.getByTestId("workspace-group-page-row").filter({ hasText: "Mobile menu" }).click();
  await page.getByTestId("inboxPage-delete").click();
  await page.locator(".toast-message", { hasText: "Pinned, starred, running and other people's conversations are not deleted here." }).waitFor();
  assert.deepEqual(await page.evaluate(() => (window as unknown as Mocked).__deleted), []);
});

test("Bob's own page is his chat with his updates beside it; his other pages keep the Ask Bob button and its window", { timeout: 120_000 }, async (t) => {
  const page = await open(t);
  // His own page: the chat fills the page beside the left column, the updates beside it, no button.
  await openBobChat(page);
  assert.equal(await page.getByTestId("bob-fab-chat").isVisible(), false);
  // What Bob and the system raise is read here, beside the chat; with nothing raised there is no empty column.
  assert.equal(await page.evaluate(() => { const updates = document.querySelector("#controlChatUpdates")!; return updates.childElementCount === 0 ? updates.closest("details")!.getClientRects().length === 0 : updates.closest("details")!.getClientRects().length > 0; }), true, "the updates show beside the chat when there are any");
  // Projects fills the column on his page; pressing Bob again brings the Inbox back (its own place is not in the column).
  await page.getByTestId("workspace-projects-button").click();
  await page.locator("body.ws-column-projects").waitFor();
  await page.getByTestId("projects-open-control-center-button").click();
  await page.locator("body.ws-column-inbox.bob-chat-page").waitFor();
  const chat = (await page.getByTestId("control-chat").boundingBox())!;
  const column = (await page.getByTestId("workspace-side").boundingBox())!;
  assert.ok(chat.x >= column.x + column.width - 1, "the chat sits beside the column");

  // Another of his pages: the chat folds into the button, which can be dragged and opens a window of its own.
  await page.getByTestId("control-tab-dashboards").click();
  const fab = page.getByTestId("bob-fab-chat");
  await fab.waitFor();
  const before = (await fab.boundingBox())!;
  await page.mouse.move(before.x + 20, before.y + 20);
  await page.mouse.down();
  await page.mouse.move(before.x + 220, before.y - 120, { steps: 8 });
  await page.mouse.up();
  const moved = (await fab.boundingBox())!;
  assert.ok(Math.abs(moved.x - before.x - 200) < 4 && Math.abs(moved.y - before.y + 140) < 24, "the button follows the pointer");
  assert.equal(await page.evaluate(() => document.body.classList.contains("bob-chat-folded")), true, "a drag does not open the chat");
  await openBobChat(page);
  assert.equal(await page.getByTestId("control-chat").evaluate((node) => getComputedStyle(node).position), "fixed", "the chat floats over the page");
  assert.equal(await page.getByTestId("control-chat-updates").isVisible(), false, "the window keeps only the chat");
});

test("the column's project filter lists only the chosen projects, and the choice is kept", { timeout: 120_000 }, async (t) => {
  const page = await open(t);
  const review = page.getByTestId("workspace-group-review").getByTestId("workspace-group-row");
  await review.filter({ hasText: "Mobile menu" }).waitFor();
  await review.filter({ hasText: "Invoice totals" }).waitFor();
  await page.getByTestId("inboxColumn-projects-trigger").click();
  await page.getByTestId("inboxColumn-projects-options").locator("[role=option]", { hasText: "Billing" }).click();
  await page.keyboard.press("Escape");
  await review.filter({ hasText: "Mobile menu" }).waitFor({ state: "detached" });
  assert.equal(await review.filter({ hasText: "Invoice totals" }).count(), 1);
  assert.equal(await page.getByTestId("workspace-group-count-review").innerText(), "1 of 2", "the label says how many of all");
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("joint-bob-inbox-projects")!).length), 1, "kept in this browser");
});
