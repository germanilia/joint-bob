import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { api, signIn } from "../dev-nodes.js";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { waitInPage } from "./wait-in-page.js";

const fixture = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),rl=require('node:readline');
const marker=path.join(process.env.HOME,'agy-synthetic-signed-in');
const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('1.5.5');process.exit(0);}
if(args.includes('--help')){console.log('ACP');process.exit(0);}
if(args.includes('--login')){
 console.log('https://accounts.google.com/o/oauth2/auth?client_id=fixture&state=fixture');
 console.log('Then paste the authorization code, or the full URL of the page you land on, and press Enter:');
 rl.createInterface({input:process.stdin}).on('line',code=>{
  if(code==='synthetic-good-code'){fs.writeFileSync(marker,'synthetic');process.exit(0);}
  process.stderr.write(code);process.exit(1);
 });
}else{
 rl.createInterface({input:process.stdin}).on('line',line=>{
  const r=JSON.parse(line);
  if(r.method==='session/new'&&!fs.existsSync(marker))return console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,error:{code:-32000,message:'Authentication required'}}));
  const result=r.method==='initialize'?{protocolVersion:1}:{sessionId:'fixture',configOptions:[{type:'select',id:'model',name:'Model',currentValue:'fixture-model',options:[{value:'fixture-model',name:'Fixture Google Model'}]}]};
  console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));
 }).on('close',()=>process.exit(0));
}
`;

test("Settings completes native Google sign-in, cancellation and failure with an isolated CLI", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const session = await signIn(environment, node);
  const executable = path.join(node.dataDir, "agy-login-fixture");
  await writeFile(executable, fixture, { mode: 0o700 });
  const settings = await api<{ runtimes: Record<string, unknown> }>(node, session, "GET", "/settings");
  const put = await api(node, session, "PUT", "/settings", { runtimes: { ...settings.body.runtimes, antigravity: { executable, configPath: path.join(node.dataDir, ".gemini"), sessionPath: path.join(node.dataDir, "agy-sessions") } } });
  assert.equal(put.status, 200);
  const endpoint = "/api/harnesses/antigravity/login";
  assert.equal((await fetch(`${node.url}${endpoint}`)).status, 401);
  assert.equal((await fetch(`${node.url}${endpoint}`, { method: "POST", headers: { Cookie: session.cookie, "Content-Type": "application/json" }, body: "{}" })).status, 403);

  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#loginDialog[open]").waitFor({ state: "hidden" });
  await waitInPage(page, async () => (await import('/app/state.js')).state.preferencesLoaded);
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-engines").click();
  await page.getByTestId("harness-tab-antigravity").click();
  const status = page.getByTestId("antigravity-login-status");
  const start = page.getByTestId("antigravity-login-start");
  const answer = page.getByTestId("antigravity-login-answer");
  await start.click();
  await answer.waitFor({ state: "visible" });
  assert.match((await page.getByTestId("antigravity-login-url").getAttribute("href"))!, /^https:\/\/accounts.google.com\//);
  assert.equal((await api(node, session, "POST", "/harnesses/antigravity/login", {})).status, 400, "duplicate starts are rejected");
  await page.getByTestId("antigravity-login-cancel").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="antigravity-login-status"]')?.textContent?.includes("cancelled"));
  await start.click();
  await answer.waitFor({ state: "visible" });
  await answer.fill("synthetic-wrong-code");
  await page.getByTestId("antigravity-login-submit").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="antigravity-login-status"]')?.textContent?.includes("failed"));
  assert.doesNotMatch((await status.textContent())!, /synthetic-wrong-code/);
  await start.click();
  await answer.waitFor({ state: "visible" });
  await answer.fill("synthetic-good-code");
  await page.getByTestId("antigravity-login-submit").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="antigravity-login-status"]')?.textContent?.includes("is signed in"));
  assert.equal(await answer.inputValue(), "");
  await waitInPage(page, async () => (await import('/app/state.js')).state.harnesses.find(h => h.id === 'antigravity')?.ready === true);
  assert.equal((await api<{ login: { state: string } }>(node, session, "GET", "/harnesses/antigravity/login")).body.login.state, "complete");
  const catalog = await api<{ models: Array<{ id: string }> }>(node, session, "GET", "/harnesses/antigravity/model-options");
  assert.ok(catalog.body.models.some(({ id }) => id === "fixture-model"), "sign-in invalidates the signed-out model cache");
});
