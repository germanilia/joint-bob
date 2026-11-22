import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { waitInPage } from "./wait-in-page.js";

const offlineOwnerSocket = /\/ws\?.*\bnodeId=offline-fixture-owner(?:&|$)/;

test("repeated conversation opens show successful takeover without a duplicate-transfer alert", { timeout: 120_000 }, async (t) => {
  const { page, node, environment } = await nativeUiFixture(t);
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#projectList .project-card", { hasText: "Internal Assistant" }).click();
  await waitInPage(page, async () => {
    const { state } = await import("/app/state.js");
    return state.preferencesLoaded && state.harnesses.length && state.sessionNodes.length
      && !state.sessionsLoading && !state.sessionsRefreshing && state.sessions.some(session => !session.readOnly);
  });

  // Do not route the synthetic owner to the local server: a real offline owner sends no ready frame.
  await page.routeWebSocket(offlineOwnerSocket, () => {});
  const resultPending = page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    const { openListedSession } = await import("/app/reviews.js");
    const session = { ...state.sessions.find(session => !session.readOnly), executionNodeId: "offline-fixture-owner", reviewState: "reviewed" };
    const nodes = [...state.sessionNodes, { id: session.executionNodeId, name: "Offline fixture owner", local: false, online: false, mapped: true }];
    state.sessionNodes = nodes;
    const endpoint = `/api/projects/${state.activeProjectId}/sessions/take-ownership`;
    const nodeEndpoint = `/api/projects/${state.activeProjectId}/session-nodes`;
    const originalFetch = window.fetch;
    let release!: () => void, started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const requested = new Promise<void>(resolve => { started = resolve; });
    let requests = 0;
    // Only the remote presence and delayed transfer are synthetic. Run the real
    // list-opening code, API error handling, socket navigation and toast rendering.
    window.fetch = async (input, options) => {
      if (String(input).startsWith(nodeEndpoint)) return Response.json({ nodes });
      if (input !== endpoint) return originalFetch(input, options);
      requests++;
      if (requests > 1) return Response.json({ error: "A transfer is already in progress for this conversation" }, { status: 409 });
      started();
      await held;
      return Response.json({ sessionPath: session.path, pendingPeerIds: [] });
    };
    try {
      await openListedSession(session);
      await requested;
      await openListedSession(session);
      release();
      while (![...document.querySelectorAll('.toast[data-severity="info"] .toast-message')].some(node => node.textContent === "Switched to this node")) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
      return {
        requests,
        activePath: state.activeSessionPath,
        expectedPath: session.path,
        errors: [...document.querySelectorAll(".toast-error .toast-message")].map(node => node.textContent),
        success: [...document.querySelectorAll('.toast[data-severity="info"] .toast-message')].map(node => node.textContent),
      };
    } finally {
      release();
      window.fetch = originalFetch;
    }
  });
  const offer = page.getByTestId("chat-takeover-offer");
  const confirmation = page.getByRole("button", { name: "Take over here" });
  await offer.or(confirmation).waitFor();
  assert.equal(await confirmation.isVisible(), false, "opening a conversation must not ask to take over");
  await offer.click();
  await confirmation.click();
  const result = await resultPending;
  assert.equal(result.requests, 1, "repeat opens must not issue a transfer that the server will reject");
  assert.deepEqual(result.errors, [], "no irrelevant transfer error may remain beside the success message");
  assert.ok(result.success.includes("Switched to this node"));
  assert.equal(result.activePath, result.expectedPath);
  assert.deepEqual(pageErrors, []);
});

test("reloading in the control center offers offline takeover without interrupting the current view", { timeout: 120_000 }, async (t) => {
  const { page, node, environment } = await nativeUiFixture(t);
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#projectList .project-card", { hasText: "Internal Assistant" }).click();
  await waitInPage(page, async () => {
    const { state } = await import("/app/state.js");
    return state.preferencesLoaded && state.harnesses.length && state.sessionNodes.length
      && !state.sessionsLoading && !state.sessionsRefreshing && state.sessions.some(session => !session.readOnly);
  });
  await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    const { openListedSession } = await import("/app/reviews.js");
    await openListedSession(state.sessions.find(session => !session.readOnly)!);
  });
  await waitInPage(page, async () => (await import("/app/socket.js")).activeConversationReady());
  const openedId = await page.evaluate(async () => (await import("/app/state.js")).state.activeSessionId);
  await page.locator("#openControlCenterButton").click();
  await waitInPage(page, async (id) => {
    const preferences = await (await fetch("/api/preferences")).json();
    return preferences.mobileView === "control" && preferences.activeSessionId === id;
  }, openedId);

  // Restoring an offline conversation must not open a modal over the control center.
  await page.routeWebSocket(offlineOwnerSocket, () => {});
  const offline = { id: "offline-fixture-owner", name: "Offline fixture owner", local: false, online: false, mapped: true };
  await page.route(/\/api\/projects\/[^/]+\/sessions(\?.*)?$/, async route => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const body = await response.json();
    body.sessions = body.sessions.map((session: { id: string }) => session.id === openedId ? { ...session, executionNodeId: offline.id } : session);
    await route.fulfill({ response, json: body });
  });
  await page.route(/\/api\/projects\/[^/]+\/session-nodes/, async route => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, nodes: [...body.nodes, offline] } });
  });
  const transferRequests: string[] = [];
  page.on("request", request => {
    if (request.url().endsWith("/sessions/take-ownership")) transferRequests.push(request.url());
  });
  try {
    await page.reload();
    await page.locator('[data-testid="chat-takeover-offer"]:not([hidden])').or(page.locator("#confirmDialog[open]")).waitFor({ state: "attached" });
    assert.equal(await page.locator("#confirmDialog[open]").count(), 0);
    assert.equal(await page.locator("body.view-control").count(), 1);
    assert.deepEqual(transferRequests, []);
    assert.deepEqual(pageErrors, []);
  } finally {
    // The list refreshes on its own; a request still in a route when the page closes would fail the test.
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});
