import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getSettings, updateSettings } from "../src/settings.js";
import { addProject } from "../src/store.js";
import { runAsAccount } from "../src/account-context.js";
import { createProviderProfile, setProviderProfileSelection } from "../src/provider-profiles/store.js";
import { antigravityProfileHome } from "../src/antigravity-profiles/native.js";
import runtime from "../src/harnesses/antigravity/runtime.js";
import { readAntigravitySession } from "../src/harnesses/antigravity/storage.js";
import { managedMcpStore } from "../src/mcp/agent.js";
import { agentPolicyBodySchema, setClusterAgentPolicy } from "../src/cluster-agent-policy.js";
import { getClusterNode } from "../src/cluster.js";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { createSharingCluster, setResourceShares } from "../src/cluster-sharing-policy.js";
import { agentResourcePaths } from "../src/agent-resources.js";
import { buildSkillBundle } from "../src/skill-sharing.js";
import { authorizeMcpServer } from "../src/server/routes/managed-mcp.js";

const fixture = `#!/usr/bin/env node
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
for(const name of ['AGY_ADC_AUTH','GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_APPLICATION_CREDENTIALS','GOOGLE_CLOUD_PROJECT'])assert.equal(process.env[name],undefined,name+' must not be inherited');
assert.ok(process.env.SSH_CONNECTION,'SSH_CONNECTION must be set to bypass OS keyring');
if(args[0]==='--version'){process.stdout.write('agy 1.0.0\\n');process.exit(0);}
if(args[0]==='acp'&&args[1]==='--help'){process.stdout.write('agy acp\\n');process.exit(0);}
assert.ok(args[0]==='acp');
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const config=()=>[
{id:'model',name:'Model',type:'select',currentValue:model,options:[{value:'model-a',name:'Model A'},{value:'model-b',name:'Model B'}]},
{id:'thought_level',name:'Thinking Level',type:'select',currentValue:effort,options:[{value:'low',name:'Low'},{value:'medium',name:'Medium'},{value:'high',name:'High'}]},
];
let model='model-a',effort='medium',sessionId=path.basename(process.env.HOME)==='antigravity-home'?'native-'+path.basename(path.dirname(process.env.HOME)):'native-antigravity-1',promptId;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const request=JSON.parse(line),reply=result=>send({jsonrpc:'2.0',id:request.id,result});
if(request.id==='permission'){
const expected=process.env.AGY_FIXTURE_TOOL_ALLOWED==='1'?'selected':'cancelled';
assert.equal(request.result.outcome.outcome,expected);
if(expected==='selected')assert.equal(request.result.outcome.optionId,'allow');
send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'completed',rawOutput:'tool finished'}}});
send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Tool permission checked'}}}});
return send({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}});
}
if(request.method==='initialize')return reply({protocolVersion:1,agentCapabilities:{loadSession:true}});
if(request.method==='session/new'||request.method==='session/load'){
if(fs.existsSync(path.join(request.params.cwd,'resource-fixture'))){
const servers=request.params.mcpServers.map(({name,command,args,env,type,url,headers})=>({name,command,args,env,type,url,headers}));
fs.writeFileSync(path.join(request.params.cwd,'observed-resources'),JSON.stringify({args,method:request.method,servers,broker:Boolean(process.env.JOINT_BOB_MCP_TOKEN)}));
}
if(process.env.AGY_FIXTURE_UNAUTHENTICATED==='1'||process.env.AGY_FIXTURE_REQUIRE_LOGIN==='1'&&!fs.existsSync(path.join(process.env.HOME,'signed-in')))return send({jsonrpc:'2.0',id:request.id,error:{code:-32000,message:'Authentication required'}});
const replacement=fs.existsSync(path.join(request.params.cwd,'missing-native-session'));
if(request.method==='session/load'&&replacement&&request.params.sessionId!==sessionId+'-replacement')return send({jsonrpc:'2.0',id:request.id,error:{code:-32002,message:'Session not found: '+request.params.sessionId}});
if(replacement)sessionId+='-replacement';
if(request.method==='session/load'){
assert.equal(request.params.sessionId,sessionId);
send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Replayed old reply'}}}});
}
return reply({...(request.method==='session/new'?{sessionId}:{}),configOptions:config()});
}
if(request.method==='session/set_config_option'){
if(request.params.configId==='model')model=request.params.value;
else if(request.params.configId==='thought_level')effort=request.params.value;
else throw Error('unexpected config '+request.params.configId);
return reply({configOptions:config()});
}
if(request.method==='session/prompt'){
promptId=request.id;
const blocks=request.params.prompt;
const text=blocks.filter(block=>block.type==='text').at(-1).text;
if(text==='hello'||text==='continue'||text.endsWith('after the move')){
assert.equal(blocks[0].type,'text');
for(const name of ['JOINT_BOB_BROWSER_CLI','JOINT_BOB_SECRET_CLI','JOINT_BOB_WORKTREE_CLI','JOINT_BOB_TASK_CLI']){
assert.ok(process.env[name],name+' is missing from the runtime environment');
assert.ok(blocks[0].text.includes(name),name+' is missing from the ACP instructions');
}
assert.match(blocks[0].text,/# Joint Bob MCP/);
assert.equal(blocks[1].text,text);
if(text==='hello')assert.deepEqual(blocks[2],{type:'image',data:'Zml4dHVyZQ==',mimeType:'image/png'});
}
if(text==='test resource policy'){
assert.match(blocks[0].text,/policy-required-test-skill/);
assert.doesNotMatch(blocks[0].text,/policy-blocked-test-skill/);
}
if(text.endsWith('after the move')){
assert.match(text,/Context handoff:/);
assert.ok(text.includes('user: hello'));
assert.ok(text.includes('assistant: Antigravity reply'));
}
if(text==='missing during prompt')return send({jsonrpc:'2.0',id:request.id,error:{code:-32002,message:'Session not found: '+sessionId}});
if(text==='tool'){
send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'tool_call',toolCallId:'tool-1',title:'Run command',kind:'execute',rawInput:{command:'echo fixture'}}}});
return send({jsonrpc:'2.0',id:'permission',method:'session/request_permission',params:{sessionId,toolCall:{toolCallId:'tool-1',title:'Run command',kind:'execute',rawInput:{command:'echo fixture'}},options:[{optionId:'allow',kind:'allow_once'},{optionId:'reject',kind:'reject_once'}]}});
}
if(text==='wait')return send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Waiting'}}}});
send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Antigravity reply'}}}});
return send({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}});
}
throw Error('unexpected ACP method '+request.method);
}).on('close',()=>process.exit(0));
`;

test("Google Antigravity ACP readiness, model selection, native session and transcript", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-runtime-")), previous = getSettings();
  let session: Awaited<ReturnType<typeof runtime.open>> | undefined;
  try {
    const executable = path.join(root, "agy");
    await writeFile(executable, fixture); await chmod(executable, 0o700);
    updateSettings({ runtimes: { ...previous.runtimes, antigravity: { executable, configPath: path.join(root, ".gemini"), sessionPath: path.join(root, "sessions") } } });
    const project = await addProject("Antigravity fixture", root, { writeInstructions: false });

    assert.deepEqual(await runtime.readiness(root), []);
    assert.deepEqual(await runtime.signInProblems(), []);
    session = await runtime.open({ projectId: project.id, cwd: root, sessionId: "antigravity-test" });
    await assert.rejects(session.configure({ provider: "antigravity", modelId: "model-b", reasoning: "xhigh" }), /thinking level is not supported/);
    await session.configure({ provider: "antigravity", modelId: "model-b", reasoning: "high" });
    const deltas: string[] = [];
    session.subscribe((event) => { if (event.type === "textDelta") deltas.push(String(event.text)); });
    await session.prompt({ text: "hello", images: [{ data: "Zml4dHVyZQ==", mimeType: "image/png" }] });

    assert.deepEqual(deltas, ["Antigravity reply"]);
    assert.deepEqual(session.status().model, { provider: "antigravity", id: "model-b", label: "Model B" });
    assert.equal(session.status().thinkingLevel, "high");
    const stored = await readAntigravitySession(session.file!.replace(/^antigravity:/, ""));
    assert.equal(stored.nativeSessionId, "native-antigravity-1");
    assert.deepEqual(stored.messages.map(({ role, text }) => ({ role, text })), [
      { role: "user", text: "hello" }, { role: "assistant", text: "Antigravity reply" },
    ]);
    const sessionPath = session.file;
    session.dispose();
    session = await runtime.open({ projectId: project.id, cwd: root, sessionId: "antigravity-test", sessionPath });
    await session.prompt({ text: "continue" });
    const resumed = await readAntigravitySession(session.file!.replace(/^antigravity:/, ""));
    assert.deepEqual(resumed.messages.map(({ role, text }) => ({ role, text })), [
      { role: "user", text: "hello" }, { role: "assistant", text: "Antigravity reply" },
      { role: "user", text: "continue" }, { role: "assistant", text: "Antigravity reply" },
    ]);

    await writeFile(path.join(root, "missing-native-session"), "");
    let starts = 0;
    await session.prompt({ text: "after the move", beforeStart: async () => { starts++; } });
    const recovered = await readAntigravitySession(session.file!.replace(/^antigravity:/, ""));
    assert.equal(session.file, sessionPath);
    assert.equal(starts, 1);
    assert.equal(recovered.nativeSessionId, "native-antigravity-1-replacement");
    assert.equal(recovered.handoffPending, false);
    assert.deepEqual(recovered.messages.map(({ role, text }) => ({ role, text })), [
      ...resumed.messages.map(({ role, text }) => ({ role, text })),
      { role: "user", text: "after the move" }, { role: "assistant", text: "Antigravity reply" },
    ]);

    session.dispose();
    session = await runtime.open({ projectId: project.id, cwd: root, sessionId: "antigravity-test", sessionPath });
    starts = 0;
    await assert.rejects(session.prompt({ text: "missing during prompt", beforeStart: async () => { starts++; } }), /Session not found: native-antigravity-1-replacement/);
    assert.equal(starts, 1);
    assert.deepEqual(await readAntigravitySession(session.file!.replace(/^antigravity:/, "")), recovered);
  } finally {
    if (session?.isBusy()) await session.stopForUpdate();
    session?.dispose();
    updateSettings({ runtimes: previous.runtimes });
    await rm(root, { recursive: true, force: true });
  }
});

test("Antigravity passes approved MCP servers on new and resumed turns and enforces cluster resources at launch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-policy-")), previous = getSettings();
  const account = { accountId: "antigravity-resource-test", username: "fixture", role: "admin" as const, isRemoteLogin: false, homeNodeId: null };
  const required = "policy-required-test-skill", blocked = "policy-blocked-test-skill";
  const requiredRoot = path.join(agentResourcePaths().sharedSkills, required);
  const sessionId = "antigravity-policy-fixture";
  const store = managedMcpStore(account.accountId);
  let session: Awaited<ReturnType<typeof runtime.open>> | undefined;
  try {
    const executable = path.join(root, "agy");
    await writeFile(executable, fixture, { mode: 0o700 });
    await writeFile(path.join(root, "resource-fixture"), "");
    updateSettings({ strictResourceIsolation: true, runtimes: { ...previous.runtimes, antigravity: { executable, configPath: path.join(root, ".gemini"), sessionPath: path.join(root, "sessions") } } });
    const project = await addProject("Antigravity policy fixture", root, { writeInstructions: false });
    const db = await clusterV2Database(), manager = (await getClusterNode()).id, clusterId = randomUUID();
    createSharingCluster(db, { id: clusterId, name: "Antigravity policy fixture" }, manager);
    setResourceShares(db, manager, "project", project.id, [{ clusterId, projectId: null }]);
    for (const skill of [requiredRoot, path.join(root, ".agents", "skills", blocked)]) {
      await mkdir(skill, { recursive: true });
      await writeFile(path.join(skill, "SKILL.md"), `---\nname: ${path.basename(skill)}\ndescription: Test skill\n---\nSynthetic instructions\n`);
    }
    const config = await buildSkillBundle(requiredRoot, required);
    const policy = agentPolicyBodySchema.parse({ guardian: null });
    policy.rules = [{ harness: "all", action: "block", name: blocked }];
    policy.enabled.skills.antigravity = [required];
    policy.skillDigests = { [required]: config.digest };
    policy.settings.skills.enforce = true;
    policy.enabled.mcp.antigravity = ["approved", "node-stdio", "node-http"];
    policy.settings.mcp = { enforce: true, allowOthers: false };
    const shared = agentResourcePaths().mcpConfig;
    await mkdir(path.dirname(shared), { recursive: true });
    await writeFile(shared, JSON.stringify({ mcpServers: {
      "node-stdio": { command: "synthetic", args: ["--fixture"], env: { FIXTURE: "safe" } },
      "node-http": { type: "streamable-http", url: "https://fixture.invalid/mcp", headers: { "X-Fixture": "safe" } },
      "node-hidden": { command: "hidden" },
    } }));
    setClusterAgentPolicy(db, manager, clusterId, { policy, sourceRelayNodeId: null }, 1);
    store.install({ approved: { url: "https://approved.invalid/mcp" }, blocked: { url: "https://blocked.invalid/mcp" } });
    const profile = createProviderProfile(account.accountId, { provider: "antigravity", label: "Policy fixture" });
    setProviderProfileSelection(account.accountId, { provider: "antigravity", scope: "default", scopeId: "", profileId: profile.id });
    const home = antigravityProfileHome(profile);
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, "signed-in"), "fixture");
    const identity = { account, projectId: project.id, conversationId: sessionId, engine: "antigravity" as const };
    assert.equal(await authorizeMcpServer(identity, "blocked"), false);
    assert.equal(await authorizeMcpServer(identity, "approved"), true);
    session = await runAsAccount(account, () => runtime.open({ projectId: project.id, cwd: root, sessionId }));
    for (const method of ["session/new", "session/load"]) {
      await runAsAccount(account, () => session!.prompt({ text: "test resource policy" }));
      const observed = JSON.parse(await readFile(path.join(root, "observed-resources"), "utf8"));
      assert.deepEqual(observed.args, ["acp", "--include-default-customizations=false"]);
      assert.equal(observed.method, method);
      assert.equal(observed.broker, true);
      assert.deepEqual(observed.servers.map((server: { name: string }) => server.name), ["node-stdio", "node-http", "approved"]);
      assert.deepEqual(observed.servers[0], { name: "node-stdio", command: "synthetic", args: ["--fixture"], env: [{ name: "FIXTURE", value: "safe" }] });
      assert.deepEqual(observed.servers[1], { name: "node-http", type: "http", url: "https://fixture.invalid/mcp", headers: [{ name: "X-Fixture", value: "safe" }] });
      assert.match(observed.servers[2].args[0], /joint-bob-mcp\.mjs$/);
      assert.deepEqual(observed.servers[2].env, []);
    }
    store.remove("approved");
    await assert.rejects(runAsAccount(account, () => session!.prompt({ text: "must not start" })), /requires unavailable mcp resource approved/);
    updateSettings({ strictResourceIsolation: false });
    await assert.rejects(runAsAccount(account, () => session!.prompt({ text: "must not start" })), /requires strict resource isolation/);
  } finally {
    session?.dispose();
    updateSettings({ runtimes: previous.runtimes, strictResourceIsolation: previous.strictResourceIsolation });
    await rm(requiredRoot, { recursive: true, force: true });
    await rm(agentResourcePaths().mcpConfig, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("Antigravity turns use the selected profile home and do not resume another profile's native session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-profile-runtime-")), previous = getSettings();
  const previousRequireLogin = process.env.AGY_FIXTURE_REQUIRE_LOGIN;
  let session: Awaited<ReturnType<typeof runtime.open>> | undefined;
  try {
    const executable = path.join(root, "agy");
    await writeFile(executable, fixture); await chmod(executable, 0o700);
    updateSettings({ runtimes: { ...previous.runtimes, antigravity: { executable, configPath: path.join(root, ".gemini"), sessionPath: path.join(root, "sessions") } } });
    process.env.AGY_FIXTURE_REQUIRE_LOGIN = "1";
    const project = await addProject("Antigravity profile fixture", root, { writeInstructions: false });
    const owner = "antigravity-profile-owner";
    const actor = { accountId: owner, username: owner, role: "member" as const, isRemoteLogin: false, homeNodeId: null };
    const work = createProviderProfile(owner, { provider: "antigravity", label: "Google work" });
    const personal = createProviderProfile(owner, { provider: "antigravity", label: "Google personal" });
    setProviderProfileSelection(owner, { provider: "antigravity", scope: "default", scopeId: "", profileId: work.id });
    const workHome = antigravityProfileHome(work);
    await mkdir(workHome, { recursive: true, mode: 0o700 });
    await writeFile(path.join(workHome, "signed-in"), "fixture");

    session = await runtime.open({ projectId: project.id, cwd: root, sessionId: "antigravity-profile-session" });
    await runAsAccount(actor, () => session!.preflight());
    await runAsAccount(actor, () => session!.prompt({ text: "work turn" }));
    const workSession = await readAntigravitySession(session.file!.replace(/^antigravity:/, ""));
    assert.equal(workSession.nativeProfileId, work.id);
    assert.equal(workSession.nativeSessionId, `native-${work.id}`);

    setProviderProfileSelection(owner, { provider: "antigravity", scope: "default", scopeId: "", profileId: personal.id });
    await assert.rejects(runAsAccount(actor, () => session!.prompt({ text: "personal turn before sign-in" })), /Sign in to Antigravity profile Google personal/);
    const personalHome = antigravityProfileHome(personal);
    await mkdir(personalHome, { recursive: true, mode: 0o700 });
    await writeFile(path.join(personalHome, "signed-in"), "fixture");
    await runAsAccount(actor, () => session!.prompt({ text: "personal turn" }));
    const personalSession = await readAntigravitySession(session.file!.replace(/^antigravity:/, ""));
    assert.equal(personalSession.nativeProfileId, personal.id);
    assert.equal(personalSession.nativeSessionId, `native-${personal.id}`);
    assert.notEqual(personalSession.nativeSessionId, workSession.nativeSessionId);
  } finally {
    if (session?.isBusy()) await session.stopForUpdate();
    session?.dispose();
    if (previousRequireLogin === undefined) delete process.env.AGY_FIXTURE_REQUIRE_LOGIN;
    else process.env.AGY_FIXTURE_REQUIRE_LOGIN = previousRequireLogin;
    updateSettings({ runtimes: previous.runtimes });
    await rm(root, { recursive: true, force: true });
  }
});

test("Antigravity enforces tool categories, persists tool output and cancels an active turn", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-tools-")), previous = getSettings();
  const previousFlag = process.env.AGY_FIXTURE_TOOL_ALLOWED;
  let session: Awaited<ReturnType<typeof runtime.open>> | undefined;
  try {
    const executable = path.join(root, "agy");
    await writeFile(executable, fixture); await chmod(executable, 0o700);
    updateSettings({ runtimes: { ...previous.runtimes, antigravity: { executable, configPath: path.join(root, ".gemini"), sessionPath: path.join(root, "sessions") } } });
    const project = await addProject("Antigravity tools fixture", root, { writeInstructions: false });
    session = await runtime.open({ projectId: project.id, cwd: root, sessionId: "tools-test" });
    const events: string[] = [];
    session.subscribe((event) => events.push(event.type));
    process.env.AGY_FIXTURE_TOOL_ALLOWED = "0";
    await session.setTools([]);
    await session.prompt({ text: "tool" });
    assert.deepEqual((await readAntigravitySession(session.file!.replace(/^antigravity:/, ""))).enabledTools, []);
    process.env.AGY_FIXTURE_TOOL_ALLOWED = "1";
    await session.setTools(["commands"]);
    await session.prompt({ text: "tool" });
    assert.ok(events.includes("toolStart"));
    assert.ok(events.includes("toolEnd"));
    const stored = await readAntigravitySession(session.file!.replace(/^antigravity:/, ""));
    assert.equal(stored.messages.filter(({ role }) => role === "toolResult").length, 2);
    assert.deepEqual(stored.enabledTools, ["commands"]);
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    session.subscribe((event) => { if (event.type === "textDelta" && event.text === "Waiting") started(); });
    const prompt = session.prompt({ text: "wait" });
    const rejected = assert.rejects(prompt, /turn cancelled/);
    await waiting;
    await session.cancel();
    await rejected;
    assert.equal(session.isBusy(), false);
    assert.equal(events.at(-1), "agent_end");
  } finally {
    if (session?.isBusy()) await session.stopForUpdate();
    session?.dispose();
    if (previousFlag === undefined) delete process.env.AGY_FIXTURE_TOOL_ALLOWED;
    else process.env.AGY_FIXTURE_TOOL_ALLOWED = previousFlag;
    updateSettings({ runtimes: previous.runtimes });
    await rm(root, { recursive: true, force: true });
  }
});

test("Google Antigravity reports official CLI sign-in instructions without attempting login", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-auth-")), previous = getSettings();
  const priorFlag = process.env.AGY_FIXTURE_UNAUTHENTICATED;
  try {
    const executable = path.join(root, "agy");
    await writeFile(executable, fixture); await chmod(executable, 0o700);
    updateSettings({ runtimes: { ...previous.runtimes, antigravity: { executable, configPath: path.join(root, ".gemini"), sessionPath: path.join(root, "sessions") } } });
    process.env.AGY_FIXTURE_UNAUTHENTICATED = "1";
    assert.deepEqual(await runtime.signInProblems(), ["Google Antigravity is not signed in on this node. Open Settings > Harnesses > Google Antigravity and sign in with Google."]);
  } finally {
    if (priorFlag === undefined) delete process.env.AGY_FIXTURE_UNAUTHENTICATED;
    else process.env.AGY_FIXTURE_UNAUTHENTICATED = priorFlag;
    updateSettings({ runtimes: previous.runtimes });
    await rm(root, { recursive: true, force: true });
  }
});
