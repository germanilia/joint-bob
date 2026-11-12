import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

const CARD = {
  projectId: "p1", projectName: "Joint Bob", conversationId: "c1", sessionId: "c1", path: "/c1", title: "Bucket question", column: "needs-you",
  agentId: "claude", agentLabel: "Claude", agentModel: null, executionNodeId: null, updatedAt: "2026-11-12T09:00:00Z", turnRunning: false,
  backgroundRunning: false, summary: null, autoRespondActive: false, pendingReviews: [], autoRespondStop: { kind: "question", reason: "Which bucket?" },
  controlledBy: null, reviewCheck: null, snooze: null,
};

test("a Needs you card can be snoozed from the board, moves to Snoozed with its end time, and wakes", { timeout: 120_000 }, async (t) => {
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

  await page.getByTestId("projects-open-control-center-button").click();
  await page.getByTestId("control-tab-live").click();
  const card = page.locator('[data-key="p1:c1"]');
  await card.waitFor();
  assert.equal(await card.getAttribute("data-column"), "needs-you");
  assert.match(await page.getByTestId("control-center-count").textContent() ?? "", /1 need you/);

  await card.getByTestId("control-card-action-snooze").click();
  // Under the button pressed, not the page corner (Safari leaves a clicked button unfocused).
  const pressed = await card.getByTestId("control-card-action-snooze").boundingBox();
  const choice = await page.getByTestId("snooze-hour").boundingBox();
  assert.ok(pressed && choice && Math.abs(choice.y - pressed.y) < 200 && Math.abs(choice.x - pressed.x) < 300, `menu at ${JSON.stringify(choice)}, button at ${JSON.stringify(pressed)}`);
  await page.getByTestId("snooze-hour").click();
  await page.waitForFunction(() => document.querySelector('[data-key="p1:c1"]')?.getAttribute("data-column") === "snoozed");
  const [sent] = await page.evaluate(() => (window as unknown as { __snoozes: Array<{ action: string; until: string | null; conversationId: string }> }).__snoozes);
  assert.equal(sent.action, "snooze");
  assert.equal(sent.conversationId, "c1");
  const ahead = Date.parse(sent.until!) - Date.now();
  assert.ok(ahead > 55 * 60_000 && ahead <= 60 * 60_000, `an hour from now, got ${ahead} ms`);
  assert.doesNotMatch(await page.getByTestId("control-center-count").textContent() ?? "", /need you/, "a snoozed card no longer counts as waiting");
  assert.equal(await page.locator('.control-lane[data-column="snoozed"] .control-lane-count').textContent(), "1");
  assert.match(await card.getByTestId("control-card-snoozed").textContent() ?? "", /^Snoozed until /);
  assert.equal(await card.getByTestId("control-card-action-snooze").count(), 0);

  await card.getByTestId("control-card-action-wake").click();
  await page.waitForFunction(() => document.querySelector('[data-key="p1:c1"]')?.getAttribute("data-column") === "needs-you");
  assert.equal(await page.evaluate(() => (window as unknown as { __snoozes: Array<{ action: string }> }).__snoozes.at(-1)!.action), "wake");
  assert.equal(await page.locator('.control-lane[data-column="snoozed"]').count(), 0, "nothing put aside, no Snoozed lane");
});
