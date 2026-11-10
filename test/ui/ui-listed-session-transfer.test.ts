import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { waitInPage } from "./wait-in-page.js";

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

  const result = await page.evaluate(async () => {
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
    const first = openListedSession(session);
    try {
      await requested;
      await openListedSession(session);
      release();
      await first;
      return {
        requests,
        activePath: state.activeSessionPath,
        expectedPath: session.path,
        errors: [...document.querySelectorAll(".toast-error .toast-message")].map(node => node.textContent),
        success: [...document.querySelectorAll('.toast[data-severity="info"] .toast-message')].map(node => node.textContent),
      };
    } finally {
      release();
      await first;
      window.fetch = originalFetch;
    }
  });
  assert.equal(result.requests, 1, "repeat opens must not issue a transfer that the server will reject");
  assert.deepEqual(result.errors, [], "no irrelevant transfer error may remain beside the success message");
  assert.ok(result.success.includes("Switched to this node"));
  assert.equal(result.activePath, result.expectedPath);
  assert.deepEqual(pageErrors, []);
});

test("reloading in the control center stays there while the open conversation is taken over from an offline machine", { timeout: 120_000 }, async (t) => {
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
  const opened = await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    const { openListedSession } = await import("/app/reviews.js");
    const session = state.sessions.find(session => !session.readOnly)!;
    await openListedSession(session);
    return { id: session.id, path: session.path };
  });
  await page.locator("#openControlCenterButton").click();
  await waitInPage(page, async (path) => {
    const preferences = await (await fetch("/api/preferences")).json();
    return preferences.mobileView === "control" && preferences.activeSessionPath === path;
  }, opened.path);

  // After the reload the conversation's machine is offline, so the page takes it over; the takeover answers late.
  const offline = { id: "offline-fixture-owner", name: "Offline fixture owner", local: false, online: false, mapped: true };
  await page.route(/\/api\/projects\/[^/]+\/sessions(\?.*)?$/, async route => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const body = await response.json();
    body.sessions = body.sessions.map((session: { id: string }) => session.id === opened.id ? { ...session, executionNodeId: offline.id } : session);
    await route.fulfill({ response, json: body });
  });
  await page.route(/\/api\/projects\/[^/]+\/session-nodes/, async route => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, nodes: [...body.nodes, offline] } });
  });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let transfers = 0;
  await page.route(/\/api\/projects\/[^/]+\/sessions\/take-ownership$/, async route => {
    transfers++;
    await held;
    await route.fulfill({ json: { sessionPath: opened.path, pendingPeerIds: [] } });
  });
  try {
    try {
      await page.reload();
      for (const deadline = Date.now() + 30_000; !transfers; await new Promise(resolve => setTimeout(resolve, 100))) {
        if (Date.now() > deadline) throw new Error("The reloaded page never took the conversation over");
      }
      await page.locator("body.view-control").waitFor();
    } finally {
      release();
    }
    await page.locator('.toast[data-severity="info"] .toast-message', { hasText: "Switched to this node" }).waitFor();
    await waitInPage(page, async (path) => (await import("/app/state.js")).state.activeSessionPath === path, opened.path);
    assert.equal(await page.locator("body.view-control").count(), 1, "the takeover's notice must not take the page out of the control center");
    assert.equal(transfers, 1);
    assert.deepEqual(pageErrors, []);
  } finally {
    // The list refreshes on its own; a request still in a route when the page closes would fail the test.
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});
