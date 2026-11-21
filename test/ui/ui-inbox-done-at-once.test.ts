import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type Browser, type Route } from "playwright-core";
import { openNodeDatabase } from "../../src/node-database.js";
import { storeReviewCheck } from "../../src/control-center/review-check.js";
import { api, projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";
import { launchChrome, WORKSPACE_COLUMN_KEY } from "./launch-chrome.js";

/** Holds every matching request until the test lets it through, or answers it with an error. */
function gate() {
  const held: Route[] = [];
  let arrival = Promise.withResolvers<void>();
  return {
    handle: (route: Route) => { held.push(route); arrival.resolve(); },
    wait: async () => { if (!held.length) await arrival.promise; },
    count: () => held.length,
    pass: async () => { for (const route of held.splice(0)) await route.continue(); arrival = Promise.withResolvers<void>(); },
    refuse: async (error: string) => { for (const route of held.splice(0)) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error }) }); arrival = Promise.withResolvers<void>(); },
  };
}

// The Inbox column draws from the board, so a conversation marked done stayed in Needs you until the next board read,
// which took seconds on a busy node (2026-11-21). The row now moves on the click, with the save and every board read
// still unanswered, and comes back if the save is refused.
test("marking a conversation done moves its Inbox column row before the server answers", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-inbox-done-"));
  let server: ChildProcess | undefined;
  let browser: Browser | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    server = await startDevNode(environment, node);
    const auth = await signIn(environment, node);
    const project = projectNamed(node, "Joint Bob");
    const sessions = await api<{ sessions: Array<{ id: string; conversationId?: string; harnessId: string; title: string }> }>(node, auth, "GET", `/projects/${project.id}/sessions`);
    const session = sessions.body.sessions[0];
    const conversationId = session.conversationId ?? session.id;
    const db = openNodeDatabase(path.join(node.dataDir, "node.db"));
    try {
      storeReviewCheck(db, {
        projectId: project.id, conversationId, accountId: "test", verdict: "needs-user", reason: "Which layout should I use?",
        by: "test", answerHash: "fixture", pushes: 0, pushPending: false, needsYou: true, checkedAt: new Date().toISOString(),
      });
    } finally { db.close(); }

    browser = await launchChrome({ headless: process.env.HEADED !== "1" });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block", reducedMotion: "reduce" });
    await context.addInitScript((key) => localStorage.setItem(key, "inbox"), WORKSPACE_COLUMN_KEY);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(node.url, { waitUntil: "domcontentloaded" });
    await page.locator("#loginDialog[open]").waitFor();
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator("#loginDialog[open]").waitFor({ state: "detached" });

    const key = `${project.id}:${conversationId}`;
    const waiting = page.locator(`[data-testid="workspace-group-needs-you"] [data-key="${key}"]`);
    const closed = page.locator(`[data-testid="workspace-group-done"] [data-key="${key}"]`);
    await waiting.waitFor();
    await waiting.click();
    await page.waitForFunction(async (id) => (await import("/app/state.js" as string)).state.activeSessionId === id, session.id);

    // From here no board read and no save is answered until the test says so.
    const board = gate(), done = gate();
    await page.route("**/api/control-center/board**", board.handle);
    await page.route("**/sessions/done", done.handle);

    // A refused save puts the row back where it was.
    await page.getByTestId("chat-done-button").click();
    await page.getByTestId("conversation-feedback-submit").click();
    await closed.waitFor();
    assert.equal(await waiting.count(), 0, "the row leaves Needs you on the click");
    await done.wait();
    await done.refuse("Done marks are unavailable");
    await waiting.waitFor();
    assert.equal(await closed.count(), 0, "a refused save takes the row out of Done again");

    // A saved one stays moved through board reads asked for before the save was confirmed.
    await page.waitForFunction(async (id) => (await import("/app/state.js" as string)).state.activeSessionId === id, session.id);
    await page.getByTestId("chat-done-button").click();
    await page.getByTestId("conversation-feedback-submit").click();
    await closed.waitFor();
    assert.equal(await waiting.count(), 0);
    await done.wait();
    await done.pass();
    await board.wait();
    await page.unroute("**/api/control-center/board**");
    await board.pass();
    // The read asked for after the save confirms it and replaces the overlay.
    await page.waitForFunction(async ({ projectId, conversationId }) => {
      const response = await fetch(`/api/control-center/board?look=1&earlier=1`);
      const body = await response.json() as { cards: Array<{ projectId: string; conversationId: string }>; earlier?: Array<{ projectId: string; conversationId: string; done: boolean }> };
      return !body.cards.some((card) => card.projectId === projectId && card.conversationId === conversationId)
        && Boolean(body.earlier?.some((row) => row.projectId === projectId && row.conversationId === conversationId && row.done));
    }, { projectId: project.id, conversationId });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("control-center-changed")));
    await page.waitForTimeout(1_500);
    assert.equal(await waiting.count(), 0, "the conversation does not come back to Needs you");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
