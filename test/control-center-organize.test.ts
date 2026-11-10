import assert from "node:assert/strict";
import test from "node:test";
import type { BobDecision } from "../src/control-center/decisions.js";
import { gitStatusText, offerOperation, pickModel } from "../src/server/control-center-operate.js";
import { mayBeAboutOrganizing, parseOrganizeIntent, propose, type OrganizeIntent, type OrganizeWorld } from "../src/server/control-center-organize.js";
import type { AuthSession } from "../src/auth.js";
import type { HarnessModel } from "../src/harnesses/runtime.js";

const world: OrganizeWorld = {
  workspaces: [{ id: "work", label: "Work" }, { id: "personal", label: "Personal" }, { id: "empty", label: "Empty" }],
  projects: [{ id: "jb", name: "Joint Bob", workspaceId: "work" }, { id: "dak", name: "DAK Live", workspaceId: "personal" }],
  conversations: [
    { key: "conversation_1", projectId: "dak", projectName: "DAK Live", engine: "claude", sessionId: "s1", conversationId: "c1", title: "slice 10", nodeId: null },
    { key: "conversation_2", projectId: "jb", projectName: "Joint Bob", engine: "pi", sessionId: "s2", conversationId: "c2", title: "Mac build", nodeId: "mac-node" },
  ],
  accounts: [{ id: "gh", label: "GitHub work", provider: "github", projectId: null }, { id: "jb-only", label: "Joint Bob deploy", provider: "custom", projectId: "jb" }],
  agents: [{ id: "pi", label: "Pi" }, { id: "claude", label: "Claude Code" }],
};
const decision = (kind: BobDecision["kind"]): BobDecision => ({ kind, size: "short", projectId: null, autoRespond: false, confidence: 0.95 });
const proposal = (intent: Parameters<typeof propose>[0]) => {
  const result = propose(intent, world);
  assert.notEqual(typeof result, "string", JSON.stringify(result));
  return result as Exclude<ReturnType<typeof propose>, string>;
};

test("what Bob's agent answers is an intent only when it fits one of the shapes", () => {
  assert.deepEqual(parseOrganizeIntent('Sure:\n{"intent":"create-project","name":"Billing","workspaceId":"work"}'), { intent: "create-project", name: "Billing", workspaceId: "work" });
  assert.deepEqual(parseOrganizeIntent('{"intent":"none"}'), { intent: "none" });
  assert.deepEqual(parseOrganizeIntent('{"intent":"summarize-conversations","conversations":["conversation_1","conversation_2"]}'), { intent: "summarize-conversations", conversations: ["conversation_1", "conversation_2"] });
  for (const bad of ["", "create it", '{"intent":"create-project","name":"Billing"}', '{"intent":"drop-database"}', '{"intent":"rename-conversation","conversation":"conversation_1","title":""}', '{"intent":"summarize-conversations","conversations":[]}']) {
    assert.equal(parseOrganizeIntent(bad), null, bad);
  }
});

test("a message is about arranging work when the decision model says so, it asks a conversation something, or it was not surely a task and names a project, workspace or conversation", () => {
  assert.equal(mayBeAboutOrganizing("anything", decision("organize"), 0.9), true);
  assert.equal(mayBeAboutOrganizing("create a project called Billing", decision("task"), 0.9), false, "work inside a project is a task");
  assert.equal(mayBeAboutOrganizing("create a project called Billing", { ...decision("task"), confidence: 0.46 }, 0.9), true, "a guess under the threshold does not rule it out");
  assert.equal(mayBeAboutOrganizing("create a project called Billing", null, 0.9), true);
  assert.equal(mayBeAboutOrganizing("what is running in the project?", null, 0.9), false, "no change is asked for");
  assert.equal(mayBeAboutOrganizing("pause the nightly schedule", decision("automation"), 0.9), false);
  assert.equal(mayBeAboutOrganizing("I want you to ask the internal assistant conversation under joint bob how to review", decision("task"), 0.9), true, "asking a conversation something");
  assert.equal(mayBeAboutOrganizing("tell me what is running in the project", null, 0.9), false, "telling the person is not messaging a conversation");
  assert.equal(mayBeAboutOrganizing("update the summaries of these three cards", decision("question"), 0.9), true, "writing summaries");
  assert.equal(mayBeAboutOrganizing("summarize the slice 10 conversation", decision("task"), 0.9), true);
  assert.equal(mayBeAboutOrganizing("summarize this article for me", null, 0.9), false, "a summary of something else");
  // As the person types it, when the decision model is not sure what it is: Bob's agent decides whether it is for a conversation.
  const unsure = { ...decision("task"), confidence: 0.39 };
  assert.equal(mayBeAboutOrganizing("I want internal assitant conversatoin to fix this the dispay here is very wrong, the conversaotin is under joint-bob", unsure, 0.9), true);
  assert.equal(mayBeAboutOrganizing("I want the internal assistant conversation to fix this", null, 0.9), true);
  assert.equal(mayBeAboutOrganizing("ask the slice 10 convresation how to review it", decision("task"), 0.9), true, "a typo does not hide asking a conversation");
  assert.equal(mayBeAboutOrganizing("fix the display in Joint Bob", unsure, 0.9), false, "no conversation named");
});

test("a conversation another of the person's machines runs is offered too: the press is sent there", () => {
  const offered = proposal({ intent: "message-conversation", conversation: "conversation_2", message: "fix this" });
  assert.equal(offered.text, `Send this to "Mac build" in Joint Bob? I'll bring you its answer here.\nfix this`);
  assert.deepEqual(offered.operation, { op: "message-conversation", projectId: "jb", engine: "pi", sessionId: "s2", conversationId: "c2", title: "Mac build", message: "fix this", nodeId: "mac-node" });
});

test("each change is said plainly, carries the exact ids, and a removal is marked as dangerous", () => {
  const created = proposal({ intent: "create-project", name: "Billing", workspaceId: "work" });
  assert.match(created.text, /Create the project "Billing" in the workspace "Work"/);
  assert.deepEqual(created.operation, { op: "create-project", name: "Billing", workspaceId: "work", workspaceName: "Work" });
  assert.equal(created.danger, false);
  const closed = proposal({ intent: "close-conversation", conversation: "conversation_1" });
  assert.deepEqual(closed.operation, { op: "close-conversation", projectId: "dak", engine: "claude", sessionId: "s1", title: "slice 10" });
  assert.deepEqual(closed.project, { id: "dak", name: "DAK Live" });
  const removed = proposal({ intent: "delete-project", projectId: "jb" });
  assert.equal(removed.danger, true);
  assert.match(removed.text, /folder stays on disk/);
  assert.equal(proposal({ intent: "delete-workspace", workspaceId: "empty" }).danger, true);
  const asked = proposal({ intent: "message-conversation", conversation: "conversation_1", message: "how do I review this?" });
  assert.match(asked.text, /^Send this to "slice 10" in DAK Live\? I'll bring you its answer here\.\nhow do I review this\?$/);
  assert.equal(asked.button, "Send it");
  assert.deepEqual(asked.operation, { op: "message-conversation", projectId: "dak", engine: "claude", sessionId: "s1", conversationId: "c1", title: "slice 10", message: "how do I review this?", nodeId: null });
  const deleted = proposal({ intent: "delete-conversation", conversation: "conversation_1" });
  assert.equal(deleted.danger, true);
  assert.deepEqual(deleted.operation, { op: "delete-conversation", projectId: "dak", engine: "claude", sessionId: "s1", title: "slice 10" });
});

test("a change that cannot be done is said so, and nothing is proposed", () => {
  assert.match(propose({ intent: "create-workspace", name: "work" }, world) as string, /already have a workspace called "work"/);
  assert.match(propose({ intent: "delete-workspace", workspaceId: "work" }, world) as string, /still holds "Joint Bob"/);
  assert.match(propose({ intent: "move-project", projectId: "jb", workspaceId: "work" }, world) as string, /already in "Work"/);
  assert.match(propose({ intent: "rename-project", projectId: "made-up", name: "x" }, world) as string, /could not find/);
  assert.match(propose({ intent: "close-conversation", conversation: "conversation_9" }, world) as string, /could not find that conversation/);
  assert.match(propose({ intent: "create-project", name: "x", workspaceId: "nope" }, world) as string, /could not find the workspace/);
  assert.match(propose({ intent: "delete-conversation", conversation: "conversation_9" }, world) as string, /could not find that conversation/);
});

// ── Operating the app: a conversation's turn, auto respond, agent, model and secrets; a project's git, tasks and quick notes ──

const session = { accountId: "a1", userId: "u1", username: "ilia" } as AuthSession;

test("the operations are intents only in their shapes", () => {
  assert.deepEqual(parseOrganizeIntent('{"intent":"change-model","conversation":"conversation_1","agent":null,"model":"opus","effort":"high"}'), { intent: "change-model", conversation: "conversation_1", agent: null, model: "opus", effort: "high" });
  assert.deepEqual(parseOrganizeIntent('{"intent":"pull-request","projectId":"jb","number":413,"action":"merge","body":""}'), { intent: "pull-request", projectId: "jb", number: 413, action: "merge", body: "" });
  for (const bad of ['{"intent":"auto-respond","conversation":"conversation_1"}', '{"intent":"change-model","conversation":"conversation_1","agent":null,"model":null,"effort":"extreme"}', '{"intent":"pull-request","projectId":"jb","number":0,"action":"merge","body":""}', '{"intent":"pull-request","projectId":"jb","number":4,"action":"force-push","body":""}']) {
    assert.equal(parseOrganizeIntent(bad), null, bad);
  }
});

test("a message about changing a conversation, a project's git, or its tasks list or quick notes is looked at, even when the decision model said task", () => {
  assert.equal(mayBeAboutOrganizing("stop the slice 10 conversation", decision("task"), 0.9), true);
  assert.equal(mayBeAboutOrganizing("turn on auto respond for the menu chat", decision("task"), 0.9), true);
  assert.equal(mayBeAboutOrganizing("switch the slice 10 conversation to opus with high effort", decision("task"), 0.9), true);
  assert.equal(mayBeAboutOrganizing("attach the github secret to the slice 10 conversation", decision("task"), 0.9), true);
  assert.equal(mayBeAboutOrganizing("what's the git status of Joint Bob?", decision("question"), 0.9), true);
  assert.equal(mayBeAboutOrganizing("merge PR 413 in Contigos", decision("task"), 0.9), true);
  assert.equal(mayBeAboutOrganizing("add a quick note in DAK Live to check the invoices", decision("task"), 0.9), true);
  assert.equal(mayBeAboutOrganizing("put it on the tasks list of Joint Bob", decision("task"), 0.9), true);
  assert.equal(mayBeAboutOrganizing("fix the login page in Joint Bob", decision("task"), 0.9), false, "work in a project is still a task");
});

test("a model is found by its id or name, or the only one that contains what was named; several are a question", () => {
  const model = (provider: string, id: string, label: string): HarnessModel => ({ provider, id, label, thinkingLevels: ["low", "medium", "high"] });
  const models = [model("anthropic", "claude-opus-5-5", "Opus 5.5"), model("anthropic", "claude-sonnet-5-5", "Sonnet 5.5"), model("openai", "gpt-6.1-sol", "GPT-6.1 Sol")];
  assert.equal((pickModel(models, "Opus 5.5") as HarnessModel).id, "claude-opus-5-5");
  assert.equal((pickModel(models, "anthropic/claude-sonnet-5-5") as HarnessModel).id, "claude-sonnet-5-5");
  assert.equal((pickModel(models, "sol") as HarnessModel).id, "gpt-6.1-sol");
  assert.deepEqual((pickModel(models, "5.5") as HarnessModel[]).map((entry) => entry.id), ["claude-opus-5-5", "claude-sonnet-5-5"]);
  assert.equal(pickModel(models, "llama"), null);
});

test("a git status reads as the branch, how it stands, its changes and its open pull requests", () => {
  const status = { branch: "main", upstream: "origin/main", ahead: 2, behind: 0, detached: false, staged: [{}], unstaged: [{}, {}], untracked: [], clean: false } as never;
  assert.equal(gitStatusText("Joint Bob", { status, pulls: [{ number: 413, title: "Fix the menu", head: "menu", base: "main", sha: "a".repeat(40), author: "ilia", draft: false, url: "" }], pullsProblem: null }),
    "Joint Bob is on the branch main, 2 ahead and 0 behind origin/main. Changes waiting: 1 staged, 2 not staged.\nOpen pull requests (1):\n- #413 Fix the menu (menu → main, by ilia)");
  assert.match(gitStatusText("Joint Bob", { status: { ...(status as object), clean: true, upstream: undefined } as never, pulls: null, pullsProblem: "No GitHub account" }), /with no upstream branch\. No changes are waiting\.\nI could not read its pull requests: No GitHub account$/);
});

test("each operation says what it does and waits for the button; what cannot be done from here is said so", async () => {
  const task = await offerOperation(session, { intent: "add-task", projectId: "jb", title: "Speed up the board", description: "It takes 3 s to draw", start: false }, world);
  assert.deepEqual([task.text, task.ask && task.button, task.ask && task.operation], ["Add the task \"Speed up the board\" in Joint Bob's Tasks list?\nIt takes 3 s to draw", "Add it", { op: "add-task", projectId: "jb", title: "Speed up the board", description: "It takes 3 s to draw", start: false }]);
  const started = await offerOperation(session, { intent: "add-task", projectId: "jb", title: "Speed up the board", description: "", start: true }, world);
  assert.equal(started.ask && started.button, "Add and start");
  const note = await offerOperation(session, { intent: "add-note", projectId: "dak", title: "Invoices", content: "check them" }, world);
  assert.deepEqual([note.text, note.ask && note.button], ["Save the quick note \"Invoices\" in DAK Live, to start later?\ncheck them", "Save it"]);
  assert.match((await offerOperation(session, { intent: "auto-respond", conversation: "conversation_2", on: true }, world)).text, /"Mac build" runs on another machine/);
  assert.match((await offerOperation(session, { intent: "change-model", conversation: "conversation_2", agent: null, model: null, effort: "high" }, world)).text, /runs on another machine/);
  assert.match((await offerOperation(session, { intent: "attach-secret", conversation: "conversation_1", accountId: "jb-only" }, world)).text, /"Joint Bob deploy" belongs to another project/);
  assert.match((await offerOperation(session, { intent: "attach-secret", conversation: "conversation_1", accountId: "made-up" }, world)).text, /could not find that secret account/);
  assert.match((await offerOperation(session, { intent: "stop-conversation", conversation: "conversation_9" }, world)).text, /could not find that conversation/);
  assert.match((await offerOperation(session, { intent: "add-note", projectId: "made-up", title: "x", content: "" }, world)).text, /could not find that project/);
  assert.match((await offerOperation(session, { intent: "pull-request", projectId: "jb", number: 4, action: "comment", body: " " }, world)).text, /What should the comment on #4 say\?/);
});
