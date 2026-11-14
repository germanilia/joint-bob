import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type Browser } from "playwright-core";
import { openNodeDatabase } from "../../src/node-database.js";
import { storeReviewCheck } from "../../src/control-center/review-check.js";
import { api, projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";
import { launchChrome, WORKSPACE_COLUMN_KEY } from "./launch-chrome.js";

test("marking a Needs you conversation done survives a redraw of an older Control Center board", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-home-done-"));
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
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block", reducedMotion: "reduce" });
    await context.addInitScript((key) => localStorage.setItem(key, "inbox"), WORKSPACE_COLUMN_KEY);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await page.goto(node.url, { waitUntil: "domcontentloaded" });
    await page.locator("#loginDialog[open]").waitFor();
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator("#loginDialog[open]").waitFor({ state: "detached" });
    await page.getByTestId("phone-home").waitFor();
    const card = page.locator(`[data-testid="home-card"][data-key="${project.id}:${conversationId}"]`);
    await card.waitFor();

    // The Control Center keeps this snapshot while Home reads subsequent changes itself.
    await page.evaluate(`import("/app/control-center.js").then((board) => board.refreshControlCenter())`);
    const closed = await api(node, auth, "PUT", `/projects/${project.id}/sessions/done`, {
      engine: session.harnessId, sessionId: conversationId, done: true, feedback: { rating: "unimportant", description: "" },
    });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    // This is a real server mutation, not a replacement board response.
    const fresh = await api<{ cards: Array<{ conversationId: string }> }>(node, auth, "GET", "/control-center/board?look=1");
    assert.equal(fresh.body.cards.some((entry) => entry.conversationId === conversationId), false);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("control-center-changed")));
    await card.waitFor({ state: "detached" });

    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      // Filtering or changing layout redraws the cached board without fetching another snapshot.
      await page.evaluate(`import("/app/control-center.js").then((board) => board.focusProject(null))`);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      assert.equal(await card.count(), 0, `the closed conversation must not reappear at ${width}px`);
      const counts = await page.getByTestId(width <= 700 ? "phone-counts" : "home-counts").innerText();
      assert.match(counts, /^0 need(?:s)? you/, "Needs you counts must stay cleared too");
    }
  } finally {
    await browser?.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
