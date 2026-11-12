import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { chromium, type BrowserContext } from "playwright-core";
import WebSocket from "ws";
import { startSupervisor } from "../scripts/joint-bob-supervisor.mjs";
import { browserAgentIdentity, browserAgentInstructions } from "../src/browser-agent.js";
import { BrowserRuntime } from "../src/browser-runtime.js";
import { getClusterNode } from "../src/cluster.js";
import { ensureConversationRecord, getConversationRecord } from "../src/conversation-records.js";
import { resolveDataDirectory } from "../src/data-directory.js";
import { getSettings, updateSettings } from "../src/settings.js";
import { addProject } from "../src/store.js";
import { saveSecretAccount, setScopeSecretAccounts } from "../src/secrets.js";
import { listPendingUpdateRecoveries, saveUpdateRecoveries } from "../src/update-recovery.js";
import { handleHarnessChatMessage, harnessChatConnections, type HarnessChatConnection } from "../src/server/harness-chat.js";
import { attachHarnessClient, detachHarnessClient, harnessSessions, openHarnessSession } from "../src/server/harness-sessions.js";

const root = path.join(os.homedir(), "browser-spawn-regressions");
const capture = path.join(root, "spawns.jsonl");
let chat: typeof import("../src/server/chat.js");
let runs: typeof import("../src/server/update-recovery-runs.js");
let supervisor: Awaited<ReturnType<typeof startSupervisor>> | undefined;
let previousWarning: string | undefined;

before(async () => {
  await mkdir(root, { recursive: true });
  supervisor = await startSupervisor({
    dataDirectory: resolveDataDirectory(),
    app: { executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: root, env: { PATH: process.env.PATH ?? "", HOME: root } },
  });
  previousWarning = process.env.NODE_NO_WARNINGS;
  process.env.NODE_NO_WARNINGS = "1";
  const executable = path.join(root, "claude-fixture.mjs");
  await writeFile(capture, "");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.join(' ') === 'auth status --json') { console.log(JSON.stringify({loggedIn:true})); process.exit(0); }
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const sessionId = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
const systemIndex = args.indexOf('--append-system-prompt-file');
const instructions = systemIndex < 0 ? '' : await readFile(args[systemIndex + 1], 'utf8');
const encoded = process.cwd().replace(/^\\//, '-').replace(/[\\s_.\\/]+/g, '-');
const transcript = path.join(${JSON.stringify(path.join(root, "claude", "projects"))}, encoded, sessionId + '.jsonl');
await mkdir(path.dirname(transcript), {recursive:true});
await appendFile(transcript, JSON.stringify({type:'user', sessionId, message:{role:'user',content:prompt}}) + '\\n' + JSON.stringify({type:'assistant', sessionId, message:{role:'assistant',content:[{type:'text',text:'done'}]}}) + '\\n');
await appendFile(${JSON.stringify(capture)}, JSON.stringify({sessionId, args, prompt, instructions, token:process.env.JOINT_BOB_BROWSER_TOKEN, url:process.env.JOINT_BOB_BROWSER_URL, cli:process.env.JOINT_BOB_BROWSER_CLI, secret:process.env.BRIDGE_FIXTURE}) + '\\n');
console.log(JSON.stringify({type:'system',subtype:'init',session_id:sessionId}));
console.log(JSON.stringify({type:'result',is_error:false,result:'done'}));
`);
  await chmod(executable, 0o755);
  updateSettings({ ...getSettings(), claude: { executable, configPath: path.join(root, "claude"), sessionPath: path.join(root, "claude", "projects") }, pi: { executable: "", configPath: path.join(root, "pi"), sessionPath: path.join(root, "pi", "sessions") } });
  chat = await import("../src/server/chat.js");
  runs = await import("../src/server/update-recovery-runs.js");
});

after(async () => {
  chat?.sessionWatcher.close();
  for (const connection of harnessChatConnections) detachHarnessClient(connection.shared, connection.socket);
  harnessChatConnections.clear();
  for (const shared of new Set(harnessSessions.values())) {
    if (shared.idleTimer) clearTimeout(shared.idleTimer);
    shared.unsubscribe();
    shared.session.dispose();
  }
  harnessSessions.clear();
  await supervisor?.close();
  if (previousWarning === undefined) delete process.env.NODE_NO_WARNINGS;
  else process.env.NODE_NO_WARNINGS = previousWarning;
});

async function projectFixture() {
  const cwd = path.join(root, randomUUID());
  await mkdir(cwd);
  const project = await addProject("Browser spawn regression", cwd, { writeInstructions: false });
  const account = await saveSecretAccount({ label: "Spawn fixture", provider: "custom", variables: [{ name: "BRIDGE_FIXTURE", kind: "value", value: "attached-secret" }] });
  await setScopeSecretAccounts("project", project.id, [account.id]);
  return project;
}

// Stub only Chrome's transport. Identity, browser reuse/control, switch handling,
// Pi session creation and the bash subprocess all run through production code.
function fakeContext(): BrowserContext {
  const context = new EventEmitter();
  return Object.assign(context, {
    pages: () => [],
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
    newPage: async () => {
      const page = Object.assign(new EventEmitter(), { url: () => "about:blank", title: async () => "Existing tab" });
      context.emit("page", page);
      return page;
    },
    close: async () => { context.emit("close"); },
  }) as unknown as BrowserContext;
}

test("live Claude to Pi and Pi to Claude to Pi switches keep the existing human-paused browser", async (t) => {
  t.mock.method(chromium, "launch", async () => { throw new Error("Ephemeral browser launch forbidden in this test"); });
  t.mock.method(chromium, "launchPersistentContext", async () => fakeContext());
  const project = await projectFixture();
  const local = await getClusterNode();
  const originalId = randomUUID();
  const frames: Array<Record<string, unknown>> = [];
  const socket = { OPEN: WebSocket.OPEN, readyState: WebSocket.OPEN, send: (text: string) => frames.push(JSON.parse(text)) } as WebSocket;
  const { claimConversationLocally } = await import("../src/server/sessions-helpers.js");
  await claimConversationLocally("claude", originalId, local.id);
  const shared = await openHarnessSession("claude", { projectId: project.id, cwd: project.path, sessionId: originalId, conversationId: originalId });
  const connection: HarnessChatConnection = { socket, project, cwd: project.path, engine: "claude", shared, handoffContext: null, accountIds: [], readOnly: false, conversationId: originalId };
  harnessChatConnections.add(connection);
  attachHarnessClient(shared, socket);
  const runtime = new BrowserRuntime({ capability: async () => ({ supported: true, available: true, executable: process.execPath, reason: null }) });
  try {
    const existing = await runtime.create({ projectId: project.id, engine: "claude", conversationId: originalId, appNodeId: local.id });
    await runtime.execute(existing.id, { action: "takeControl" }, { kind: "human", id: "fixture-human" });
    for (const engine of ["pi", "claude", "pi"] as const) {
      await handleHarnessChatMessage(connection, Buffer.from(JSON.stringify({ type: "setEngine", engine })));
      assert.equal(connection.engine, engine);
      assert.equal(frames.filter(frame => frame.type === "engineChanged").at(-1)?.conversationId, originalId, "viewer must retain the logical conversation");
      if (engine !== "pi") continue;
      const handle = (connection.shared.session as unknown as { handle: { session: { sessionId: string; agent: { state: { tools: Array<{ name: string; execute(id: string, input: { command: string }): Promise<{ content: Array<{ type: string; text: string }> }> }> } } } } }).handle;
      const session = handle.session;
      assert.notEqual(session.sessionId, originalId, "switch must allocate a fresh segment before testing its token");
      assert.equal((await getConversationRecord(project.id, "pi", session.sessionId))?.conversationId, originalId);
      const bash = session.agent.state.tools.find(tool => tool.name === "bash")!;
      const result = await bash.execute("switch-token", { command: `node -e 'console.log(process.env.JOINT_BOB_BROWSER_TOKEN)'` });
      const token = result.content.filter(part => part.type === "text").map(part => part.text).join("\n").trim();
      const identity = browserAgentIdentity(token)!;
      assert.deepEqual(identity, { projectId: project.id, engine: "pi", conversationId: originalId }, "live Pi bash must use the logical ID known before segment persistence");
      const agentBrowser = await runtime.create({ ...identity, appNodeId: local.id });
      const viewerBrowser = (await runtime.list({ projectId: project.id, conversationId: originalId }))[0];
      assert.equal(agentBrowser.id, existing.id);
      assert.equal(viewerBrowser.id, existing.id);
      assert.deepEqual(agentBrowser.tabs, existing.tabs);
      assert.equal(agentBrowser.owner, "human");
      await assert.rejects(runtime.execute(agentBrowser.id, { action: "navigate", url: "https://example.com" }, { kind: "agent" }), /agent input paused/);
    }
  } finally {
    harnessChatConnections.delete(connection);
    detachHarnessClient(connection.shared, socket);
    await runtime.close();
  }
});

interface CapturedRun { sessionId: string; args: string[]; prompt: string; instructions: string; token: string; url: string; cli: string; secret: string; }
async function captured(): Promise<CapturedRun[]> {
  return (await readFile(capture, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}
function assertBridge(run: CapturedRun, projectId: string, conversationId: string) {
  assert.match(run.token ?? "", /^[a-f0-9]{64}$/, "Claude subprocess must receive a browser token");
  assert.deepEqual(browserAgentIdentity(run.token), { projectId, engine: "claude", conversationId });
  assert.equal(run.url, `http://127.0.0.1:${process.env.PORT || 8790}/api/browser/agent`);
  assert.equal(run.cli, path.resolve("bin/joint-bob-browser.mjs"));
  assert.equal(run.secret, "attached-secret");
  assert.ok(run.instructions.includes(browserAgentInstructions), "browser instructions belong in every spawn's system file");
  assert.ok(!run.prompt.includes(browserAgentInstructions));
  assert.ok(!run.instructions.includes(run.token));
}

test("recovered Claude chat and queued recovery turns retain browser bridge without changing slash input", async () => {
  const project = await projectFixture();
  const { claudeSessionFilePath } = await import("../src/claude-service.js");
  const segment = randomUUID(), logicalId = randomUUID();
  const file = claudeSessionFilePath(project.path, segment);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ type: "user", message: { role: "user", content: "Browser work in progress" } }) + "\n");
  await ensureConversationRecord(project.id, "claude", segment, (await getClusterNode()).id, undefined, { conversationId: logicalId, segmentIndex: 1 });
  await saveUpdateRecoveries([{ id: randomUUID(), kind: "chat", engine: "claude", projectId: project.id, cwd: project.path, sessionId: segment, sessionPath: `claude:${file}`, queuedPrompts: ["/compact"], model: null, effort: null, createdAt: new Date().toISOString() }]);
  const count = (await captured()).length;
  await runs.recoverPendingUpdateRuns();
  assert.deepEqual(await listPendingUpdateRecoveries(), []);
  const recovered = (await captured()).slice(count);
  assert.equal(recovered.length, 2);
  assert.equal(recovered[1].prompt, "/compact");
  for (const run of recovered) assertBridge(run, project.id, logicalId);
  assert.notEqual(recovered[0].token, recovered[1].token, "each recovered spawn gets its own token");
});
