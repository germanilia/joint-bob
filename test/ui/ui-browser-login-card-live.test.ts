import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { chromeExecutable } from "./launch-chrome.js";
import { api, signIn } from "../dev-nodes.js";

test("real conversation card signs in through username and password on a loopback website", { timeout: 120_000 }, async t => {
  const website = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url === "/ready") return void res.end("<h1>Account ready</h1>");
    if (req.url?.startsWith("/password")) return void res.end('<form method="post" action="/ready"><label>Password<input type="password" autocomplete="current-password" name="password"></label><button>Sign in</button></form>');
    res.end('<form action="/password"><label>Email<input name="email" type="email"></label><button>Next</button></form>');
  });
  website.listen(0, "127.0.0.1"); await once(website, "listening");
  t.after(() => { website.closeAllConnections(); website.close(); });
  const origin = `http://127.0.0.1:${(website.address() as AddressInfo).port}`;
  const executable = await chromeExecutable();
  const { page, node, environment } = await nativeUiFixture(t, () => ({ JOINT_BOB_BROWSER_EXECUTABLE: executable }));
  const login = await signIn(environment, node);
  await page.context().addCookies(login.cookie.split("; ").map(cookie => ({ name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1), url: node.url })));
  await page.goto(node.url);
  await page.locator("#projectList").getByText("Internal Assistant", { exact: true }).click();
  await page.locator("#sessionList .list-row").filter({ has: page.locator("strong", { hasText: "Short one" }) }).first().click();
  await page.locator("#sessionTitle").filter({ hasText: "Short one" }).waitFor();
  const identity = await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    return { projectId: state.activeConversationProjectId || state.activeProjectId, engine: state.engine, conversationId: state.activeConversationId || state.activeSessionId, appNodeId: state.conversationLock?.nodeId || state.activeNodeId };
  });
  const started = await api<any>(node, login, "POST", `/browser/sessions?nodeId=${node.nodeId}`, { ...identity, url: origin, profileName: "Synthetic card login" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const id = started.body.session.id;
  try {
  await page.evaluate(() => document.dispatchEvent(new Event("browserSessionsChanged")));
  const panel = page.getByTestId("browser-login-panel");
  await panel.getByLabel("Email", { exact: true }).fill("synthetic@example.test");
  await panel.getByTestId("browser-login-submit").click();
  await panel.getByLabel("Password", { exact: true }).fill("SYNTHETIC-ONLY-PASSWORD");
  await panel.getByTestId("browser-login-submit").click();
  await panel.getByTestId("browser-login-done").waitFor({ state: "visible" });
  assert.equal(await panel.getByTestId("browser-screen").count(), 0);
  await panel.getByTestId("browser-login-done").click();
  await panel.getByTestId("browser-login-status").filter({ hasText: /^Signed in\./ }).waitFor();
  const finished = await api<any>(node, login, "GET", `/browser/sessions/${id}?nodeId=${node.nodeId}`);
  assert.equal(finished.body.session.loginRequest, null);
  assert.equal(finished.body.session.owner, "agent");
  } finally { await api(node, login, "POST", `/browser/sessions/${id}/command?nodeId=${node.nodeId}`, { action: "close" }); }
});
