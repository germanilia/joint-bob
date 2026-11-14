// The phone sweep: every main phone screen at 360 and 390 px, in several themes, has no sideways overflow, no text under
// 13 px, no control under 44 px and readable contrast. Exploratory output goes to PHONE_AUDIT_OUT when set.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
const found: Record<string, string[]> = {};
const shots = process.env.PHONE_SHOTS;
let width = 390;
let height = 844;
let theme = "light";

const card = (id: string, column: string, extra: Record<string, unknown> = {}) => ({
  projectId: "p1", projectName: "Internal Assistant", conversationId: id, sessionId: id, path: `/x/${id}`, title: `Conversation ${id} with a rather long title that has to wrap somewhere`, column,
  harnessId: "pi", agentId: "pi", agentLabel: "Pi", agentModel: null, executionNodeId: null, updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  turnRunning: column === "running", backgroundRunning: false, summary: null, activity: column === "running" ? "Running the tests" : null,
  autoRespondActive: false, startedBy: "you", pendingReviews: [], autoRespondStop: null, controlledBy: null, reviewCheck: null, ...extra,
});
const cards = [
  ...Array.from({ length: 4 }, (_, index) => card(`n${index}`, "needs-you", { reviewCheck: { needsYou: true, reason: `Question ${index}: keep the ticket form link, or drop it and ship the rest without the footer?`, by: "Decision model 96%" } })),
  card("g1", "needs-you", { pendingReviews: [{ id: "r1", title: "Deploy", subject: "npm run deploy -- --environment production --region eu-central-1 --verbose", detail: "", expiresAt: new Date(Date.now() + 600_000).toISOString() }] }),
  ...Array.from({ length: 4 }, (_, index) => card(`r${index}`, "running")),
  ...Array.from({ length: 12 }, (_, index) => card(`v${index}`, "review", { summary: "**Current state** Twelve files changed, tests pass." })),
];

// A string, so the test's compiler adds no helpers the page does not have.
const AUDIT = `(() => {
  const out = [];
  const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  canvas.canvas.width = canvas.canvas.height = 1;
  const rgba = (value) => { canvas.clearRect(0, 0, 1, 1); canvas.fillStyle = "#000"; canvas.fillStyle = value; canvas.fillRect(0, 0, 1, 1); const d = canvas.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const over = (top, under) => { const a = top[3]; return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1]; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const background = (el) => { const chain = []; for (let n = el; n; n = n.parentElement) chain.push(n); let color = [255, 255, 255, 1]; if (document.documentElement.dataset.theme !== "light") color = rgba(getComputedStyle(document.body).backgroundColor); for (const n of chain.reverse()) { const b = rgba(getComputedStyle(n).backgroundColor); if (b[3] > 0) color = over(b, color); } return color; };
  const name = (el) => el.tagName.toLowerCase() + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(" ").slice(0, 3).join(".") : "") + (el.id ? "#" + el.id : "");
  const shown = (el) => {
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null;
    const hit = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, r.x + r.width / 2)), Math.min(innerHeight - 1, Math.max(0, r.y + r.height / 2)));
    return hit && (el.contains(hit) || hit.contains(el)) ? r : null;
  };
  const skip = (el) => el.closest(".sr-only, svg, .app-boot, [aria-hidden=true]");
  for (const el of document.querySelectorAll("button, a[href], select, input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, [role=button], [role=switch], [role=tab], [role=menuitem], summary")) {
    if (skip(el) || el.closest("#messages, .md, .message-body")) continue;
    const r = shown(el);
    if (r && (r.height < 43.5 || r.width < 43.5)) out.push("target " + name(el) + " " + Math.round(r.width) + "x" + Math.round(r.height) + " '" + (el.textContent || "").trim().slice(0, 18) + "'");
  }
  for (const el of document.querySelectorAll("body *")) {
    if (skip(el) || el.closest("#messages, .app-boot") || ![...el.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim())) continue;
    const r = shown(el);
    if (!r) continue;
    const style = getComputedStyle(el);
    const size = parseFloat(style.fontSize);
    const text = el.textContent.trim().slice(0, 22);
    if (size === 0) continue;
    if (size < 13) out.push("text " + size + " " + name(el) + " '" + text + "'");
    if (!el.disabled && !el.closest(":disabled")) {
      const bg = background(el);
      const fg = over(rgba(style.color), bg);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      const ratio = (hi + 0.05) / (lo + 0.05);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) out.push("contrast " + ratio.toFixed(2) + " " + name(el) + " '" + text + "'");
    }
  }
  const clipped = (el) => { for (let n = el.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) { const o = getComputedStyle(n).overflowX; if (o !== "visible") { const r = n.getBoundingClientRect(); if (r.right <= innerWidth + 1 && r.left >= -1) return true; } } return false; };
  for (const el of document.querySelectorAll("body *")) {
    if (skip(el) || !el.checkVisibility()) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if ((r.right > innerWidth + 1 || r.left < -1) && !clipped(el) && getComputedStyle(el).position !== "fixed" && !el.closest("[hidden]")) out.push("edge " + name(el) + " " + Math.round(r.left) + ".." + Math.round(r.right));
  }
  if (document.documentElement.scrollWidth > innerWidth) out.push("sideways " + document.documentElement.scrollWidth);
  return [...new Set(out)];
})()`;

const SCROLLER = `(() => {
  let best = null;
  for (const el of document.querySelectorAll("body *")) {
    if (el.scrollHeight <= el.clientHeight + 4 || !el.checkVisibility()) continue;
    const o = getComputedStyle(el).overflowY;
    if (o !== "auto" && o !== "scroll") continue;
    const r = el.getBoundingClientRect();
    if (r.width < innerWidth * 0.6 || r.height < 150) continue;
    if (!best || el.scrollHeight - el.clientHeight > best.scrollHeight - best.clientHeight) best = el;
  }
  const root = document.scrollingElement;
  if (!best && root.scrollHeight > root.clientHeight + 4) best = root;
  return best;
})()`;
const SCROLL_STEP = `(() => { const el = ${SCROLLER}; if (!el) return false; if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) return false; el.scrollTop += el.clientHeight * 0.85; window.__scrolled = el; return true; })()`;
const SCROLL_RESET = `(() => { const el = ${SCROLLER}; if (el) el.scrollTop = 0; document.scrollingElement.scrollTop = 0; })()`;
const BEHIND_TABS = `(() => {
  const tabs = document.querySelector("#phoneTabs"); const out = [];
  if (!tabs || !tabs.checkVisibility()) return out;
  const top = tabs.getBoundingClientRect().top;
  const el = window.__scrolled; if (!el) return out;
  if (el.scrollTop + el.clientHeight < el.scrollHeight - 2) return out;
  const last = [...el.querySelectorAll("*")].filter((n) => n.checkVisibility() && n.getBoundingClientRect().height > 0).sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
  if (last && last.getBoundingClientRect().bottom > top + 1) out.push("behind-tabs " + (last.dataset.testid || last.className) + " bottom " + Math.round(last.getBoundingClientRect().bottom) + " > tabs " + Math.round(top));
  return out;
})()`;

async function audit(label: string, scrolling = true) {
  await page.waitForTimeout(250);
  const problems = (await page.evaluate(AUDIT)) as string[];
  const key = `${width}x${height} ${theme} ${label}`;
  if (problems.length) found[key] = problems;
  if (shots) {
    await mkdir(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `${width}-${theme}-${label.replace(/\W+/g, "-")}.png`) });
  }
  if (!scrolling) return;
  // The longest scrolling area on the screen: look at every screenful, and at what sits behind the tab bar at the end.
  for (let part = 1; part <= 6; part += 1) {
    const more = await page.evaluate(SCROLL_STEP) as boolean;
    if (!more) break;
    await page.waitForTimeout(150);
    const rest = (await page.evaluate(AUDIT)) as string[];
    const behind = await page.evaluate(BEHIND_TABS) as string[];
    if (rest.length || behind.length) found[`${key} +${part}`] = [...rest, ...behind];
    if (shots && part === 1) await page.screenshot({ path: path.join(shots, `${width}-${theme}-${label.replace(/\W+/g, "-")}-s${part}.png`) });
  }
  await page.evaluate(SCROLL_RESET);
}

async function step(label: string, action: () => Promise<void>) {
  try {
    await action();
    await audit(label);
  } catch (error) {
    found[`${width}x${height} ${theme} ${label}`] = [`STEP FAILED ${String(error).split("\n")[0].slice(0, 160)}`];
    await page.keyboard.press("Escape").catch(() => undefined);
  }
}

const tap = async (testid: string) => { await page.getByTestId(testid).first().tap(); };
const settle = (ms = 400) => page.waitForTimeout(ms);

async function setTheme(next: string) {
  theme = next;
  await page.evaluate((id) => {
    const base = id === "dark" || id === "midnight" || id === "graphite" ? "dark" : "light";
    document.documentElement.dataset.theme = base;
    if (id === base) delete document.documentElement.dataset.palette;
    else document.documentElement.dataset.palette = id;
  }, next);
}

/** Closes whatever is open: dialogs, panels with a Close button, the details sheet. */
async function closeAll() {
  for (let round = 0; round < 3; round += 1) {
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      document.querySelectorAll("dialog[open]").forEach((dialog) => (dialog as HTMLDialogElement).close());
      for (const button of document.querySelectorAll<HTMLElement>('[aria-label^="Close"], [data-testid="focus-close"]')) if (button.checkVisibility()) button.click();
    });
    await page.waitForTimeout(200);
  }
}

async function goHome() {
  await closeAll();
  await page.getByTestId("phone-tab-inbox").tap().catch(async () => { await page.goBack(); });
  await settle();
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-phone-audit-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  // 70 more conversations in the first project, so its list scrolls.
  const { writeFile: write } = await import("node:fs/promises");
  const project = node.projects[0];
  for (let index = 0; index < 70; index += 1) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const at = (minutes: number) => new Date(Date.parse("2026-08-30T09:00:00.000Z") + minutes * 60_000 + index * 3_600_000).toISOString();
    const records = [
      { type: "session", version: 3, id, timestamp: at(0), cwd: project.path },
      { type: "session_info", name: `Extra conversation ${index} about something fairly long to wrap`, timestamp: at(0) },
      { type: "message", id: `${id}-0`, parentId: null, timestamp: at(1), message: { role: "user", content: [{ type: "text", text: "Look at this." }], timestamp: Date.parse(at(1)) } },
      { type: "message", id: `${id}-1`, parentId: `${id}-0`, timestamp: at(2), message: { role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: Date.parse(at(2)) } },
    ];
    await write(path.join(environment.home, ".pi", "sessions", `${id}.jsonl`), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  }
  server = await startDevNode(environment, node);
  browser = await launchChrome({ headless: process.env.HEADED !== "1" });
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, serviceWorkers: "block", reducedMotion: "reduce" });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(60_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/control-center/board*", (route) => route.fulfill({ json: { cards, projects: [{ id: "p1", name: "Internal Assistant", color: "#2f6fed" }] } }));
  await page.route("**/api/control-center/cards/detail*", (route) => route.fulfill({ json: { request: "Please pick a plan", answer: "**Two plans**:\n\n- Plan A keeps the flag\n- Plan B removes it", answerAt: null, answerCut: false, steps: [{ name: "Bash", target: "npm test", failed: false }] } }));
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 30_000 });
  await page.evaluate((key) => localStorage.setItem(key, "unset"), WORKSPACE_COLUMN_KEY);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 30_000 });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#loginDialog[open]").waitFor({ state: "detached" });
  await page.reload({ waitUntil: "domcontentloaded" });
}, { timeout: 400_000 });

after(async () => {
  if (process.env.PHONE_AUDIT_OUT) await writeFile(process.env.PHONE_AUDIT_OUT, JSON.stringify(found, null, 1));
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

async function walkMain() {
  await goHome();
  await step("home", async () => { await page.getByTestId("phone-home").waitFor(); await page.getByTestId("needs-deck").waitFor(); await settle(); });
  await step("install-banner", async () => { await page.evaluate(() => { document.querySelector<HTMLElement>(".install-banner")!.hidden = false; }); await settle(300); });
  await page.evaluate(() => { document.querySelector<HTMLElement>(".install-banner")!.hidden = true; });
  await step("home-sheet", async () => { await page.getByTestId("needs-deck").getByTestId("home-card").first().locator(".ws-wait-title").tap(); await page.getByTestId("need-sheet").waitFor(); await settle(600); });
  await goHome();
  await step("search", async () => { await tap("phone-search-input"); await page.locator("#spotlightDialog[open]").waitFor(); await page.keyboard.type("conv"); await settle(600); });
  await goHome();
  await step("new-menu", async () => { await tap("phone-new-button"); await page.getByTestId("workspace-new-menu").waitFor(); });
  await goHome();
  await step("wizard-1", async () => { await tap("phone-new-button"); await tap("workspace-new-conversation"); await page.getByTestId("new-session-name-dialog").waitFor(); await settle(600); });
  await step("wizard-2", async () => { await tap("new-session-next-button"); await settle(500); });
  await step("wizard-3", async () => { await tap("new-session-next-button"); await settle(500); });
  const full = page.viewportSize()!;
  await page.setViewportSize({ width: full.width, height: 420 });
  height = 420;
  await step("wizard-3-keyboard", async () => { await page.locator("#newSessionNameDialog input, #newSessionNameDialog textarea").first().focus().catch(() => undefined); await settle(300); });
  await page.setViewportSize(full);
  height = full.height;
  await closeAll();
  await step("bob", async () => { await tap("phone-tab-bob"); await page.getByTestId("control-chat").waitFor(); await settle(800); });
  await step("bob-menu", async () => { await tap("focus-controls-button"); await page.locator("#focusControls").waitFor(); await settle(500); });
  await closeAll();
  await step("projects", async () => { await tap("phone-tab-projects"); await page.locator("body.view-projects .project-card").first().waitFor(); });
  await step("project-sessions", async () => { await page.locator(".project-card", { hasText: node.projects[0].name }).first().tap(); await page.locator("body.view-sessions #sessionList .session-card").first().waitFor(); await settle(600); });
  await step("project-row-menu", async () => { await page.locator("#sessionList [data-testid=session-menu-button]").first().tap(); await settle(500); });
  await page.keyboard.press("Escape");
  await step("project-notes", async () => { await tap("notes-tab"); await settle(600); });
  await tap("conversations-tab").catch(() => undefined);
  await step("conversation", async () => {
    await page.locator("#sessionList .session-card").first().tap();
    await page.locator("body.view-chat").waitFor();
    await page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>("#messageInput")!.disabled);
    await settle();
  });
  await step("composer-slash", async () => { await page.locator("#messageInput").tap(); await page.keyboard.type("/"); await settle(700); });
  await step("composer-at", async () => { await page.locator("#messageInput").fill(""); await page.keyboard.type("@"); await settle(700); });
  await page.locator("#messageInput").fill("");
  for (const chip of ["harness", "model", "node"]) await step(`chip-${chip}`, async () => { await tap(`phone-chip-${chip}`); await settle(700); await page.keyboard.press("Escape"); });
  await step("details", async () => { await tap("focus-controls-button"); await page.locator("#focusControls").waitFor(); await settle(600); });
  await page.keyboard.press("Escape");
}

async function walkDialogs() {
  for (const id of ["focus-tool-chat-open-terminal-button", "focus-tool-chat-open-browser-button", "focus-tool-chat-rename-button", "focus-tool-chat-share-button", "focus-tool-chat-cron-button", "focus-tool-chat-more-dashboard-button", "focus-tool-chat-session-menu-button", "focus-files", "focus-git", "focus-activity", "focus-tasks", "focus-add-secret", "focus-usage-open", "focus-new-note"]) {
    await step(`dialog-${id.replace("focus-tool-chat-", "")}`, async () => {
      if (!(await page.locator("#focusControls").isVisible())) { await tap("focus-controls-button"); await page.locator("#focusControls").waitFor(); }
      if (id.startsWith("focus-tool-chat") && !(await page.getByTestId(id).isVisible())) { await tap("focus-tools"); await settle(300); }
      await tap(id);
      await settle(900);
    });
    await closeAll();
  }
}

async function walkSettings() {
  await closeAll();
  await goHome();
  await tap("phone-tab-settings");
  await page.locator("#settingsDialog[open]").waitFor();
  await step("settings-list", async () => { await settle(600); });
  await step("settings-appearance", async () => { await tap("settings-appearance-link"); await settle(600); });
  await page.evaluate(() => document.querySelector<HTMLElement>("#settingsBackButton")!.click());
  const tabs = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("#settingsDialog [data-settings-tab]")].filter((el) => el.checkVisibility()).map((el) => el.dataset.settingsTab!));
  for (const id of tabs) {
    await step(`settings-${id}`, async () => {
      await page.locator(`#settingsDialog [data-settings-tab="${id}"]`).first().tap();
      await settle(900);
    });
    await page.evaluate(() => document.querySelector<HTMLElement>("#settingsBackButton")!.click());
    await settle(300);
  }
}

const matrix: Array<[number, string]> = process.env.PHONE_FULL
  ? [[390, "light"], [390, "dark"], [390, "graphite"], [360, "light"], [360, "dark"], [360, "graphite"], [390, "sepia"], [390, "midnight"]]
  : [[360, "light"], [390, "graphite"]];
for (const [size, name] of matrix) {
  test(`phone screens at ${size} px in ${name}`, async () => {
    width = size;
    height = size === 360 ? 740 : 844;
    await page.setViewportSize({ width, height });
    await setTheme(name);
    await walkMain();
    await walkDialogs();
    await walkSettings();
  });
}
test("every phone screen fits: no sideways overflow, no text under 13 px, no control under 44 px, readable greys", async () => {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const [key, problems] of Object.entries(found)) for (const problem of problems) if (!seen.has(problem)) { seen.add(problem); lines.push(`${key} :: ${problem}`); }
  if (process.env.PHONE_AUDIT_OUT) console.log(lines.join("\n"));
  assert.deepEqual(lines, []);
  assert.deepEqual(pageErrors, []);
});
