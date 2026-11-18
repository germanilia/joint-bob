// A real Chrome walks worktree creation, flat conversation badges, management,
// starting conversations in a worktree, merging and deleting it.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after, before } from "node:test";
import { type Browser, type BrowserContext, type Page } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { projectNamed, seedDevEnvironment, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "../dev-nodes.js";

const WORKTREE_NAME = "audit-suppressed-ticket-confirmation-loop-20261008";
const CONVERSATION_NAME = "Inbox mock replacement";
const SESSION_ID = "worktree-inbox-conversation";

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let server: ChildProcess;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let project: SeededNode["projects"][number];
// Chrome reports the machine's own audio device failing when the completion sound plays (a headset switching, say):
// that is the test machine, not the app, so the checks below leave that one message out.
const consoleErrors: string[] = [];

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

function worktreeRoot(): string {
  return path.join(environment.home, "JointBob", "worktrees", project.id);
}

async function onlyWorktreePath(): Promise<string> {
  const entries = (await readdir(worktreeRoot())).filter((entry) => !entry.startsWith("."));
  assert.equal(entries.length, 1, `one worktree folder exists (${entries.join(", ")})`);
  return path.join(worktreeRoot(), entries[0]);
}

/** The transcript a conversation leaves after running inside the worktree, plus the marker the server writes when it starts there. */
async function seedWorktreeConversation(worktree: string): Promise<void> {
  const at = (minutes: number) => new Date(Date.parse("2026-10-06T10:00:00.000Z") + minutes * 60_000).toISOString();
  const records = [
    { type: "session", version: 3, id: SESSION_ID, timestamp: at(0), cwd: worktree },
    { type: "session_info", name: CONVERSATION_NAME, timestamp: at(0) },
    { type: "message", id: `${SESSION_ID}-0`, parentId: null, timestamp: at(1), message: { role: "user", content: [{ type: "text", text: "Replace the inbox mock" }], timestamp: Date.parse(at(1)) } },
    { type: "message", id: `${SESSION_ID}-1`, parentId: `${SESSION_ID}-0`, timestamp: at(2), message: { role: "assistant", content: [{ type: "text", text: "The inbox now persists messages." }], timestamp: Date.parse(at(2)) } },
  ];
  await writeFile(path.join(environment.home, ".pi", "sessions", `${SESSION_ID}.jsonl`), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  const markers = path.join(worktree, ".joint-bob-worktree", "conversations");
  await mkdir(markers, { recursive: true });
  await writeFile(path.join(markers, `pi--${SESSION_ID}.json`), "{}\n");
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-worktrees-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  project = projectNamed(node, "Joint Bob");
  await mkdir(path.join(project.path, "src"), { recursive: true });
  await writeFile(path.join(project.path, "src", "inbox.ts"), "export const inbox = 'mock';\n");
  await mkdir(path.join(project.path, "node_modules", "dep"), { recursive: true });
  await writeFile(path.join(project.path, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  server = await startDevNode(environment, node);
  browser = await launchChrome({ headless: process.env.HEADED !== "1" });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
  page = await context.newPage();
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(`${message.text()} ${message.location().url}`); });
}, { timeout: 120_000 });

after(async () => {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(root, "final.png") }).catch(() => undefined);
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

async function openProject(): Promise<void> {
  const appState = await page.evaluateHandle(async () => (await import("/app/state.js")).state);
  try {
    await page.waitForFunction((state) => state.preferencesLoaded, appState);
  } finally {
    await appState.dispose();
  }
  const projectCard = page.locator(".project-card", { hasText: "Joint Bob" }).first();
  await projectCard.waitFor({ timeout: 20_000 });
  await projectCard.click();
  await page.locator(".session-card").first().waitFor({ timeout: 20_000 });
}

/** Hold the real fixture response, not an intercepted request that navigation may abort. */
function delayWorktreeListing(pending: Promise<void>): Promise<void> {
  return page.route("**/api/projects/*/worktrees", async (route) => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    const response = await route.fetch();
    await pending;
    await route.fulfill({ response });
  });
}

test("a worktree is created from the conversation list as a code-only copy", async () => {
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 20_000 });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await openProject();

  await page.getByTestId("worktree-create-button").click();
  await page.locator("#worktreeDialog[open]").waitFor({ timeout: 10_000 });
  await page.getByTestId("worktree-name-input").fill(WORKTREE_NAME);
  await page.getByTestId("worktree-save-button").click();
  const section = page.getByTestId("worktree-section").filter({ hasText: WORKTREE_NAME });
  await section.waitFor({ timeout: 20_000 });
  await page.locator("#worktreeDialog[open]").waitFor({ state: "detached", timeout: 10_000 });

  const worktree = await onlyWorktreePath();
  assert.equal(await readFile(path.join(worktree, "src", "inbox.ts"), "utf8"), "export const inbox = 'mock';\n");
  assert.ok((await lstat(path.join(worktree, "node_modules"))).isSymbolicLink(), "dependencies are linked, not copied");
  assert.equal(await realpath(path.join(worktree, "node_modules")), await realpath(path.join(project.path, "node_modules")));
  assert.equal(await section.getAttribute("data-worktree-color"), "teal", "the first worktree gets a vivid colour, not slate");
  assert.equal((await section.getByTestId("worktree-section-count").innerText()).trim(), "0");
});

test("workspace cleanup settings preview keeps a new worktree", async () => {
  await page.evaluate(async () => (await import("/app/settings.js")).openSettings("workspace-cleanup"));
  const panel = page.getByTestId("settings-panel-workspace-cleanup");
  await panel.getByRole("button", { name: "Preview cleanup" }).click();
  await panel.getByText(/Kept\. Recent conversation or workspace activity/).waitFor();
  assert.equal(await panel.getByRole("checkbox", { name: /Enable automatic cleanup/ }).isChecked(), false);
  await access(await onlyWorktreePath());
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "hidden" });
});

test("a conversation that ran in the worktree stays in the flat list with a badge", async () => {
  const worktree = await onlyWorktreePath();
  await seedWorktreeConversation(worktree);
  await page.reload({ waitUntil: "domcontentloaded" });
  await openProject();

  const row = page.locator(".list-row", { hasText: CONVERSATION_NAME }).first();
  await row.waitFor({ timeout: 20_000 });
  assert.match(await row.getAttribute("class") ?? "", /\bhas-worktree\b/);
  const badge = row.getByTestId("session-worktree-badge");
  assert.equal((await badge.innerText()).trim(), WORKTREE_NAME);
  assert.equal(await badge.getAttribute("data-worktree-color"), "teal");
  assert.equal(await row.locator(".session-card").getAttribute("data-worktree-color"), null, "only the badge carries the worktree colour");
  assert.equal(await page.locator("#sessionList .list-row", { has: page.getByTestId("session-worktree-badge") }).count(), 1, "only the worktree conversation is marked");
  assert.equal(await page.locator("#sessionList > [data-testid='worktree-section']").count(), 0);
  const total = await page.locator("#sessionList .list-row").count();
  await page.getByTestId("other-worktrees-toggle").click();
  const section = page.getByTestId("worktree-section").first();
  assert.equal((await section.getByTestId("worktree-section-count").innerText()).trim(), "1");
  await page.getByTestId("other-worktrees-toggle").click();
  assert.equal(await page.locator("#sessionList .list-row").count(), total, "folding management never hides conversations");
});

test("worktree filtering keeps one pinned-first list and includes project-folder conversations", async () => {
  const row = page.locator("#sessionList .list-row", { hasText: CONVERSATION_NAME });
  await row.getByTestId("session-pin-button").click();
  assert.equal(await page.locator("#sessionList .list-row").first().getAttribute("data-session-path"), await row.getAttribute("data-session-path"));
  const total = await page.locator("#sessionList .list-row").count();
  assert.ok(total > 1, "the fixture includes project-folder and worktree conversations");
  await page.getByTestId("conversation-worktree-filter-trigger").click();
  await page.getByTestId("conversation-worktree-filter-option").filter({ hasText: WORKTREE_NAME }).click();
  assert.equal(await page.locator("#sessionList .list-row").count(), 1);
  assert.equal(await row.isVisible(), true);
  await page.getByTestId("conversation-worktree-filter-trigger").click();
  await page.getByTestId("conversation-worktree-filter-clear").click();
  await page.getByTestId("conversation-worktree-filter-trigger").click();
  await page.getByTestId("conversation-worktree-filter-option").filter({ hasText: "Project folder" }).click();
  assert.equal(await page.locator("#sessionList .list-row").count(), total - 1);
  assert.equal(await row.count(), 0);
  await page.getByTestId("conversation-worktree-filter-trigger").click();
  await page.getByTestId("conversation-worktree-filter-clear").click();
  await row.getByTestId("session-pin-button").click();
});

test("worktree badges and management do not wait for a slow cleanup scan", async () => {
  let release!: () => void;
  const scan = new Promise<void>((resolve) => { release = resolve; });
  const route = "**/api/projects/*/worktrees/cleanup";
  let cleanupRequests = 0;
  let listRequests = 0;
  await page.route("**/api/projects/*/worktrees", async (request) => { listRequests += 1; await request.continue(); });
  await page.route(route, async (request) => {
    cleanupRequests += 1;
    await scan;
    await request.continue();
  });
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await openProject();
    const row = page.locator("#sessionList .list-row", { hasText: CONVERSATION_NAME });
    await row.getByTestId("session-worktree-badge").waitFor();
    await page.getByTestId("other-worktrees-toggle").click();
    const section = page.getByTestId("worktree-section").filter({ hasText: WORKTREE_NAME });
    await section.waitFor({ timeout: 5_000 });
    assert.equal(await section.getByTestId("worktree-section-count").innerText(), "1");
    assert.ok(listRequests > 0, "headers come from the fast listing endpoint");
    await page.evaluate(async () => {
      const { loadWorktrees } = await import("/app/worktrees.js");
      await loadWorktrees();
      await loadWorktrees();
    });
    assert.equal(cleanupRequests, 1, "refresh notices do not pile up cleanup requests");
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("conversation badges and filters work while the worktree listing is pending", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await delayWorktreeListing(pending);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await openProject();
    const row = page.locator("#sessionList .list-row", { hasText: CONVERSATION_NAME });
    await row.getByTestId("session-worktree-badge").waitFor();
    assert.equal(await page.locator("#sessionList > [data-testid='worktree-section']").count(), 0);
    await page.getByTestId("conversation-worktree-filter-trigger").click();
    await page.getByTestId("conversation-worktree-filter-option").filter({ hasText: WORKTREE_NAME }).click();
    assert.equal(await page.locator("#sessionList .list-row").count(), 1);
    await page.getByTestId("conversation-worktree-filter-trigger").click();
    await page.getByTestId("conversation-worktree-filter-clear").click();
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("a late listing keeps worktree management folded without moving conversations", async () => {
  const empty = await page.evaluate(async () => {
    const { api } = await import("/app/api.js");
    const { state } = await import("/app/state.js");
    return (await api(`/api/projects/${state.activeProjectId}/worktrees`, { method: "POST", body: JSON.stringify({ name: "Empty worktree", color: "amber" }) })).worktree;
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await delayWorktreeListing(pending);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await openProject();
    const row = page.locator("#sessionList .list-row", { hasText: CONVERSATION_NAME });
    await row.waitFor();
    const before = await page.locator("#sessionList .session-card strong").allTextContents();
    assert.equal(await page.getByTestId("worktree-section").count(), 0, "conversations do not need management rows");
    release();
    const toggle = page.getByTestId("other-worktrees-toggle");
    await toggle.waitFor();
    assert.deepEqual(await page.locator("#sessionList .session-card strong").allTextContents(), before, "a late listing must not reorder conversations");
    const section = page.getByTestId("worktree-section").filter({ hasText: "Empty worktree" });
    assert.equal(await section.isVisible(), false);
    assert.equal(await toggle.innerText(), "Manage worktrees (2)");
    await toggle.click();
    await section.waitFor();
    await page.evaluate(async () => {
      await (await import("/app/worktrees.js")).loadWorktrees();
      (await import("/app/session-list.js")).renderSessions();
    });
    assert.equal(await section.isVisible(), true, "refresh preserves an explicitly expanded section");
    await section.getByTestId("worktree-menu-button").click();
    await page.getByTestId("worktree-menu-new-conversation").waitFor();
    await page.keyboard.press("Escape");
    await toggle.click();
    assert.equal(await section.isVisible(), false);
    assert.equal(await row.isVisible(), true, "occupied groups stay visible");
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
    await page.evaluate(async (id) => {
      const { api } = await import("/app/api.js");
      const { state } = await import("/app/state.js");
      await api(`/api/projects/${state.activeProjectId}/worktrees/${id}`, { method: "DELETE" });
      await (await import("/app/worktrees.js")).loadWorktrees();
    }, empty.id);
  }
});

test("long worktree management names and conversation badges fit without horizontal scrolling", async () => {
  await page.getByTestId("other-worktrees-toggle").click();
  try {
    for (const width of [1440, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const geometry = await page.evaluate(() => {
        const list = document.querySelector<HTMLElement>("#sessionList")!;
        const bounds = list.getBoundingClientRect();
        const name = list.querySelector<HTMLElement>(".worktree-section-name")!;
        const items = [...list.querySelectorAll(".worktree-section-header, .session-card, .worktree-section-count, .worktree-section-menu, .row-action-button")];
        return {
          width: list.clientWidth,
          scrollWidth: list.scrollWidth,
          badges: [...list.querySelectorAll(".session-worktree-badge")].map(badge => ({ width: badge.getBoundingClientRect().width, height: badge.getBoundingClientRect().height })),
          nameWidth: name.clientWidth,
          nameScrollWidth: name.scrollWidth,
          overflowing: items.filter((item) => {
            const box = item.getBoundingClientRect();
            return box.left < bounds.left || box.right > bounds.left + list.clientWidth;
          }).map((item) => item.className),
        };
      });
      assert.ok(geometry.nameScrollWidth > 250, "fixture name must be wider than a narrow column");
      assert.ok(geometry.scrollWidth <= geometry.width, `at ${width}px, list must fit: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.badges.length > 0 && geometry.badges.every(badge => badge.width <= 140 && badge.height <= 24), `at ${width}px, worktree badges stay compact: ${JSON.stringify(geometry.badges)}`);
      assert.deepEqual(geometry.overflowing, [], `at ${width}px, cards and actions must stay inside the column`);
      assert.ok(geometry.nameWidth > 0 && geometry.nameWidth < geometry.nameScrollWidth, `at ${width}px, only the long name should truncate`);
      await page.getByTestId("worktree-menu-button").first().click();
      await page.getByTestId("worktree-menu-new-conversation").waitFor();
      await page.keyboard.press("Escape");
    }
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

test("review references search keeps selections and only the list scrolls", async () => {
  await page.setViewportSize({ width: 390, height: 420 });
  try {
    await page.getByTestId("context-references-open-button").click();
    const dialog = page.getByTestId("context-references-dialog");
    const search = page.getByTestId("context-references-search");
    const worktree = dialog.locator(".context-reference-row", { hasText: WORKTREE_NAME }).first();
    await worktree.locator("input").check();
    await search.fill("Inbox mock");
    assert.equal(await worktree.isVisible(), false);
    assert.equal(await dialog.locator(".context-reference-row:visible").count(), 1);
    assert.equal(await page.locator("#contextReferencesCount").innerText(), "1 reference selected");
    await search.fill("no matching references");
    assert.equal(await dialog.locator(".context-reference-row:visible").count(), 0);
    await search.fill("");
    assert.equal(await worktree.locator("input").isChecked(), true);

    const before = await dialog.evaluate((element) => {
      const card = element.querySelector<HTMLElement>(".context-references-card")!;
      const list = element.querySelector<HTMLElement>(".context-references-list")!;
      const actions = element.querySelector<HTMLElement>(".dialog-actions")!;
      const searchField = element.querySelector<HTMLElement>("#contextReferencesSearch")!;
      return { cardOverflow: getComputedStyle(card).overflowY, listOverflow: getComputedStyle(list).overflowY,
        listHeight: list.clientHeight, contentHeight: list.scrollHeight, actionsTop: actions.getBoundingClientRect().top,
        searchTop: searchField.getBoundingClientRect().top, actionsBottom: actions.getBoundingClientRect().bottom,
        dialogBottom: element.getBoundingClientRect().bottom };
    });
    assert.equal(before.cardOverflow, "hidden");
    assert.equal(before.listOverflow, "auto");
    assert.ok(before.contentHeight > before.listHeight, `list must overflow: ${JSON.stringify(before)}`);
    assert.ok(before.actionsBottom <= before.dialogBottom, "actions stay inside dialog");
    await dialog.locator(".context-references-list").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const after = await dialog.evaluate((element) => ({
      actionsTop: element.querySelector(".dialog-actions")!.getBoundingClientRect().top,
      searchTop: element.querySelector("#contextReferencesSearch")!.getBoundingClientRect().top,
      scrollTop: element.querySelector(".context-references-list")!.scrollTop,
    }));
    assert.ok(after.scrollTop > 0);
    assert.equal(after.actionsTop, before.actionsTop);
    assert.equal(after.searchTop, before.searchTop);
  } finally {
    await page.getByTestId("context-references-cancel-button").click();
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

test("worktrees and conversations can be referenced together in a new conversation", async () => {
  await page.getByTestId("context-references-open-button").click();
  const dialog = page.getByTestId("context-references-dialog");
  await dialog.waitFor();
  const worktree = dialog.locator(".context-reference-row", { hasText: WORKTREE_NAME });
  const conversation = dialog.locator(".context-reference-row", { hasText: CONVERSATION_NAME });
  await worktree.first().locator("input").check();
  await conversation.last().locator("input").check();
  assert.equal(await page.locator("#contextReferencesCount").innerText(), "2 references selected");
  await page.getByTestId("context-references-start-button").click();
  await page.locator("#choiceDialog[open]").waitFor({ timeout: 10_000 });
  await page.getByTestId("choice-accept-button").click();
  await page.locator("#newSessionNameDialog[open]").waitFor({ timeout: 10_000 });
  await page.getByTestId("new-session-name-input").fill("Combined review");
  await page.getByTestId("new-session-new-worktree-checkbox").uncheck();
  await page.getByTestId("new-session-name-start-button").click();
  await page.locator("#messageInput:not([disabled])").waitFor({ timeout: 30_000 });
  const draft = await page.locator("#messageInput").inputValue();
  assert.match(draft, new RegExp(`Worktree: ${WORKTREE_NAME}[\\s\\S]*Conversation: ${CONVERSATION_NAME}`));
  assert.match(draft, /pointers only; content is not preloaded/);
});

test("starting a conversation from the worktree menu runs it in the worktree", async () => {
  await page.getByTestId("worktree-menu-button").first().click();
  await page.getByTestId("worktree-menu-new-conversation").click();
  await page.locator("#choiceDialog[open]").waitFor({ timeout: 10_000 });
  await page.getByTestId("choice-accept-button").click();
  await page.locator("#newSessionNameDialog[open]").waitFor({ timeout: 10_000 });
  await page.getByTestId("new-session-next-button").click();
  await page.getByTestId("new-session-next-button").click();
  const select = page.getByTestId("new-session-worktree-select");
  await select.waitFor({ timeout: 10_000 });
  const chosen = await select.evaluate((element) => (element as HTMLSelectElement).selectedOptions[0]?.textContent);
  assert.equal(chosen, `Worktree: ${WORKTREE_NAME}`);
  await page.getByTestId("new-session-name-cancel-button").click();
  await page.locator("#newSessionNameDialog[open]").waitFor({ state: "detached", timeout: 10_000 });
});

test("a conversation started in the worktree skips the start-of-conversation prompt", async () => {
  const START_PROMPT = "Update from main first.";
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-commands").click();
  await page.locator('#settingsForm[data-ready="true"]').waitFor();
  await page.getByTestId("settings-start-conversation-enabled").check();
  await page.getByTestId("settings-start-conversation-prompt").fill(START_PROMPT);
  await page.locator('[data-testid="settings-save-state"][data-state="saved"]').waitFor();
  await page.getByTestId("settings-cancel-button").click();
  await page.locator("#settingsDialog[open]").waitFor({ state: "hidden", timeout: 20_000 });
  await page.getByTestId("worktree-menu-button").first().click();
  await page.getByTestId("worktree-menu-new-conversation").click();
  await page.locator("#choiceDialog[open]").waitFor({ timeout: 10_000 });
  await page.getByTestId("choice-accept-button").click();
  await page.locator("#newSessionNameDialog[open]").waitFor({ timeout: 10_000 });
  await page.getByTestId("new-session-name-input").fill("Worktree start check");
  await page.getByTestId("new-session-name-start-button").click();
  const state = await page.evaluateHandle(async () => (await import("/app/state.js")).state);
  await page.waitForFunction((state) => Boolean(state.activeSessionId), state, { timeout: 30_000 });
  await state.dispose();
  const row = page.locator("#sessionList .list-row.active");
  await row.waitFor({ timeout: 20_000 });
  assert.match(await row.getAttribute("class") ?? "", /\bhas-worktree\b/, "the new conversation runs in the worktree");
  // The prompt would be queued as soon as the conversation is ready; give it time to show.
  await page.waitForTimeout(3_000);
  assert.equal(await page.getByText(START_PROMPT, { exact: true }).count(), 0, "the start prompt is not sent in a worktree");
  // Its record names the worktree, so a machine still waiting for the worktree's files lists it there too.
  const sessionId = await page.evaluate(async () => (await import("/app/state.js")).state.activeSessionId);
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"), { readOnly: true });
  const recorded = db.prepare("SELECT worktree FROM conversation_records WHERE project_id = ? AND session_id = ?").get(project.id, sessionId) as { worktree: string | null } | undefined;
  db.close();
  assert.deepEqual({ id: JSON.parse(recorded?.worktree ?? "{}").id, name: JSON.parse(recorded?.worktree ?? "{}").name }, { id: path.basename(await onlyWorktreePath()), name: WORKTREE_NAME });
});

test("merge to project writes the worktree's edits into the project folder", async () => {
  const worktree = await onlyWorktreePath();
  await writeFile(path.join(worktree, "src", "inbox.ts"), "export const inbox = 'real';\n");
  await page.getByTestId("worktree-menu-button").first().click();
  await page.getByTestId("worktree-menu-merge").click();
  await page.locator("#confirmDialog[open]").waitFor({ timeout: 10_000 });
  await page.locator("#confirmAcceptButton").click();
  await page.locator(".toast-message", { hasText: `Merged ${WORKTREE_NAME}: 1 file written, 0 deleted.` }).waitFor({ timeout: 20_000 });
  assert.equal(await readFile(path.join(project.path, "src", "inbox.ts"), "utf8"), "export const inbox = 'real';\n");
});

test("deleting a worktree removes its folder and keeps its conversation as history", async () => {
  const worktree = await onlyWorktreePath();
  await page.getByTestId("worktree-menu-button").first().click();
  await page.getByTestId("worktree-menu-delete").click();
  await page.locator("#confirmDialog[open]").waitFor({ timeout: 10_000 });
  await page.locator("#confirmAcceptButton").click();
  await page.getByTestId("worktree-section").waitFor({ state: "detached", timeout: 20_000 });
  // The list can update before the folder is fully gone.
  for (const deadline = Date.now() + 20_000; await exists(worktree) && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await exists(worktree), false);
  assert.equal(consoleErrors.filter((message) => !/favicon|ERR_ABORTED|WebSocket|instructions\/content\?.*worktreeId|AudioContext encountered an error from the audio device/i.test(message)).length, 0, consoleErrors.join("\n"));
});

test("with the setting on, each new conversation starts in a worktree of its own named after it", async () => {
  const AUTO_NAME = "Inbox persistence";
  await page.getByTestId("session-create-button").click();
  await page.locator("#newSessionNameDialog[open]").waitFor({ timeout: 10_000 });
  await page.getByTestId("new-session-name-input").fill(AUTO_NAME);
  assert.equal(await page.getByTestId("new-session-new-worktree-checkbox").isChecked(), true);
  const picked = await page.getByTestId("new-session-worktree-select").evaluate((element) => (element as HTMLSelectElement).value);
  assert.equal(picked, "new", "New worktree is the default choice");
  await page.getByTestId("new-session-name-start-button").click();

  await page.locator("#sessionList .list-row.active", { hasText: AUTO_NAME }).getByTestId("session-worktree-badge").waitFor({ timeout: 60_000 });
  const row = page.locator("#sessionList .list-row.active");
  await row.waitFor({ timeout: 20_000 });
  assert.match(await row.getAttribute("class") ?? "", /\bhas-worktree\b/, "the conversation runs in the new worktree");
  assert.equal((await row.getByTestId("session-worktree-badge").innerText()).trim(), AUTO_NAME);
  const worktree = await onlyWorktreePath();
  assert.equal(await readFile(path.join(worktree, "src", "inbox.ts"), "utf8"), "export const inbox = 'real';\n", "the worktree copies the project as it is now");
});

test("marking the last conversation done preserves its unverified worktree", async () => {
  const worktree = await onlyWorktreePath();
  const row = page.locator("#sessionList .list-row", { has: page.getByTestId("session-worktree-badge") }).first();
  await row.hover();
  await row.getByTestId("session-menu-button").click();
  const marked = page.waitForResponse((response) => response.url().endsWith("/sessions/done") && response.request().method() === "PUT");
  await page.getByTestId("session-done-button").click();
  await page.getByTestId("conversation-feedback-submit").click();
  const result = await (await marked).json();
  assert.deepEqual(result.deletedWorktreeIds, [], JSON.stringify(result));
  assert.equal(await exists(worktree), true, "Done is not evidence of a verified commit");
  await page.reload({ waitUntil: "domcontentloaded" });
  await openProject();
  await page.getByTestId("other-worktrees-toggle").click();
  await page.getByTestId("worktree-section").waitFor();
  assert.equal(await exists(worktree), true, "unverified work survives reload and cleanup");
  // Explicit deletion is a separate human action; clean up this test-owned fixture before the next case.
  await page.getByTestId("worktree-menu-button").click();
  await page.getByTestId("worktree-menu-delete").click();
  await page.locator("#confirmDialog[open]").waitFor();
  await page.locator("#confirmAcceptButton").click();
  await page.getByTestId("worktree-section").waitFor({ state: "detached" });
});

// Metadata arrives before files on another machine. The badge and filter need
// only metadata; management actions still require the local files.
test("a conversation whose worktree has not synced has a badge and filter, without local actions", async () => {
  const REMOTE = { id: "41ab1391-dd48-4ca3-9398-c1be5a8f8a27", name: "audit-email-attachment-scope", color: "amber" };
  const REMOTE_SESSION = "remote-worktree-conversation";
  const REMOTE_NAME = "Scope report email attachments";
  const at = (minutes: number) => new Date(Date.parse("2026-10-11T07:09:00.000Z") + minutes * 60_000).toISOString();
  const transcript = [
    { type: "session", version: 3, id: REMOTE_SESSION, timestamp: at(0), cwd: project.path },
    { type: "session_info", name: REMOTE_NAME, timestamp: at(0) },
    { type: "message", id: `${REMOTE_SESSION}-0`, parentId: null, timestamp: at(1), message: { role: "user", content: [{ type: "text", text: "Scope the attachments to the current request" }], timestamp: Date.parse(at(1)) } },
    { type: "message", id: `${REMOTE_SESSION}-1`, parentId: `${REMOTE_SESSION}-0`, timestamp: at(2), message: { role: "assistant", content: [{ type: "text", text: "Reading the attachment collector." }], timestamp: Date.parse(at(2)) } },
  ];
  await writeFile(path.join(environment.home, ".pi", "sessions", `${REMOTE_SESSION}.jsonl`), `${transcript.map((record) => JSON.stringify(record)).join("\n")}\n`);
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  db.prepare("INSERT INTO conversation_records (project_id, engine, session_id, created_at, updated_at, origin_node_id, worktree, worktree_at) VALUES (?, 'pi', ?, ?, ?, 'peer', ?, ?)")
    .run(project.id, REMOTE_SESSION, at(0), at(2), JSON.stringify(REMOTE), at(0));
  db.close();
  // These files and rows were written outside the server. Rebuild its index from disk.
  await page.goto("about:blank");
  await stopDevNode(server);
  server = await startDevNode(environment, node);

  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await openProject();
  const row = page.locator("#sessionList .list-row", { hasText: /scope report email attachments/i });
  await row.waitFor({ timeout: 20_000 });
  assert.equal((await row.getByTestId("session-worktree-badge").innerText()).trim(), REMOTE.name);
  assert.equal(await page.getByTestId("worktree-section").filter({ hasText: REMOTE.name }).count(), 0);
  await page.getByTestId("conversation-worktree-filter-trigger").click();
  await page.getByTestId("conversation-worktree-filter-option").filter({ hasText: REMOTE.name }).click();
  assert.equal(await page.locator("#sessionList .list-row").count(), 1);
  await page.getByTestId("conversation-worktree-filter-trigger").click();
  await page.getByTestId("conversation-worktree-filter-clear").click();
  // The picker for a new conversation offers only worktrees whose files are here.
  assert.equal(await page.evaluate(async (id) => (await import("/app/state.js")).state.worktrees.some((worktree: { id: string }) => worktree.id === id), REMOTE.id), false);

  // Once its conversation is hidden as done, nothing is left to show: it has no actions to keep reachable.
  await row.getByTestId("session-menu-button").click();
  const marked = page.waitForResponse((response) => response.url().endsWith("/sessions/done") && response.request().method() === "PUT");
  await page.getByTestId("session-done-button").click();
  await page.getByTestId("conversation-feedback-submit").click();
  await marked;
  await row.waitFor({ state: "detached", timeout: 20_000 });
  assert.equal(await page.getByTestId("other-worktrees").count(), 0, "no empty group for a worktree that cannot be used here");
  assert.equal(consoleErrors.filter((message) => !/favicon|ERR_ABORTED|WebSocket|instructions\/content\?.*worktreeId|AudioContext encountered an error from the audio device/i.test(message)).length, 0, consoleErrors.join("\n"));
});

test("a new worktree is created in the background: the conversation is on screen while the project is copied", async () => {
  const NAME = "Background copy";
  await page.getByTestId("session-create-button").click();
  await page.locator("#newSessionNameDialog[open]").waitFor({ timeout: 10_000 });
  await page.getByTestId("new-session-name-input").fill(NAME);
  // New worktree is chosen with its box on the first step. Once it is the default (the test above turns that on), the
  // "Runs in" select on the last step is hidden, so it is not chosen there.
  await page.getByTestId("new-session-new-worktree-checkbox").check();
  await page.getByTestId("new-session-next-button").click();
  await page.getByTestId("new-session-next-button").click();
  // The copy is held back here: the chat must already be open under its own name while it runs.
  let releaseCopy!: () => void;
  const copyHeld = new Promise<void>((resolve) => { releaseCopy = resolve; });
  await page.route("**/api/projects/*/worktrees", async (route) => {
    if (route.request().method() !== "POST") { await route.fallback(); return; }
    await copyHeld;
    await route.fallback();
  });
  await page.getByTestId("new-session-name-start-button").click();
  await page.locator("#newSessionNameDialog[open]").waitFor({ state: "hidden", timeout: 10_000 });
  await page.locator("#messages").getByText("Creating worktree…").waitFor({ timeout: 10_000 });
  assert.equal(await page.locator("#sessionTitle").innerText(), NAME, "the chat opens at once under the new name");
  releaseCopy();
  await page.unroute("**/api/projects/*/worktrees");
  // The row is listed (and active) before the list learns its worktree, so wait for the worktree, not the row.
  const row = page.locator("#sessionList .list-row.active", { hasText: NAME });
  await row.getByTestId("session-worktree-badge").waitFor({ timeout: 60_000 });
  assert.match(await row.getAttribute("class") ?? "", /\bhas-worktree\b/, "the conversation then starts in the new worktree");
});
