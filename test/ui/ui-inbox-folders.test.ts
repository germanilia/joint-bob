// The Inbox lists every conversation and groups it by state, by project or by folder: Scheduled and Done are groups of their own,
// a row carries its tags and a menu button, and folders (with subfolders) file conversations the way a mailbox does.
//
// Run with `npm run test:file -- test/ui/ui-inbox-folders.test.ts`.
import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

type Mocked = typeof window & { __saved: Array<Record<string, unknown>> };

const base = {
  harnessId: "claude", agentId: "claude", agentLabel: "Claude", agentModel: null, executionNodeId: null, turnRunning: false, backgroundRunning: false,
  summary: null, activity: null, autoRespondActive: false, pendingReviews: [], autoRespondStop: null, controlledBy: null, worktree: null,
  pinEngine: "claude", parentPath: null, classification: null,
};

function boardFor(projects: Array<{ id: string; name: string }>, withTools = false) {
  const [first, second] = projects;
  const board = (id: string, project: { id: string; name: string }, title: string, column: string, updatedAt: string, extra: Record<string, unknown> = {}) =>
    ({ ...base, projectId: project.id, projectName: project.name, conversationId: id, sessionId: id, path: `/${id}`, title, column, updatedAt, ...extra });
  const earlier = (id: string, project: { id: string; name: string }, title: string, updatedAt: string, extra: Record<string, unknown> = {}) =>
    ({ projectId: project.id, projectName: project.name, conversationId: id, sessionId: id, path: `/${id}`, harnessId: "claude", agentLabel: "Claude", agentModel: null, title, updatedAt,
      done: false, executionNodeId: null, scheduled: false, readOnly: false, fresh: false, worktree: null, pinEngine: "claude", parentPath: null, classification: null, ...extra });
  const result = {
    projects: projects.map((project) => ({ ...project, color: "violet" })),
    cards: [
      board("n1", first, "Answer the deploy question", "needs-you", "2026-11-18T10:00:00Z"),
      board("r1", first, "Running the migration", "running", "2026-11-18T09:00:00Z", { turnRunning: true, autoRespondActive: true, worktree: { id: "w1", name: "unify", color: "#f0b45a" } }),
      board("v1", second, "Review the invoice fix", "review", "2026-11-18T08:00:00Z"),
    ],
    earlier: [
      earlier("s1", first, "Hourly deploy check", "2026-11-18T07:00:00Z", { scheduled: true }),
      earlier("e1", first, "Old design notes", "2026-11-17T07:00:00Z"),
      earlier("e2", second, "Read-only copy from Matan", "2026-11-16T07:00:00Z", { readOnly: true }),
      earlier("e3", second, "New conversation", "2026-11-18T06:00:00Z", { fresh: true }),
      earlier("d1", first, "Shipped release", "2026-11-15T07:00:00Z", { done: true }),
    ],
  };
  if (withTools) {
    // A sub-agent under the running conversation, and labels, for the tools below.
    result.cards.push(board("r2", first, "Sub-agent: check the schema", "running", "2026-11-18T09:30:00Z", { turnRunning: true, parentPath: "/r1" }));
    result.earlier[1] = earlier("e1", first, "Old design notes", "2026-11-17T07:00:00Z", { classification: "research" });
  }
  return result;
}

async function open(t: Parameters<typeof nativeUiFixture>[0], withTools = false) {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length === 3 && !document.body.classList.contains("booting"));
  await page.waitForFunction(async () => (await import("/app/state.js")).state.preferencesLoaded);
  const projects = await page.evaluate(async () => (await import("/app/state.js")).state.projects.slice(0, 2).map((project: { id: string; name: string }) => ({ id: project.id, name: project.name })));
  await page.evaluate(`(() => {
    const originalFetch = window.fetch;
    window.__saved = [];
    window.fetch = async (...args) => {
      const url = new URL(String(args[0]), location.href);
      const method = (args[1] && args[1].method) || 'GET';
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.pathname === '/api/control-center/board') return json(${JSON.stringify(boardFor(projects, withTools))});
      if (url.pathname === '/api/preferences' && method === 'PUT') window.__saved.push(JSON.parse(args[1].body));
      return originalFetch(...args);
    };
  })()`);
  await page.evaluate(() => { localStorage.removeItem("joint-bob-inbox-mode"); localStorage.removeItem("joint-bob-inbox-open-folders"); });
  await page.getByTestId("workspace-inbox-button").click();
  await page.getByTestId("workspace-group-needs-you").waitFor();
  await page.evaluate(async () => (await import("/app/workspace.js")).scheduleGroupsRefresh(0));
  await page.getByTestId("workspace-group-scheduled").getByTestId("workspace-group-row").first().waitFor();
  return { page, projects };
}

test("every conversation is listed: scheduled runs and done ones are groups, and a row says what it is", { timeout: 120_000 }, async (t) => {
  const { page } = await open(t);
  const titles = async (group: string) => (await page.getByTestId(`workspace-group-${group}`).getByTestId("workspace-group-row").locator("b").allTextContents()).map((text) => text.replace(/^[^A-Za-z]+/, ""));
  assert.deepEqual(await titles("needs-you"), ["Answer the deploy question"]);
  assert.deepEqual(await titles("running"), ["Running the migration"]);
  assert.deepEqual(await titles("scheduled"), ["Hourly deploy check"]);
  assert.deepEqual((await titles("earlier")).sort(), ["New conversation", "Old design notes", "Read-only copy from Matan"]);
  assert.deepEqual(await titles("done"), ["Shipped release"]);
  const running = page.getByTestId("workspace-group-running").getByTestId("workspace-group-row");
  assert.equal(await running.getByTestId("inbox-row-tag-worktree").textContent(), "unify");
  assert.equal(await running.getByTestId("inbox-row-tag-auto").textContent(), "Auto");
  const earlier = page.getByTestId("workspace-group-earlier").getByTestId("workspace-group-row");
  assert.equal(await earlier.filter({ hasText: "Read-only copy" }).getByTestId("inbox-row-tag-readonly").count(), 1);
  assert.equal(await earlier.filter({ hasText: "New conversation" }).getByTestId("inbox-row-tag-new").count(), 1);
  // A row's menu is one press away, and carries what the project's own list offered.
  await running.hover();
  await running.getByTestId("inbox-row-menu").click();
  for (const id of ["inbox-row-folder", "inbox-row-star", "inbox-row-pin", "inbox-row-done", "inbox-row-rename", "inbox-row-fork", "inbox-row-transfer", "inbox-row-delete"]) {
    assert.equal(await page.getByTestId(id).count(), 1, `${id} is in the row menu`);
  }
});

test("by project: a section per project with its counts, and the project's own menu", { timeout: 120_000 }, async (t) => {
  const { page, projects } = await open(t);
  await page.getByTestId("workspace-mode-project").click();
  const sections = page.getByTestId("workspace-project");
  await sections.first().waitFor();
  assert.equal(await sections.count(), 2);
  const first = sections.filter({ has: page.locator(`[data-project="${projects[0].id}"]`) }).or(page.locator(`[data-project="${projects[0].id}"]`));
  const rows = await page.locator(`[data-project="${projects[0].id}"] [data-testid="workspace-group-row"] b`).allTextContents();
  assert.ok(rows.length >= 5, "the first project lists its conversations, most urgent first");
  assert.match(rows[0], /Answer the deploy question/, "what needs you comes first");
  assert.match(rows[1], /Running the migration/);
  assert.equal(await first.getByTestId("workspace-project-name").first().textContent(), projects[0].name);
  await page.locator(`[data-project="${projects[0].id}"]`).getByTestId("workspace-project-menu").click();
  for (const label of ["Open the project's page", "Git repositories", "GitHub issues", "Automations", "Skills & tools", "Edit project", "Secret accounts"]) {
    assert.equal(await page.locator("#rowMenu button", { hasText: label }).count() > 0, true, `${label} is in the project menu`);
  }
  await page.keyboard.press("Escape");
  // Show all lists every one of its conversations in the middle.
  await page.getByTestId("workspace-project-name").first().click();
  await page.getByTestId("workspace-group-page").waitFor();
  assert.ok(await page.getByTestId("workspace-listing-page-row").count() >= 5);
});

test("by folder: folders and subfolders, filing by menu and by drag, and filing never hides what needs you", { timeout: 180_000 }, async (t) => {
  const { page } = await open(t);
  await page.getByTestId("workspace-mode-folder").click();
  await page.getByTestId("workspace-folder-new").waitFor();
  // A folder, then a subfolder in it.
  await page.getByTestId("workspace-folder-new").click();
  await page.getByTestId("control-pop-input").fill("Clients");
  await page.keyboard.press("Enter");
  await page.locator('[data-testid="workspace-folder"][data-path="Clients"]').waitFor();
  await page.locator('[data-testid="workspace-folder"][data-path="Clients"]').getByTestId("workspace-folder-menu").click();
  await page.getByTestId("control-pop-input").first().fill("Contigos");
  await page.keyboard.press("Enter");
  await page.locator('[data-testid="workspace-folder"][data-path="Clients/Contigos"]').waitFor();
  assert.deepEqual(await page.evaluate(async () => (await import("/app/state.js")).state.controlCenter.folderList), ["Clients", "Clients/Contigos"]);
  // The empty folders were saved with the preferences.
  await page.waitForFunction(() => (window as unknown as Mocked).__saved.some((saved) => JSON.stringify(saved).includes("Clients/Contigos")), undefined, { timeout: 20_000 });

  // File a conversation from its menu: it is in the folder and out of Earlier.
  await page.getByTestId("workspace-mode-state").click();
  const earlierRow = page.getByTestId("workspace-group-earlier").getByTestId("workspace-group-row").filter({ hasText: "Old design notes" });
  await earlierRow.hover();
  await earlierRow.getByTestId("inbox-row-menu").click();
  await page.getByTestId("inbox-row-folder").click();
  await page.getByTestId("control-pop-choice").filter({ hasText: "Contigos" }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="workspace-group-earlier"] [data-testid="workspace-group-row"]').length === 2);
  assert.deepEqual(await page.evaluate(async () => (await import("/app/state.js")).state.controlCenter.folders), { "claude:e1": "Clients/Contigos" });

  // A conversation that needs you stays under Needs you after it is filed, with its folder on the row.
  const needs = page.getByTestId("workspace-group-needs-you").getByTestId("workspace-group-row");
  await needs.hover();
  await needs.getByTestId("inbox-row-menu").click();
  await page.getByTestId("inbox-row-folder").click();
  await page.getByTestId("control-pop-choice").filter({ hasText: "Clients" }).first().click();
  await page.waitForFunction(() => document.querySelector('[data-testid="workspace-group-needs-you"] [data-testid="inbox-row-tag-folder"]'));
  assert.equal(await needs.getByTestId("inbox-row-tag-folder").textContent(), "Clients");

  // By folder: the tree opens in place, counts include subfolders, and the filed row is under its folder.
  await page.getByTestId("workspace-mode-folder").click();
  const clients = page.locator('[data-testid="workspace-folder"][data-path="Clients"]');
  assert.equal(await clients.locator(".ws-folder-count").textContent(), "2");
  // Clients opened itself when its subfolder was made.
  const contigos = page.locator('[data-testid="workspace-folder"][data-path="Clients/Contigos"]');
  await contigos.getByTestId("workspace-folder-toggle").click();
  await page.getByTestId("workspace-folder-row-conversation").filter({ hasText: "Old design notes" }).waitFor();
  assert.equal(await page.getByTestId("workspace-folder-unfiled").locator(".ws-folder-count").textContent(), "6");
  await page.getByTestId("workspace-folder-unfiled-open").click();
  await page.getByTestId("workspace-group-page").waitFor();
  await page.getByTestId("workspace-listing-page-row").first().waitFor();
  assert.equal(await page.getByTestId("workspace-listing-page-row").count(), 6);
  await page.getByTestId("workspace-group-close").click();

  // Drag a filed conversation onto another folder, then onto Not filed.
  const filed = page.getByTestId("workspace-folder-row-conversation").filter({ hasText: "Old design notes" });
  await filed.dragTo(clients);
  await page.waitForFunction(async () => (await import("/app/state.js")).state.controlCenter.folders["claude:e1"] === "Clients");
  await page.getByTestId("workspace-folder-row-conversation").filter({ hasText: "Old design notes" }).dragTo(page.getByTestId("workspace-folder-unfiled"));
  await page.waitForFunction(async () => !("claude:e1" in (await import("/app/state.js")).state.controlCenter.folders));
  await page.getByTestId("workspace-folder-unfiled").locator(".ws-folder-count").waitFor();
  assert.equal(await page.getByTestId("workspace-folder-unfiled").locator(".ws-folder-count").textContent(), "7");
  // And back into the subfolder, so deleting it below has something to give back.
  await page.getByTestId("workspace-mode-state").click();
  const old = page.getByTestId("workspace-group-earlier").getByTestId("workspace-group-row").filter({ hasText: "Old design notes" });
  await old.hover();
  await old.getByTestId("inbox-row-menu").click();
  await page.getByTestId("inbox-row-folder").click();
  await page.getByTestId("control-pop-choice").filter({ hasText: "Contigos" }).click();
  await page.getByTestId("workspace-mode-folder").click();
  await contigos.waitFor();

  // Pinned and Starred are views across every folder.
  await page.getByTestId("workspace-folder-starred-open").click();
  await page.getByTestId("workspace-group-page").waitFor();
  assert.equal(await page.getByTestId("workspace-listing-page-row").count(), 0);
  await page.getByTestId("workspace-group-close").click();

  // Deleting a folder deletes no conversation: the filed ones are back in the Inbox.
  await contigos.getByTestId("workspace-folder-menu").click();
  await page.getByTestId("control-pop-choice").filter({ hasText: "Delete folder" }).click();
  await page.locator("#confirmAcceptButton").click();
  await page.waitForFunction(() => !document.querySelector('[data-path="Clients/Contigos"]'));
  assert.deepEqual(await page.evaluate(async () => (await import("/app/state.js")).state.controlCenter.folders), { "claude:n1": "Clients" });
  await page.getByTestId("workspace-mode-state").click();
  await page.getByTestId("workspace-group-earlier").getByTestId("workspace-group-row").filter({ hasText: "Old design notes" }).waitFor();
});

test("a sub-agent's conversation folds under its parent", { timeout: 120_000 }, async (t) => {
  const { page } = await open(t, true);
  await page.getByTestId("workspace-group-running").getByTestId("workspace-group-row").nth(1).waitFor();
  const rows = page.getByTestId("workspace-group-running").getByTestId("workspace-group-row");
  assert.match(await rows.nth(0).innerText(), /Running the migration/);
  assert.match(await rows.nth(1).innerText(), /Sub-agent: check the schema/);
  assert.equal(await rows.nth(1).evaluate((row) => row.classList.contains("ws-kid")), true, "the sub-agent is indented under its parent");
  assert.equal(await rows.nth(0).getByTestId("inbox-row-kids").textContent(), "▾ 1");
  await rows.nth(0).getByTestId("inbox-row-kids").click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="workspace-group-running"] [data-testid="workspace-group-row"]').length === 1);
  assert.equal(await page.getByTestId("workspace-group-running").getByTestId("inbox-row-kids").textContent(), "▸ 1");
});

test("the Show all page filters by label and by worktree", { timeout: 120_000 }, async (t) => {
  const { page } = await open(t, true);
  await page.getByTestId("workspace-show-all-earlier").click();
  await page.getByTestId("workspace-group-page-row").first().waitFor();
  assert.equal(await page.getByTestId("workspace-group-page-row").count(), 3);
  await page.getByTestId("inboxPage-labels-trigger").click();
  await page.getByTestId("inboxPage-labels-options").locator('[data-value="label:research"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="workspace-group-page-row"]').length === 1);
  assert.match(await page.getByTestId("workspace-group-page-row").innerText(), /Old design notes/);
  await page.keyboard.press("Escape");
  await page.getByTestId("inboxPage-labels-trigger").click();
  await page.getByTestId("inboxPage-labels-clear").click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="workspace-group-page-row"]').length === 3);
  await page.getByTestId("inboxPage-worktrees-trigger").click();
  await page.getByTestId("inboxPage-worktrees-options").locator('[data-value="w1"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="workspace-group-page-row"]').length === 0);
  assert.match(await page.locator(".ws-page-list .ws-empty").innerText(), /Nothing matches the filters/);
});

test("by project, the menu has the notes and worktree tools, and a pin means the same in both lists", { timeout: 120_000 }, async (t) => {
  const { page, projects } = await open(t);
  await page.getByTestId("workspace-mode-project").click();
  await page.locator(`[data-project="${projects[0].id}"]`).getByTestId("workspace-project-menu").click();
  for (const label of ["Notes", "New worktree…", "Manage worktrees", "Review together…"]) {
    assert.equal(await page.locator("#rowMenu button", { hasText: label }).count() > 0, true, `${label} is in the project menu`);
  }
  await page.keyboard.press("Escape");
  // The Inbox pins a conversation by its first engine and conversation id, as the project list does.
  const pin = await page.evaluate(async () => {
    const marks = await import("/app/control-marks.js");
    const state = (await import("/app/state.js")).state;
    const card = { projectId: "pX", harnessId: "pi", pinEngine: "claude", sessionId: "newest", conversationId: "first" };
    state.pinnedConversations = [{ projectId: "pX", engine: "claude", sessionId: "first" }];
    return { pinned: marks.isPinned(card), unpinnedOther: marks.isPinned({ ...card, conversationId: "other", sessionId: "other" }) };
  });
  assert.deepEqual(pin, { pinned: true, unpinnedOther: false });
});

test("the phone's Home groups by state, project or folder too, with 44 px controls", { timeout: 120_000 }, async (t) => {
  const { page } = await open(t);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.body.classList.contains("focus-ui"));
  await page.getByTestId("phone-tab-inbox").click();
  await page.getByTestId("phone-mode").waitFor();
  const small = await page.getByTestId("phone-mode").locator("button").evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height).filter((height) => height < 43.5));
  assert.deepEqual(small, []);
  await page.getByTestId("phone-mode-project").click();
  await page.getByTestId("workspace-project").first().waitFor();
  await page.getByTestId("phone-mode-folder").click();
  await page.getByTestId("workspace-folder-new").waitFor();
  await page.getByTestId("phone-mode-state").click();
  await page.getByTestId("workspace-group-needs-you").waitFor();
});
