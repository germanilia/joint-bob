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
