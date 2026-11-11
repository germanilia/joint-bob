import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { chromeExecutable } from "./launch-chrome.js";
import { api, signIn } from "../dev-nodes.js";
import { waitForAssertion } from "../async-assertion.js";

for (const width of [412, 1280]) {
  test(`real login card hands a challenge to the human viewer and back at ${width}px`, { timeout: 120_000 }, async t => {
    const website = http.createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      if (req.url === "/ready") return void res.end("<h1 id=phase>Account ready</h1>");
      if (req.url === "/challenge") return void res.end(`<h1 id="phase">Security check</h1>
        <input aria-label="Synthetic challenge" autocomplete="one-time-code" style="position:absolute;left:20px;top:140px">
        <button style="position:absolute;left:20px;top:70px;width:250px;height:50px" onclick="document.querySelector('#phase').textContent='Alternative verification';this.textContent='Approve synthetic challenge';this.onclick=()=>location.href='/ready'">Use another method</button>`);
      res.end('<form action="/challenge" method="post"><label>Password<input type="password" autocomplete="current-password" name="password"></label><button>Sign in</button></form>');
    });
    website.listen(0, "127.0.0.1"); await once(website, "listening");
    t.after(() => { website.closeAllConnections(); website.close(); });
    const origin = `http://127.0.0.1:${(website.address() as AddressInfo).port}`;
    const executable = await chromeExecutable();
    const { page, node, environment } = await nativeUiFixture(t, () => ({ JOINT_BOB_BROWSER_EXECUTABLE: executable }));
    const login = await signIn(environment, node);
    await page.context().addCookies(login.cookie.split("; ").map(cookie => ({ name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1), url: node.url })));
    const commands: string[] = [], viewerCommands: string[] = [];
    page.on("request", request => {
      if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/command")) commands.push(request.postDataJSON().action);
    });
    page.on("websocket", socket => socket.on("framesent", event => {
      const message = JSON.parse(String(event.payload));
      if (message.type === "browserCommand") viewerCommands.push(message.command.action);
    }));
    await page.goto(node.url);
    await page.locator("#projectList").getByText("Internal Assistant", { exact: true }).click();
    await page.locator("#sessionList .list-row").filter({ has: page.locator("strong", { hasText: "Short one" }) }).first().click();
    await page.locator("#sessionTitle").filter({ hasText: "Short one" }).waitFor();
    await page.setViewportSize({ width, height: 900 });
    const identity = await page.evaluate(async () => {
      const { state } = await import("/app/state.js");
      return { projectId: state.activeConversationProjectId || state.activeProjectId, engine: state.engine, conversationId: state.activeConversationId || state.activeSessionId, appNodeId: state.conversationLock?.nodeId || state.activeNodeId };
    });
    const started = await api<any>(node, login, "POST", `/browser/sessions?nodeId=${node.nodeId}`, { ...identity, url: origin, profileName: "Synthetic challenge login" });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const endpoint = `/browser/sessions/${started.body.session.id}`, query = `?nodeId=${node.nodeId}`;
    const session = async () => (await api<any>(node, login, "GET", endpoint + query)).body.session;
    const phase = async () => {
      const result = await api<any>(node, login, "POST", `${endpoint}/command${query}`, { action: "evaluate", expression: "document.querySelector('#phase')?.textContent" });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return result.body.result;
    };
    try {
      await page.evaluate(() => document.dispatchEvent(new Event("browserSessionsChanged")));
      const panel = page.getByTestId("browser-login-panel");
      await panel.getByLabel("Password", { exact: true }).fill("SYNTHETIC-ONLY-PASSWORD");
      await panel.getByTestId("browser-login-submit").click();
      await panel.getByTestId("browser-login-status").filter({ hasText: "This step needs the browser" }).waitFor();
      assert.equal(await panel.locator("input").count(), 0, "challenge must not become a proxy field");
      assert.equal(await panel.getByTestId("browser-login-done").isVisible(), false);
      assert.equal(await panel.getByTestId("browser-screen").count(), 0, "takeover must be explicit");
      const pending = await session();
      assert.ok(pending.loginRequest); assert.equal(pending.owner, "human");

      await panel.getByTestId("browser-login-takeover").click();
      const screen = panel.getByTestId("browser-screen");
      await screen.waitFor({ state: "visible" });
      await panel.locator('[data-testid="browser-login-done"]:enabled').waitFor();
      assert.equal(await panel.getByTestId("browser-login-form").count(), 0);
      await panel.getByTestId("browser-login-done").click();
      await panel.getByTestId("browser-error").filter({ hasText: "Login could not be verified" }).waitFor();
      assert.equal((await session()).loginRequest.id, pending.loginRequest.id, "premature Done must keep agent paused");
      await panel.getByTestId("browser-login-back-to-card").click();
      await panel.getByTestId("browser-login-status").filter({ hasText: "This step needs the browser" }).waitFor();
      assert.equal(await panel.locator("input").count(), 0);
      assert.equal(await panel.evaluate(element => element.classList.contains("browser-login-fullscreen")), false);
      await panel.getByTestId("browser-login-takeover").click();
      await screen.waitFor({ state: "visible" });
      await panel.locator('[data-testid="browser-login-done"]:enabled').waitFor();
      if (width < 700) await page.waitForFunction(() => document.querySelector<HTMLImageElement>('[data-testid="browser-screen"]')?.naturalWidth === innerWidth);
      // Native viewer pointer events, not API clicks, act as the synthetic human.
      const point = await screen.evaluate(image => {
        const scale = image.getBoundingClientRect().width / (image as HTMLImageElement).naturalWidth;
        return { x: 145 * scale, y: 95 * scale };
      });
      await screen.click({ position: point });
      await waitForAssertion(async () => assert.equal(await phase(), "Alternative verification"), 10_000);
      assert.equal((await session()).loginRequest.id, pending.loginRequest.id);
      await screen.click({ position: point });
      await waitForAssertion(async () => assert.equal(await phase(), "Account ready"), 10_000);
      assert.deepEqual(viewerCommands.filter(action => action === "click"), ["click", "click"]);
      assert.equal(commands.filter(action => action === "submitLoginStep").length, 1, "only the credential step uses the proxy");
      assert.equal(commands.filter(action => action === "completeLogin").length, 1, "no automatic challenge completion");

      await panel.getByTestId("browser-login-back-to-card").click();
      await panel.getByTestId("browser-login-done").waitFor({ state: "visible" });
      assert.doesNotMatch(await panel.getByTestId("browser-login-status").innerText(), /no supported|unsupported/i, "signed-in page must not be presented as an unsupported login");
      await panel.getByTestId("browser-login-done").click();
      await panel.getByTestId("browser-login-status").filter({ hasText: /^Signed in\./ }).waitFor();
      const finished = await session();
      assert.equal(finished.loginRequest, null); assert.equal(finished.owner, "agent");
    } finally { await api(node, login, "POST", `${endpoint}/command${query}`, { action: "close" }); }
  });
}
