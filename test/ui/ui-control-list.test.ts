import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

const card = (overrides: Record<string, unknown>) => ({
  projectId: "p1", projectName: "Joint Bob", sessionId: "c1", path: "/c1", agentId: "claude", agentLabel: "Claude", agentModel: null, executionNodeId: null,
  turnRunning: false, backgroundRunning: false, summary: null, activity: null, autoRespondActive: false, pendingReviews: [], autoRespondStop: null, controlledBy: null, ...overrides,
});
const BOARD = {
  projects: [{ id: "p1", name: "Joint Bob", color: "violet" }, { id: "p2", name: "DAK Live" }],
  cards: [
    card({ conversationId: "c1", title: "Deploy the release", column: "needs-you", updatedAt: "2026-11-05T10:00:00Z", summary: "**Goal** — Ship 2.300.\n**Current state** — Waiting on the deploy step.",
      pendingReviews: [{ id: "r1", title: "Claude wants to run a command", subject: "npm run deploy", detail: "Production step · 98%", expiresAt: "2026-11-05T10:10:00Z" }] }),
    card({ conversationId: "c2", title: "Mobile menu", column: "running", updatedAt: "2026-11-05T09:00:00Z", turnRunning: true, summary: "Running the UI tests", activity: "Bash · npm run test:ui" }),
    card({ projectId: "p2", projectName: "DAK Live", conversationId: "c3", title: "Review counter", column: "review", agentId: "pi", agentLabel: "Pi", updatedAt: "2026-11-05T08:00:00Z",
      summary: "**Current state** — Fixed and tested.", reviewCheck: { verdict: "done", reason: "", by: "Decision model 94%", pushes: 0, pushPending: false, needsYou: false } }),
  ],
};

test("Live agents as a list: rows by project, the preview with summary and chat, a message, and the switch to cards", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.addInitScript(() => localStorage.setItem("jointBobLiveLayout", "list"));
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length === 3 && !document.body.classList.contains("booting"));
  await page.waitForFunction(async () => (await import("/app/state.js")).state.preferencesLoaded);
  await page.waitForTimeout(500);
  await page.evaluate(`(() => {
    const originalFetch = window.fetch;
    window.__board = ${JSON.stringify(BOARD)};
    window.__sent = [];
    window.fetch = async (...args) => {
      const url = new URL(String(args[0]), location.href);
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.pathname === '/api/control-center/board') return json(window.__board);
      if (url.pathname === '/api/control-center/cards/detail') {
        return json({ request: 'Ship ' + url.searchParams.get('conversationId'), answer: 'The **deploy** is ready.', answerCut: false, steps: [{ name: 'Bash', target: 'npm run build', failed: false }, { name: 'Edit', target: 'package.json', failed: true }] });
      }
      if (url.pathname === '/api/control-center/cards/reply') { window.__sent.push(JSON.parse(args[1].body)); return json({ ok: true }); }
      if (url.pathname === '/api/control-center/guardian/decide') { window.__decided = JSON.parse(args[1].body); return json({ ok: true }); }
      return originalFetch(...args);
    };
  })()`);

  await page.getByTestId("projects-open-control-center-button").click();
  await page.getByTestId("control-tab-live").click();
  await page.getByTestId("control-list").waitFor();
  // Bob's page folds his chat away on opening; the list has the width.
  assert.equal(await page.getByTestId("control-center-card").count(), 0, "the list draws no cards");

  // One row per conversation, grouped by project in name order; inside a project what needs the person comes before what runs.
  const rows = page.getByTestId("control-list-row");
  assert.deepEqual(await rows.evaluateAll((nodes) => nodes.map((row) => row.getAttribute("data-key"))), ["p2:c3", "p1:c1", "p1:c2"]);
  assert.deepEqual(await page.getByTestId("control-list-project").evaluateAll((heads) => heads.map((head) => head.querySelector("b")!.textContent)), ["DAK Live", "Joint Bob"]);
  assert.equal(await page.locator('[data-key="p1:c1"]').getAttribute("data-column"), "needs-you");
  assert.match(await page.locator('[data-key="p1:c1"]').textContent() ?? "", /Claude wants to run a command · npm run deploy/, "the row says what it waits for");
  assert.match(await page.locator('[data-key="p1:c2"]').textContent() ?? "", /Bash · npm run test:ui/, "a running row says what it does now");
  assert.equal(await page.getByTestId("control-card-running").count(), 1);
  assert.match(await page.getByTestId("control-list-summary").textContent() ?? "", /1 Needs you.*1 Running.*1 To review.*★ 0 finished while watching/);

  // The first row opens in the preview: what it needs, its summary, its chat and its steps.
  const preview = page.getByTestId("control-list-preview");
  assert.equal(await page.locator('[data-key="p1:c1"]').evaluate((row) => row.classList.contains("selected")), true);
  assert.match(await preview.locator("h2").textContent() ?? "", /Deploy the release/);
  assert.match(await page.getByTestId("control-list-need").textContent() ?? "", /npm run deploy/);
  assert.match(await page.getByTestId("control-list-summary-text").textContent() ?? "", /Ship 2\.300/);
  await page.getByTestId("control-list-thread").getByText("The deploy is ready.").waitFor();
  assert.match(await page.getByTestId("control-list-thread").textContent() ?? "", /You asked[\s\S]*Ship c1/);
  assert.equal(await page.getByTestId("control-list-steps").locator("li.failed").count(), 1);
  // The chat sits below the summary, and Open conversation is in the preview's top line.
  const [summaryBox, chatBox, openBox] = await Promise.all(["control-list-summary-text", "control-list-chat", "control-list-open"].map((id) => page.getByTestId(id).boundingBox()));
  assert.ok(summaryBox && chatBox && openBox && chatBox.y > summaryBox.y + summaryBox.height - 1, "the chat is below the summary");
  assert.ok(openBox.y < summaryBox.y, "Open conversation is above the summary");

  if (process.env.CONTROL_LIST_SHOT) await page.screenshot({ path: process.env.CONTROL_LIST_SHOT });

  // Looking at a row changes nothing; Allow once decides the held step.
  await page.getByTestId("control-review-allow").click();
  await page.waitForFunction(() => (window as unknown as { __decided?: unknown }).__decided !== undefined);
  assert.deepEqual(await page.evaluate(() => (window as unknown as { __decided: unknown }).__decided), { projectId: "p1", conversationId: "c1", reviewId: "r1", decision: "allow" });

  // Another row shows its own preview; what was typed for a conversation is kept while the board redraws.
  await page.locator('[data-key="p1:c2"]').click();
  await page.getByTestId("control-list-preview").locator("h2", { hasText: "Mobile menu" }).waitFor();
  assert.equal(await page.getByTestId("control-list-need").count(), 0, "a running conversation waits for nothing");
  await page.getByTestId("control-list-message").fill("keep it small");
  await page.evaluate(async () => {
    (window as unknown as { __board: { cards: { conversationId: string; updatedAt: string }[] } }).__board.cards[1]!.updatedAt = "2026-11-05T09:30:00Z";
    window.dispatchEvent(new CustomEvent("control-center-changed"));
  });
  await page.waitForFunction(() => document.querySelector('[data-key="p1:c2"] .control-list-time')?.textContent !== "");
  await page.waitForTimeout(400);
  assert.equal(await page.getByTestId("control-list-message").inputValue(), "keep it small", "the draft survives a redraw");
  await page.getByTestId("control-list-message").press("Enter");
  await page.waitForFunction(() => (window as unknown as { __sent: unknown[] }).__sent.length === 1);
  assert.deepEqual(await page.evaluate(() => (window as unknown as { __sent: unknown[] }).__sent), [{ projectId: "p1", conversationId: "c2", message: "keep it small" }]);
  await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('[data-testid="control-list-message"]')!.value === "", undefined, { timeout: 5_000 });

  // Arrow keys move through the rows.
  await page.locator('[data-key="p1:c2"]').focus();
  await page.keyboard.press("ArrowUp");
  assert.equal(await page.locator('[data-key="p1:c1"]').evaluate((row) => row.classList.contains("selected")), true);

  // The switch brings the cards back, and back again.
  await page.getByTestId("control-layout-cards").click();
  await page.getByTestId("control-center-card").first().waitFor();
  assert.equal(await page.getByTestId("control-list").count(), 0);
  await page.getByTestId("control-layout-list").click();
  await page.getByTestId("control-list").waitFor();
  assert.equal(await page.getByTestId("control-center-card").count(), 0);
});
