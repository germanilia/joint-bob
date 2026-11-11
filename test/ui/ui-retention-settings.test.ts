// Browser suite for the retention boxes in Settings: the three boxes that widen the first follow
// it, "Show what would be deleted" asks for the ticked boxes (not the saved ones) and shows the
// answer or the error, and saving sends the six boxes as one setting. The dry-run answer comes
// from a fixture, so nothing is counted or deleted on the node.
//
// And for "Backup before deleting" under them: the fields of the chosen place show and no others,
// the check button sends what is typed, a save sends the chosen place's fields only and the node
// gives them back, a refused save says why where it can be seen, and the status shows what is kept
// and the last problem. Saves and the folder check reach the node; a bucket is never contacted.
//
// Like the rest of test/ui it needs a Chrome binary, and it fails rather than skipping without one.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { type Browser, type Page, type Route } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "../dev-nodes.js";

const BOXES = ["full", "includeUnrecorded", "includeScheduled", "includeTickets", "leftovers", "backgroundRuns"] as const;
const count = (conversations: number, files: number, bytes: number) => ({ conversations, files, bytes });
/** What the node says about backups: where they go, what is kept, the last problem. */
interface BackupStatus { destination: string; where: string; keepDays: number; kept: { backups: number; bytes: number }; nextRemovalAt: string | null; problem: { at: string; message: string } | null }
const noBackups: BackupStatus = { destination: "off", where: "", keepDays: 30, kept: { backups: 0, bytes: 0 }, nextRemovalAt: null, problem: null };
const answer = {
  generatedAt: "2026-11-11T00:00:00.000Z", retentionDays: 40, passLimit: 500,
  switches: { full: true, includeUnrecorded: false, includeScheduled: false, includeTickets: true, leftovers: false, backgroundRuns: true },
  totals: { expired: count(975, 1076, 1_194_000_000), empty: count(6, 0, 0), background: count(2577, 2600, 577_000_000), leftover: count(449, 612, 601_000_000), held: count(32, 241, 119_000_000) },
  projects: [
    { projectId: "p1", name: "Contigos <b>", expired: count(500, 520, 479_000_000), empty: count(1, 0, 0) },
    { projectId: "p2", name: "Joint Bob", expired: count(461, 540, 627_000_000), empty: count(5, 0, 0) },
  ],
  kept: { "owned by another machine": 168, pinned: 4, "running, open or waiting": 11 },
  backup: noBackups,
};

/** The backup setting as GET /api/settings gives it. */
interface StoredBackup {
  destination: string; keepDays: number; folder: string;
  s3: { bucket: string; region: string; prefix: string; endpoint: string; credentials: string; accessKeyId: string; profile: string };
  hasSecretAccessKey: boolean; defaultFolder: string;
}

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

/** Fixture answers for the backup routes. While one is undefined the request reaches the node. */
let statusAnswer: { status: number; body: unknown } | undefined;
let checkAnswer: { body: unknown; hold?: boolean } | undefined;
let saveAnswer: { status: number; body: unknown } | undefined;
/** Lets a held check answer go. */
let releaseCheck: (() => void) | undefined;
/** The body of every check the page asked for. */
const checked: unknown[] = [];

const json = (status: number, body: unknown) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

async function backupStatus(route: Route): Promise<void> {
  if (statusAnswer) await route.fulfill(json(statusAnswer.status, statusAnswer.body));
  else await route.fallback();
}

async function backupCheck(route: Route): Promise<void> {
  checked.push(JSON.parse(route.request().postData() ?? "null"));
  const fixture = checkAnswer;
  if (!fixture) { await route.fallback(); return; }
  if (fixture.hold) await new Promise<void>((resolve) => { releaseCheck = resolve; });
  await route.fulfill(json(200, fixture.body));
}

/** While true, the node's settings reach the page without the backup setting, as from a node that predates it. */
let withoutBackup = false;

/** Answers one save from a fixture, so a refusal can be shown that the node would not make; or takes the backup setting out of what the node answers. */
async function settingsRoute(route: Route): Promise<void> {
  const fixture = saveAnswer;
  if (route.request().method() === "PUT" && fixture) {
    saveAnswer = undefined;
    await route.fulfill(json(fixture.status, fixture.body));
    return;
  }
  if (!withoutBackup) { await route.fallback(); return; }
  const response = await route.fetch();
  const { conversationBackup: _unknown, ...settings } = await response.json() as Record<string, unknown>;
  await route.fulfill({ response, json: settings });
}

const box = (name: string) => page.locator(`[data-retention-scope="${name}"]`);
// Reopening keeps the last values on screen until the reload finishes, so wait for it.
const settingsLoaded = () => page.waitForFunction(() => !document.querySelector("#settingsForm")!.hasAttribute("aria-busy"));
const digits = (text: string) => text.replace(/[^\d]/g, "");

async function rowOf(kind: string): Promise<string[]> {
  return page.locator(`[data-testid="settings-retention-preview-totals"] tr[data-kind="${kind}"] td`).allInnerTexts();
}

const field = (name: string) => page.getByTestId(`settings-backup-${name}`);
const S3_FIELDS = ["s3-bucket", "s3-region", "s3-prefix", "s3-credentials"] as const;
const KEY_FIELDS = ["s3-access-key-id", "s3-secret-access-key"] as const;
const ON_FIELDS = ["keep-days", "check-button"] as const;

/** Opens Settings afresh, so the form shows what the node has saved, with the backup group on screen. */
async function openSettings(): Promise<void> {
  const dialog = page.getByTestId("settings-dialog");
  if (await dialog.isVisible()) await dialog.evaluate((element: HTMLDialogElement) => element.close());
  await page.getByTestId("settings-open-button").click();
  await settingsLoaded();
  await page.getByTestId("settings-backup").scrollIntoViewIfNeeded();
}

/** Saves, waits for the dialog to close, and returns the backup part of the one request that made. */
async function saveBackup(): Promise<unknown> {
  const before = saved.length;
  await page.getByTestId("settings-save-button").click();
  await page.getByTestId("settings-dialog").waitFor({ state: "hidden" });
  assert.equal(saved.length, before + 1, "one save, one request");
  return saved.at(-1)!.conversationBackup;
}

async function storedBackup(): Promise<StoredBackup> {
  return (await api<{ conversationBackup: StoredBackup }>(node, session, "GET", "/settings")).body.conversationBackup;
}

/** The status line once it reads `text`: it is asked for apart from the settings, and an earlier answer stays until the new one. */
async function keptLine(text: string): Promise<void> {
  await page.getByTestId("settings-backup-kept").filter({ hasText: text }).waitFor();
  assert.equal(await page.getByTestId("settings-backup-kept").innerText(), text);
}

/** Whether the element can be seen now: inside the window, not scrolled out of its panel, nothing over its middle. */
function onScreen(selector: string): Promise<boolean> {
  return page.locator(selector).evaluate((element) => {
    const area = element.getBoundingClientRect();
    if (!area.width || !area.height) return false;
    const top = document.elementFromPoint(area.left + area.width / 2, area.top + area.height / 2);
    return top !== null && element.contains(top);
  });
}

/** Asks for a dry run whose answer is not held back, and waits until it is on the page. */
async function askDryRun(): Promise<void> {
  release ??= () => {};
  await page.getByTestId("settings-retention-preview-button").click();
  // The button is itself again when the answer is on the page.
  await page.waitForFunction(() => document.querySelector("#settingsRetentionPreviewButton")!.textContent === "Show what would be deleted");
}

async function dryRunBackupLine(): Promise<string> {
  await askDryRun();
  return page.getByTestId("settings-retention-preview-backup").innerText();
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
  await context.route("**/api/settings/conversation-backups", backupStatus);
  await context.route("**/api/settings/conversation-backups/check", backupCheck);
  await context.route("**/api/settings", settingsRoute);
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
  // Over the tables: nothing is kept of what goes, because no backup place is saved.
  assert.equal(await page.getByTestId("settings-retention-preview-backup").innerText(), "No backup is made: what is deleted is gone.");
  assert.equal(await page.getByTestId("settings-retention-preview").locator(":scope > *").first().getAttribute("data-testid"), "settings-retention-preview-backup", "the line comes before the tables");
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

// Backup before deleting. Each test opens Settings afresh, so it starts from what the node has saved.

/** The example secret key from Amazon's own documentation. */
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const KEY_ID = "AKIAIOSFODNN7EXAMPLE";
const CHECK_LABEL = "Check that backups can be written";
const checkButtonReads = (label: string) => page.waitForFunction((expected) => document.querySelector("#settingsBackupCheckButton")!.textContent === expected, label);

/** Waits until a held answer is waiting, then lets it go. */
async function letGo(held: () => (() => void) | undefined): Promise<void> {
  let go = held();
  while (!go) { await new Promise((resolve) => setTimeout(resolve, 20)); go = held(); }
  go();
}

test("backups start off: only the choice and what is kept show", async () => {
  await openSettings();
  const group = await page.getByTestId("settings-backup").innerText();
  assert.match(group, /^Backup before deleting\n/i);
  assert.match(group, /With a place chosen, the hourly check deletes a conversation only after its backup is stored there\./);
  assert.match(group, /If a backup cannot be written, old conversations are kept and the problem is shown here\./);
  assert.match(group, /Not backed up: a conversation that someone deletes by hand, a conversation that never got a message, and Joint Bob's own background runs\./);
  assert.match(group, /Pinned conversations are never deleted\./);
  assert.equal(await field("destination").inputValue(), "off");
  assert.deepEqual(await field("destination").locator("option").allTextContents(), ["Do not back up", "A folder on this machine", "An Amazon S3 bucket"]);
  for (const name of ["folder", ...S3_FIELDS, ...KEY_FIELDS, "s3-profile", "s3-endpoint", ...ON_FIELDS]) assert.equal(await field(name).isVisible(), false, `${name} is not shown while backups are off`);
  await keptLine("No backups yet.");
  assert.equal(await page.getByTestId("settings-backup-problem").count(), 0);
  assert.equal(await page.getByTestId("settings-backup-check-result").getAttribute("aria-live"), "polite");
  const stored = await storedBackup();
  assert.deepEqual([stored.destination, stored.keepDays, stored.folder, stored.hasSecretAccessKey], ["off", 30, "", false], "a node that never saved the setting");
});

test("choosing a place shows its fields and no others", async () => {
  await openSettings();
  const stored = await storedBackup();
  assert.ok(path.isAbsolute(stored.defaultFolder), "the node names the folder it uses when none is typed");

  await field("destination").selectOption("folder");
  for (const name of ["folder", ...ON_FIELDS]) assert.equal(await field(name).isVisible(), true, `${name} shows for a folder`);
  for (const name of [...S3_FIELDS, ...KEY_FIELDS, "s3-profile", "s3-endpoint"]) assert.equal(await field(name).isVisible(), false, `${name} is for a bucket`);
  assert.equal(await field("folder").inputValue(), "");
  assert.equal(await field("folder").getAttribute("placeholder"), stored.defaultFolder);
  assert.equal(await field("folder-hint").innerText(), `Leave this empty to use ${stored.defaultFolder}. Use a folder outside your projects.`);
  assert.equal(await field("keep-days").inputValue(), "30");
  assert.deepEqual(await field("keep-days").evaluate((input: HTMLInputElement) => [input.type, input.min, input.max]), ["number", "0", "3650"]);
  assert.match(await page.getByTestId("settings-backup").innerText(), /0 keeps backups for good\./);
  assert.equal(await field("check-button").innerText(), CHECK_LABEL);
  assert.equal(await field("check-button").isEnabled(), true);

  await field("destination").selectOption("s3");
  assert.equal(await field("folder").isVisible(), false, "the folder is for the other choice");
  for (const name of [...S3_FIELDS, ...KEY_FIELDS, ...ON_FIELDS]) assert.equal(await field(name).isVisible(), true, `${name} shows for a bucket`);
  assert.equal(await field("s3-region").getAttribute("placeholder"), "eu-west-1");
  assert.deepEqual(await field("s3-credentials").locator("option").allTextContents(), ["An access key", "An AWS profile on this machine"]);
  assert.equal(await field("s3-credentials").inputValue(), "keys");
  assert.equal(await field("s3-profile").isVisible(), false, "a profile is the other way to sign in");
  const secret = field("s3-secret-access-key");
  assert.deepEqual(await secret.evaluate((input: HTMLInputElement) => [input.type, input.autocomplete, input.value, input.placeholder]), ["password", "new-password", "", ""]);
  assert.equal(await field("s3-secret-hint").innerText(), "The secret key is stored encrypted on this machine and is never shown again.", "no key is saved, and nothing says one is");

  // The other S3-compatible service sits behind its own line until somebody wants it.
  assert.equal(await field("s3-endpoint").isVisible(), false);
  await field("s3-more").locator("summary").click();
  assert.equal(await field("s3-endpoint").isVisible(), true);
  assert.match(await field("s3-more").innerText(), /Leave this empty for Amazon S3\./);

  await field("s3-credentials").selectOption("profile");
  for (const name of KEY_FIELDS) assert.equal(await field(name).isVisible(), false, `${name} is for an access key`);
  assert.equal(await field("s3-profile").isVisible(), true);
  assert.equal(await field("s3-profile").getAttribute("placeholder"), "default profile");
  assert.match(await page.getByTestId("settings-backup").innerText(), /This needs the AWS command line tool on this machine\./);
  await field("s3-credentials").selectOption("keys");
  for (const name of KEY_FIELDS) assert.equal(await field(name).isVisible(), true);
  assert.equal(await field("s3-profile").isVisible(), false);

  await field("destination").selectOption("off");
  for (const name of ["folder", ...S3_FIELDS, ...KEY_FIELDS, "s3-profile", "s3-endpoint", ...ON_FIELDS]) assert.equal(await field(name).isVisible(), false, `${name} goes when backups are off`);
  assert.deepEqual(await storedBackup(), stored, "looking saves nothing");
});

test("the check button sends what is typed and shows the node's answer", async () => {
  await openSettings();
  const folder = path.join(root, "checked-backups");
  const button = field("check-button");
  const result = page.getByTestId("settings-backup-check-result");
  const refusal = result.locator('[role="alert"]');
  await field("destination").selectOption("folder");
  await field("keep-days").fill("14");
  await field("folder").fill(`  ${folder} `);
  checked.length = 0;

  // A folder the node can write to: the node itself answers.
  await button.click();
  await result.locator("p").waitFor();
  assert.deepEqual(checked, [{ destination: "folder", keepDays: 14, folder }], "the values on the page, in the shape a save takes");
  assert.equal(await result.innerText(), `Joint Bob can write backups to ${folder}.`);
  assert.equal(await refusal.count(), 0);
  assert.equal(await button.innerText(), CHECK_LABEL);
  assert.equal(await button.isEnabled(), true);
  const left = (await readdir(folder, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
  assert.deepEqual(left, [], "the file the check wrote is gone again");
  assert.equal((await storedBackup()).destination, "off", "checking saves nothing");

  // A changed value takes the answer away: it was about the folder as it was.
  await field("folder").fill("backups/here");
  assert.equal(await result.locator("p").count(), 0);
  // A folder the node refuses: its reason, as an alert.
  await button.click();
  await refusal.waitFor();
  assert.equal(await refusal.innerText(), "The backup folder must be an absolute path");
  assert.deepEqual(checked.at(-1), { destination: "folder", keepDays: 14, folder: "backups/here" });
  assert.equal(await button.isEnabled(), true);

  // A bucket. The answers come from the fixture, so no bucket is contacted; the first is held back.
  await field("destination").selectOption("s3");
  await field("s3-bucket").fill("team-backups");
  await field("s3-region").fill("eu-west-1");
  await field("s3-prefix").fill("joint-bob");
  await field("s3-access-key-id").fill(KEY_ID);
  await field("s3-secret-access-key").fill(SECRET);
  assert.equal(await result.locator("p").count(), 0, "the folder's answer does not stay under a bucket");
  checkAnswer = { hold: true, body: { ok: false, message: "S3 refused the upload to <b>team-backups</b>: AccessDenied" } };
  releaseCheck = undefined;
  await button.click();
  await checkButtonReads("Checking…");
  assert.equal(await button.isDisabled(), true, "it cannot be pressed twice");
  await letGo(() => releaseCheck);
  await refusal.waitFor();
  assert.equal(await refusal.innerText(), "S3 refused the upload to <b>team-backups</b>: AccessDenied", "the node's words, shown as text");
  assert.equal(await button.innerText(), CHECK_LABEL);
  assert.equal(await button.isEnabled(), true);
  assert.deepEqual(checked.at(-1), { destination: "s3", keepDays: 14, s3: { bucket: "team-backups", region: "eu-west-1", prefix: "joint-bob", endpoint: "", credentials: "keys", accessKeyId: KEY_ID, secretAccessKey: SECRET } });

  // An answer that arrives after the values changed is not shown: it is about another bucket.
  checkAnswer = { hold: true, body: { ok: true, where: "s3://team-backups/joint-bob/node-a" } };
  releaseCheck = undefined;
  await button.click();
  await checkButtonReads("Checking…");
  await field("s3-bucket").fill("other-backups");
  await letGo(() => releaseCheck);
  await checkButtonReads(CHECK_LABEL);
  assert.equal(await result.locator("p").count(), 0);

  // A profile: the key fields stay out of the request.
  await field("s3-credentials").selectOption("profile");
  await field("s3-profile").fill("backup-writer");
  checkAnswer = { body: { ok: true, where: "s3://other-backups/joint-bob/node-a" } };
  await button.click();
  await result.locator("p").waitFor();
  assert.equal(await result.innerText(), "Joint Bob can write backups to s3://other-backups/joint-bob/node-a.");
  assert.deepEqual(checked.at(-1), { destination: "s3", keepDays: 14, s3: { bucket: "other-backups", region: "eu-west-1", prefix: "joint-bob", endpoint: "", credentials: "profile", profile: "backup-writer" } });

  // A number of days the node would refuse stops at the field: nothing is asked.
  const asks = checked.length;
  await field("keep-days").fill("4000");
  await button.click();
  assert.equal(await field("keep-days").evaluate((input: HTMLInputElement) => input.validity.rangeOverflow), true);
  await field("keep-days").fill("14");
  await button.click();
  await result.locator("p").waitFor();
  assert.equal(checked.length, asks + 1, "only the check with a number in range was sent");
  checkAnswer = undefined;
  assert.equal((await storedBackup()).destination, "off", "none of it was saved");
});

test("the dry run says what is kept of a conversation before it goes", async () => {
  // What the fixtures stand in for: the node's own dry run carries the object its status route gives.
  const [dry, status] = await Promise.all([api<{ backup: BackupStatus }>(node, session, "GET", "/settings/retention-preview"), api<BackupStatus>(node, session, "GET", "/settings/conversation-backups")]);
  assert.deepEqual([dry.status, status.status], [200, 200]);
  assert.deepEqual(dry.body.backup, status.body);
  assert.deepEqual(Object.keys(status.body).sort(), Object.keys(noBackups).sort());
  await openSettings();
  const kept: BackupStatus = { ...noBackups, destination: "folder", where: "/srv/backups <b>" };
  const rest = "Empty conversations and background runs are not backed up.";
  next = { status: 200, body: { ...answer, backup: kept } };
  assert.equal(await dryRunBackupLine(), `Expired conversations and left-behind files are backed up to /srv/backups <b> first. Each backup is deleted after 30 days. ${rest}`, "the place is shown as text");
  next = { status: 200, body: { ...answer, backup: { ...kept, destination: "s3", where: "s3://team-backups/joint-bob/node-a", keepDays: 1 } } };
  assert.equal(await dryRunBackupLine(), `Expired conversations and left-behind files are backed up to s3://team-backups/joint-bob/node-a first. Each backup is deleted after 1 day. ${rest}`);
  next = { status: 200, body: { ...answer, backup: { ...kept, keepDays: 0 } } };
  assert.equal(await dryRunBackupLine(), `Expired conversations and left-behind files are backed up to /srv/backups <b> first. The backups are kept for good. ${rest}`);

  // The dry run reads the saved backup setting. A choice that is not saved yet does not count, and the line says so.
  next = { status: 200, body: answer };
  await field("destination").selectOption("folder");
  assert.equal(await dryRunBackupLine(), "No backup is made: what is deleted is gone. This is the saved backup setting. Your changes below are not saved yet.");
  await field("destination").selectOption("off");
  assert.equal(await dryRunBackupLine(), "No backup is made: what is deleted is gone.");

  // A node that predates backups says nothing about them, and the tables still show.
  const { backup: _backup, ...older } = answer;
  next = { status: 200, body: older };
  await askDryRun();
  assert.equal(await page.getByTestId("settings-retention-preview-totals").count(), 1);
  assert.equal(await page.getByTestId("settings-retention-preview-backup").count(), 0);
  next = { status: 200, body: answer };
});

test("a save sends the fields of the chosen place and no others, and the node gives them back", async () => {
  await openSettings();
  // A bucket with an access key. Saving checks the fields and contacts nobody.
  await field("destination").selectOption("s3");
  await field("keep-days").fill("14");
  await field("s3-bucket").fill(" team-backups ");
  await field("s3-region").fill("eu-west-1");
  await field("s3-prefix").fill("/joint-bob/");
  await field("s3-access-key-id").fill(KEY_ID);
  await field("s3-secret-access-key").fill(SECRET);
  assert.deepEqual(await saveBackup(), { destination: "s3", keepDays: 14, s3: { bucket: "team-backups", region: "eu-west-1", prefix: "/joint-bob/", endpoint: "", credentials: "keys", accessKeyId: KEY_ID, secretAccessKey: SECRET } });
  // The form takes the node's answer at once: the secret key is gone from the page, and the folder in the bucket reads as the node keeps it.
  assert.deepEqual(await Promise.all(["s3-secret-access-key", "s3-prefix"].map((name) => field(name).inputValue())), ["", "joint-bob"]);
  const settings = await api<{ conversationBackup: StoredBackup }>(node, session, "GET", "/settings");
  const { defaultFolder } = settings.body.conversationBackup;
  const bucket = { bucket: "team-backups", region: "eu-west-1", prefix: "joint-bob", endpoint: "", credentials: "keys", accessKeyId: KEY_ID, profile: "" };
  assert.deepEqual(settings.body.conversationBackup, { destination: "s3", keepDays: 14, folder: "", s3: bucket, hasSecretAccessKey: true, defaultFolder });
  assert.equal(JSON.stringify(settings.body).includes(SECRET), false, "the secret key never comes back");

  // The saved values return to the form, except the secret key.
  await openSettings();
  assert.equal(await field("destination").inputValue(), "s3");
  assert.equal(await field("keep-days").inputValue(), "14");
  assert.deepEqual(await Promise.all(["s3-bucket", "s3-region", "s3-prefix", "s3-credentials", "s3-access-key-id"].map((name) => field(name).inputValue())), ["team-backups", "eu-west-1", "joint-bob", "keys", KEY_ID]);
  assert.deepEqual(await field("s3-secret-access-key").evaluate((input: HTMLInputElement) => [input.value, input.placeholder]), ["", "A key is saved. Type a new one to replace it."]);
  assert.match(await field("s3-secret-hint").innerText(), /^A key is saved\. Leave this empty to keep it\. The secret key is stored encrypted/);
  assert.equal(await field("folder").isVisible(), false);
  assert.equal(await field("s3-endpoint").isVisible(), false, "no other service is saved, so its line stays closed");

  // Saved again with the key's field left empty: no key is sent, and the saved one stays.
  await field("keep-days").fill("0");
  await field("s3-more").locator("summary").click();
  await field("s3-endpoint").fill("https://s3.example.test/");
  assert.deepEqual(await saveBackup(), { destination: "s3", keepDays: 0, s3: { bucket: "team-backups", region: "eu-west-1", prefix: "joint-bob", endpoint: "https://s3.example.test/", credentials: "keys", accessKeyId: KEY_ID } }, "an empty secret key is left out");
  assert.deepEqual(await storedBackup(), { destination: "s3", keepDays: 0, folder: "", s3: { ...bucket, endpoint: "https://s3.example.test" }, hasSecretAccessKey: true, defaultFolder });

  // A profile instead: the key's fields are not sent.
  await openSettings();
  assert.equal(await field("s3-endpoint").isVisible(), true, "a saved address does not hide behind the closed line");
  assert.equal(await field("s3-endpoint").inputValue(), "https://s3.example.test");
  await field("s3-endpoint").fill("");
  await field("s3-credentials").selectOption("profile");
  await field("s3-profile").fill("backup-writer");
  assert.deepEqual(await saveBackup(), { destination: "s3", keepDays: 0, s3: { bucket: "team-backups", region: "eu-west-1", prefix: "joint-bob", endpoint: "", credentials: "profile", profile: "backup-writer" } });
  const profile = { ...bucket, credentials: "profile", profile: "backup-writer" };
  assert.deepEqual(await storedBackup(), { destination: "s3", keepDays: 0, folder: "", s3: profile, hasSecretAccessKey: true, defaultFolder });

  // A folder: the bucket's fields are not sent, and the node keeps them for a later change of mind.
  await openSettings();
  assert.equal(await field("s3-profile").inputValue(), "backup-writer");
  for (const name of KEY_FIELDS) assert.equal(await field(name).isVisible(), false);
  const folder = path.join(root, "kept-backups");
  await field("destination").selectOption("folder");
  await field("folder").fill(folder);
  // An empty number of days stops the save at the field, and nothing is sent.
  const puts = saved.length;
  await field("keep-days").fill("");
  await page.getByTestId("settings-save-button").click();
  assert.equal(await field("keep-days").evaluate((input: HTMLInputElement) => input.validity.valueMissing), true);
  assert.equal(await page.getByTestId("settings-dialog").isVisible(), true);
  await field("keep-days").fill("21");
  assert.deepEqual(await saveBackup(), { destination: "folder", keepDays: 21, folder });
  assert.equal(saved.length, puts + 1, "the save without a number was not sent");
  assert.deepEqual(await storedBackup(), { destination: "folder", keepDays: 21, folder, s3: profile, hasSecretAccessKey: true, defaultFolder });

  // A reload of the page shows what the node saved.
  await page.reload();
  await page.getByText("Internal Assistant", { exact: true }).waitFor();
  await openSettings();
  assert.equal(await field("destination").inputValue(), "folder");
  assert.equal(await field("folder").inputValue(), folder);
  assert.equal(await field("keep-days").inputValue(), "21");
  for (const name of [...S3_FIELDS, "s3-profile"]) assert.equal(await field(name).isVisible(), false);
  await keptLine("No backups yet.");

  // Off: the choice alone is sent. The days are not on screen, so an emptied field neither
  // holds up the save nor changes the saved number.
  await field("keep-days").fill("");
  await field("destination").selectOption("off");
  assert.deepEqual(await saveBackup(), { destination: "off" });
  assert.deepEqual(await storedBackup(), { destination: "off", keepDays: 21, folder, s3: profile, hasSecretAccessKey: true, defaultFolder });
  for (const body of saved) {
    const sent = JSON.stringify(body.conversationBackup);
    assert.equal(/hasSecretAccessKey|defaultFolder|"secretAccessKey":""/.test(sent), false, `a save carries only what the node takes: ${sent}`);
  }
  assert.equal(saved.filter((body) => JSON.stringify(body).includes(SECRET)).length, 1, "the secret key was sent once, when it was typed");
});

test("a save the node refuses says why, where it can be seen", async () => {
  await openSettings();
  const before = await storedBackup();
  const footer = page.locator("#settingsRestartMessage");
  const inline = page.getByTestId("settings-backup-save-error");
  const groupOutOfSight = async () => {
    await page.locator("#settingsPanel-account").evaluate((panel) => { panel.scrollTop = 0; });
    assert.equal(await onScreen('[data-testid="settings-backup-destination"]'), false, "the group is below what the panel shows");
  };
  await field("destination").selectOption("s3");
  await field("s3-bucket").fill("");
  await field("s3-region").fill("eu-west-1");
  await field("keep-days").fill("30");

  // The node itself refuses a bucket without a name. Saved from the top of the panel, where the group is out of sight.
  await groupOutOfSight();
  await page.getByTestId("settings-save-button").click();
  await footer.filter({ hasText: "Could not save settings:" }).waitFor();
  assert.match(await footer.innerText(), /^Could not save settings: .*Backups to S3 need a bucket$/);
  assert.equal(await onScreen("#settingsRestartMessage"), true, "the reason is on screen, over the Save button");
  await page.locator(".toast-error").filter({ hasText: "Backups to S3 need a bucket" }).waitFor();
  // And next to the fields it is about, in the node's own words: the panel has moved to it.
  await inline.locator('[role="alert"]').waitFor();
  assert.equal(await inline.innerText(), "Backups to S3 need a bucket");
  assert.equal(await onScreen('[data-testid="settings-backup-save-error"]'), true, "the group's reason is on screen");
  assert.equal(await page.getByTestId("settings-dialog").isVisible(), true, "the dialog stays for another try");
  assert.equal(await field("s3-region").inputValue(), "eu-west-1", "what was typed is still there");
  assert.equal(await page.getByTestId("settings-save-button").isEnabled(), true);
  assert.deepEqual(await storedBackup(), before, "nothing was saved");
  // Correcting a field takes the reason away.
  await field("s3-bucket").fill("Team Backups");
  assert.equal(await inline.locator("p").count(), 0);

  // Whatever the node says is shown as text.
  saveAnswer = { status: 400, body: { error: "That is not a bucket name <b>S3</b> accepts", details: { setting: "conversationBackup" } } };
  await page.getByTestId("settings-save-button").click();
  await inline.locator('[role="alert"]').waitFor();
  assert.equal(await inline.innerText(), "That is not a bucket name <b>S3</b> accepts");
  assert.match(await footer.innerText(), /^Could not save settings: .*That is not a bucket name <b>S3<\/b> accepts$/);

  // A refusal about another setting stays out of the backup group, and takes the earlier reason with it.
  saveAnswer = { status: 400, body: { error: "Joint Bob home folder must be absolute" } };
  await page.getByTestId("settings-save-button").click();
  await footer.filter({ hasText: "Joint Bob home folder must be absolute" }).waitFor();
  assert.equal(await inline.locator("p").count(), 0);
  assert.deepEqual(await storedBackup(), before, "the fixture answered, so the node saved nothing");
});

test("the status shows what is kept, when the oldest goes, and the last problem", async () => {
  const soon = new Date(Date.now() + 20 * 86_400_000).toISOString();
  const day = await page.evaluate((iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }), soon);
  const problem = { at: "2026-11-10T08:05:00.000Z", message: "Conversation claude:abc in Contigos <b> could not be backed up: no space left on device. Nothing more is deleted for its age until a backup succeeds." };
  const when = await page.evaluate((iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" }), problem.at);

  statusAnswer = { status: 200, body: { destination: "folder", where: "/srv/backups", keepDays: 30, kept: { backups: 3, bytes: 5_400_000 }, nextRemovalAt: soon, problem } satisfies BackupStatus };
  await openSettings();
  await keptLine(`3 backups kept (5.4 MB). The oldest is removed on ${day}.`);
  const alert = page.getByTestId("settings-backup-problem");
  assert.equal(await alert.getAttribute("role"), "alert");
  assert.equal(await alert.innerText(), `Problem on ${when}: ${problem.message}`, "the time and the node's words, shown as text");
  await alert.scrollIntoViewIfNeeded();
  assert.equal(await onScreen('[data-testid="settings-backup-problem"]'), true);
  const colours = await alert.evaluate((element) => [getComputedStyle(element).color, getComputedStyle(document.querySelector('[data-testid="settings-backup-kept"]')!).color]);
  assert.notEqual(colours[0], colours[1], "the problem stands out from the line over it");

  // One small backup that is kept for good, and no problem.
  statusAnswer = { status: 200, body: { ...noBackups, keepDays: 0, kept: { backups: 1, bytes: 340_000 } } satisfies BackupStatus };
  await openSettings();
  await keptLine("1 backup kept for good (340 KB).");
  assert.equal(await alert.count(), 0, "a problem that is over is not shown");

  // Backups whose day has come go at the next hourly check.
  statusAnswer = { status: 200, body: { ...noBackups, kept: { backups: 1280, bytes: 7_340_000_000 }, nextRemovalAt: "2026-01-01T00:00:00.000Z" } satisfies BackupStatus };
  await openSettings();
  await keptLine("1,280 backups kept (7.3 GB). The oldest is removed at the next hourly check.");

  // The status is not part of the settings: when it cannot be read, the reason shows and Settings still opens and saves.
  statusAnswer = { status: 500, body: { error: "The backup list could not be read" } };
  await openSettings();
  const failed = page.getByTestId("settings-backup-status-error");
  await failed.waitFor();
  assert.match(await failed.innerText(), /The backup list could not be read$/);
  assert.equal(await page.getByTestId("settings-backup-kept").count(), 0);
  assert.equal(await field("destination").inputValue(), "off");
  statusAnswer = undefined;
  assert.deepEqual(await saveBackup(), { destination: "off" });
});

test("a node that predates backups shows no backup group, and a save leaves the setting out", async () => {
  withoutBackup = true;
  try {
    // A page that never saw the setting: the group's number field is as empty as the page ships it.
    await page.reload();
    await page.getByText("Internal Assistant", { exact: true }).waitFor();
    await page.getByTestId("settings-open-button").click();
    await settingsLoaded();
    await page.getByTestId("settings-retention-scope").scrollIntoViewIfNeeded();
    assert.equal(await page.getByTestId("settings-backup").isVisible(), false);
    assert.equal(await field("keep-days").inputValue(), "");
    // The dry run of such a node has no backup line either.
    const { backup: _backup, ...older } = answer;
    next = { status: 200, body: older };
    await askDryRun();
    assert.equal(await page.getByTestId("settings-retention-preview-totals").count(), 1);
    assert.equal(await page.getByTestId("settings-retention-preview-backup").count(), 0);
    // The empty number that nobody can see does not hold up the save, and the setting is not sent.
    const puts = saved.length;
    await page.getByTestId("settings-save-button").click();
    await page.getByTestId("settings-dialog").waitFor({ state: "hidden" });
    assert.equal(saved.length, puts + 1);
    assert.equal("conversationBackup" in saved.at(-1)!, false, "a node that does not know the setting is not sent it");
    assert.equal("conversationRetentionScope" in saved.at(-1)!, true, "the rest of the settings goes as before");
  } finally {
    withoutBackup = false;
    next = { status: 200, body: answer };
  }
  // The same page, once the node knows the setting: the group is back.
  await openSettings();
  assert.equal(await page.getByTestId("settings-backup").isVisible(), true);
  assert.equal(await field("destination").inputValue(), "off");
});

test("on a phone the backup group stacks and nothing in it scrolls sideways", async () => {
  // Long words that cannot break at a space: a folder path, a bucket address, an archive's name.
  const long = "/Volumes/backups-of-the-office-machine/joint-bob/conversation-backups-kept-for-the-whole-team-since-2026";
  statusAnswer = { status: 200, body: {
    destination: "s3", where: "s3://team-backups/joint-bob/office-mac", keepDays: 30, kept: { backups: 128, bytes: 734_000_000 }, nextRemovalAt: "2026-01-01T00:00:00.000Z",
    problem: { at: "2026-11-10T08:05:00.000Z", message: `The backup s3://team-backups/joint-bob/office-mac/Contigos_p1/2026-10-01_claude_5d0c6f6e-9a1b-4c1e-8a57-0f3f2c7d9e11_a-long-title-of-a-conversation.tar.gz is past its 30 days and could not be removed: AccessDenied` },
  } satisfies BackupStatus };
  await page.getByTestId("settings-dialog").evaluate((dialog: HTMLDialogElement) => dialog.close());
  await page.setViewportSize({ width: 390, height: 844 });
  try {
    // A phone has no Settings button in the header; the app opens the section the same way.
    await page.evaluate(async () => { await (await import("/app/settings.js" as string)).openSettings("account"); });
    await settingsLoaded();
    await page.getByTestId("settings-backup-problem").waitFor();
    /** What reaches past the panel's right edge, and whether the panel or the page scrolls sideways. */
    const sideways = () => page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>("#settingsPanel-account")!;
      const edge = panel.getBoundingClientRect().right + 1;
      const wide = [...document.querySelectorAll<HTMLElement>("#settingsBackup, #settingsBackup *, #settingsRetentionPreview *")].filter((element) => element.getBoundingClientRect().right > edge);
      return { wide: wide.map((element) => `${element.tagName.toLowerCase()}#${element.id}.${element.className}`), panel: panel.scrollWidth - panel.clientWidth, page: document.documentElement.scrollWidth - window.innerWidth };
    });
    const fits = { wide: [], panel: 0, page: 0 };
    assert.deepEqual(await sideways(), fits, "with backups off");

    await field("destination").selectOption("folder");
    await field("folder").fill(long);
    checkAnswer = { body: { ok: true, where: long } };
    await field("check-button").click();
    await page.getByTestId("settings-backup-check-result").locator("p").waitFor();
    assert.deepEqual(await sideways(), fits, "a folder, checked");
    for (const name of ["folder", "keep-days"]) assert.equal(await field(name).evaluate((input) => Math.round(input.getBoundingClientRect().width) >= 300), true, `${name} takes the phone's width`);

    await field("destination").selectOption("s3");
    await field("s3-credentials").selectOption("keys");
    await field("s3-more").locator("summary").click();
    checkAnswer = { body: { ok: false, message: `S3 refused ${long.replaceAll("/", "_")}` } };
    await field("check-button").click();
    await page.getByTestId("settings-backup-check-result").locator('[role="alert"]').waitFor();
    assert.deepEqual(await sideways(), fits, "a bucket, refused");
    // One field under the other, each as wide as the group.
    const stacked = ["s3-bucket", "s3-region", "s3-prefix", "s3-access-key-id", "s3-secret-access-key", "s3-endpoint", "keep-days"];
    for (const name of stacked) assert.equal(await field(name).isVisible(), true, `${name} shows`);
    const tops = await Promise.all(stacked.map((name) => field(name).evaluate((input) => Math.round(input.getBoundingClientRect().top))));
    assert.deepEqual(tops, [...tops].sort((a, b) => a - b), "the fields come in reading order, top to bottom");
    assert.equal(new Set(tops).size, tops.length, "no two fields share a row");

    // The dry run's line carries a place too.
    next = { status: 200, body: { ...answer, backup: { ...noBackups, destination: "folder", where: long } } };
    assert.match(await dryRunBackupLine(), /are backed up to \/Volumes\/backups-of-the-office-machine/);
    assert.deepEqual(await sideways(), fits, "with the dry run's answer");
  } finally {
    next = { status: 200, body: answer };
    statusAnswer = undefined;
    checkAnswer = undefined;
    await page.getByTestId("settings-dialog").evaluate((dialog: HTMLDialogElement) => dialog.close());
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

test("the settings search opens the line a bucket's other service sits behind", async () => {
  await openSettings();
  await field("destination").selectOption("s3");
  assert.equal(await field("s3-endpoint").isVisible(), false);
  await page.getByTestId("settings-search-input").fill("Address of the service");
  const found = page.getByTestId("settings-search-result").first();
  await found.waitFor();
  assert.match(await found.innerText(), /Address of the service\s+Account › Backup before deleting/);
  await found.click();
  await field("s3-endpoint").waitFor();
  assert.equal(await field("s3-more").evaluate((details: HTMLDetailsElement) => details.open), true);
  await page.getByTestId("settings-dialog").evaluate((dialog: HTMLDialogElement) => dialog.close());
  assert.deepEqual(pageErrors, []);
});
