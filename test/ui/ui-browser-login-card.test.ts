import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { signIn } from "../dev-nodes.js";

for (const width of [412, 1440]) {
  test(`conversation login card follows steps without a full-screen viewer at ${width}px`, { timeout: 120_000 }, async t => {
    const { page, environment, node } = await nativeUiFixture(t);
    await page.setViewportSize({ width, height: 900 });
    const login = await signIn(environment, node);
    await page.context().addCookies(login.cookie.split("; ").map(cookie => ({ name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1), url: node.url })));
    const commands: any[] = [];
    let step = 0, fail = false;
    const session: any = { id: "session", nodeId: "owner", state: "running", owner: "agent", canControl: true, profileLabel: "Synthetic account", activePageId: "page", tabs: [{ id: "page", url: "https://accounts.example.test/login" }], downloads: [], loginRequest: { id: "request", expectedOrigin: "https://accounts.example.test", label: "Sign in" } };
    await page.route("**/api/browser/**", async route => {
      const url = new URL(route.request().url());
      let result: any = null;
      if (url.pathname === "/api/browser/sessions") return void await route.fulfill({ json: { sessions: session.projectId ? [session] : [] } });
      if (route.request().method() === "POST") {
        const command = route.request().postDataJSON(); commands.push(command);
        assert.equal(url.searchParams.get("nodeId"), "owner");
        if (command.action === "takeControl") session.owner = "human";
        if (command.action === "readLoginStep") result = { origin: "https://accounts.example.test", stepId: step < 2 ? `step-${step}` : null, fields: step < 2 ? [{ type: step === 0 ? "email" : "password", label: step === 0 ? "Email" : "Password", autocomplete: step === 0 ? "username" : "current-password" }] : [], submitLabel: "Continue", challenge: false };
        if (command.action === "submitLoginStep") {
          if (fail) return void await route.abort("failed");
          step++;
        }
        if (command.action === "completeLogin") { session.loginRequest = null; session.owner = "agent"; }
      }
      await route.fulfill({ json: { session, result } });
    });
    await page.goto(node.url);
    await page.locator("#projectList").getByText("Internal Assistant", { exact: true }).click();
    await page.locator("#sessionList .list-row").filter({ has: page.locator("strong", { hasText: "Short one" }) }).first().click();
    await page.locator("#sessionTitle").filter({ hasText: "Short one" }).waitFor();
    const identity = await page.evaluate(async () => {
      const { state } = await import("/app/state.js");
      return { projectId: state.activeConversationProjectId || state.activeProjectId, engine: state.engine, conversationId: state.activeConversationId || state.activeSessionId, appNodeId: state.conversationLock?.nodeId || state.activeNodeId };
    });
    Object.assign(session, identity);
    await page.evaluate(() => document.dispatchEvent(new Event("activeConversationChanged")));
    const panel = page.getByTestId("browser-login-panel"), form = panel.getByTestId("browser-login-form");
    await form.waitFor();
    assert.equal(await page.locator(".browser-login-fullscreen").count(), 0);
    assert.equal(await panel.getByTestId("browser-screen").count(), 0);
    assert.match(await panel.innerText(), /https:\/\/accounts.example.test/);
    const box = (await panel.boundingBox())!;
    assert.ok(box.width <= width && box.height < 500, `card geometry ${JSON.stringify(box)}`);
    await form.getByLabel("Email", { exact: true }).fill("synthetic@example.test");
    await panel.getByTestId("browser-login-submit").click();
    await form.getByLabel("Password", { exact: true }).waitFor();
    assert.equal(await form.getByLabel("Password", { exact: true }).getAttribute("type"), "password");
    await form.getByLabel("Password", { exact: true }).fill("SYNTHETIC-CARD-PASSWORD");
    fail = true;
    await panel.getByTestId("browser-login-submit").click();
    await panel.getByTestId("browser-login-status").filter({ hasText: /not confirmed/i }).waitFor();
    assert.equal(await form.locator("input").count(), 0, "uncertain submission clears and locks the old step");
    assert.equal(commands.filter(c => c.action === "submitLoginStep").length, 2);
    assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes("SYNTHETIC-CARD-PASSWORD")), false);
    assert.ok(!(await page.locator("body").innerText()).includes("SYNTHETIC-CARD-PASSWORD"));
    fail = false;
    await panel.getByTestId("browser-login-refresh").click();
    await form.getByLabel("Password", { exact: true }).waitFor();
    assert.equal(await form.getByLabel("Password", { exact: true }).inputValue(), "");
    await form.getByLabel("Password", { exact: true }).fill("SYNTHETIC-CARD-PASSWORD");
    await panel.getByTestId("browser-login-submit").click();
    await panel.getByTestId("browser-login-done").waitFor({ state: "visible" });
    assert.ok(session.loginRequest, "card must await human confirmation");
    await panel.getByTestId("browser-login-done").click();
    await panel.getByTestId("browser-login-status").filter({ hasText: /signed in/i }).waitFor();
    assert.equal(session.loginRequest, null);
  });
}

test("card uses explicit takeover for a challenge and discards stale responses after disposal", { timeout: 120_000 }, async t => {
  const { page, node } = await nativeUiFixture(t);
  await page.goto(`${node.url}/browser.html`);
  await page.evaluate("window.__name = value => value");
  await page.evaluate(async () => {
    const { createBrowserLoginCard } = await import("/app/browser-login-card.js");
    const host = document.createElement("section"); host.id = "card"; document.body.replaceChildren(host);
    const session = { id: "session", nodeId: "owner", state: "running", owner: "human", canControl: true, activePageId: "page", loginRequest: { id: "request", label: "Sign in" } };
    (window as any).card = createBrowserLoginCard(host, { session, isCurrent: () => true, onTakeover: () => { host.dataset.takeover = "yes"; }, api: async (_url, options) => ({ session, result: options && JSON.parse(options.body).action === "readLoginStep" ? { origin: "https://example.test", fields: [], stepId: null, challenge: true } : null }) });
  });
  const host = page.locator("#card");
  await host.getByTestId("browser-login-status").filter({ hasText: /browser/i }).waitFor();
  assert.equal(await host.locator("input").count(), 0);
  await host.getByTestId("browser-login-takeover").click();
  assert.equal(await host.getAttribute("data-takeover"), "yes");
  await page.evaluate(() => (window as any).card.dispose());
  assert.equal(await host.locator("input").count(), 0);
});
