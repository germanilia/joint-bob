import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { type Browser, type Page } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { reach } from "./workspace-menus.js";
import { seedDevEnvironment, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "../dev-nodes.js";

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let server: ChildProcess;
let browser: Browser;
let page: Page;
const consoleErrors: string[] = [];

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-shortcut-hints-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  server = await startDevNode(environment, node);
  browser = await launchChrome({ headless: process.env.HEADED !== "1" });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
}, { timeout: 120_000 });

after(async () => {
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

async function signIn(): Promise<void> {
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 20_000 });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card").first().waitFor({ timeout: 20_000 });
}

const hint = (testid: string) => page.locator(`[data-testid="${testid}"] .shortcut-hint`);

// The badges only exist on screen while the command modifiers are held, so every
// assertion about them holds Control+Option first and lets go afterwards.
async function holdingModifiers<T>(read: () => Promise<T>): Promise<T> {
  await page.keyboard.down("Control");
  await page.keyboard.down("Alt");
  await page.locator("body.shortcuts-revealed").waitFor({ timeout: 2000 });
  try { return await read(); } finally {
    await page.keyboard.up("Alt");
    await page.keyboard.up("Control");
  }
}

test("header icons reveal the shortcut that opens them while the modifiers are held", async () => {
  await signIn();
  assert.equal(await hint("recent-sessions-open-button").isVisible(), false, "a resting button shows no badge");
  // Every command rides Control+Option, so the badge carries the key alone and the
  // whole chord stays in the badge's tooltip.
  await holdingModifiers(async () => {
    assert.equal(await hint("recent-sessions-open-button").innerText(), "K", "recents shows its key");
    assert.equal(await hint("pending-reviews-open-button").innerText(), "R", "reviews shows its key");
    assert.equal(await hint("running-conversations-open-button").innerText(), "O", "running shows its key");
    assert.equal(await hint("settings-open-button").innerText(), ",", "settings shows its key");
    assert.equal(await hint("projects-open-control-center-button").innerText(), "V", "the control center launch shows its key");
  });
  assert.equal(await hint("recent-sessions-open-button").isVisible(), false, "letting go hides the badges again");
  assert.equal(await hint("recent-sessions-open-button").getAttribute("title"), process.platform === "darwin" ? "\u2303\u2325K" : "Ctrl+Alt+K", "the badge spells the whole chord on hover");
});

// The old projects toolbar became the workspace's left column: Bob (the control center) and Costs are places,
// Settings is in the foot, and the rest is in the column's ⋯ menu, where each row writes out its chord.
test("the control center shares the top toolbar with larger icons and readable shortcut badges", async () => {
  const places = page.getByTestId("workspace-places");
  assert.equal(await places.locator("#openControlCenterButton").count(), 1, "the control center is the first place, Bob");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  for (const button of [places.locator("#openControlCenterButton"), places.getByTestId("usage-open"), page.getByTestId("settings-open-button")]) {
    const icon = await button.locator("svg").boundingBox();
    assert.ok(icon && icon.width >= 16, `a place's icon must be at least 16px, got ${icon?.width}`);
    const font = await holdingModifiers(() => button.locator(".shortcut-hint").evaluate((badge) => parseFloat(getComputedStyle(badge).fontSize)));
    assert.ok(font >= 13, `shortcut needs at least 13px, got ${font}`);
    // The badge hangs under the row, so carrying one costs the row no height.
    const box = await button.boundingBox();
    assert.ok(box && box.height <= 36, `a place stays one line tall, got ${box?.height}px`);
  }
  await page.getByTestId("workspace-more-button").click();
  const menu = page.getByTestId("workspace-more-menu");
  const assistants = menu.getByTestId("projects-open-assistants-button");
  assert.equal(await assistants.isVisible(), true, "the column's ⋯ menu has its own switch to assistants");
  assert.equal(await assistants.getAttribute("href"), "/assistant.html");
  const chord = await menu.getByTestId("recent-sessions-open-button").locator(".shortcut-hint").evaluate((badge) => getComputedStyle(badge, "::after").content);
  assert.equal(chord, JSON.stringify(process.platform === "darwin" ? "⌃⌥K" : "Ctrl+Alt+K"), "a menu row writes out its chord");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
});

test("chat controls advertise shortcuts", async () => {
  for (const id of ["chat-node-select", "chat-harness-select", "chat-model-button", "chat-reasoning-select", "chat-open-terminal-button", "chat-open-browser-button", "chat-notify-button", "chat-rename-button", "chat-cron-button", "background-tasks-open", "chat-files-button", "chat-session-menu-button", "chat-done-button", "chat-auto-respond-button", "chat-git-button", "activity-story-button"]) {
    const control = page.getByTestId(id);
    const host = await control.evaluate((element) => element.closest("[data-shortcut-hint]")?.getAttribute("data-shortcut-hint"));
    assert.ok(host, `${id} needs a shortcut hint`);
  }
  assert.equal(await page.getByTestId("chat-safeguards-button").count(), 0);
});

test("Escape closes recent conversations even with a search query", async () => {
  for (const query of ["", "Thread"]) {
    await (await reach(page, "recent-sessions-open-button")).click();
    const dialog = page.getByTestId("recent-sessions-dialog");
    await dialog.waitFor({ state: "visible" });
    await page.getByTestId("recent-sessions-search-input").fill(query);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 2000 });
    // Recent lives in the column's ⋯ menu, which closed when the dialog opened: focus goes back to the menu's button.
    assert.equal(await page.getByTestId("workspace-more-button").evaluate((button) => button === document.activeElement), true);
  }
});

test("the running and settings shortcuts open their dialogs", async () => {
  await page.keyboard.press("Control+Alt+KeyO");
  await page.getByTestId("running-conversations-dialog").waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page.getByTestId("running-conversations-dialog").waitFor({ state: "hidden" });
  await page.keyboard.press("Control+Alt+Comma");
  await page.getByTestId("settings-dialog").waitFor({ state: "visible" });
  await page.getByTestId("settings-cancel-button").click();
  await page.getByTestId("settings-dialog").waitFor({ state: "hidden" });
});

test("a saved chord retitles the badges without a reload", async () => {
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-dialog").waitFor({ state: "visible" });
  await page.getByTestId("settings-tab-shortcuts").click();
  const recents = page.getByTestId("keymap-recents-input");
  await recents.click();
  // A captured chord saves on its own.
  await page.keyboard.press("Control+KeyJ");
  await page.locator('[data-testid="settings-save-state"][data-state="saved"]').waitFor();
  await page.getByTestId("keymap-status").filter({ hasText: "Saved." }).waitFor();
  await page.getByTestId("settings-cancel-button").click();
  await page.getByTestId("settings-dialog").waitFor({ state: "hidden" });
  assert.equal(await hint("recent-sessions-open-button").textContent(), "J", "the badge follows the saved chord");

  // Put the defaults back so the other tests keep seeing them.
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-dialog").waitFor({ state: "visible" });
  await page.getByTestId("settings-tab-shortcuts").click();
  await page.getByTestId("keymap-reset-button").click();
  await page.locator('[data-testid="settings-save-state"][data-state="saved"]').waitFor();
  await page.getByTestId("keymap-status").filter({ hasText: "Saved." }).waitFor();
  await page.getByTestId("settings-cancel-button").click();
  await page.getByTestId("settings-dialog").waitFor({ state: "hidden" });
  assert.equal(await hint("recent-sessions-open-button").textContent(), "K");
});

// Until a project is chosen the picker has the workspace's whole left column: its title row keeps collapse, search
// sits under it, and the app's name is written once, at the top of the column, beside New.
test("the project title keeps collapse while its action row sits above search", async () => {
  const header = await page.locator("#projectsPanel .panel-bar").boundingBox();
  const search = await page.locator("#projectsPanel .project-search-row").boundingBox();
  assert.ok(header && search, "the project panel rows rendered");
  assert.equal(await page.locator("#projectsPanel .panel-bar > #collapseProjectsButton").isVisible(), true, "collapse stays in the title row");
  assert.ok(search!.y >= header!.y + header!.height - 1, `search (y=${search!.y}) starts below the title row (ends ${header!.y + header!.height})`);
  assert.equal(await page.locator("#projectsPanel > .project-actions:visible").count(), 0, "the old action row moved into the column");

  const cut = await page.locator("#workspaceSide .ws-name").evaluate((node) => node.scrollWidth > node.clientWidth + 1);
  assert.equal(cut, false, "the app name fits its row");
});

test("the chat toolbar keeps its controls and actions on one row when there is room, and hangs the badges below them", async () => {
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card", { hasText: "Thread-Based Agent Builder" }).click();
  await page.locator("#modelButton:enabled").waitFor();
  // Wide enough that the selects, the model button and the action row all fit on one line.
  await page.setViewportSize({ width: 2400, height: 900 });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

  // The desktop header: the four chips (agent, model, effort, machine) on one row under the title, and Mark done, the
  // details toggle and ⋯ on the title's row; the rest of the actions wait in ⋯.
  const resting = await page.evaluate(() => {
    const bar = document.querySelector("#chatToolbar")!;
    const head = document.querySelector("#chatHeadActions")!;
    return {
      badges: [...bar.querySelectorAll(".shortcut-hint"), ...head.querySelectorAll(":scope > button .shortcut-hint")].filter((badge) => badge.getBoundingClientRect().height > 0).length,
      controls: ["#chatNodeSelect", "#chatHarnessSelect", "#modelButton", "#reasoningLevelSelect"]
        .map((selector) => bar.querySelector(selector)!.getBoundingClientRect())
        .map((box) => Math.round((box.top + box.bottom) / 2 * 10) / 10),
      // The chips must stay inside the card instead of riding off its edge.
      fits: [...bar.querySelectorAll(".chat-toolbar-control")].every((control) => control.getBoundingClientRect().right <= bar.getBoundingClientRect().right + 0.5),
    };
  });

  // Every badge hangs under the control it belongs to: clear of the label, still
  // centred on it, and out of the layout so it neither adds a line nor moves one.
  const overlays = await holdingModifiers(() => page.evaluate(() => {
    const badges = [...document.querySelectorAll("#chatToolbar .shortcut-hint, #chatHeadActions > button .shortcut-hint")];
    return badges.filter((badge) => badge.getBoundingClientRect().height > 0).map((badge) => {
      const host = badge.parentElement!.getBoundingClientRect();
      const box = badge.getBoundingClientRect();
      return {
        below: box.top >= host.bottom - 1 && box.top - host.bottom <= 8,
        centred: Math.abs((box.left + box.right) / 2 - (host.left + host.right) / 2) <= 1,
        height: box.height,
      };
    });
  }));

  await page.setViewportSize({ width: 1440, height: 900 });

  assert.equal(resting.badges, 0, "a resting header shows no badges at all");
  assert.ok(overlays.length >= 5, `the chips and the header's buttons carry badges, saw ${overlays.length}`);
  assert.ok(overlays.every((badge) => badge.below && badge.centred), `each badge sits under its own control, got ${JSON.stringify(overlays)}`);
  assert.equal(resting.fits, true, "the chips stay inside the conversation");
  const controlLine = resting.controls[0];
  assert.ok(resting.controls.every((middle) => Math.abs(middle - controlLine) <= 1),
    `the chips share one row, got ${JSON.stringify(resting.controls)}`);
});

test("the chat toolbar icons share one size and name themselves on hover at once", async () => {
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card", { hasText: "Thread-Based Agent Builder" }).click();
  await page.locator("#modelButton:enabled").waitFor();
  await page.setViewportSize({ width: 1800, height: 900 });

  // The actions are rows of the header's ⋯ menu now, each with its icon and its name.
  await page.getByTestId("chat-more-button").click();
  const sizes = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("#chatMoreMenu .chat-action")]
    .filter((button) => button.getBoundingClientRect().height > 0)
    .map((button) => ({ id: button.id, width: Math.round(button.getBoundingClientRect().width), height: Math.round(button.getBoundingClientRect().height) })));
  assert.ok(sizes.length >= 10, `the menu shows its actions, saw ${JSON.stringify(sizes)}`);
  assert.ok(sizes.every((size) => size.width === sizes[0].width && size.height === sizes[0].height),
    `every action row is the same size, got ${JSON.stringify(sizes)}`);
  assert.equal(await page.locator("#chatMoreMenu .chat-action .chat-action-label").first().isVisible(), true, "each row names its action");
  await page.getByTestId("chat-more-button").click();
  // Tasks sits in the details column's Tasks summary, named in words.
  const tasks = await reach(page, "background-tasks-open");
  assert.equal(await tasks.locator(".background-tasks-icon").isVisible(), true, "Tasks shows an icon");
  assert.equal(await tasks.locator(".background-tasks-label").isVisible(), true, "and its word");

  // The header's icon-only buttons name themselves at once.
  const tooltip = page.locator(".quick-tooltip");
  const toggle = page.getByTestId("chat-activity-toggle");
  const title = await toggle.getAttribute("title");
  await toggle.hover();
  await tooltip.waitFor({ state: "visible", timeout: 600 });
  assert.equal(await tooltip.innerText(), title);
  assert.equal(await toggle.getAttribute("title"), null, "the native tooltip is held back while ours shows");
  await page.mouse.move(700, 895);
  await tooltip.waitFor({ state: "hidden" });
  assert.equal(await toggle.getAttribute("title"), title, "the title comes back once the pointer leaves");
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("the composer shortcut puts the cursor in the message box", async () => {
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card", { hasText: "Thread-Based Agent Builder" }).click();
  await page.locator("#messageInput:enabled").waitFor();
  await page.getByTestId("recent-sessions-open-button").focus();
  await page.keyboard.press("Control+Alt+I");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "messageInput", "the shortcut lands in the composer");

  // The composer sits on the bottom edge, so its badge hangs above the row: below it
  // would fall off the screen.
  const badge = await holdingModifiers(() => page.evaluate(() => {
    const host = document.querySelector("#composer .composer-row")!;
    const mark = host.querySelector(".shortcut-hint")!;
    const box = mark.getBoundingClientRect();
    return { key: mark.textContent, above: box.bottom <= host.getBoundingClientRect().top + 1 };
  }));
  assert.equal(badge.key, "I", "the composer advertises its key");
  assert.ok(badge.above, "the composer badge sits above the row so the window edge never clips it");
});

test("chat shortcuts focus selectors and open actions", async () => {
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card", { hasText: "Thread-Based Agent Builder" }).click();
  await page.locator("#modelButton:enabled").waitFor();
  for (const [key, id] of [["H", "chatNodeSelect"], ["A", "chatHarnessSelect"], ["T", "reasoningLevelSelect"]]) {
    await page.keyboard.press(`Control+Alt+${key}`);
    assert.equal(await page.evaluate(() => document.activeElement?.id), id, `${key} focuses ${id}`);
  }
  for (const [key, target, close] of [["M", "model-dialog", "model-dialog-close-button"], ["X", "terminal-panel", "terminal-close-button"], ["E", "rename-session-input", null]]) {
    await page.keyboard.press(`Control+Alt+${key}`);
    await page.getByTestId(target!).waitFor({ timeout: 5000 });
    if (close) await page.getByTestId(close).click();
    else await page.keyboard.press("Escape");
    await page.getByTestId(target!).waitFor({ state: "hidden" });
  }
  await page.route(/\/api\/browser\/(?:sessions|profiles)\?/, (route) => route.fulfill({
    json: route.request().url().includes("/profiles?") ? { profiles: [] } : { sessions: [] },
  }));
  await page.keyboard.press("Control+Alt+B");
  await page.locator("#browserPanel").waitFor();
  await page.getByTestId("browser-close-viewer").click();
  await page.keyboard.press("Control+Alt+S");
  await page.getByTestId("cron-dialog").waitFor();
  await page.getByTestId("cron-close").click();
  // The actions the letters ran out for ride Shift as well.
  await page.keyboard.press("Control+Alt+Shift+R");
  await page.getByTestId("auto-respond-dialog").waitFor();
  await page.getByTestId("auto-respond-cancel-button").click();
  await page.getByTestId("auto-respond-dialog").waitFor({ state: "hidden" });
  // The seeded project is no git repository and marking done would change the fixture,
  // so these only prove the key presses the button, with its own handler held back.
  const pressed = await page.evaluate(() => {
    const seen: string[] = [];
    for (const id of ["chatGitButton", "chatDoneButton"]) {
      document.getElementById(id)!.addEventListener("click", (event) => { event.stopImmediatePropagation(); seen.push(id); }, { capture: true });
    }
    (window as unknown as { pressedChatButtons: string[] }).pressedChatButtons = seen;
    return seen.length;
  });
  assert.equal(pressed, 0);
  for (const key of ["G", "D"]) await page.keyboard.press(`Control+Alt+Shift+${key}`);
  assert.deepEqual(await page.evaluate(() => (window as unknown as { pressedChatButtons: string[] }).pressedChatButtons), ["chatGitButton", "chatDoneButton"]);
  await page.keyboard.press("Control+Alt+Shift+A");
  await page.locator("#rowMenu:popover-open").waitFor();
  await page.keyboard.press("Escape");
  await page.locator("#rowMenu:popover-open").waitFor({ state: "detached" });
  assert.equal(await page.locator("#chatDoneButton .shortcut-hint").textContent(), "⇧D", "a Shift chord says so on its badge");
  await page.context().grantPermissions(["notifications"]);
  const before = await page.getByTestId("chat-notify-button").getAttribute("aria-pressed");
  await page.keyboard.press("Control+Alt+Y");
  // Notify lives in the conversation's ⋯ menu (and as a switch in the details), so it is not on screen.
  await page.locator(`#notifyButton[aria-pressed="${before === "true" ? "false" : "true"}"]`).waitFor({ state: "attached" });
});

test("the shortcut journey produces no console errors", () => {
  assert.deepEqual(consoleErrors, []);
});
