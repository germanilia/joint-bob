import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { Locator, Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

async function choose(page: Page | Locator, testid: string, search: string, label: string): Promise<void> {
  await page.getByTestId(testid).click();
  await page.getByTestId(`${testid}-search`).fill(search);
  await page.getByTestId(`${testid}-option`).filter({ hasText: label }).first().click();
}

async function waitForConnectionsReload(page: Page): Promise<void> {
  const endpoints = ["/api/provider-profiles", "/api/provider-profiles/pools", "/api/projects", "/api/workspaces", "/api/provider-profiles/relay-rules", "/api/provider-profiles/clusters", "/api/settings"];
  await Promise.all(endpoints.map((endpoint) => page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === endpoint)));
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

test("connections have their own Settings tab, list profiles per provider, and choose a default with exceptions", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t, (root) => ({ AGY_FIXTURE_HOME_RECORD: path.join(root, "agy-profile-home") }));
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#loginDialog[open]").waitFor({ state: "hidden" });
  await page.locator(".project-card").first().waitFor();
  const antigravityCli = path.join(environment.home, "agy-fixture");
  await writeFile(antigravityCli, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline'),args=process.argv.slice(2);
if(args[0]==='--version'||args[0]==='acp'&&args[1]==='--help')process.exit(0);
if(args[0]==='acp'&&args[1]==='--login'){
 process.stdout.write('Open this link: https://accounts.google.com/o/oauth2/auth?client_id=fixture&state=fixture\\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\\n');
 readline.createInterface({input:process.stdin}).on('line',code=>{if(code!=='fixture-code')process.exit(1);fs.mkdirSync(process.env.HOME,{recursive:true});fs.writeFileSync(path.join(process.env.HOME,'signed-in'),'fixture');if(process.env.AGY_FIXTURE_HOME_RECORD)fs.writeFileSync(process.env.AGY_FIXTURE_HOME_RECORD,process.env.HOME);process.exit(0);});
}else{
 const rl=readline.createInterface({input:process.stdin}),send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
 rl.on('line',line=>{const request=JSON.parse(line);if(request.method==='initialize')return send({jsonrpc:'2.0',id:request.id,result:{protocolVersion:1}});if(request.method==='session/new'){if(!fs.existsSync(path.join(process.env.HOME,'signed-in')))return send({jsonrpc:'2.0',id:request.id,error:{code:-32000,message:'Authentication required'}});return send({jsonrpc:'2.0',id:request.id,result:{sessionId:'profile-session',configOptions:[{id:'model',name:'Model',type:'select',currentValue:'model-a',options:[{value:'model-a',name:'Model A'}]}]}})}throw Error('Unexpected ACP request '+request.method)});
}`);
  await chmod(antigravityCli, 0o700);
  await page.evaluate(async (executable) => {
    const { api } = await import("/app/api.js");
    const settings = await api("/api/settings");
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ runtimes: { ...settings.runtimes, antigravity: { ...settings.runtimes.antigravity, executable } } }) });
  }, antigravityCli);
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-connections").click();
  await page.getByTestId("provider-profile-add").waitFor();
  assert.equal(await page.getByTestId("provider-profiles-tab-profiles").getAttribute("aria-selected"), "true");
  await page.getByTestId("settings-tab-engines").click();
  await page.getByTestId("harness-config-card").waitFor();
  assert.equal(await page.locator("#settingsPanel-engines [data-testid='provider-profiles'], #settingsPanel-engines [data-testid='kiro-profiles']").count(), 0, "Harnesses holds no profile management");
  const connectionsReload = waitForConnectionsReload(page);
  await page.getByTestId("settings-tab-connections").click();
  await connectionsReload;

  // Every provider, Kiro included, is the same kind of tab with its own icon.
  for (const provider of ["claude", "openai-codex", "pi", "kiro", "antigravity"]) {
    assert.equal(await page.getByTestId(`provider-profile-provider-${provider}`).locator("svg").count(), 1, `${provider} tab has its icon`);
  }

  await page.getByTestId("provider-profile-provider-antigravity").click();
  assert.equal(await page.getByTestId("provider-profile-provider-antigravity").getAttribute("aria-selected"), "true");
  await page.getByTestId("provider-profile-label").fill("Google work");
  const antigravityCreated = page.waitForResponse((response) => response.url().endsWith("/api/provider-profiles") && response.request().method() === "POST");
  await page.getByTestId("provider-profile-add").click();
  assert.equal((await antigravityCreated).status(), 201);
  const antigravityCard = page.getByTestId("provider-profile-row").filter({ hasText: "Google work" });
  await antigravityCard.waitFor();
  const createdProfiles = await (await page.request.get(`${node.url}/api/provider-profiles`)).json();
  const antigravityProfileId = createdProfiles.profiles.find((profile: { id: string; label: string }) => profile.label === "Google work").id;
  assert.equal(await antigravityCard.getByTestId("provider-profile-signin").count(), 1);
  assert.equal(await antigravityCard.getByTestId("provider-profile-sharing").count(), 0, "Antigravity profiles stay private");
  await antigravityCard.locator(".profile-pill").filter({ hasText: "Not signed in" }).waitFor();
  await antigravityCard.getByTestId("provider-profile-signin").click();
  await page.getByTestId("provider-profile-login-answer").waitFor();
  await page.getByTestId("provider-profile-login-answer").fill("fixture-code");
  await page.getByTestId("provider-profile-login-continue").click();
  await antigravityCard.locator(".profile-pill").filter({ hasText: "Signed in on this node" }).waitFor();
  assert.equal(await readFile(path.join(environment.root, "agy-profile-home"), "utf8"), path.join(node.dataDir, "provider-profile-auth", antigravityProfileId, "antigravity-home"));
  await antigravityCard.getByTestId("provider-profile-signout").click();
  await page.locator("#confirmDialog[open]").waitFor();
  assert.match(await page.locator("#confirmDialog").innerText(), /Signs out only this Antigravity profile/);
  await page.getByTestId("confirm-accept-button").click();
  await antigravityCard.locator(".profile-pill").filter({ hasText: "Not signed in" }).waitFor();

  await page.getByTestId("provider-profiles-tab-assignments").click();
  await page.getByTestId("provider-assignment-provider-antigravity").click();
  const antigravitySaved = page.waitForResponse((response) => response.url().endsWith("/api/provider-profiles/selection") && response.request().method() === "PUT");
  await choose(page, "provider-assignment-default-select", "Google work", "Google Antigravity profile");
  await page.getByTestId("confirm-accept-button").click();
  assert.equal((await antigravitySaved).status(), 200);
  const antigravityListing = await (await page.request.get(`${node.url}/api/provider-profiles`)).json();
  assert.ok(antigravityListing.selections.some((item: { provider: string; profileId: string }) => item.provider === "antigravity" && item.profileId === antigravityListing.profiles.find((profile: { label: string }) => profile.label === "Google work").id));

  await page.getByTestId("provider-profiles-tab-pools").click();
  await page.getByTestId("subscription-pool-new").click();
  await page.getByTestId("subscription-pool-name").fill("Google pool");
  await choose(page, "subscription-pool-member-0", "Google work", "Google work");
  const poolSaved = page.waitForResponse((response) => response.url().endsWith("/api/provider-profiles/pools") && response.request().method() === "POST");
  await page.getByTestId("subscription-pool-save").click();
  assert.equal((await poolSaved).status(), 201);
  await page.getByTestId("subscription-pool-card").filter({ hasText: "Google pool" }).waitFor();
  const savedPools = await (await page.request.get(`${node.url}/api/provider-profiles/pools`)).json();
  assert.ok(savedPools.pools.some((pool: { name: string; members: { profileId: string }[] }) => pool.name === "Google pool" && pool.members.some(({ profileId }) => profileId === antigravityProfileId)));

  await page.getByTestId("provider-profiles-tab-profiles").click();
  let posted = 0;
  page.on("request", (request) => { if (request.url().endsWith("/api/provider-profiles") && request.method() === "POST") posted += 1; });
  await page.getByTestId("provider-profile-label").fill("   ");
  await page.getByTestId("provider-profile-add").click();
  await page.locator(".toast-message", { hasText: "Enter a profile name first." }).waitFor();
  assert.equal(posted, 0, "an empty name is not sent");
  assert.equal(await page.getByTestId("provider-profile-label").evaluate((input) => input === document.activeElement), true);

  await page.getByTestId("provider-profile-provider-openai-codex").click();
  for (let i = 1; i <= 5; i += 1) {
    await page.getByTestId("provider-profile-label").fill(`Account ${i}`);
    const created = page.waitForResponse((response) => response.url().endsWith("/api/provider-profiles") && response.request().method() === "POST");
    await page.getByTestId("provider-profile-add").click();
    const response = await created;
    assert.equal(response.status(), 201, `Account ${i}: ${await response.text()}`);
    await page.getByTestId("provider-profile-row").filter({ hasText: `Account ${i}` }).waitFor();
  }
  assert.equal(await page.getByTestId("provider-profile-row").count(), 1);
  await page.getByTestId("provider-profile-prev").click();
  assert.equal(await page.getByTestId("provider-profile-row").count(), 4);
  const first = page.getByTestId("provider-profile-row").filter({ hasText: "Account 1" });
  await first.getByTestId("provider-profile-status").filter({ hasText: "Sign in on this node or on a twin." }).waitFor();
  assert.equal(await first.locator(".profile-pill").innerText(), "Not signed in");
  assert.equal(await first.getByTestId("provider-profile-signout").isVisible(), false);
  await page.getByTestId("provider-profile-provider-claude").click();
  assert.equal(await page.getByTestId("provider-profile-row").count(), 0, "each provider tab lists only its own profiles");
  assert.match(await page.getByTestId("provider-profile-list").innerText(), /No Claude profiles yet/);

  const ids = Object.fromEntries((await (await page.request.get(`${node.url}/api/provider-profiles`)).json()).profiles.map((item: { id: string; label: string }) => [item.label, item.id]));
  const puts: Array<{ scope: string; scopeId: string; profileId: string | null }> = [];
  page.on("request", (request) => { if (request.url().endsWith("/api/provider-profiles/selection") && request.method() === "PUT") puts.push(request.postDataJSON()); });

  await page.getByTestId("provider-profiles-tab-assignments").click();
  assert.equal(await page.getByTestId("provider-profile-row").count(), 0, "profile cards stay on the Profiles tab");
  await page.getByTestId("provider-assignment-provider-openai-codex").click();
  assert.match(await page.getByTestId("provider-assignment-default").innerText(), /Every ChatGPT conversation uses/);
  const savedChoice = () => page.waitForResponse((response) => response.url().endsWith("/api/provider-profiles/selection") && response.request().method() === "PUT");
  await choose(page, "provider-assignment-default-select", "Account 1", "Account 1");
  await page.locator("#confirmDialog[open]").waitFor();
  assert.match(await page.locator("#confirmDialog").innerText(), /conversation history/);
  const defaultSaved = savedChoice();
  await page.getByTestId("confirm-accept-button").click();
  assert.equal((await defaultSaved).status(), 200);
  assert.deepEqual(puts.at(-1), { provider: "openai-codex", scope: "default", scopeId: "", profileId: ids["Account 1"] });

  const addException = async (scope: "workspace" | "project", label: string) => {
    await page.getByTestId("provider-exception-new").click();
    await page.getByTestId("provider-exception-scope").selectOption(scope);
    await page.getByTestId(`provider-exception-${scope}`).selectOption({ index: 0 });
    await choose(page, "provider-exception-choice-select", label, label);
    await page.getByTestId("provider-exception-add").click();
    const exceptionSaved = savedChoice();
    await page.getByTestId("confirm-accept-button").click();
    assert.equal((await exceptionSaved).status(), 200);
    await page.getByTestId("provider-exception-row").filter({ hasText: label }).waitFor();
  };
  await addException("project", "Account 3");
  await addException("workspace", "Account 2");
  const rows = page.getByTestId("provider-exception-row");
  assert.deepEqual(await rows.evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.scope)), ["workspace", "project"], "less specific exceptions come first");
  assert.match(await rows.first().innerText(), /workspace[\s\S]*uses[\s\S]*Account 2/i);
  assert.deepEqual(puts.slice(-2).map(({ scope, profileId }) => [scope, profileId]), [["project", ids["Account 3"]], ["workspace", ids["Account 2"]]]);

  await page.getByTestId("settings-tab-account").click();
  const reload = page.waitForResponse((response) => response.url().endsWith("/api/provider-profiles") && response.request().method() === "GET");
  await page.getByTestId("settings-tab-connections").click();
  await reload;
  await rows.nth(1).waitFor();
  assert.equal((await page.getByTestId("provider-assignment-default-select").innerText()).trim(), "Account 1");
  await page.getByTestId("provider-assignment-provider-claude").click();
  assert.match(await page.getByTestId("provider-exception-list").innerText(), /No exceptions/, "each provider has its own choices");
  await page.getByTestId("provider-assignment-provider-openai-codex").click();

  const project = rows.filter({ hasText: "Account 3" });
  await project.getByTestId("provider-exception-remove").click();
  await page.getByTestId("confirm-accept-button").click();
  await project.waitFor({ state: "detached" });

  await page.getByTestId("provider-profiles-tab-profiles").click();
  await page.getByTestId("provider-profile-provider-openai-codex").click();
  const sharing = page.getByTestId("provider-profile-row").filter({ hasText: "Account 2" });
  await sharing.getByTestId("provider-profile-sharing").click();
  await page.locator("#confirmDialog[open]").waitFor();
  assert.match(await page.locator("#confirmDialog").innerText(), /Every user on this node/);
  await page.getByTestId("confirm-accept-button").click();
  await page.getByTestId("provider-profile-row").filter({ hasText: "Account 2" }).filter({ hasText: "Shared for automation" }).waitFor();
  await page.getByTestId("provider-profiles-tab-assignments").click();
  const shared = rows.filter({ hasText: "Account 2" }).getByTestId("provider-exception-choice");
  assert.match(await shared.innerText(), /Account 2 — unavailable, choose another/);
  assert.match(await shared.getAttribute("class") ?? "", /invalid/);
  await page.getByTestId("provider-assignment-default-select").click();
  await page.getByTestId("provider-assignment-default-select-search").fill("Account 2");
  assert.equal(await page.getByTestId("provider-assignment-default-select-option").count(), 0);
});
