// Browser suite for the retention boxes in Settings: the three boxes that widen the first follow
// it, "Show what would be deleted" asks for the ticked boxes (not the saved ones) and shows the
// answer or the error, and saving sends the six boxes as one setting. The dry-run answer comes
// from a fixture, so nothing is counted or deleted on the node.
//
// Like the rest of test/ui it needs a Chrome binary, and it fails rather than skipping without one.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { type Browser, type Page, type Route } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "../dev-nodes.js";

const BOXES = ["full", "includeUnrecorded", "includeScheduled", "includeTickets", "leftovers", "backgroundRuns"] as const;
const count = (conversations: number, files: number, bytes: number) => ({ conversations, files, bytes });
const answer = {
  generatedAt: "2026-11-11T00:00:00.000Z", retentionDays: 40, passLimit: 500,
  switches: { full: true, includeUnrecorded: false, includeScheduled: false, includeTickets: true, leftovers: false, backgroundRuns: true },
  totals: { expired: count(975, 1076, 1_194_000_000), empty: count(6, 0, 0), background: count(2577, 2600, 577_000_000), leftover: count(449, 612, 601_000_000), held: count(32, 241, 119_000_000) },
  projects: [
    { projectId: "p1", name: "Contigos <b>", expired: count(500, 520, 479_000_000), empty: count(1, 0, 0) },
    { projectId: "p2", name: "Joint Bob", expired: count(461, 540, 627_000_000), empty: count(5, 0, 0) },
  ],
  kept: { "owned by another machine": 168, pinned: 4, "running, open or waiting": 11 },
};

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let session: SignedIn;
let server: ChildProcess;
let browser: Browser;
let page: Page;
const asked: string[] = [];
const saved: Array<Record<string, unknown>> = [];
const pageErrors: string[] = [];
/** How the next dry run is answered, and a gate that holds the answer back until the test lets it go. */
let next: { status: number; body: unknown } = { status: 200, body: answer };
let release: (() => void) | undefined;

async function dryRun(route: Route): Promise<void> {
  asked.push(new URL(route.request().url()).search);
  if (release === undefined) await new Promise<void>((resolve) => { release = resolve; });
  await route.fulfill({ status: next.status, contentType: "application/json", body: JSON.stringify(next.body) });
}

const box = (name: string) => page.locator(`[data-retention-scope="${name}"]`);
// Reopening keeps the last values on screen until the reload finishes, so wait for it.
const settingsLoaded = () => page.waitForFunction(() => !document.querySelector("#settingsForm")!.hasAttribute("aria-busy"));
const digits = (text: string) => text.replace(/[^\d]/g, "");

async function rowOf(kind: string): Promise<string[]> {
  return page.locator(`[data-testid="settings-retention-preview-totals"] tr[data-kind="${kind}"] td`).allInnerTexts();
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-retention-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  server = await startDevNode(environment, node);
  session = await signIn(environment, node);
  browser = await launchChrome({ headless: process.env.HEADED !== "1" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
  const [name, value] = session.cookie.split("=");
  await context.addCookies([{ name, value, url: node.url }]);
  await context.route("**/api/settings/retention-preview**", dryRun);
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "PUT" && new URL(request.url()).pathname === "/api/settings") saved.push(JSON.parse(request.postData() ?? "{}") as Record<string, unknown>);
  });
  await page.goto(node.url);
  await page.getByText("Internal Assistant", { exact: true }).waitFor();
}, { timeout: 120_000 });

after(async () => {
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

test("every box starts unticked, and the three that widen the first follow it", async () => {
  await page.getByTestId("settings-open-button").click();
  await settingsLoaded();
  await page.getByTestId("settings-retention-scope").scrollIntoViewIfNeeded();
  const group = await page.getByTestId("settings-retention-scope").innerText();
  assert.match(group, /Only the conversations a project's list still shows are checked\. Older ones stay until you tick the first box\./);
  assert.match(group, /Nothing is deleted until you save, and then only at the next hourly check\./);
  for (const name of BOXES) assert.equal(await box(name).isChecked(), false, `${name} is off on a node that never saved the setting`);
  const dependents = ["includeUnrecorded", "includeScheduled", "includeTickets"];
  for (const name of dependents) assert.equal(await box(name).isDisabled(), true, `${name} waits for the first box`);
  for (const name of ["full", "leftovers", "backgroundRuns"]) assert.equal(await box(name).isEnabled(), true);
  await box("full").check();
  for (const name of dependents) assert.equal(await box(name).isEnabled(), true, `${name} can be ticked with the first box`);
  await box("full").uncheck();
  for (const name of dependents) assert.equal(await box(name).isDisabled(), true);
  assert.equal(await page.getByTestId("settings-retention-preview").isVisible(), false, "no table before anyone asks");
});

test("the dry run asks for the ticked boxes and shows what they would delete", async () => {
  await box("full").check();
  await box("includeTickets").check();
  await box("backgroundRuns").check();
  const button = page.getByTestId("settings-retention-preview-button");
  assert.equal(await button.innerText(), "Show what would be deleted");
  release = undefined;
  await button.click();
  // Held back by the test: the button says it is working and cannot be pressed twice.
  await page.waitForFunction(() => document.querySelector("#settingsRetentionPreviewButton")!.textContent === "Checking…");
  assert.equal(await button.isDisabled(), true);
  while (release === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  await page.getByTestId("settings-retention-preview-totals").waitFor();
  assert.equal(await button.innerText(), "Show what would be deleted");
  assert.equal(await button.isEnabled(), true);

  // The boxes on the page were sent, though nothing is saved yet.
  const query = new URLSearchParams(asked.at(-1));
  assert.deepEqual(Object.fromEntries(BOXES.map((name) => [name, query.get(name)])), { full: "1", includeUnrecorded: "0", includeScheduled: "0", includeTickets: "1", leftovers: "0", backgroundRuns: "1" });
  const stored = await api<{ conversationRetentionScope: Record<string, boolean> }>(node, session, "GET", "/settings");
  assert.equal(Object.values(stored.body.conversationRetentionScope).some(Boolean), false, "looking saves nothing");

  const expired = await rowOf("expired");
  assert.match(expired[0], /^Expired: no activity for 40 days$/);
  assert.deepEqual([digits(expired[1]), digits(expired[2]), expired[3]], ["975", "1076", "1.2 GB"]);
  assert.deepEqual((await rowOf("empty")).slice(1).map(digits), ["6", "0", "0"]);
  const background = await rowOf("background");
  assert.deepEqual([background[0], digits(background[1]), digits(background[2]), background[3]], ["Background runs", "2577", "2600", "577 MB"]);
  const leftover = await rowOf("leftover");
  assert.deepEqual([leftover[0], digits(leftover[1]), leftover[3]], ["Left-behind files", "449", "601 MB"]);
  const held = await rowOf("held");
  assert.deepEqual([held[0], digits(held[1]), digits(held[2]), held[3]], ["Held back, not deleted", "32", "241", "119 MB"]);

  const projects = await page.locator('[data-testid="settings-retention-preview-projects"] tbody tr').allInnerTexts();
  assert.equal(projects.length, 2);
  assert.match(projects[0], /^Contigos <b>\s+501\s+479 MB$/, "a project's name is shown as text");
  assert.match(projects[1], /^Joint Bob\s+466\s+627 MB$/);
  const kept = await page.locator('[data-testid="settings-retention-preview-kept"] tbody tr').allInnerTexts();
  assert.deepEqual(kept.map((row) => row.replace(/\s+/g, " ")), ["Owned by another machine 168", "Pinned 4", "Running, open or waiting 11"]);
  assert.match(await page.getByTestId("settings-retention-preview").innerText(), /One hourly check deletes at most 500 conversations\. The rest go in the checks that follow\./);
});

test("an error takes the table's place", async () => {
  next = { status: 500, body: { error: "The harness folder could not be read" } };
  await page.getByTestId("settings-retention-preview-button").click();
  const alert = page.getByTestId("settings-retention-preview-error");
  await alert.waitFor();
  assert.match(await alert.innerText(), /^Could not work out what would be deleted: /);
  assert.equal(await page.getByTestId("settings-retention-preview-totals").count(), 0);
  assert.equal(await page.getByTestId("settings-retention-preview-button").isEnabled(), true);
  next = { status: 200, body: answer };
});

test("saving sends the six boxes as one setting, and they come back ticked", async () => {
  const days = (await api<{ conversationRetentionDays: number }>(node, session, "GET", "/settings")).body.conversationRetentionDays;
  await page.getByTestId("settings-save-button").click();
  await page.getByTestId("settings-dialog").waitFor({ state: "hidden" });
  const expected = { full: true, includeUnrecorded: false, includeScheduled: false, includeTickets: true, leftovers: false, backgroundRuns: true };
  assert.deepEqual(saved.at(-1)?.conversationRetentionScope, expected);
  const stored = await api<{ conversationRetentionScope: Record<string, boolean>; conversationRetentionDays: number }>(node, session, "GET", "/settings");
  assert.deepEqual(stored.body.conversationRetentionScope, expected);
  assert.equal(stored.body.conversationRetentionDays, days, "the number of days is saved with them, unchanged");

  await page.getByTestId("settings-open-button").click();
  await settingsLoaded();
  await page.waitForFunction(() => (document.querySelector("#settingsRetentionFull") as HTMLInputElement).checked);
  for (const name of BOXES) assert.equal(await box(name).isChecked(), expected[name], name);
  assert.equal(await box("includeUnrecorded").isEnabled(), true, "the first box is ticked, so the ones under it can be");
  assert.equal(await page.getByTestId("settings-retention-preview").isVisible(), false, "an earlier answer is not shown again as if it were current");

  // Unticking everything saves that too: the page always sends all six.
  // The first box last: unticking it locks the three under it as they are.
  for (const name of [...BOXES].reverse()) if (await box(name).isChecked()) await box(name).uncheck();
  await page.getByTestId("settings-save-button").click();
  await page.getByTestId("settings-dialog").waitFor({ state: "hidden" });
  assert.equal(Object.values(saved.at(-1)?.conversationRetentionScope as Record<string, boolean>).some(Boolean), false);
  assert.equal(Object.values((await api<{ conversationRetentionScope: Record<string, boolean> }>(node, session, "GET", "/settings")).body.conversationRetentionScope).some(Boolean), false);
  assert.deepEqual(pageErrors, []);
});
