// What the control center's board did, now in the left column's Inbox: the system messages, a row's own menu (star and pin),
// the retention rule on Delete, Bob's own page with his updates beside his chat, and the "Ask Bob" window on his other pages.
//
// Run with `npm run test:file -- test/ui/ui-inbox-board.test.ts`.
import assert from "node:assert/strict";
import path from "node:path";
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

type Mocked = typeof window & { __older: unknown[]; __askedAll: boolean; __holdDelete: boolean; __system: unknown[]; __pins: Array<{ sessionId: string }>; __deleted: string[]; __releaseDelete: () => void; __deleteStatus: number };

async function open(t: Parameters<typeof nativeUiFixture>[0], extraEnv?: Parameters<typeof nativeUiFixture>[1]) {
  const { page, environment, node } = await nativeUiFixture(t, extraEnv);
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
    window.__pins = []; window.__deleted = []; window.__deleteStatus = 200; window.__releaseDelete = () => {}; window.__holdDelete = false; window.__older = []; window.__askedAll = false;
    window.fetch = async (...args) => {
      const url = new URL(String(args[0]), location.href);
      const method = (args[1] && args[1].method) || 'GET';
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.pathname === '/api/control-center/board') { const board = ${JSON.stringify(BOARD)}; return json({ ...board, cards: board.cards.filter((card) => !window.__deleted.some((search) => search.includes('sessionId=' + card.sessionId + '&'))) }); }
      if (url.pathname === '/api/control-center/system') return json({ messages: window.__system });
      if (url.pathname === '/api/pins' && method === 'GET') return json({ projectIds: [], conversations: window.__pins });
      if (url.pathname === '/api/pins' && method === 'PUT') {
        const change = JSON.parse(args[1].body);
        window.__pins = window.__pins.filter((pin) => pin.sessionId !== change.sessionId);
        if (change.pinned) window.__pins.push({ projectId: change.projectId, engine: change.engine, sessionId: change.sessionId });
        return json({ projectIds: [], conversations: window.__pins });
      }
      if (url.pathname === '/api/projects/p1/sessions' && method === 'GET' && url.searchParams.get('all') === '1') { window.__askedAll = true; return json({ sessions: window.__older }); }
      if (['/api/projects/p1/sessions', '/api/projects/p2/sessions'].includes(url.pathname) && method === 'DELETE') {
        if (window.__holdDelete) await new Promise((resolve) => { window.__releaseDelete = resolve; });
        window.__deleted.push(url.search);
        if (window.__deleteStatus === 404) return new Response(JSON.stringify({ error: 'Session not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
        return json({ ok: true });
      }
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

test("Delete from a row's menu takes the row out at once, opens nothing, and says nothing of a conversation that is already gone", { timeout: 120_000 }, async (t) => {
  const page = await open(t);
  const group = page.getByTestId("workspace-group-review");
  const mobile = group.getByTestId("workspace-group-row").filter({ hasText: "Mobile menu" });
  const invoice = group.getByTestId("workspace-group-row").filter({ hasText: "Invoice totals" });
  await mobile.waitFor();
  // The server is slow: the row goes before it answers, and the person is not taken into the conversation.
  await page.evaluate(() => { (window as unknown as Mocked).__holdDelete = true; });
  await mobile.click({ button: "right" });
  await page.getByTestId("inbox-row-delete").click();
  await page.locator("#confirmDialog").getByRole("button", { name: "Delete conversation" }).click();
  await mobile.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.body.classList.contains("control-popup")), false, "nothing was opened");
  assert.ok(await page.locator("body.view-control").count(), "the view did not change");
  assert.deepEqual(await page.evaluate(() => (window as unknown as Mocked).__deleted), [], "the server has not answered yet");
  await page.evaluate(() => { const mocked = window as unknown as Mocked; mocked.__holdDelete = false; mocked.__releaseDelete(); });
  await page.waitForFunction(() => (window as unknown as Mocked).__deleted.length === 1);
  await invoice.waitFor();
  assert.equal(await mobile.count(), 0, "it stays gone once the server has deleted it");

  // Already deleted by a cleanup: the server says not found, and that is what was asked for.
  await page.evaluate(() => { (window as unknown as Mocked).__deleteStatus = 404; });
  await invoice.click({ button: "right" });
  await page.getByTestId("inbox-row-delete").click();
  await page.locator("#confirmDialog").getByRole("button", { name: "Delete conversation" }).click();
  await invoice.waitFor({ state: "detached" });
  await page.waitForTimeout(1500);
  assert.equal(await page.locator(".toast.error, .toast-message", { hasText: "not found" }).count(), 0, "no error was shown");
});

test("a conversation the project does not list is not shown in the Inbox once it is found out", { timeout: 120_000 }, async (t) => {
  const page = await open(t);
  const row = page.getByTestId("workspace-group-review").getByTestId("workspace-group-row").filter({ hasText: "Mobile menu" });
  // The project is already chosen and its list is read: nothing is on its way that could still list the conversation.
  await page.evaluate(async () => { (await import("/app/state.js")).state.activeProjectId = "p1"; });
  await row.click();
  await row.waitFor({ state: "detached" });
  // It stays away when the board is read again.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("conversations-removed")));
  await page.waitForTimeout(2000);
  assert.equal(await row.count(), 0);
});

test("a conversation past the newest ones is opened from the full list, not hidden", { timeout: 120_000 }, async (t) => {
  const page = await open(t);
  const row = page.getByTestId("workspace-group-review").getByTestId("workspace-group-row").filter({ hasText: "Mobile menu" });
  await page.evaluate(async () => {
    const mocked = window as unknown as Mocked;
    mocked.__older = [{ id: "c2", conversationId: "c2", path: "/c2", title: "Mobile menu", harnessId: "claude", executionNodeId: null }];
    (await import("/app/state.js")).state.activeProjectId = "p1";
  });
  await row.click();
  await page.waitForFunction(() => (window as unknown as Mocked).__askedAll);
  await page.waitForTimeout(1500);
  assert.equal(await row.count(), 1, "the row stays");
  assert.equal(await page.getByText("That conversation is no longer listed.").count(), 0);
});

test("Ctrl+Alt+N opens New with a project selector from the full Inbox list", { timeout: 120_000 }, async (t) => {
  const page = await open(t, (root) => ({ JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "turns.jsonl") }));
  await page.getByTestId("workspace-show-all-review").click();
  await page.keyboard.press("Control+Alt+KeyN");
  const dialog = page.getByTestId("new-session-name-dialog");
  await dialog.waitFor({ timeout: 5000 });
  const project = dialog.getByRole("button", { name: "Project" });
  await project.click();
  await dialog.getByTestId("new-session-project-option").filter({ hasText: "Joint Bob" }).click();
  assert.match(await project.innerText(), /Joint Bob/);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.getByTestId("inboxPage-search").waitFor();
});

test("Quick Reply shows the last four messages and sends without leaving the Inbox", { timeout: 120_000 }, async (t) => {
  const page = await open(t);
  const samples = ["First answer", "Follow-up question", "Second answer", "One more question"];
  const replies: unknown[] = [];
  await page.route("**/api/control-center/cards/detail?*", (route) => route.fulfill({ json: {
    // Long answers, as real ones are: the history must scroll inside the dialog, not squeeze to nothing.
    recentMessages: samples.map((text, index) => ({ text: `${text}\n\n${Array.from({ length: 12 }, (_, line) => `Line ${line} of ${text}.`).join("\n\n")}`, role: index % 2 ? "user" : "assistant" })),
  } }));
  await page.route("**/api/control-center/cards/reply", (route) => {
    replies.push(route.request().postDataJSON());
    return replies.length === 1
      ? route.fulfill({ status: 409, json: { error: "The conversation is busy." } })
      : route.fulfill({ json: { ok: true } });
  });
  await page.getByTestId("workspace-show-all-review").click();
  const search = page.getByTestId("inboxPage-search");
  await search.fill("Mobile menu");
  const quickReply = page.getByRole("button", { name: "Quick reply to Mobile menu" });
  await quickReply.click({ timeout: 5000 });
  const dialog = page.getByRole("dialog", { name: "Mobile menu" });
  const input = dialog.getByRole("textbox", { name: "Reply" });
  assert.equal(await input.evaluate((element) => document.activeElement === element), true);
  await dialog.getByText(samples.at(-1)!, { exact: true }).waitFor();
  // The messages have room to be read: the history is not squeezed to a sliver between the title and the box.
  assert.ok((await dialog.getByRole("region", { name: "Recent messages" }).boundingBox())!.height >= 120, "the history is tall enough to read");
  assert.deepEqual((await dialog.getByTestId("inbox-reply-message").locator(".inbox-reply-text").allTextContents()).map((text) => samples.find((sample) => text.startsWith(sample))), samples);
  await input.fill("Please check the tablet layout too.");
  const send = dialog.getByRole("button", { name: "Send reply" });
  await send.click();
  await dialog.getByRole("alert").filter({ hasText: "The conversation is busy." }).waitFor();
  assert.equal(await input.inputValue(), "Please check the tablet layout too.");
  await send.click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(replies, Array(2).fill({ projectId: "p1", conversationId: "c2", message: "Please check the tablet layout too." }));
  assert.equal(await search.inputValue(), "Mobile menu");
  assert.equal(await quickReply.isVisible(), true);
  assert.equal(await page.locator("body.control-popup").count(), 0);

  await quickReply.click();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await quickReply.evaluate((element) => document.activeElement === element), true);
  await quickReply.click();
  await page.evaluate(() => window.addEventListener("control-popup-opened", (event) => {
    document.body.dataset.openedCard = (event as CustomEvent).detail.conversationId;
  }, { once: true }));
  await dialog.getByRole("button", { name: "Open", exact: true }).click();
  await search.waitFor({ state: "hidden" });
  await page.locator('body[data-opened-card="c2"]').waitFor();
});

test("Bob's chat stays accessible from the column without a floating button", { timeout: 120_000 }, async (t) => {
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

  for (const view of ["dashboards", "my-dashboard", "assistants"]) {
    await page.getByTestId(`control-tab-${view}`).click();
    await page.locator(`#controlView-${view}`).waitFor({ state: "visible" });
    assert.equal(await page.getByTestId("bob-fab-chat").count(), 0, "no floating button on other pages");
    assert.notEqual(await page.locator(".control-stage").evaluate((node) => getComputedStyle(node).paddingBottom), "80px", "no space reserved for the removed button");
  }
  await page.getByTestId("projects-open-control-center-button").click();
  await page.locator("body.bob-chat-page").waitFor();
  assert.equal(await page.getByTestId("control-chat-input").isVisible(), true);
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
