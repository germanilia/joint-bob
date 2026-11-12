import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { decodeAuthor, encodeAuthor } from "../src/message-authors.js";
import { assertQueuedPromptEditor } from "../src/prompt-queue.js";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { actingAccount, asNode, runAsAccount } from "../src/account-context.js";
import { automationProfileContext, poolProfileContext, withAutomationProfile, withPoolProfile, withoutAutomationProfile } from "../src/provider-profiles/context.js";
import { classifyPoolAttemptFailure, resolvePoolModelSettings, resolvePoolSwitchModel, runPoolAttempts } from "../src/provider-profiles/pool-execution.js";
import { ConversationOwnershipError } from "../src/conversation-ownership.js";

const require = createRequire(import.meta.url);
function load(file: string, dependencies: Record<string, any>, extra = ""): any {
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const exports: any = {};
  vm.runInThisContext(`(function(require, exports) { ${compiled}\n${extra}\n})`)(
    (name: string) => name.startsWith("node:") || name === "ws" || name === "zod" ? require(name) : dependencies, exports);
  return exports;
}
const actor = (accountId: string) => ({ accountId, username: accountId, role: "member" as const, isRemoteLogin: false, homeNodeId: null });
const author = (accountId: string, homeNodeId: string | null = null) => ({ accountId, username: accountId, email: null, homeNodeId });

/** Cross the real signed-socket identity boundary without opening a listener or an agent. */
async function bobPromptAuthor(accountId: string) {
  let url: URL | undefined;
  const dependencies: Record<string, any> = {
    actingAccount, runAsAccount, encodeAuthor,
    server: { address: () => ({ port: 1234 }) }, getClusterNode: async () => ({ id: "node" }),
    runtimeSocketHeaders: async () => ({}), personalContinuationAllowed: async () => true, registerBobAction: () => {},
    authSessionEvents: new EventEmitter(), webSocketServer: new EventEmitter(), onPhonePolicyChanged: () => {},
    clusterV2Database: async () => ({}), isTrustedTwin: () => false,
  };
  const socket = load("server/conversation-prompt.ts", dependencies, "exports.localChatSocket = localChatSocket;");
  dependencies.queueConversationPrompt = async (options: any) => { url = (await socket.localChatSocket(options)).url; };
  const review = load("server/control-center-review-check.ts", dependencies, "exports.push = push;");
  await review.push(actor(accountId), { projectId: "project", conversationId: "conversation", sessionId: "conversation", engine: "claude" }, "Work remains");
  assert.ok(url);
  assert.equal(url.searchParams.has("automationProfile"), false, "Bob's push stays editable, not an automation-owned prompt");
  const receiver = load("server/chat-socket.ts", dependencies, "exports.peerAuthor = peerAuthor;");
  const decoded = decodeAuthor(url.searchParams.get("author"));
  assert.ok(decoded, "the signed socket carries a valid author");
  return receiver.peerAuthor("node", decoded);
}

type Selection = "profile" | "pool" | "relay-pool";
function fixture(selection: Selection, failure?: string) {
  const calls: Array<{ account: string | undefined; profile: string; text: string }> = [], events: any[] = [];
  const lookups: any[] = [];
  const profiles = ["first", "second"].map(id => ({ id, profileId: id, provider: "claude", label: id }));
  const pool = { id: "pool", name: "configured-pool", fallbackModels: {}, members: profiles };
  const queued: any = { id: "queued", dispatchState: "pending", revision: 1, promptText: "Do the work", displayText: "Do the work", images: [], attachmentPaths: [], settings: null, author: author("writer") };
  let queue = [queued], completed = false, blocked = "", restored = 0;
  let settings = { provider: "claude", modelId: "opus", reasoning: "high" };
  const listeners = new Set<(event: any) => void>();
  const selectedProfile = () => {
    const member = poolProfileContext();
    if (member) return member.profileId;
    const automation = automationProfileContext();
    if (automation?.profileId) return automation.profileId;
    if (selection !== "profile") throw new Error("Selected subscription pool requires pool-aware execution");
    return `${automation?.accountId ?? actingAccount()?.accountId}-profile`;
  };
  const session: any = {
    id: "conversation", messages: [], isBusy: () => false, status: () => ({}), settings: () => settings,
    configure: async (value: typeof settings) => { selectedProfile(); settings = value; },
    preflight: async () => { selectedProfile(); },
    subscribe: (listener: (event: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    checkpointPoolAttempt: async () => ({}), restorePoolAttempt: async () => { restored++; },
    prompt: async (input: any) => {
      await input.beforeStart?.();
      const profile = selectedProfile();
      calls.push({ account: automationProfileContext()?.accountId ?? actingAccount()?.accountId, profile, text: input.text });
      if (failure) throw new Error(failure);
      if (profile === "first") throw new Error("rate_limit");
      input.onStarted?.();
      session.messages.push({ role: "assistant", text: "Finished.\nBOB_GOAL_COMPLETE" });
    },
  };
  const shared: any = { engine: "claude", projectId: "project", conversationId: "conversation", session, turnInFlight: 0, clients: new Set() };
  const connection: any = { engine: "claude", project: { id: "project", type: "workspace" }, conversationId: "conversation", cwd: "/synthetic", shared, author: author("viewer"), socket: {}, readOnly: false };
  const dependencies: Record<string, any> = {
    flags: {}, onGuardianEvent: () => {}, actingAccount, asNode, runAsAccount, withPoolProfile, withoutAutomationProfile, automationProfileContext,
    runPoolAttempts, classifyPoolAttemptFailure, resolvePoolModelSettings, resolvePoolSwitchModel, ConversationOwnershipError,
    listHarnessModels: async () => [{ provider: "claude", id: "opus", thinkingLevels: ["high"] }],
    nearestReasoning: (_levels: string[], reasoning: string) => reasoning,
    ownerAsActor: actor, resourceOwner: () => "project-owner",
    runWithAutomationProfile: (input: any, work: () => any) => withAutomationProfile({ accountId: input.creatorAccountId, profileId: input.providerProfileId }, work),
    getClusterNode: async () => ({ id: "node" }), clusterV2Database: async () => ({}), projectClusterIds: () => ["cluster"],
    getProject: async () => connection.project,
    resolveClusterSubscriptionPools: () => selection === "relay-pool" ? [{ poolId: "pool", poolOwnerNodeId: "node", clusterId: "cluster", manifest: pool }] : [],
    resolveSubscriptionChoice: (account: string, provider: string, scope: any, usage: string) => {
      lookups.push({ account, provider, scope, usage });
      return selection === "pool" ? { kind: "pool", pool } : undefined;
    },
    poolCandidates: () => profiles, projectProviderProfile: async () => ({ label: selectedProfile() }),
    getAutoRespond: async () => undefined, findHarnessSession: () => shared,
    teamQueuedTurn: async () => undefined, teamConversation: async () => undefined,
    getSettings: () => ({ digestAttachments: false, conversationDefaults: { claude: { provider: "claude", modelId: "opus", thinkingLevel: "high" } } }), markHarnessInput: () => {},
    activeRoutingConfig: () => null, routingConfigDatabase: () => ({}), readQueueSettings: () => null,
    getProjectLock: async () => undefined, conversationBelongsToDoneTask: async () => false,
    requireLocalConversationOwner: async () => {}, listConversationSegments: async () => [],
    catchUpGitHead: async () => {}, genericSecretEnvironment: () => ({}),
    queuedAttachments: async () => ({ text: queued.promptText, images: [] }),
    promptQueuePaused: () => false,
    listQueuedPrompts: () => queue, beginQueuedPrompt: () => true,
    claimQueuedPrompt: () => { queue = []; return true; }, resetQueuedPromptAttempt: () => {},
    queuedSettingsSchema: { parse: (value: unknown) => value },
    promptStarted: () => {}, promptEnded: () => {}, saveDifficulty: () => {}, recordQueueSettings: () => {},
    authoredPromptText: (_project: string, _conversation: string, text: string) => text,
    recordMessageAuthor: () => {}, personalAssistantSettings: async () => undefined,
    isScheduledPromptText: () => false, internalTaskPrompt: (_event: string, text: string) => text,
    send: (_socket: unknown, event: unknown) => { events.push(event); }, sendHarnessStatus: () => {}, broadcastToProject: () => {},
    chatErrorMessage: (error: Error) => error.message, recordTurnFailure: () => {},
    getHarnessRuntime: async () => ({ validateSettings: async () => {} }),
    getConversationGoal: async () => ({ status: "active", createdAt: "2026-11-05T00:00:00Z" }),
    goalPrompt: () => "Joint Bob goal: finish the work", goalStatusMessage: () => "Completed",
    recordConversationGoalResponse: async () => { completed = true; return { status: "completed" }; },
    blockConversationGoal: async (_project: string, _conversation: string, _at: string, error: string) => { blocked = error; return { status: "blocked" }; },
  };
  const exports = load("server/harness-chat.ts", dependencies, "exports.dispatch = dispatch; exports.runGoalTurn = runGoalTurn; exports.drainLoop = drainLoop;");
  Object.assign(dependencies, { resolveSubscriptionPool: exports.resolveSubscriptionPool, promptOnSubscriptionPool: exports.promptOnSubscriptionPool });
  Object.assign(dependencies, load("server/background-turn.ts", dependencies));
  exports.harnessChatConnections.add(connection);
  return { exports, dependencies, connection, shared, queued, calls, events, lookups, restored: () => restored, completed: () => completed, blocked: () => blocked };
}

for (const selection of ["profile", "pool", "relay-pool"] as const) {
  for (const origin of ["human", "bob-continuation", "remote-human", "automation-inherited", "automation-explicit", "internal-completion"] as const) {
    test(`${origin} queued turn uses its configured ${selection}, not the draining viewer's account`, async () => {
      const f = fixture(selection);
      const writer = origin === "bob-continuation" ? "a".repeat(32) : "writer";
      if (origin === "bob-continuation") {
        f.queued.author = await bobPromptAuthor(writer);
        f.connection.author = f.queued.author;
        assert.deepEqual(f.queued.author, author(writer), "Bob retains the local member's identity, not the project's owner");
        assert.doesNotThrow(() => assertQueuedPromptEditor(f.queued, writer));
        assert.throws(() => assertQueuedPromptEditor(f.queued, "unrelated-viewer"), /Only the prompt's author/);
      }
      if (origin === "remote-human") f.queued.author = author("remote-writer", "remote-node");
      if (origin.startsWith("automation")) f.queued.automationProfile = { accountId: "creator", profileId: origin === "automation-explicit" ? "pinned-profile" : null, nodeId: "node" };
      if (origin === "internal-completion") f.queued.systemEventId = "completion";
      await runAsAccount(actor("unrelated-viewer"), () => withAutomationProfile({ accountId: "unrelated-job", profileId: "wrong-profile" }, () => f.exports.dispatch(f.connection, f.queued)));
      const account = origin.startsWith("automation") ? "creator" : origin === "remote-human" ? "project-owner" : writer;
      const pooled = selection === "relay-pool" || (selection === "pool" && origin !== "automation-explicit");
      assert.deepEqual(f.calls.map(call => call.account), pooled ? [account, account] : [account]);
      assert.deepEqual(f.calls.map(call => call.profile), pooled ? ["first", "second"] : [origin === "automation-explicit" ? "pinned-profile" : `${account}-profile`]);
      assert.equal(f.restored(), pooled ? 1 : 0);
      assert.equal(f.shared.turnInFlight, 0);
      assert.equal(f.shared.turnAccountId, null);
      if (origin !== "internal-completion") assert.ok(f.events.some(event => event.type === "promptCompleted"));
      assert.equal(automationProfileContext(), undefined);
      assert.equal(poolProfileContext(), undefined);
    });
  }
  test(`goal continuation uses the conversation author's ${selection}`, async () => {
    const f = fixture(selection);
    f.connection.author = author("writer");
    assert.equal(await runAsAccount(actor("unrelated-viewer"), () => f.exports.runGoalTurn(f.connection)), true);
    assert.deepEqual(f.calls.map(call => call.account), selection === "profile" ? ["writer"] : ["writer", "writer"]);
    assert.deepEqual(f.calls.map(call => call.profile), selection === "profile" ? ["writer-profile"] : ["first", "second"]);
    assert.equal(f.completed(), true);
    assert.equal(f.shared.turnInFlight, 0);
  });
}

test("local signed sockets preserve explicit authors and automation assignments without inventing a user", async () => {
  const dependency = { actingAccount, encodeAuthor, server: { address: () => ({ port: 1234 }) },
    getClusterNode: async () => ({ id: "node" }), runtimeSocketHeaders: async () => ({}) };
  const socket = load("server/conversation-prompt.ts", dependency, "exports.localChatSocket = localChatSocket;");
  const options = { projectId: "project", sessionId: "conversation", engine: "claude", label: "test" };
  const explicit = author("b".repeat(32));
  const explicitSocket = await runAsAccount(actor("a".repeat(32)), () => socket.localChatSocket({ ...options, author: explicit }));
  assert.deepEqual(decodeAuthor(explicitSocket.url.searchParams.get("author")), explicit);
  const automationProfile = { accountId: "b".repeat(32), profileId: "pinned" };
  const automated = await runAsAccount(actor("a".repeat(32)), () => socket.localChatSocket({ ...options, automationProfile }));
  assert.equal(automated.url.searchParams.has("author"), false);
  assert.deepEqual(JSON.parse(automated.url.searchParams.get("automationProfile")), automationProfile);
  const system = await asNode(() => socket.localChatSocket(options));
  assert.equal(system.url.searchParams.has("author"), false);
});

test("signed authors remain local only for this node and trusted twins", async () => {
  const dependency = { authSessionEvents: new EventEmitter(), webSocketServer: new EventEmitter(), onPhonePolicyChanged: () => {},
    clusterV2Database: async () => ({}), getClusterNode: async () => ({ id: "node" }),
    isTrustedTwin: (_db: unknown, _local: string, peer: string) => peer === "twin" };
  const receiver = load("server/chat-socket.ts", dependency, "exports.peerAuthor = peerAuthor;");
  const person = author("a".repeat(32));
  assert.deepEqual(await receiver.peerAuthor("node", person), person);
  assert.deepEqual(await receiver.peerAuthor("twin", person), person);
  assert.deepEqual(await receiver.peerAuthor("teammate", person), { ...person, homeNodeId: "teammate" });
  const visitor = { ...person, homeNodeId: "visitor-home" };
  assert.deepEqual(await receiver.peerAuthor("node", visitor), visitor);
});

test("a pool turn restores saved settings on its first member and uses the default after switching", async () => {
  const f = fixture("pool");
  const saved = { harnessId: "claude", provider: "claude", modelId: "saved-model", reasoning: "high" };
  f.dependencies.readQueueSettings = () => saved;
  await f.exports.dispatch(f.connection, f.queued);
  assert.equal(f.shared.session.settings().modelId, "opus");
  assert.deepEqual(f.calls.map(call => call.profile), ["first", "second"]);
});

test("a compaction failure cannot strand the next queued prompt", async () => {
  const f = fixture("pool");
  Object.assign(f.dependencies, {
    getSettings: () => ({ autoCompactThreshold: 70, conversationDefaults: { claude: { provider: "claude", modelId: "opus", thinkingLevel: "high" } } }),
    getConversationGoal: async () => undefined,
    compactHarnessSession: async (_shared: unknown, compact: () => Promise<void>) => compact(),
    harnessTurnBusy: () => false,
  });
  f.shared.session.status = () => ({ contextUsage: { percent: 90 } });
  f.shared.session.compact = async () => { throw new Error("Summarization failed"); };
  await f.exports.drainLoop(f.connection);
  assert.deepEqual(f.calls.map(call => call.profile), ["first", "second"]);
  assert.ok(f.events.some(event => event.type === "error" && event.nonFatal === true && /Summarization failed/.test(event.error)));
  assert.ok(f.events.some(event => event.type === "promptCompleted" && event.queueId === f.queued.id));
  assert.equal(f.dependencies.listQueuedPrompts().length, 0);
  assert.equal(f.shared.turnInFlight, 0);
});

test("an automation bound to another node cannot run here", async () => {
  const f = fixture("pool");
  f.queued.automationProfile = { accountId: "creator", profileId: null, nodeId: "other-node" };
  await assert.rejects(f.exports.dispatch(f.connection, f.queued), /another execution node/);
  assert.deepEqual(f.calls, []);
});

test("a generic pool failure is surfaced without account fallback or a stuck busy counter", async () => {
  const f = fixture("pool", "Invalid request");
  await assert.rejects(f.exports.dispatch(f.connection, f.queued), /Invalid request/);
  assert.deepEqual(f.calls.map(call => call.profile), ["first"]);
  assert.equal(f.shared.turnInFlight, 0);
  assert.ok(f.events.some(event => event.type === "promptFailed" && event.error === "Invalid request"));
});

test("a routed model runs on the first pool member and the default runs after switching", async () => {
  const f = fixture("pool");
  let saved: any = null;
  const routed: any[] = [];
  const policy = { id: "config", revision: 1, policy: { classifierId: "typesafe", confidenceThreshold: 0.5, contextMessages: 10,
    harnesses: { claude: { levels: { "7": { provider: "claude", modelId: "routed-model", thinkingLevel: "high", description: "Hard work" } } } } } };
  Object.assign(f.dependencies, {
    activeRoutingConfig: () => policy, bumpRoutingPromptCount: () => 1, routingEvalDue: () => true, recordRoutingEval: () => {},
    readRoutingState: () => ({ mode: "auto", lastEvalOrdinal: null, configId: "config", configRevision: 1 }),
    classifyForRouting: async () => ({ classification: { level: 7, score: 7, confidence: 0.9 }, source: "local" }),
    systemAiSettings: () => ({ decision: { model: "typesafe" }, routing: { enabled: true, shareWithRelay: false } }), DEFAULT_ROUTING_CONFIG_ID: "default-config",
    automaticRoutingModelAllowed: () => true, getHarness: () => ({ configuration: {} }),
    readQueueSettings: () => saved, recordQueueSettings: (_key: string, value: unknown) => { saved = value; },
    getHarnessRuntime: async () => ({ validateSettings: async (value: any) => { routed.push(value.modelId); } }),
  });
  await f.exports.dispatch(f.connection, f.queued);
  assert.deepEqual(routed, ["routed-model"]);
  assert.ok(f.events.some(event => event.type === "promptRouted" && event.mapped === true && event.modelId === "routed-model"));
  // The fixture's configure throws outside a member, so the routed model was switched to inside one.
  assert.equal(f.shared.session.settings().modelId, "opus");
  assert.deepEqual(f.calls.map(call => call.profile), ["first", "second"]);
  assert.equal(saved.modelId, "opus", "saved queue settings reflect the model that completed the turn");
});
