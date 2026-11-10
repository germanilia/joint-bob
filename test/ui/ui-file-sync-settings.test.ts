// Browser suite for Settings → File sync. It drives a real Chrome against a seeded node and
// answers every /api/file-sync/* request from fixtures, so it checks the screen against the
// engine's answers without running the engine: the tab is the admin's only, lists page instead
// of scrolling, a synced project says so, a project being checked says what the check is doing
// and is refreshed until it is synced, a held check is left alone, the first index says where it
// is, a quiet engine is not asked again, and the differing files page.
//
// Run with `npm run test:file -- test/ui/ui-file-sync-settings.test.ts`. Like the rest of
// test/ui it needs a Chrome binary, and it fails rather than skipping when there is none.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { type Browser, type BrowserContext, type Page, type Route } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "../dev-nodes.js";
import { addMember } from "../node-script.js";

const PEER = "node-peer-b";
const DAY = 86_400_000;
const DIFFERING = Array.from({ length: 30 }, (_, index) => `src/file-${String(index + 1).padStart(2, "0")}.ts`);

interface Project { projectId: string; name: string; owner: boolean; phase: "builtin" | "bootstrapping"; phaseMessage: string | null; phaseError: string | null; differences: number; shares: string[]; waiting: boolean }
interface Seen { method: string; path: string; query: string; at: number; body?: unknown }

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const projects: Project[] = Array.from({ length: 14 }, (_, index) => {
  const id = `p${String(index + 1).padStart(2, "0")}`;
  return { projectId: id, name: `Project ${id.slice(1)}`, owner: index < 3, phase: "builtin", phaseMessage: null, phaseError: null, differences: 0, shares: ["project"], waiting: false };
});
projects[0].differences = DIFFERING.length;
let indexing: { projectId: string; name: string; position: number; total: number } | null = null;

/** The second project's folder size, as the engine reports it now. */
let shareBytes = 4_200_000;

function shareStatus(share: string, projectId: string, kind: string, differences: number, cleanSince: string | null) {
  return {
    share, projectId, kind, state: "idle", phase: "builtin", engine: "builtin", maxSeq: 10, indexId: "index", digest: "digest", rulesHash: "rules",
    liveFiles: 120, liveBytes: projectId === "p02" ? shareBytes : 4_200_000, need: { files: 0, bytes: 0 }, blocked: 0, errors: 0, scanning: false, watch: "watching",
    peers: [{ peer: PEER, cursor: 10, peerMaxSeq: 10, peerIndexId: "peer", peerDigest: "digest", rulesMatch: true, caughtUp: true, differences, cleanSince, route: "direct" }],
  };
}

function statusAnswer() {
  return {
    enabled: true, worker: "running", leaving: false, config: { enabled: true, enabledBy: "default", shadowProjects: "all", shadowProjectsBy: "default", port: 22700, requestedProjects: [], lastChosenProjects: null },
    origins: ["http://100.64.0.5:22700"], indexing,
    shares: [
      shareStatus("project:p01", "p01", "project", DIFFERING.length, null),
      shareStatus("tickets:p01", "p01", "tickets", 0, ago(2 * DAY)),
      shareStatus("project:p02", "p02", "project", 0, ago(3 * DAY)),
    ],
    peers: [{ nodeId: PEER, present: true, protocol: 2, switchCapable: true, enabled: true, origins: ["http://100.64.0.9:22700"], route: "direct", heardAt: ago(120_000) }],
  };
}

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let server: ChildProcess;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const seen: Seen[] = [];
const pageErrors: string[] = [];

/** Every /api/file-sync/* request is answered here; nothing reaches the node's engine. */
async function answer(route: Route): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const raw = request.postData();
  seen.push({ method: request.method(), path: url.pathname, query: url.search, at: Date.now(), ...(raw ? { body: JSON.parse(raw) } : {}) });
  const json = (status: number, payload: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
  const pageNumber = Number(url.searchParams.get("page") ?? 1), pageSize = Number(url.searchParams.get("pageSize") ?? 10);
  switch (`${request.method()} ${url.pathname}`) {
    case "GET /api/file-sync/status": return json(200, statusAnswer());
    case "PUT /api/file-sync/config": return json(200, statusAnswer());
    case "GET /api/file-sync/projects": return json(200, { projects });
    case "GET /api/file-sync/differences": {
      const items = url.searchParams.get("share") === "project:p01" ? DIFFERING.map((file) => ({ path: file, kind: "content", local: { size: 100, mtimeMs: 1, sha256: "a", deleted: false }, remote: { size: 120, mtimeMs: 2, sha256: "b", deleted: false }, since: ago(DAY) })) : [];
      return json(200, { total: items.length, items: items.slice((pageNumber - 1) * pageSize, pageNumber * pageSize) });
    }
    case "GET /api/file-sync/errors": return json(200, { total: 0, items: [] });
    case "POST /api/file-sync/repair": return json(200, { ok: true });
    default: return json(404, { error: `Not stubbed: ${request.method()} ${url.pathname}` });
  }
}

const statusRequests = () => seen.filter((entry) => entry.method === "GET" && entry.path === "/api/file-sync/status");
const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function signInAsAdmin(target: Page): Promise<void> {
  await target.goto(node.url, { waitUntil: "domcontentloaded" });
  await target.locator("#loginDialog[open]").waitFor({ timeout: 30_000 });
  await target.getByTestId("login-username-input").fill(environment.username);
  await target.getByTestId("login-password-input").fill(environment.password);
  await target.getByTestId("login-submit-button").click();
  await target.getByText("Internal Assistant", { exact: true }).waitFor({ timeout: 30_000 });
}

/** Back to the project list's first page. */
async function projectListStart(): Promise<void> {
  if (await page.getByTestId("file-sync-project-detail").isVisible()) await page.getByTestId("file-sync-detail-back").click();
  const previous = page.getByTestId("file-sync-projects-page-previous");
  while (await previous.isVisible() && await previous.isEnabled()) { await previous.click(); await settle(); }
}

/** Pages to the project's row, wherever the fitted page size put it. */
async function showRow(projectId: string) {
  await projectListStart();
  const row = page.locator(`[data-testid="file-sync-project-row"][data-project-id="${projectId}"]`);
  await page.getByTestId("file-sync-project-row").first().waitFor();
  for (let clicks = 0; !(await row.isVisible()); clicks += 1) {
    assert.ok(clicks < projects.length, `${projectId} is on some page`);
    await page.getByTestId("file-sync-projects-page-next").click();
    await settle();
  }
  return row;
}

/** Pages to the project's row and opens its details. */
async function openDetails(projectId: string): Promise<void> {
  const row = await showRow(projectId);
  await row.getByTestId("file-sync-project-details").click();
  await page.getByTestId("file-sync-project-detail").waitFor({ state: "visible" });
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-file-sync-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  server = await startDevNode(environment, node);
  browser = await launchChrome({ headless: process.env.HEADED !== "1" });
  // A short window, so the project list has room for a few rows only.
  context = await browser.newContext({ viewport: { width: 1440, height: 640 }, reducedMotion: "reduce", serviceWorkers: "block" });
  await context.route("**/api/file-sync/**", answer);
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
}, { timeout: 120_000 });

after(async () => {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(root, "final.png") }).catch(() => undefined);
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

test("signing in reaches the app", { timeout: 90_000 }, async () => {
  await signInAsAdmin(page);
});

test("the File sync tab sits next to Node and Resources and shows the engine and its machines", async () => {
  await page.getByTestId("settings-open-button").click();
  const tabs = await page.locator("[data-settings-tab]").evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.settingsTab));
  assert.deepEqual(tabs.slice(tabs.indexOf("node"), tabs.indexOf("node") + 3), ["node", "resources", "file-sync"], `File sync follows Node and Resources: ${tabs.join(", ")}`);
  await page.getByTestId("settings-tab-file-sync").click();
  await page.getByTestId("settings-panel-file-sync").waitFor({ state: "visible" });
  await page.getByTestId("file-sync-worker").filter({ hasText: "Running" }).waitFor();
  assert.equal(await page.getByTestId("file-sync-enabled-toggle").isChecked(), true);
  assert.equal(await page.getByTestId("file-sync-enabled-toggle").isVisible(), false, "the switch is hidden: file sync is on everywhere");
  assert.match(await page.getByTestId("file-sync-addresses").innerText(), /directly at 100\.64\.0\.5:22700/);
  const peer = page.getByTestId("file-sync-peer-row");
  await peer.waitFor();
  assert.equal(await peer.getByTestId("file-sync-peer-reachable").innerText(), "Reachable");
  assert.match(await peer.getByTestId("file-sync-peer-facts").innerText(), /^Direct connection · Last heard 2 minutes ago$/);
  await page.getByTestId("file-sync-project-row").first().waitFor();
  assert.equal(await page.locator('[data-project-id="p01"]').getByTestId("file-sync-project-state").innerText(), "Synced");
  // Every shared project is synced: nothing to choose, compare or move.
  assert.equal(await page.getByTestId("file-sync-project-move").count(), 0);
  assert.equal(await page.getByTestId("file-sync-compare").count(), 0);
  assert.equal(await page.getByTestId("file-sync-project-compare").count(), 0);
  assert.doesNotMatch(await page.getByTestId("settings-panel-file-sync").innerText(), /syncthing/i);
});

test("the project list pages instead of scrolling at a short height", async () => {
  const list = page.getByTestId("file-sync-project-list");
  await settle();
  const pager = page.getByTestId("file-sync-project-pager");
  await pager.waitFor({ state: "visible" });
  const label = page.getByTestId("file-sync-projects-page-label");
  const names = new Set<string>();
  const starts: number[] = [];
  for (let clicks = 0; ; clicks += 1) {
    assert.ok(clicks <= projects.length, "paging terminates");
    const box = await list.evaluate((element) => ({ scroll: element.scrollHeight, client: element.clientHeight, rows: element.children.length }));
    assert.ok(box.scroll <= box.client + 1, `the list never overflows its box: ${JSON.stringify(box)}`);
    assert.ok(box.rows < projects.length, `a short window shows a page, not every project: ${box.rows}`);
    for (const name of await list.getByTestId("file-sync-project-row").locator(".relay-row-name").allInnerTexts()) names.add(name);
    starts.push(Number((await label.innerText()).split("–")[0]));
    const next = page.getByTestId("file-sync-projects-page-next");
    if (await next.isDisabled()) break;
    await next.click();
    await settle();
  }
  assert.deepEqual([...names].sort(), projects.map((project) => project.name), "every project is reachable with Next");
  for (let index = 1; index < starts.length; index += 1) assert.ok(starts[index] > starts[index - 1], `Next advances: ${starts.join(", ")}`);
  assert.match(await label.innerText(), /–14 of 14$/);
});

test("a synced project says so, with how its files compare and nothing to move", async () => {
  const same = await showRow("p02");
  assert.equal(await same.getByTestId("file-sync-project-state").innerText(), "Synced");
  assert.equal(await same.locator(".relay-row-meta").first().innerText(), "Same files on every machine");
  assert.equal(await same.getByTestId("file-sync-project-message").count(), 0);
  assert.equal(await same.locator(".relay-error").count(), 0);
  assert.equal(await (await showRow("p01")).locator(".relay-row-meta").first().innerText(), "30 files differ right now");
  // No folder of this one is reported yet, so nothing says its files are the same.
  assert.equal(await (await showRow("p03")).locator(".relay-row-meta").first().innerText(), "Not compared with the other machines yet");
  await openDetails("p02");
  assert.equal(await page.getByTestId("file-sync-detail-name").innerText(), "Project 02");
  assert.equal(await page.getByTestId("file-sync-detail-state").innerText(), "Synced");
  await page.getByTestId("file-sync-detail-facts").getByText("120 files, 4.20 MB").waitFor();
  assert.deepEqual(await page.getByTestId("file-sync-detail-actions").locator("button").allInnerTexts(), ["Rescan files"]);
  await page.getByTestId("file-sync-detail-back").click();
  await projectListStart();
});

test("the first index of the projects says which one it is on, and moves on by itself", { timeout: 30_000 }, async () => {
  const line = page.getByTestId("file-sync-indexing");
  assert.equal(await line.isVisible(), false);
  indexing = { projectId: "p05", name: "Project 05", position: 3, total: 19 };
  try {
    await page.getByTestId("file-sync-refresh-button").click();
    await line.filter({ hasText: "Reading Project 05's files for the first time (3 of 19)" }).waitFor();
    // While it indexes the page looks again by itself (at most every 5 s), and shows the next project.
    indexing = { projectId: "p06", name: "Project 06", position: 4, total: 19 };
    await line.filter({ hasText: "Reading Project 06's files for the first time (4 of 19)" }).waitFor({ timeout: 8_000 });
  } finally {
    indexing = null;
  }
  await line.waitFor({ state: "hidden", timeout: 8_000 });
});

test("a quiet engine is not asked again while the tab stays open", { timeout: 30_000 }, async () => {
  const before = statusRequests().length;
  await pause(6_500);
  assert.equal(statusRequests().length, before, "no project is checked or copied, so nothing is refreshed on a timer");
});

test("a project being checked says what the check is doing, and is refreshed at most every 5 seconds until it is synced", { timeout: 60_000 }, async () => {
  Object.assign(projects[1], { phase: "bootstrapping", phaseMessage: "Comparing Project 02 with node-peer-b" });
  await page.getByTestId("file-sync-refresh-button").click();
  const row = await showRow("p02");
  await row.getByTestId("file-sync-project-state").filter({ hasText: "Checking both machines' files" }).waitFor();
  assert.equal(await row.getByTestId("file-sync-project-message").innerText(), "Comparing Project 02 with node-peer-b");
  const opening = statusRequests().length;
  await openDetails("p02");
  assert.equal(await page.getByTestId("file-sync-detail-state").innerText(), "Checking both machines' files");
  assert.equal(await page.getByTestId("file-sync-detail-facts").getByTestId("file-sync-project-message").innerText(), "Comparing Project 02 with node-peer-b");
  // Opening the details loads once; from then on the page looks again by itself.
  while (statusRequests().length === opening) await pause(100);
  const opened = statusRequests().at(-1)!.at;
  const deadline = Date.now() + 20_000;
  while (statusRequests().filter((entry) => entry.at > opened).length < 2 && Date.now() < deadline) await pause(250);
  const times = statusRequests().filter((entry) => entry.at >= opened).map((entry) => entry.at);
  assert.ok(times.length >= 3, `the project being checked was refreshed: ${times.length} status requests`);
  for (let index = 1; index < times.length; index += 1) assert.ok(times[index] - times[index - 1] >= 4_900, `at most one status request per 5 s: ${times.map((at) => at - opened).join(", ")}`);

  Object.assign(projects[1], { phase: "builtin", phaseMessage: null });
  // The folders' final figures come after the check: they are not left as the checking page showed them.
  shareBytes = 9_300_000;
  await page.getByTestId("file-sync-detail-state").filter({ hasText: "Synced" }).waitFor({ timeout: 10_000 });
  assert.equal(await page.getByTestId("file-sync-detail-facts").getByTestId("file-sync-project-message").count(), 0);
  const finishedAt = statusRequests().length;
  await pause(1_500);
  assert.equal(statusRequests().length, finishedAt + 1, "one more load once the check finished, for the folders' last figures");
  await page.getByTestId("file-sync-detail-facts").getByText("120 files, 9.30 MB").waitFor();
  const settled = statusRequests().length;
  await pause(6_500);
  assert.equal(statusRequests().length, settled, "once nothing is checked, nothing is refreshed");
  await page.getByTestId("file-sync-detail-back").click();
  await projectListStart();
});

// A check that waits for a person or for sharing changes nothing by itself, so nothing is refreshed for it.
test("a check that is held says why and is not refreshed", { timeout: 40_000 }, async () => {
  Object.assign(projects[2], { phase: "bootstrapping", phaseMessage: "Waiting for node-peer-b to share its folders", waiting: true });
  Object.assign(projects[3], { phase: "bootstrapping", phaseError: "The folder /home/me/docs could not be read" });
  try {
    await page.getByTestId("file-sync-refresh-button").click();
    const waiting = await showRow("p03");
    await waiting.getByTestId("file-sync-project-state").filter({ hasText: "Checking both machines' files" }).waitFor();
    assert.equal(await waiting.getByTestId("file-sync-project-message").innerText(), "Waiting for node-peer-b to share its folders");
    const failed = await showRow("p04");
    assert.equal(await failed.getByTestId("file-sync-project-state").innerText(), "Checking both machines' files");
    assert.equal(await failed.locator(".relay-error").innerText(), "The folder /home/me/docs could not be read");
    const before = statusRequests().length;
    await pause(6_500);
    assert.equal(statusRequests().length, before, "nothing changes until someone acts");
  } finally {
    Object.assign(projects[2], { phase: "builtin", phaseMessage: null, waiting: false });
    Object.assign(projects[3], { phase: "builtin", phaseError: null });
    await page.getByTestId("file-sync-refresh-button").click();
    await settle();
  }
});

test("the differing files page, and Repair names the folder and the machine", async () => {
  await page.getByTestId("file-sync-tab-differences").click();
  await page.getByTestId("file-sync-differences-section").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("file-sync-differences-count").innerText(), "30");
  const row = page.locator(`[data-testid="file-sync-diff-row"][data-project-id="p01"][data-peer="${PEER}"]`);
  assert.equal(await row.getByTestId("file-sync-diff-count").innerText(), "30 differences");
  assert.match(await row.innerText(), /Not matching yet/);
  assert.match(await page.locator('[data-testid="file-sync-diff-row"][data-project-id="p02"]').innerText(), /Same files[\s\S]*Matching for 3 days/);
  await row.getByTestId("file-sync-diff-open").click();
  await page.getByTestId("file-sync-diff-detail").waitFor({ state: "visible" });
  const items = page.getByTestId("file-sync-diff-items");
  await items.getByTestId("file-sync-diff-item").first().waitFor();
  await settle();
  const pager = page.getByTestId("file-sync-diff-items-pager");
  assert.equal(await pager.isVisible(), true, "thirty files do not fit: the list pages");
  const paths = new Set<string>();
  for (let clicks = 0; ; clicks += 1) {
    assert.ok(clicks <= DIFFERING.length, "paging terminates");
    const box = await items.evaluate((element) => ({ scroll: element.scrollHeight, client: element.clientHeight }));
    assert.ok(box.scroll <= box.client + 1, `the list never overflows its box: ${JSON.stringify(box)}`);
    for (const text of await items.getByTestId("file-sync-diff-path").allInnerTexts()) paths.add(text);
    const next = page.getByTestId("file-sync-diff-items-page-next");
    if (await next.isDisabled()) break;
    await next.click();
    await settle();
  }
  assert.deepEqual([...paths].sort(), DIFFERING, "every differing file is reachable with Next");
  assert.ok(seen.filter((entry) => entry.path === "/api/file-sync/differences").length > 1, "each page is asked from the engine");
  const repaired = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/file-sync/repair");
  await page.getByTestId("file-sync-diff-repair").click();
  assert.deepEqual((await repaired).postDataJSON(), { share: "project:p01", peer: PEER });
  await page.getByTestId("file-sync-diff-status").filter({ hasText: "list of files was reloaded" }).waitFor();
  assert.deepEqual(seen.filter((entry) => entry.path.startsWith("/api/file-sync/engine")).map((entry) => entry.path), [], "the removed engine routes are never asked");
  assert.deepEqual(pageErrors, []);
});

test("a member sees no File sync tab and never asks for it", { timeout: 150_000 }, async () => {
  const member = await addMember(environment, node, "noam", "noam@example.test");
  const memberContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  try {
    const asked: string[] = [];
    await memberContext.route("**/api/file-sync/**", (route) => { asked.push(new URL(route.request().url()).pathname); return route.fulfill({ status: 403, contentType: "application/json", body: "{}" }); });
    const memberPage = await memberContext.newPage();
    memberPage.setDefaultTimeout(30_000);
    await memberPage.goto(node.url, { waitUntil: "domcontentloaded" });
    await memberPage.locator("#loginDialog[open]").waitFor();
    await memberPage.getByTestId("login-username-input").fill("noam@example.test");
    await memberPage.getByTestId("login-password-input").fill(member.oneTimePassword);
    await memberPage.getByTestId("login-submit-button").click();
    await memberPage.getByTestId("login-new-password-input").waitFor({ state: "visible" });
    await memberPage.getByTestId("login-password-input").fill(member.oneTimePassword);
    await memberPage.getByTestId("login-new-password-input").fill("member-chosen-password-1");
    await memberPage.getByTestId("login-submit-button").click();
    await memberPage.locator("#loginDialog[open]").waitFor({ state: "hidden" });
    await memberPage.getByTestId("settings-open-button").click();
    await memberPage.getByTestId("settings-tab-account").waitFor({ state: "visible" });
    assert.equal(await memberPage.getByTestId("settings-tab-file-sync").isVisible(), false, "no File sync tab for a member");
    assert.equal(await memberPage.getByTestId("settings-panel-file-sync").isVisible(), false);
    assert.deepEqual(asked, [], "a member's client never asks for file sync");
  } finally {
    await memberContext.close();
  }
});
