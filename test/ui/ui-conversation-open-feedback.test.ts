// Opening a conversation from a card (Home, the Inbox, the board) shows that it is on its way at once, and asks for it
// without waiting for its project's list: that list took seconds on a busy machine, and the page went on showing what
// it showed before the click until it came.
import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("a card opens its conversation before the project's list answers, saying it is opening meanwhile", { timeout: 120_000 }, async (t) => {
  const { page, node, environment } = await nativeUiFixture(t);
  const project = node.projects.find((item) => item.name === "Joint Bob")!;
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#loginDialog[open]").waitFor({ state: "detached" });

  // A card the board would draw for one of the project's conversations, read the way the board reads it.
  const card = await page.evaluate(async (projectId) => {
    const { api } = await import("/app/api.js");
    const { sessions } = await api(`/api/projects/${encodeURIComponent(projectId)}/sessions`);
    const session = sessions.find((item: { draft?: boolean; path?: string }) => !item.draft && item.path);
    return {
      projectId, projectName: "Joint Bob", conversationId: session.conversationId ?? session.id, sessionId: session.id, path: session.path,
      title: session.displayTitle ?? session.title, column: "review", harnessId: session.harnessId, executionNodeId: session.executionNodeId ?? null,
      updatedAt: session.updatedAt ?? null, turnRunning: false, backgroundRunning: false,
    };
  }, project.id);
  // Another project is open, so the card's project has to be chosen and listed.
  await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    state.activeProjectId = "another-project";
    state.keptSessionLists.clear();
    state.sessions = [];
  });

  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let listAsked!: () => void;
  const asked = new Promise<void>((resolve) => { listAsked = resolve; });
  await page.route(`**/api/projects/${project.id}/sessions`, async (route) => {
    listAsked();
    await held;
    await route.fallback();
  });
  const reported = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/performance/conversation-open", { timeout: 30_000 });
  try {
    const socketOpened = page.waitForEvent("websocket", {
      predicate: (socket) => { const url = new URL(socket.url()); return url.pathname === "/ws" && url.searchParams.get("sessionPath") === card.path; },
      timeout: 10_000,
    });
    await page.evaluate(async (card) => {
      const { openConversation } = await import("/app/control-center.js");
      (window as unknown as { opening: Promise<void> }).opening = openConversation(card);
    }, card);
    await asked;
    await page.locator("#messages .empty-state.opening").waitFor();
    const title = (await page.locator("#sessionTitle").textContent())?.trim();
    assert.ok(title && title !== "Select a conversation", `the conversation on its way is named, not "${title}"`);
    await socketOpened;
    assert.equal(await page.evaluate(async () => (await import("/app/state.js")).state.sessionsLoading), true, "the conversation was asked for while its list was still loading");
  } finally {
    release();
  }
  await page.evaluate(() => (window as unknown as { opening: Promise<void> }).opening);
  await page.locator("#messages .empty-state.opening").waitFor({ state: "detached", timeout: 20_000 });
  // The page tells its node how long the open took, and the node takes it.
  const response = await reported;
  assert.equal(response.status(), 204);
  const timing = response.request().postDataJSON() as { source: string; list: string; owner: string; shownMs: number; connectingMs: number; readyMs: number };
  assert.equal(timing.source, "card");
  assert.equal(timing.list, "card", "the open used what the card said, not the list");
  assert.ok(timing.shownMs <= timing.connectingMs && timing.connectingMs <= timing.readyMs, JSON.stringify(timing));
  const refused = await page.evaluate(async () => {
    const { api } = await import("/app/api.js");
    return api("/api/performance/conversation-open", { method: "POST", body: JSON.stringify({ source: "card", readyMs: "soon" }) }).then(() => "accepted", (error: Error) => error.message);
  });
  assert.notEqual(refused, "accepted", "a malformed timing is refused");
  await page.unrouteAll({ behavior: "wait" });
});
