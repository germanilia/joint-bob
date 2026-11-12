import assert from "node:assert/strict";
import test from "node:test";
import { signIn } from "../dev-nodes.js";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("Browser stays open above a control-center conversation popup and closes with it", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const login = await signIn(environment, node);
  await page.context().addCookies(login.cookie.split("; ").map(cookie => ({ name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1), url: node.url })));
  await page.goto(node.url);
  await page.locator("#projectList").getByText("Internal Assistant", { exact: true }).click();
  await page.locator("#sessionList .list-row").filter({ has: page.locator("strong", { hasText: "Thread-Based Agent Builder" }) }).first().click();
  await page.locator("#messages .message.assistant").first().waitFor();
  // Use the same entry point as a board card, retaining the control-center view.
  await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    const { setMobileView } = await import("/app/layout.js");
    const { openConversation } = await import("/app/control-center.js");
    const card = { projectId: state.activeProjectId, conversationId: state.activeConversationId || state.activeSessionId };
    setMobileView("control");
    await openConversation(card);
  });
  await page.locator("body.view-control.control-popup").waitFor();
  if (await page.getByTestId("chat-more-button").isVisible()) await page.getByTestId("chat-more-button").click();
  await page.getByTestId("chat-open-browser-button").click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator("#browserPanel").count(), 1, "opening Browser in a conversation popup must not immediately dispose it");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const visible = await page.getByTestId("browser-close-viewer").evaluate(button => {
      const box = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    });
    assert.equal(visible, true, `${width}px: browser controls must be above the conversation popup and its scrim`);
  }
  await page.getByTestId("browser-close-viewer").click();
  await page.locator("#browserPanel").waitFor({ state: "detached" });
  await page.setViewportSize({ width: 1440, height: 900 });
  // Pending sign-in must appear automatically inside this same popup, without
  // selecting a different conversation or escaping the control-center view.
  const identity = await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    return { projectId: state.activeProjectId, engine: state.engine, conversationId: state.activeConversationId || state.activeSessionId, appNodeId: state.activeNodeId };
  });
  const session = {
    ...identity, id: "11111111-1111-4111-8111-111111111111", nodeId: node.nodeId,
    state: "running", owner: "human", canControl: true,
    activePageId: "33333333-3333-4333-8333-333333333333", tabs: [], downloads: [],
    loginRequest: { id: "44444444-4444-4444-8444-444444444444", expectedOrigin: "https://accounts.example.test", automatic: true },
  };
  await page.route("**/api/browser/sessions**", async route => {
    const url = new URL(route.request().url());
    await route.fulfill({ json: url.pathname === "/api/browser/sessions" ? { sessions: [session] }
      : { session, result: { origin: "https://accounts.example.test", challenge: true, stepId: null, fields: [] } } });
  });
  await page.evaluate(() => document.dispatchEvent(new Event("browserSessionsChanged")));
  const signInCard = page.getByTestId("browser-login-panel");
  await signInCard.getByTestId("browser-login-status").filter({ hasText: "This step needs the browser" }).waitFor();
  assert.equal(await signInCard.evaluate(element => !!element.closest("#chatPanel")), true, "automatic sign-in belongs inside the conversation popup");
  await signInCard.getByTestId("browser-login-takeover").click();
  assert.equal(await signInCard.evaluate(element => element.classList.contains("browser-login-fullscreen")), true, "Open browser expands automatic sign-in above the popup");
  await signInCard.getByTestId("browser-login-dismiss").click();
  await signInCard.waitFor({ state: "detached" });
  await page.unroute("**/api/browser/sessions**");
  if (await page.getByTestId("chat-more-button").isVisible()) await page.getByTestId("chat-more-button").click();
  await page.getByTestId("chat-open-browser-button").click();
  await page.locator("#browserPanel").waitFor();
  await page.evaluate(async () => { const { closeConversationPopup } = await import("/app/control-center.js"); closeConversationPopup(); });
  await page.locator("#browserPanel").waitFor({ state: "detached" });
  assert.equal(await page.locator("body.view-control:not(.control-popup)").count(), 1, "closing the popup leaves the control center in place");
});
