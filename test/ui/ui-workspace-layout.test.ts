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

test("the details column keeps its controls together at the top, More shows its three rows at any text size, and every theme draws them readably", async () => {
  if (!(await page.locator("#activityPanel").isVisible())) await page.getByTestId("chat-activity-toggle").click();
  await page.getByTestId("activity-activity-tab").click();
  // The test runner wraps named functions in a helper the page does not have.
  await page.evaluate("window.__name = (value) => value");
  // Browser, Terminal, Share and Schedule sit directly under the segments, above the column's content, each with an icon.
  const rows = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const links = [...document.querySelectorAll<HTMLElement>("#detailsLinks .ws-link")];
    return {
      segments: rect("#activityPanel .activity-tabs"), links: rect("#detailsLinks"), body: rect("#activityBody"), foot: rect("#detailsFoot"),
      icons: links.every((link) => link.querySelector("svg") !== null && link.textContent!.trim().length > 0),
      cut: links.filter((link) => link.scrollWidth > link.clientWidth + 1 || link.querySelector("span")!.scrollWidth > link.querySelector("span")!.clientWidth + 1).map((link) => link.dataset.testid),
      inFoot: document.querySelectorAll("#detailsFoot button:not([role=switch])").length,
    };
  });
  assert.ok(rows.links.top >= rows.segments.bottom && rows.links.top - rows.segments.bottom <= 16, `the actions are right under the segments (${rows.segments.bottom} → ${rows.links.top})`);
  assert.ok(rows.links.bottom <= rows.body.top, "and above the column's content");
  assert.ok(rows.foot.top >= rows.body.bottom - 1, "the switches stay at the foot");
  assert.equal(rows.inFoot, 0, "nothing but the two switches is at the foot");
  assert.equal(rows.icons, true, "each action has an icon and a label");
  assert.deepEqual(rows.cut, [], "no label is cut");
  assert.equal(await page.locator("#detailsFoot [role=switch]").count(), 2);

  // More is a segment with a pane of its own: a click shows the side chat, Story and the Activity overview, each with
  // a line about it and its button. With larger Details text too: the old popover menu opened outside the window.
  for (const zoom of ["1", "1.3"]) {
    await page.evaluate((value) => document.documentElement.style.setProperty("--ui-zoom-activity", value), zoom);
    await page.getByTestId("activity-activity-tab").click();
    await page.getByTestId("details-more-button").click();
    assert.equal(await page.getByTestId("details-more-button").getAttribute("aria-selected"), "true");
    assert.equal(await visible("activity-body"), false);
    for (const [row, button] of [["details-more-chat", "activity-chat-tab"], ["details-more-story", "activity-story-button"], ["details-more-overview", "activity-overview-button"]]) {
      const seen = await page.getByTestId(row).evaluate((element, id) => {
        const inside = (rect: DOMRect) => rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
        element.scrollIntoView({ block: "nearest" });
        return { words: element.querySelector("p")!.textContent!.trim().length > 20 && inside(element.querySelector("b")!.getBoundingClientRect()), button: inside(element.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect()) };
      }, button);
      assert.deepEqual(seen, { words: true, button: true }, `${row} shows inside the window at text size ${zoom}`);
    }
  }
  await page.evaluate(() => document.documentElement.style.removeProperty("--ui-zoom-activity"));
  // The side chat opens from its row; More stays the way back to the three rows.
  await page.getByTestId("activity-chat-tab").click();
  assert.equal(await visible("conversation-chat"), true);
  await page.getByTestId("details-more-button").click();
  assert.equal(await visible("details-more"), true);
  assert.equal(await visible("conversation-chat"), false);
  await page.getByTestId("details-more-button").press("ArrowLeft");
  assert.equal(await visible("details-tasks"), true, "Left and Right walk the segments");
  await page.getByTestId("details-more-button").click();

  // Contrast, measured: every label at least 4.5:1 on its own fill, and the outline of the segments' track, of the lit
  // segment and of each action button at least 3:1 against the column, in every theme.
  const themes: Array<[string, string]> = [["light", ""], ["light", "sepia"], ["dark", ""], ["dark", "midnight"], ["dark", "graphite"]];
  const before = await page.evaluate(() => [document.documentElement.dataset.theme ?? "", document.documentElement.dataset.palette ?? ""]);
  for (const [theme, palette] of themes) {
    await page.evaluate(([name, tone]) => {
      document.documentElement.dataset.theme = name;
      if (tone) document.documentElement.dataset.palette = tone; else delete document.documentElement.dataset.palette;
    }, [theme, palette]);
    // Colours ease from one theme to the next; measure them once they have arrived.
    await page.waitForTimeout(400);
    const weak = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      const rgba = (colour: string) => { context.clearRect(0, 0, 1, 1); context.fillStyle = colour; context.fillRect(0, 0, 1, 1); const data = context.getImageData(0, 0, 1, 1).data; return [data[0], data[1], data[2], data[3] / 255]; };
      const over = (top: number[], under: number[]) => [0, 1, 2].map((index) => top[index] * top[3] + under[index] * (1 - top[3])).concat(1);
      const fillOf = (element: Element | null) => {
        const chain: Element[] = [];
        for (let node = element; node; node = node.parentElement) chain.unshift(node);
        return chain.reduce((colour, node) => over(rgba(getComputedStyle(node).backgroundColor), colour), [255, 255, 255, 1]);
      };
      const light = (colour: number[]) => { const part = (value: number) => { const unit = value / 255; return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4; }; return 0.2126 * part(colour[0]) + 0.7152 * part(colour[1]) + 0.0722 * part(colour[2]); };
      const ratio = (one: number[], other: number[]) => { const [high, low] = [light(one), light(other)].sort((a, b) => b - a); return (high + 0.05) / (low + 0.05); };
      const found: string[] = [];
      const text = (selector: string) => {
        for (const element of document.querySelectorAll<HTMLElement>(selector)) {
          if (!element.getClientRects().length || element.matches(":disabled")) continue;
          const fill = fillOf(element);
          const value = ratio(over(rgba(getComputedStyle(element).color), fill), fill);
          if (value < 4.5) found.push(`${selector} text ${value.toFixed(2)}`);
        }
      };
      const edge = (selector: string) => {
        for (const element of document.querySelectorAll<HTMLElement>(selector)) {
          if (!element.getClientRects().length || element.matches(":disabled")) continue;
          const around = fillOf(element.parentElement);
          const shadow = getComputedStyle(element).boxShadow;
          const colour = shadow.includes("inset") ? shadow.match(/(rgba?\([^)]*\)|color\([^)]*\))/)?.[1] : undefined;
          const value = colour ? ratio(over(rgba(colour), around), around) : 1;
          if (value < 3) found.push(`${selector} outline ${value.toFixed(2)}`);
        }
      };
      text("#activityPanel .activity-tabs > button");
      text("#detailsLinks .ws-link");
      text("#activityPanelCloseButton");
      text("#activityPanel .ws-pane-actions > button");
      text("#detailsFoot .ws-switch-row");
      edge("#activityPanel .activity-tabs");
      edge("#activityPanel .activity-tabs > button[aria-selected=true]");
      edge("#detailsLinks .ws-link");
      edge("#activityPanelCloseButton");
      edge("#activityPanel .ws-pane-actions > button");
      edge("#detailsFoot .ws-switch-row[aria-checked=false] .ws-switch");
      return found;
    });
    assert.deepEqual(weak, [], `${palette || theme}: the column's controls are readable`);
  }
  await page.evaluate(([name, tone]) => {
    if (name) document.documentElement.dataset.theme = name; else delete document.documentElement.dataset.theme;
    if (tone) document.documentElement.dataset.palette = tone; else delete document.documentElement.dataset.palette;
  }, before);
  await page.getByTestId("activity-activity-tab").click();
});

const box = (selector: string) => page.locator(selector).evaluate((element) => {
  const rect = element.getBoundingClientRect();
  return { left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top), bottom: Math.round(rect.bottom), width: Math.round(rect.width) };
});

test("Projects shows two columns: the projects under the places, and the chosen project's conversations beside them", async () => {
  await page.getByTestId("workspace-projects-button").click();
  // A conversation is open: its project's conversations have their own column between the projects and the conversation.
  await page.locator("#projectsPanel").waitFor();
  await page.locator("#chatsPanel").waitFor();
  assert.equal(await page.locator("body").evaluate((body) => body.classList.contains("ws-picker")), false);
  const side = await box("#workspaceSide");
  const projects = await box("#projectsPanel");
  const conversations = await box("#chatsPanel");
  const chat = await box("#chatPanel");
  assert.ok(projects.width >= 220 && projects.width <= 290, `the projects column is ${projects.width}px wide`);
  assert.ok(conversations.width >= 288 && conversations.width <= 340, `the conversations column is ${conversations.width}px wide`);
  assert.ok(projects.right <= conversations.left && conversations.right <= chat.left, "projects, conversations, conversation: side by side, none over another");
  assert.ok(projects.top >= side.bottom - 1, "the projects are under the places");
  assert.ok(conversations.top <= side.top + 8, "the conversations column starts at the top of the window");
  assert.equal(await page.locator("#chatsPanel #projectName").innerText(), "Internal Assistant", "the conversations column is headed by its project");
  for (const id of ["project-list-search-input", "all-project-issues-button", "project-create-button", "projects-panel-collapse-button", "chats-panel-collapse-button"]) assert.equal(await visible(id), true, `${id} is in the columns`);
  for (const id of ["conversation-list-search-input", "conversation-filters-toggle", "chats-filter-all-button", "show-done-conversations-toggle", "show-scheduled-conversations-toggle", "conversations-tab", "notes-tab", "chats-mark-all-reviewed-button", "session-create-button", "session-create-claude-button"]) {
    assert.equal(await visible(id), true, `${id} is in the project's list`);
  }
  // The places are one column of rows with their whole names.
  const places = await page.getByTestId("workspace-places").locator(".ws-place").evaluateAll((items) => items.map((item) => {
    const label = item.querySelector(".ws-place-label");
    const rect = item.getBoundingClientRect();
    return { left: Math.round(rect.left), top: Math.round(rect.top), cut: label.scrollWidth > label.clientWidth, shown: label.getClientRects().length > 0 };
  }));
  assert.ok(places.every((place) => place.shown && !place.cut), "every place shows its whole name");
  assert.equal(new Set(places.map((place) => place.left)).size, 1, "the places are one column");
  assert.equal(new Set(places.map((place) => place.top)).size, places.length, "one place per row");
  // Nothing in either column scrolls or is cut: every row in sight is whole, and the rows of a list share one height.
  for (const list of ["#sessionList", "#projectList"]) {
    const rows = await page.locator(`${list} .list-row`).evaluateAll((items, selector) => {
      const host = document.querySelector<HTMLElement>(selector);
      const frame = host.getBoundingClientRect();
      const clip = parseFloat((host.style.clipPath.match(/inset\(0(?:px)? 0(?:px)? ([\d.]+)px/) ?? [])[1] ?? "0");
      return items.map((item) => item.getBoundingClientRect()).filter((rect) => rect.height > 0 && rect.bottom > frame.top + 1 && rect.top < frame.bottom - clip - 1)
        .map((rect) => ({ whole: rect.top >= frame.top - 1 && rect.bottom <= frame.bottom - clip + 1, height: Math.round(rect.height), top: Math.round(rect.top - frame.top), room: Math.round(frame.height - clip) }));
    }, list);
    assert.ok(rows.length >= 2, `${list}: several rows fit (${rows.length})`);
    assert.ok(rows.every((row) => row.whole), `${list}: no row is cut at the top or the bottom: ${JSON.stringify(rows)}`);
    assert.equal(new Set(rows.map((row) => row.height)).size, 1, `${list}: rows share one height: ${rows.map((row) => row.height)}`);
    assert.equal(await page.locator(list).evaluate((host) => getComputedStyle(host).overflowY), "hidden", `${list} has no scroll bar`);
  }
  // A row's pin and ⋮ come with the pointer or the keyboard; a resting row shows neither, and keeps its height.
  const row = page.locator("#sessionList > .list-row").first();
  await page.mouse.move(900, 500);
  await page.getByTestId("chat-message-input").focus();
  const shown = (selector: string) => row.locator(selector).evaluate((button) => getComputedStyle(button).opacity === "1");
  assert.equal(await shown("[data-testid='session-menu-button']"), false, "a resting row shows no ⋮");
  assert.equal(await shown(".pin-button"), false, "a resting row shows no pin");
  const resting = await row.evaluate((item) => item.getBoundingClientRect().height);
  await row.locator(".session-card").hover();
  await page.waitForTimeout(250);
  assert.equal(await shown("[data-testid='session-menu-button']"), true, "⋮ shows under the pointer");
  assert.equal(await shown(".pin-button"), true, "the pin shows under the pointer");
  assert.equal(await row.evaluate((item) => item.getBoundingClientRect().height), resting, "the row keeps its height");
  assert.equal(await row.evaluate((item) => item.querySelector(".session-card > strong").getBoundingClientRect().right <= item.querySelector(".pin-button").getBoundingClientRect().left), true, "the title ends before the pin and ⋮");
  await page.mouse.move(900, 500);
  await row.locator(".session-card").focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains("pin-button")), true, "Tab reaches the pin from the row");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.testid), "session-menu-button", "and then ⋮");
  await page.getByTestId("chat-message-input").focus();
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
  // Another project is one click away: its conversations take the second column.
  await page.locator(".project-card", { hasText: "Joint Bob" }).click();
  await page.locator("#projectName", { hasText: "Joint Bob" }).waitFor();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).click();
  await page.locator("#projectName", { hasText: "Internal Assistant" }).waitFor();
  await page.locator("#sessionList .session-card", { hasText: "Thread-Based Agent Builder" }).waitFor();
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), WORKSPACE_COLUMN_KEY), "projects", "the column remembers the choice");

  // Each column folds on its own chevron: ] the conversations to a strip, [ the left column to the rail.
  await page.getByTestId("chats-panel-collapse-button").click();
  await page.getByTestId("chats-panel-expand-button").waitFor();
  assert.ok((await box("#chatsPanel")).width <= 48, "the conversations fold to a strip");
  assert.equal(await visible("project-list-search-input"), true, "the projects stay");
  await page.getByTestId("chats-panel-expand-button").click();
  await page.getByTestId("conversation-list-search-input").waitFor();
  await page.getByTestId("projects-panel-collapse-button").click();
  await page.getByTestId("projects-panel-expand-button").waitFor();
  assert.ok((await box("#workspaceSide")).width < 80, "the left column folds to the rail");
  assert.equal(await visible("conversation-list-search-input"), true, "the conversations stay");
  await page.getByTestId("projects-panel-expand-button").click();
  await page.getByTestId("project-list-search-input").waitFor();

  // A narrower window keeps the conversation usable: the details give way first, then the left column folds itself.
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.locator("body.ws-details-tucked").waitFor();
  assert.equal(await page.locator("#activityPanel").isVisible(), false, "at 1100 px the details are put away");
  assert.equal(await visible("project-list-search-input"), true, "and both columns stay");
  assert.ok((await box("#chatPanel")).width >= 480, "the conversation keeps a readable width");
  await page.getByTestId("chat-activity-toggle").click();
  await page.locator("#activityPanel").waitFor();
  await page.setViewportSize({ width: 1030, height: 900 });
  await page.locator("body.ws-auto-rail").waitFor();
  assert.ok((await box("#workspaceSide")).width < 80, "at 1030 px the left column is the rail");
  assert.equal(await visible("conversation-list-search-input"), true, "the conversations stay beside it");
  assert.ok((await box("#chatPanel")).width >= 480, "and the conversation keeps a readable width");
  await page.getByTestId("projects-panel-expand-button").click();
  await page.getByTestId("project-list-search-input").waitFor();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator("body:not(.ws-auto-rail):not(.ws-details-float)").waitFor();
  assert.equal(await visible("project-list-search-input"), true);

  // Inbox brings the groups back, in one column.
  await page.getByTestId("workspace-inbox-button").click();
  await page.getByTestId("workspace-groups").waitFor();
  assert.equal(await page.locator("#chatsPanel").isVisible(), false, "Inbox has no second column");
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
  // Settings is the gear at the end of the person's row, beside the palette: an icon with a name for readers, no row of its own.
  const foot = await page.evaluate(() => {
    // No named helper in here: the test loader wraps one in a call the page does not have.
    const [footBox, palette, gearBox] = ["#workspaceFoot", "#workspacePersonButton > svg", "#settingsButton"].map((selector) => document.querySelector(selector)!.getBoundingClientRect().toJSON() as DOMRect);
    const gear = document.querySelector<HTMLElement>("#settingsButton")!;
    const label = [...gear.childNodes].filter((node) => !(node as HTMLElement).classList?.contains("shortcut-hint")).map((node) => node.textContent ?? "").join("").trim();
    return { foot: footBox, palette, gear: gearBox, text: label, label: gear.getAttribute("aria-label"), title: gear.title, hint: gear.dataset.shortcutHint };
  });
  assert.equal(foot.text, "", "the gear carries no visible label");
  assert.deepEqual([foot.label, foot.title, foot.hint], ["Settings", "Settings", "settings"]);
  assert.deepEqual([foot.gear.width, foot.gear.height], [foot.palette.width, foot.palette.height], "the gear is the palette's size");
  assert.ok(foot.gear.left >= foot.palette.right && foot.gear.left - foot.palette.right <= 8, "the gear sits right after the palette");
  assert.ok(Math.abs((foot.gear.top + foot.gear.bottom) / 2 - (foot.palette.top + foot.palette.bottom) / 2) <= 1, "on the same line");
  assert.ok(foot.foot.height <= 60, `the foot is one row, got ${foot.foot.height}px`);
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
