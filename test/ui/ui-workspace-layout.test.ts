// The desktop workspace (Paper · Editorial, phase 4): the left column with places and the three groups, the
// project picker, the conversation header with its chips and ⋯ menu, and the details column. Every action the
// old desktop panels and toolbar offered must still be reachable here. Spec: "Layout › Desktop workspace" in
// docs/superpowers/specs/2026-11-10-ui-redo-paper-design.md.
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
let reviewCount = 0;

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
const visible = (testid: string) => page.getByTestId(testid).isVisible();

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-workspace-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  server = await startDevNode(environment, node);
  browser = await launchChrome({ headless: process.env.HEADED !== "1" });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block", reducedMotion: "reduce" });
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 30_000 });
  // A person who never chose a column starts in Inbox. (launchChrome starts the suite in Projects only when the key
  // is missing, so a value the page does not know stands for "never chose".)
  await page.evaluate((key) => localStorage.setItem(key, "unset"), WORKSPACE_COLUMN_KEY);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 30_000 });
  // Signing in sets the review baseline (the first read of what waits for review); answers after it wait for review.
  const baseline = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/reviews/pending" && response.ok());
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#loginDialog[open]").waitFor({ state: "detached" });
  await baseline;
  for (const [name, seconds] of [["short-one", 1], ["canvas-picker-readability", 2], ["terraform-state-locking", 3], ["thread-based-agent-builder", 4], ["flow-runner-tool-evaluation", 5]] as const) await answerAgain(name, seconds);
  await page.reload({ waitUntil: "domcontentloaded" });
}, { timeout: 120_000 });

after(async () => {
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

test("the left column starts in Inbox: places, then Needs you, Running and To review with their counts", async () => {
  await page.getByTestId("workspace-side").waitFor();
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), WORKSPACE_COLUMN_KEY), "unset", "nothing was chosen yet");
  assert.equal(await page.getByTestId("workspace-inbox-button").getAttribute("aria-pressed"), "true");
  for (const id of ["projects-open-control-center-button", "workspace-inbox-button", "workspace-projects-button", "workspace-board-button", "workspace-automations-button", "usage-open", "settings-open-button", "workspace-person-button", "workspace-new-button", "workspace-search-input"]) {
    assert.equal(await visible(id), true, `${id} is in the column`);
  }
  assert.deepEqual(
    await page.locator('[data-testid="workspace-places"] .ws-place-label').allInnerTexts(),
    ["Bob", "Inbox", "Projects", "Board", "Automations", "Costs"],
  );
  // The conversations answered again after their last review wait under To review.
  await page.getByTestId("workspace-group-count-review").filter({ hasText: /^[1-9]\d*$/ }).waitFor();
  reviewCount = Number(await page.getByTestId("workspace-group-count-review").innerText());
  assert.ok(reviewCount >= 3, `the answered conversations are counted (${reviewCount})`);
  assert.equal(await page.getByTestId("workspace-group-count-needs-you").innerText(), "0");
  assert.equal(await page.getByTestId("workspace-group-count-running").innerText(), "0");
  assert.ok(await page.locator('[data-testid="workspace-group-review"] [data-testid="workspace-group-row"]').count() >= 1);
  // The project panels wait behind Projects.
  assert.equal(await page.locator("#projectsPanel").isVisible(), false);
  assert.equal(await page.locator("#chatsPanel").isVisible(), false);
  // The column never scrolls: it is exactly the window's height.
  const scroll = await page.evaluate(() => ({ document: document.scrollingElement!.scrollHeight, window: innerHeight, groups: [document.querySelector("#workspaceGroups")!.scrollHeight, document.querySelector("#workspaceGroups")!.clientHeight] }));
  assert.ok(scroll.document <= scroll.window, `the page does not scroll (${scroll.document} > ${scroll.window})`);
  assert.ok(scroll.groups[0] <= scroll.groups[1] + 1, "the groups fit their part of the column");
});

test("a group shows the rows that fit and Show all lists it, paged, in the middle", async () => {
  await page.setViewportSize({ width: 1440, height: 560 });
  await frames();
  const shown = await page.locator('[data-testid="workspace-group-review"] [data-testid="workspace-group-row"]').count();
  assert.ok(shown < reviewCount, `a short window shows fewer rows (${shown} of ${reviewCount})`);
  await page.getByTestId("workspace-show-all-review").click();
  await page.getByTestId("workspace-group-page").waitFor();
  assert.equal(await page.getByTestId("workspace-group-title").innerText(), "To review");
  assert.equal(await page.locator("#chatPanel").isVisible(), false, "the list takes the middle");
  const rows = await page.getByTestId("workspace-group-page-row").count();
  assert.ok(rows >= 1 && rows <= reviewCount);
  if (rows < reviewCount) {
    assert.equal(await visible("workspace-group-pager"), true, "more rows than fit page instead of scrolling");
    await page.getByTestId("workspace-group-next").click();
  }
  await page.getByTestId("workspace-group-tab-running").click();
  assert.equal(await page.getByTestId("workspace-group-title").innerText(), "Running");
  await page.getByTestId("workspace-group-tab-review").click();
  await page.getByTestId("workspace-group-page-row").first().click();
  await page.getByTestId("workspace-group-page").waitFor({ state: "hidden" });
  await page.locator("#messages .message").first().waitFor();
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("a row opens its conversation, and reading it takes it off To review", async () => {
  const row = page.locator('[data-testid="workspace-group-review"] [data-testid="workspace-group-row"]:not(.sel)').first();
  const title = await row.locator("b").innerText();
  const project = (await row.locator(".ws-row-line").innerText()).split(" · ")[0];
  await row.click();
  await page.locator("#sessionTitle", { hasText: title }).waitFor();
  assert.equal(await page.getByTestId("chat-project-name").innerText(), project);
  // Reading it is reviewing it: it leaves To review (the open one is marked while it is still listed).
  await page.waitForFunction((name) => ![...document.querySelectorAll('[data-testid="workspace-group-review"] .ws-row b')].some((cell) => cell.textContent === name && !cell.closest(".sel")), title);
});

test("the conversation header: title, project and state on one line, Mark done and ⋯ beside them, four chips under it", async () => {
  const head = page.getByTestId("chat-head-actions");
  for (const id of ["chat-done-button", "chat-activity-toggle", "chat-more-button"]) assert.equal(await head.getByTestId(id).count(), 1, `${id} is in the header`);
  // Middles of each control, in order: title, Mark done, ⋯, then three chips. (No named helpers inside evaluate: the
  // test runner's compiler would wrap them in a function the page does not have.)
  const middles = await page.evaluate((selectors) => selectors.map((selector) => {
    const box = document.querySelector(selector)!.getBoundingClientRect();
    return Math.round(box.top + box.height / 2);
  }), ["#sessionTitle", "#chatDoneButton", "#chatMoreMenu > summary", "#chatHarnessSelect", "#modelButton", "#chatNodeSelect"]);
  const line = { title: middles[0], done: middles[1], more: middles[2], chips: middles.slice(3) };
  assert.ok(Math.abs(line.title - line.done) <= 8 && Math.abs(line.title - line.more) <= 8, `title, Mark done and ⋯ share a line (${JSON.stringify(line)})`);
  assert.ok(line.chips.every((chip) => chip > line.title + 12), "the chips sit under the title");
  // Agent, model, effort, machine, in that order.
  const order = await page.evaluate(() => ["#chatHarnessSelect", "#modelButton", "#reasoningLevelSelect", "#chatNodeSelect"]
    .map((selector) => document.querySelector(selector)!).filter((element) => element.getClientRects().length).map((element) => element.getBoundingClientRect().left));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "the chips read agent, model, effort, machine");
  // Context, time and cost are quiet meta at the end of the chip row.
  assert.equal(await page.getByTestId("chat-meta").locator("#turnTimer").count(), 1);
  assert.equal(await page.getByTestId("chat-meta").locator("#contextUsage").count(), 1);

  // Every other toolbar action is in ⋯.
  await page.getByTestId("chat-more-button").click();
  for (const id of ["chat-open-terminal-button", "chat-open-browser-button", "chat-notify-button", "chat-auto-respond-button", "chat-rename-button", "chat-more-dashboard-button", "chat-cron-button", "chat-session-menu-button", "chat-share-button", "chat-pin-button", "chat-personal-assistant-button"]) {
    assert.equal(await visible(id), true, `${id} is in the ⋯ menu`);
  }
  assert.equal(await page.locator("#chatMoreMenu #chatInstallButton, #chatMoreMenu [data-testid='chat-install-button']").count(), 1, "Install stays in the menu (shown when the browser offers it)");
  await page.getByTestId("chat-rename-button").click();
  await page.locator("dialog[open]").first().waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#chatMoreMenu[open]").count(), 0, "choosing an action closes the menu");
  // The quick commands stay above the message box.
  assert.equal(await visible("chat-help-button"), true);
  assert.equal(await visible("chat-resources-button"), true);
});

test("the details column: Activity, Files, Git and Tasks, More, the two switches and the links", async () => {
  if (!(await page.locator("#activityPanel").isVisible())) await page.getByTestId("chat-activity-toggle").click();
  for (const id of ["activity-activity-tab", "details-files-tab", "details-git-tab", "details-tasks-tab", "details-more-button"]) assert.equal(await visible(id), true, `${id} is a segment`);
  assert.equal(await visible("activity-summary"), true, "Activity shows the summary");
  await page.getByTestId("details-files-tab").click();
  assert.equal(await visible("details-files"), true);
  assert.equal(await visible("activity-body"), false);
  assert.equal(await page.getByTestId("details-files").getByTestId("chat-files-button").isVisible(), true, "Files opens today's files screen");
  await page.getByTestId("details-git-tab").click();
  assert.equal(await page.getByTestId("details-git").getByTestId("chat-git-button").isVisible(), true, "Git opens today's Git screen");
  await page.getByTestId("chat-git-button").click();
  await page.locator("#gitReviewDialog[open]").waitFor();
  await page.keyboard.press("Escape");
  await page.locator("#gitReviewDialog[open]").waitFor({ state: "detached" });
  await page.getByTestId("details-tasks-tab").click();
  assert.equal(await page.getByTestId("details-tasks").getByTestId("background-tasks-open").isVisible(), true, "Tasks opens today's tasks dialog");
  await page.getByTestId("details-more-button").click();
  for (const id of ["activity-chat-tab", "activity-story-button", "activity-overview-button"]) assert.equal(await visible(id), true, `${id} is under More`);
  await page.getByTestId("activity-chat-tab").click();
  assert.equal(await visible("conversation-chat"), true, "the side chat opens in the column");
  assert.equal(await visible("details-tasks"), false);
  await page.getByTestId("activity-activity-tab").click();
  assert.equal(await visible("activity-body"), true);

  // The switches show the conversation's state and work its own controls.
  assert.equal(await visible("details-auto-respond-switch"), true);
  assert.equal(await page.getByTestId("details-notify-switch").getAttribute("aria-checked"), await page.getByTestId("chat-notify-button").getAttribute("aria-pressed"));
  await page.getByTestId("details-auto-respond-switch").click();
  await page.locator("#autoRespondDialog[open]").waitFor();
  await page.keyboard.press("Escape");
  await page.locator("#autoRespondDialog[open]").waitFor({ state: "detached" });
  await page.getByTestId("details-link-schedule").click();
  await page.locator("#cronDialog[open]").waitFor();
  await page.keyboard.press("Escape");
  for (const id of ["details-link-browser", "details-link-terminal", "details-link-share", "details-link-schedule"]) assert.equal(await page.getByTestId(id).count(), 1);
  // It collapses like the activity pane did, and the header brings it back.
  await page.getByTestId("activity-panel-close").click();
  await page.locator("#activityPanel").waitFor({ state: "hidden" });
  await page.getByTestId("chat-activity-toggle").click();
  await page.locator("#activityPanel").waitFor();
});

test("Projects turns the column into the picker over that project's conversations, with its filters and notes", async () => {
  await page.getByTestId("workspace-projects-button").click();
  // A conversation is open: the projects stay on top, one line each, and its project's list fills the rest.
  await page.locator("#projectsPanel").waitFor();
  await page.locator("#chatsPanel").waitFor();
  assert.equal(await page.locator("body").evaluate((body) => body.classList.contains("ws-picker")), false);
  for (const id of ["project-list-search-input", "all-project-issues-button", "project-create-button", "projects-panel-collapse-button", "chats-panel-collapse-button"]) assert.equal(await visible(id), true, `${id} is in the column`);
  for (const id of ["conversation-list-search-input", "chats-filter-all-button", "show-done-conversations-toggle", "show-scheduled-conversations-toggle", "conversations-tab", "notes-tab", "chats-mark-all-reviewed-button", "session-create-button", "session-create-claude-button"]) {
    assert.equal(await visible(id), true, `${id} is in the project's list`);
  }
  assert.ok(await page.locator("#sessionList .session-card").first().isVisible(), "at least one conversation row fits under the controls");
  // The filters fold behind one button beside the search box, so the list keeps the column; the button counts the
  // filters that are on. The suite starts with them open (launch-chrome.ts); a person starts with them folded.
  const filters = page.getByTestId("conversation-filters-toggle");
  assert.equal(await filters.getAttribute("aria-expanded"), "true");
  const listHeight = () => page.locator("#sessionList").evaluate((list) => list.getBoundingClientRect().height);
  const open = await listHeight();
  await page.getByTestId("show-done-conversations-toggle").check();
  await filters.click();
  assert.equal(await filters.getAttribute("aria-expanded"), "false");
  for (const id of ["chats-filter-all-button", "show-done-conversations-toggle", "show-scheduled-conversations-toggle", "chats-mark-all-reviewed-button"]) {
    assert.equal(await visible(id), false, `${id} folds away`);
  }
  assert.equal(await visible("conversation-list-search-input"), true, "the search box stays");
  assert.ok(await listHeight() >= open + 60, "the list takes the room the filters had");
  assert.equal(await page.getByTestId("conversation-filters-count").textContent(), "1", "a filter that is on shows on the folded button");
  assert.equal(await page.evaluate(() => localStorage.getItem("joint-bob-conversation-filters-open")), "0", "the choice is kept");
  await filters.click();
  await page.getByTestId("show-done-conversations-toggle").uncheck();
  assert.equal(await page.getByTestId("conversation-filters-count").isVisible(), false);
  await page.getByTestId("notes-tab").click();
  await page.getByTestId("quick-notes-section").waitFor();
  await page.getByTestId("conversations-tab").click();
  // Another project is one click away, as in the old projects panel.
  await page.locator(".project-card", { hasText: "Internal Assistant" }).click();
  await page.locator("#projectName", { hasText: "Internal Assistant" }).waitFor({ state: "attached" });
  await page.locator("#sessionList .session-card", { hasText: "Thread-Based Agent Builder" }).waitFor();
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), WORKSPACE_COLUMN_KEY), "projects", "the column remembers the choice");
  // The places keep their labels there (two short columns), and Inbox brings the groups back.
  assert.equal(await page.getByTestId("workspace-places").locator(".ws-place-label").first().isVisible(), true, "labelled places in Projects");
  await page.getByTestId("workspace-inbox-button").click();
  await page.getByTestId("workspace-groups").waitFor();
});

test("New, ⋯ and the places reach every action the old panels had", async () => {
  await page.getByTestId("workspace-new-button").click();
  for (const id of ["workspace-new-conversation", "workspace-new-note", "workspace-new-project", "workspace-new-pi", "workspace-new-claude"]) assert.equal(await visible(id), true, `${id} is in New`);
  await page.getByTestId("workspace-new-project").click();
  await page.locator("#projectDialog[open], dialog[open]").first().waitFor();
  await page.keyboard.press("Escape");
  await page.getByTestId("workspace-more-button").click();
  for (const id of ["pending-reviews-open-button", "recent-sessions-open-button", "running-conversations-open-button", "projects-open-notes-button", "workspace-issues-button", "projects-open-assistants-button"]) assert.equal(await visible(id), true, `${id} is in ⋯`);
  await page.getByTestId("recent-sessions-open-button").click();
  await page.getByTestId("recent-sessions-dialog").waitFor();
  await page.keyboard.press("Escape");
  await page.getByTestId("recent-sessions-dialog").waitFor({ state: "hidden" });

  await page.getByTestId("workspace-board-button").click();
  await page.locator("#boardPanel").waitFor();
  assert.equal(await page.locator("#chatPanel").isVisible(), false, "the board takes the middle");
  await page.getByTestId("workspace-automations-button").click();
  await page.locator("#controlCenterPanel").waitFor();
  assert.equal(await page.locator('[data-testid="control-center-tabs"] [aria-selected="true"]').innerText(), "Automations");
  assert.equal(await page.getByTestId("workspace-automations-button").getAttribute("class").then((value) => value?.includes("on")), true);
  // Bob opens the control center in the middle and keeps its exit rule: Esc twice leaves.
  await page.getByTestId("projects-open-control-center-button").click();
  assert.equal(await visible("workspace-side"), true, "the column stays beside Bob");
  await page.locator("body").press("Escape");
  await page.getByTestId("control-exit-prompt").waitFor();
  await page.locator("body").press("Escape");
  await page.waitForFunction(() => !document.body.classList.contains("view-control"));

  await page.getByTestId("usage-open").click();
  await page.locator("#usageDialog[open]").waitFor();
  await page.getByTestId("usage-close").click();
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-dialog").waitFor();
  await page.getByTestId("settings-cancel-button").click();
  // The person: name, machine and theme; it opens the theme picker.
  assert.match(await page.getByTestId("workspace-person-detail").innerText(), /theme$/);
  await page.getByTestId("workspace-person-button").click();
  await page.getByTestId("appearance-dialog").waitFor();
  await page.getByTestId("appearance-theme-sepia").click();
  assert.match(await page.getByTestId("workspace-person-detail").innerText(), /Sepia theme/);
  await page.getByTestId("appearance-reset-button").click();
  await page.getByTestId("appearance-close-button").click();
});

test("the workspace search opens with what was typed, and can hand it to Bob", async () => {
  await page.getByTestId("workspace-search-input").pressSequentially("terra");
  await page.getByTestId("spotlight-dialog").waitFor();
  assert.equal(await page.getByTestId("spotlight-input").inputValue(), "terra");
  await page.getByTestId("spotlight-option").filter({ hasText: "Terraform state locking" }).first().waitFor();
  const bob = page.getByTestId("spotlight-option").filter({ hasText: "Ask Bob" });
  await bob.click();
  await page.waitForFunction(() => document.body.classList.contains("view-control"));
  assert.equal(await page.getByTestId("control-chat-input").inputValue(), "terra");
  await page.getByTestId("control-center-close-button").click();
});

test("[ folds the column to a rail of icons and back", async () => {
  await page.keyboard.press("Control+Alt+BracketLeft");
  await page.getByTestId("projects-panel-expand-button").waitFor();
  const width = await page.getByTestId("workspace-side").evaluate((side) => side.getBoundingClientRect().width);
  assert.ok(width < 80, `the rail is narrow (${width}px)`);
  assert.equal(await visible("projects-open-control-center-button"), true, "the places stay as icons");
  await page.getByTestId("projects-panel-expand-button").click();
  await page.getByTestId("workspace-groups").waitFor();
});

test("between 701 and 1023 px the column stays and the details float; the phone keeps its own layout", async () => {
  // Leaving Bob went back to the board; Inbox brings the open conversation back to the middle.
  await page.getByTestId("workspace-inbox-button").click();
  // Choosing another project closed the conversation, so the middle is Home: a row of the column opens one again.
  await page.waitForTimeout(200);
  if (await page.getByTestId("home-page").isVisible()) await page.getByTestId("workspace-group-row").first().click();
  await page.locator("#chatPanel").waitFor();
  await page.setViewportSize({ width: 820, height: 800 });
  await frames();
  assert.equal(await visible("workspace-side"), true);
  assert.equal(await page.locator(".mobile-nav").isVisible(), false);
  if (!(await page.locator("#activityPanel").isVisible())) await page.getByTestId("chat-activity-toggle").click();
  assert.equal(await page.locator("#activityPanel").evaluate((panel) => getComputedStyle(panel).position), "absolute", "the details float over the conversation");
  const overflow = await page.evaluate(() => document.scrollingElement!.scrollWidth - innerWidth);
  assert.ok(overflow <= 0, `nothing runs off the side (${overflow}px)`);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.body.classList.contains("focus-ui"));
  assert.equal(await visible("workspace-side"), false, "the phone has no left column");
  // The controls the desktop moved are back where the phone's menus look for them.
  assert.equal(await page.locator(".chat-toolbar-actions #backgroundTasksButton").count(), 1);
  assert.equal(await page.locator(".chat-more-actions #chatFilesButton").count(), 1);
  assert.equal(await page.locator(".chat-more-actions #chatDoneButton").count(), 1);
  assert.equal(await page.locator(".chat-actions #abortButton").count(), 1);
  assert.equal(await page.locator(".activity-tabs #activityChatTab").count(), 1);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => !document.body.classList.contains("focus-ui"));
  assert.equal(await page.getByTestId("chat-head-actions").locator("#chatDoneButton").count(), 1, "and move back on the desktop");
});

test("the workspace raised no page errors", () => {
  assert.deepEqual(pageErrors, []);
});
