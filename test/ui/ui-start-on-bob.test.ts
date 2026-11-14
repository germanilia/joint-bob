// The app opens on the Inbox on a phone and on Bob on the desktop unless the person came by a link; a phone conversation's header is two lines
// with chips that scroll instead of cutting their words; and Home shown over an open conversation closes back to it.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { type Browser, type Page } from "playwright-core";
import { launchChrome, START_VIEW_KEY, WORKSPACE_COLUMN_KEY } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "../dev-nodes.js";

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let server: ChildProcess;
let browser: Browser;
const pageErrors: string[] = [];

const view = (page: Page) => page.evaluate(() => ["projects", "sessions", "chat", "control"].find((name) => document.body.classList.contains(`view-${name}`)));

/** A signed-in page that has never chosen a start view; `startKey` "last" is what the rest of the suite runs with. */
async function openApp(viewport: { width: number; height: number }, startKey: string | null, touch = false): Promise<Page> {
  const context = await browser.newContext({ viewport, hasTouch: touch, serviceWorkers: "block", reducedMotion: "reduce" });
  // Runs after launchChrome's own script, which sets "last" when the key is missing.
  await context.addInitScript(([key, value]) => { if (value === null) localStorage.removeItem(key!); else localStorage.setItem(key!, value); }, [START_VIEW_KEY, startKey]);
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 30_000 });
  await page.evaluate((key) => localStorage.setItem(key, "unset"), WORKSPACE_COLUMN_KEY);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#loginDialog[open]").waitFor({ state: "detached" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("body:not(.booting)").waitFor({ timeout: 30_000 });
  // Boot loading puts the start view back once it finishes; a tap before that is overridden.
  await page.waitForLoadState("networkidle");
  return page;
}

/** Through Projects: the seeded node has no rows in Home's groups until answers arrive. */
async function openFirstConversation(page: Page, touch: boolean) {
  const act = (locator: ReturnType<Page["locator"]>) => touch ? locator.tap() : locator.click();
  if (touch) await act(page.getByTestId("phone-tab-projects"));
  else await act(page.getByTestId("workspace-projects-button"));
  await act(page.locator(".project-card").first());
  await act(page.locator(".session-card").first());
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-start-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  server = await startDevNode(environment, node);
  browser = await launchChrome({ headless: process.env.HEADED !== "1" });
}, { timeout: 120_000 });

after(async () => {
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

test("a phone opens on the Inbox, and the Inbox tab is the one marked", async () => {
  const page = await openApp({ width: 390, height: 844 }, null, true);
  await page.getByTestId("phone-home").waitFor();
  assert.equal(await view(page), "projects");
  assert.equal(await page.getByTestId("phone-tab-inbox").getAttribute("aria-current"), "page");
  // Choosing another view is kept for this visit only: the next open is the Inbox again.
  await page.getByTestId("phone-tab-bob").tap();
  await page.locator("body.view-control").waitFor();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("phone-home").waitFor();
  assert.equal(await view(page), "projects");
});

test("the desktop opens on Bob, and Exit leaves for the workspace", async () => {
  const page = await openApp({ width: 1440, height: 900 }, null);
  await page.locator("body.view-control").waitFor();
  await page.getByTestId("control-center-close-button").click();
  await page.getByTestId("workspace-side").waitFor();
  assert.notEqual(await view(page), "control");
});

test("the key set to last reopens the view that was left", async () => {
  const page = await openApp({ width: 1440, height: 900 }, "last");
  await page.getByTestId("workspace-side").waitFor();
  assert.notEqual(await view(page), "control");
});

test("a phone conversation's header is two lines and its chips keep whole words", async () => {
  const page = await openApp({ width: 390, height: 844 }, "last", true);
  await openFirstConversation(page, true);
  await page.locator("body.view-chat").waitFor();
  const header = await page.evaluate(() => {
    const top = document.querySelector<HTMLElement>(".chat-topbar")!.getBoundingClientRect();
    const title = document.querySelector<HTMLElement>("#sessionTitle")!.getBoundingClientRect();
    const project = document.querySelector<HTMLElement>("#chatProjectName")!.getBoundingClientRect();
    const chips = document.querySelector<HTMLElement>("#phoneChips")!;
    return {
      topbar: top.height, projectBelowTitle: project.top >= title.bottom - 1, projectRowGap: project.top - title.bottom,
      chipsScroll: getComputedStyle(chips).overflowX, chipsFit: chips.scrollWidth <= chips.clientWidth || getComputedStyle(chips).overflowX === "auto",
      chipHeights: [...chips.querySelectorAll<HTMLElement>(".searchable-select-trigger")].map((chip) => Math.round(chip.getBoundingClientRect().height)).filter(Boolean),
      overflowing: document.documentElement.scrollWidth > innerWidth,
    };
  });
  assert.ok(header.topbar <= 92, `the header is two lines, not four (${header.topbar}px)`);
  assert.equal(header.projectBelowTitle, true);
  assert.ok(header.projectRowGap < 8, "the project line sits right under the title");
  assert.equal(header.chipsScroll, "auto", "the chips scroll sideways instead of cutting their words");
  assert.ok(header.chipHeights.length >= 3 && header.chipHeights.every((height) => height >= 44), `chips stay 44 px targets ${header.chipHeights}`);
  assert.equal(header.overflowing, false, "the page does not scroll sideways");
});

test("Home over an open conversation closes back to it with the button or Esc", async () => {
  const page = await openApp({ width: 1440, height: 900 }, "last");
  await openFirstConversation(page, false);
  await page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>("#messageInput")!.disabled);
  assert.equal(await page.getByTestId("home-page").isVisible(), false);
  await page.getByTestId("workspace-home-button").click();
  await page.getByTestId("home-page").waitFor();
  await page.getByTestId("home-close-button").click();
  await page.getByTestId("home-page").waitFor({ state: "hidden" });
  await page.getByTestId("workspace-home-button").click();
  await page.getByTestId("home-close-button").waitFor();
  await page.keyboard.press("Escape");
  await page.getByTestId("home-page").waitFor({ state: "hidden" });
  assert.deepEqual(pageErrors, []);
});
