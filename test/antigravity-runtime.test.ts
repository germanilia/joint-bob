import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

const fixture = `#!/usr/bin/env node
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
for(const name of ['AGY_ADC_AUTH','GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_APPLICATION_CREDENTIALS','GOOGLE_CLOUD_PROJECT'])assert.equal(process.env[name],undefined,name+' must not be inherited');
if(args[0]==='--version'){process.stdout.write('agy 1.0.0\\n');process.exit(0);}
if(args[0]==='acp'&&args[1]==='--help'){process.stdout.write('agy acp\\n');process.exit(0);}
assert.deepEqual(args,['acp']);
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const config=()=>[
{id:'model',name:'Model',type:'select',currentValue:model,options:[{value:'model-a',name:'Model A'},{value:'model-b',name:'Model B'}]},
{id:'effortLevel',name:'Thinking level',type:'select',currentValue:effort,options:[{value:'low',name:'Low'},{value:'medium',name:'Medium'},{value:'extra',name:'Extra'}]},
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
if(process.env.AGY_FIXTURE_UNAUTHENTICATED==='1'||process.env.AGY_FIXTURE_REQUIRE_LOGIN==='1'&&!fs.existsSync(path.join(process.env.HOME,'signed-in')))return send({jsonrpc:'2.0',id:request.id,error:{code:-32000,message:'Authentication required'}});
if(request.method==='session/load'){
assert.equal(request.params.sessionId,sessionId);
send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Replayed old reply'}}}});
}
return reply({...(request.method==='session/new'?{sessionId}:{}),configOptions:config()});
}
if(request.method==='session/set_config_option'){
if(request.params.configId==='model')model=request.params.value;
else if(request.params.configId==='effortLevel')effort=request.params.value;
else throw Error('unexpected config '+request.params.configId);
return reply({configOptions:config()});
}
if(request.method==='session/prompt'){
promptId=request.id;
if(request.params.prompt[0].text==='tool'){
send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'tool_call',toolCallId:'tool-1',title:'Run command',kind:'execute',rawInput:{command:'echo fixture'}}}});
return send({jsonrpc:'2.0',id:'permission',method:'session/request_permission',params:{sessionId,toolCall:{toolCallId:'tool-1',title:'Run command',kind:'execute',rawInput:{command:'echo fixture'}},options:[{optionId:'allow',kind:'allow_once'},{optionId:'reject',kind:'reject_once'}]}});
}
if(request.params.prompt[0].text==='wait')return send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Waiting'}}}});
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
    await session.configure({ provider: "antigravity", modelId: "model-b", reasoning: "xhigh" });
    const deltas: string[] = [];
    session.subscribe((event) => { if (event.type === "textDelta") deltas.push(String(event.text)); });
    await session.prompt({ text: "hello" });

    assert.deepEqual(deltas, ["Antigravity reply"]);
    assert.deepEqual(session.status().model, { provider: "antigravity", id: "model-b", label: "Model B" });
    assert.equal(session.status().thinkingLevel, "xhigh");
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
  } finally {
    if (session?.isBusy()) await session.stopForUpdate();
    session?.dispose();
    updateSettings({ runtimes: previous.runtimes });
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
