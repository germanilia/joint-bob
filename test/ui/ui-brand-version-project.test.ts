import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { type Browser, type Page } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "../dev-nodes.js";

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let server: ChildProcess;
let browser: Browser;
let page: Page;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-brand-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  server = await startDevNode(environment, node);
  browser = await launchChrome({ headless: process.env.HEADED !== "1" });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
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

test("the release number sits under the brand name, centred with the mark, and not under a page title", async () => {
  await signIn();
  const version = page.getByTestId("workspace-version");
  await version.waitFor();
  await page.waitForFunction(() => /^v\d+\.\d+\.\d+/.test(document.querySelector("[data-testid='workspace-version']")?.textContent ?? ""));
  const name = await page.locator(".ws-home-button .ws-name").boundingBox();
  const release = await version.boundingBox();
  const mark = await page.locator(".ws-home-button .ws-mark").boundingBox();
  const title = await page.locator(".ws-home-button .ws-title").boundingBox();
  assert.ok(name && release && mark && title);
  assert.ok(release.y >= name.y + name.height - 1, `version is below the name: ${JSON.stringify({ name, release })}`);
  assert.ok(Math.abs(title.y + title.height / 2 - (mark.y + mark.height / 2)) <= 2, `name block is centred on the mark: ${JSON.stringify({ title, mark })}`);
  assert.equal(await page.locator(".bob-head-version").count(), 0, "no version under a page title");
  await page.screenshot({ path: process.env.BRAND_SHOT ?? path.join(root, "brand.png"), clip: { x: 0, y: 0, width: 360, height: 120 } });
});

test("every new conversation window shows its project", async () => {
  await page.locator(".project-card").first().click();
  await page.getByTestId("session-create-button").click();
  await page.getByTestId("new-session-name-dialog").waitFor();
  const picker = page.getByTestId("new-session-project-select");
  assert.equal(await picker.isVisible(), true, "the wizard shows the project on the desktop");
  assert.ok((await picker.textContent())?.trim(), "the project is named");
  await page.screenshot({ path: process.env.WIZARD_SHOT ?? path.join(root, "wizard.png") });
  await page.getByTestId("new-session-name-cancel-button").click();
});
