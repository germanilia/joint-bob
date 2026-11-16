import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

const CARD = {
  projectId: "p1", projectName: "Joint Bob", conversationId: "c1", sessionId: "c1", path: "/c1", title: "Bucket question", column: "needs-you",
  agentId: "claude", agentLabel: "Claude", agentModel: null, executionNodeId: null, updatedAt: "2026-11-12T09:00:00Z", turnRunning: false,
  backgroundRunning: false, summary: null, autoRespondActive: false, pendingReviews: [], autoRespondStop: { kind: "question", reason: "Which bucket?" },
  controlledBy: null, reviewCheck: null, snooze: null,
};

test("a Needs you conversation is snoozed from its Inbox row, is listed under Snoozed with its end time, and wakes", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(async () => (await import("/app/state.js")).state.preferencesLoaded);
  await page.waitForTimeout(500);
  await page.evaluate(`(() => {
    const originalFetch = window.fetch;
    window.__board = { projects: [{ id: 'p1', name: 'Joint Bob' }], cards: [${JSON.stringify(CARD)}] };
    window.__snoozes = [];
    window.fetch = async (...args) => {
      const path = new URL(String(args[0]), location.href).pathname;
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (path === '/api/control-center/snooze') {
        // As the server does: a snoozed card moves to Snoozed, a woken one back to Needs you.
        const body = JSON.parse(args[1].body);
        window.__snoozes.push(body);
        const card = window.__board.cards[0];
        Object.assign(card, body.action === 'snooze' ? { column: 'snoozed', snooze: { until: body.until, snoozedAt: new Date().toISOString() } } : { column: 'needs-you', snooze: null });
        return json({ ok: true });
      }
      if (path === '/api/control-center/board') return json(window.__board);
      return originalFetch(...args);
    };
  })()`);

  // The Inbox in the left column lists the conversation under Needs you (opening Bob reads the board again; Home keeps the
  // Inbox in the column whatever the page's start restores afterwards).
  await page.getByTestId("projects-open-control-center-button").click();
  await page.waitForTimeout(500);
  await page.getByTestId("workspace-home-button").click();
  const row = page.getByTestId("workspace-group-needs-you").getByTestId("workspace-group-row").filter({ hasText: "Bucket question" });
  await row.waitFor();
  assert.equal(await page.getByTestId("workspace-group-count-needs-you").textContent(), "1");

  // Its own menu (right click) puts it aside, under the row pressed.
  await row.click({ button: "right" });
  await page.getByTestId("inbox-row-snooze").click();
  const pressed = await row.boundingBox();
  const choice = await page.getByTestId("snooze-hour").boundingBox();
  assert.ok(pressed && choice && Math.abs(choice.y - pressed.y) < 200 && Math.abs(choice.x - pressed.x) < 300, `menu at ${JSON.stringify(choice)}, row at ${JSON.stringify(pressed)}`);
  await page.getByTestId("snooze-hour").click();
  await row.waitFor({ state: "detached" });
  const [sent] = await page.evaluate(() => (window as unknown as { __snoozes: Array<{ action: string; until: string | null; conversationId: string }> }).__snoozes);
  assert.equal(sent.action, "snooze");
  assert.equal(sent.conversationId, "c1");
  const ahead = Date.parse(sent.until!) - Date.now();
  assert.ok(ahead > 55 * 60_000 && ahead <= 60 * 60_000, `an hour from now, got ${ahead} ms`);
  await page.waitForFunction(() => document.querySelector('[data-testid="workspace-group-count-needs-you"]')?.textContent === "0");

  // Needs you's label counts what is snoozed; it opens the Snoozed list, where each says until when and can be woken.
  const link = page.getByTestId("workspace-snoozed-link");
  await link.waitFor();
  assert.equal(await link.textContent(), "1 snoozed");
  await link.click();
  await page.getByTestId("workspace-group-tab-snoozed").waitFor();
  assert.equal(await page.getByTestId("workspace-group-tab-snoozed").getAttribute("aria-selected"), "true");
  const snoozed = page.getByTestId("workspace-group-page-row").filter({ hasText: "Bucket question" });
  assert.match(await snoozed.textContent() ?? "", /Snoozed until /);
  await page.getByTestId("workspace-page-wake").click();
  await page.waitForFunction(() => (window as unknown as { __snoozes: Array<{ action: string }> }).__snoozes.at(-1)?.action === "wake");
  await page.getByTestId("workspace-group-close").click();
  await row.waitFor();
  await link.waitFor({ state: "detached" });
});
