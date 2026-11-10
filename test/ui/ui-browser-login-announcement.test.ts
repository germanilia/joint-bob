import assert from "node:assert/strict";
import test from "node:test";
import { signIn } from "../dev-nodes.js";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("background sign-in notices do not repeat after reload, but new requests and the sign-in card remain visible", { timeout: 90_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  const errors: string[] = [], commands: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const login = await signIn(environment, node);
  await page.context().addCookies(login.cookie.split("; ").map(cookie => ({ name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1), url: node.url })));
  const session = {
    id: "11111111-1111-4111-8111-111111111111", nodeId: node.nodeId,
    projectId: "background-project", engine: "pi", conversationId: "background-conversation", appNodeId: node.nodeId,
    state: "running", owner: "human", canControl: true, profileLabel: "Background fixture",
    activePageId: "page", tabs: [], downloads: [],
    loginRequest: { id: "first-request", expectedOrigin: "https://accounts.example.test", label: "Synthetic sign-in" },
  };
  await page.route("**/api/browser/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/browser/sessions") return void await route.fulfill({ json: { sessions: [session] } });
    if (url.pathname.endsWith("/command")) {
      const command = route.request().postDataJSON();
      commands.push(command.action);
      assert.equal(command.action, "readLoginStep", "announcements must not complete login or change browser control");
      return void await route.fulfill({ json: { session, result: { origin: session.loginRequest.expectedOrigin, stepId: null, fields: [], challenge: true } } });
    }
    await route.fulfill({ json: { session } });
  });
  const discover = async () => {
    const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/browser/sessions" && !new URL(response.url()).search);
    await page.evaluate(() => document.dispatchEvent(new Event("browserSessionsChanged")));
    await (await response).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  await page.goto(node.url);
  const notice = page.locator(".toast", { hasText: "Sign-in needed for Background fixture" });
  await notice.waitFor();
  assert.equal(await notice.count(), 1);
  await notice.getByTestId("toast-close-button").click();
  await discover();
  assert.equal(await notice.count(), 0, "rediscovery must not repeat a notice");

  for (let reload = 0; reload < 2; reload++) {
    await page.reload();
    await page.waitForFunction(async () => (await import("/app/state.js")).state.authenticated);
    await discover();
    assert.equal(await notice.count(), 0, "reload must not reannounce the same pending request");
  }
  assert.deepEqual(commands, [], "background notices must not issue browser commands");
  assert.equal(await page.getByTestId("browser-login-panel").count(), 0);

  session.loginRequest = { ...session.loginRequest, id: "second-request" };
  await discover();
  await notice.waitFor();
  assert.equal(await notice.count(), 1, "a new request for the same browser must still notify");
  await page.reload();
  await page.waitForFunction(async () => (await import("/app/state.js")).state.authenticated);
  await discover();
  assert.equal(await notice.count(), 0, "even an undismissed notice must not repeat after reload");

  // Announcing a request must not dismiss the card when its conversation becomes active.
  await page.evaluate(session => import("/app/state.js").then(({ state }) => {
    state.activeConversationProjectId = session.projectId;
    state.activeConversationId = session.conversationId;
    state.activeNodeId = session.appNodeId;
    state.engine = session.engine;
    document.dispatchEvent(new Event("activeConversationChanged"));
  }), session);
  const panel = page.getByTestId("browser-login-panel");
  await panel.getByTestId("browser-login-status").filter({ hasText: "This step needs the browser" }).waitFor({ state: "attached" });
  assert.equal(await panel.count(), 1, "the sign-in request remains available in its own conversation");
  assert.deepEqual(commands, ["readLoginStep"]);
  assert.deepEqual(errors, []);
});
