import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { BobMessage } from "../src/control-center/bob-store.js";
import { api, seedDevEnvironment, signIn, stopDevNode, waitForDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";
import { serverArgs } from "./server-entry.js";

/** What each node last wrote to stderr, and how it ended: a node that crashed shows in a test only as "fetch failed". */
const nodeOutput = new WeakMap<ChildProcess, string[]>();

/** The failure, with what the node last wrote and whether it exited. */
function withNodeOutput(error: unknown, child: ChildProcess | undefined): Error {
  const output = (child && nodeOutput.get(child)?.join("").slice(-6_000)) || "(none)";
  return new Error(`${error instanceof Error ? error.message : String(error)}\n--- what the node last wrote ---\n${output}`, { cause: error });
}

/** A real node with Bob's agent stood in: what it "answers" for a message is the organize.json the test writes. */
async function startNode(environment: DevEnvironment, node: SeededNode, directory: string): Promise<ChildProcess> {
  const env: NodeJS.ProcessEnv = {
    ...process.env, PORT: String(node.port), NODE_ENV: "test", HOME: environment.home, JOINT_BOB_DATA_DIR: node.dataDir, JOINT_BOB_SESSION_COOKIE: node.cookieName,
    JOINT_BOB_INSECURE_COOKIE: "1", JOINT_BOB_RELEASE: "development", JOINT_BOB_TEST_ENGINE_LOG: path.join(directory, "engine.log"), JOINT_BOB_TEST_AUTOMATION_DIR: directory,
  };
  delete env.TYPESAFE_AI_API_KEY;
  const child = spawn(process.execPath, serverArgs(env, ["./test/stub-harness-bootstrap.ts", "./test/stub-automation-bootstrap.ts"]), { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  const output: string[] = [];
  nodeOutput.set(child, output);
  child.stderr!.on("data", (chunk) => { output.push(String(chunk)); if (output.length > 400) output.shift(); });
  child.on("exit", (code, signal) => output.push(`\n[the node exited: ${code ?? signal}]`));
  return waitForDevNode(child, node.key, node.url);
}

async function say(node: SeededNode, auth: SignedIn, directory: string, text: string, intent: unknown): Promise<BobMessage> {
  await writeFile(path.join(directory, "organize.json"), JSON.stringify(intent));
  const reply = await api<{ reply: BobMessage }>(node, auth, "POST", "/control-center/bob/message", { message: text });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return reply.body.reply;
}

async function press(node: SeededNode, auth: SignedIn, message: BobMessage, actionId = "organize.run"): Promise<BobMessage> {
  const pressed = await api<{ messages: BobMessage[] }>(node, auth, "POST", "/control-center/bob/action", { messageId: message.id, actionId });
  assert.equal(pressed.status, 200, JSON.stringify(pressed.body));
  return pressed.body.messages[0];
}

interface Workspace { id: string; label: string }
interface Project { id: string; name: string; path: string; type: string }

test("Bob creates, renames, moves and removes workspaces and projects, each only after the person presses the button", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "control-organize-"));
  let child: ChildProcess | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const directory = path.join(root, "stubs");
    await mkdir(directory, { recursive: true });
    child = await startNode(environment, node, directory);
    const auth = await signIn(environment, node);
    const workspaces = async () => (await api<{ workspaces: Workspace[] }>(node, auth, "GET", "/workspaces")).body.workspaces;
    const projects = async () => (await api<{ projects: Project[] }>(node, auth, "GET", "/projects?syncStatus=false")).body.projects;
    const before = await workspaces();

    // A workspace: the message asks, the button makes it.
    const askWorkspace = await say(node, auth, directory, "create a workspace called Clients", { intent: "create-workspace", name: "Clients" });
    assert.equal(askWorkspace.importance, "needs-you");
    assert.match(askWorkspace.text, /Create the workspace "Clients"\?/);
    assert.deepEqual(askWorkspace.actions.map((action) => [action.id, action.style ?? null]), [["organize.run", "primary"], ["organize.cancel", null]]);
    assert.equal((await workspaces()).length, before.length, "nothing is made before the button");
    assert.match((await press(node, auth, askWorkspace)).text, /Created the workspace "Clients"/);
    const clients = (await workspaces()).find((workspace) => workspace.label === "Clients")!;
    assert.ok(clients, "the workspace is there");
    assert.match((await say(node, auth, directory, "create a workspace called clients", { intent: "create-workspace", name: "clients" })).text, /already have a workspace/);

    // A project in it, with its folder in the projects home.
    const askProject = await say(node, auth, directory, "create a project called Billing in Clients", { intent: "create-project", name: "Billing", workspaceId: clients.id });
    assert.match(askProject.text, /Create the project "Billing" in the workspace "Clients"/);
    await press(node, auth, askProject);
    const billing = (await projects()).find((project) => project.name === "Billing")!;
    assert.equal(billing.type, clients.id);
    assert.ok((await stat(billing.path)).isDirectory(), "the project's folder exists");

    // Rename and move it; an empty-workspace check stops a workspace that still holds it from being deleted.
    await press(node, auth, await say(node, auth, directory, "rename the Billing project to Invoices", { intent: "rename-project", projectId: billing.id, name: "Invoices" }));
    assert.equal((await projects()).find((project) => project.id === billing.id)?.name, "Invoices");
    const refused = await say(node, auth, directory, "delete the Clients workspace", { intent: "delete-workspace", workspaceId: clients.id });
    assert.match(refused.text, /still holds "Invoices"/);
    assert.deepEqual(refused.actions, []);
    const home = before[0];
    await press(node, auth, await say(node, auth, directory, `move the Invoices project to ${home.label}`, { intent: "move-project", projectId: billing.id, workspaceId: home.id }));
    const moved = (await projects()).find((project) => project.id === billing.id)!;
    assert.equal(moved.type, home.id);

    // Cancelling changes nothing; removing waits for a warning button and leaves the folder on disk.
    const keep = await say(node, auth, directory, "delete the Invoices project", { intent: "delete-project", projectId: billing.id });
    assert.match((await press(node, auth, keep, "organize.cancel")).text, /nothing was changed/);
    assert.ok((await projects()).some((project) => project.id === billing.id));
    const remove = await say(node, auth, directory, "delete the Invoices project", { intent: "delete-project", projectId: billing.id });
    assert.equal(remove.actions[0].style, "warn");
    assert.match((await press(node, auth, remove)).text, /Removed the project "Invoices" from Joint Bob/);
    assert.equal((await projects()).some((project) => project.id === billing.id), false);
    assert.ok((await stat(moved.path)).isDirectory(), "its folder stays");
    await press(node, auth, await say(node, auth, directory, "delete the Clients workspace", { intent: "delete-workspace", workspaceId: clients.id }));
    assert.equal((await workspaces()).some((workspace) => workspace.id === clients.id), false);

    // Whatever the agent says is checked: an id that is not the person's changes nothing.
    const invented = await say(node, auth, directory, "rename the payments project", { intent: "rename-project", projectId: "made-up", name: "x" });
    assert.match(invented.text, /could not find/);
    assert.deepEqual(invented.actions, []);
  } catch (error) {
    throw withNodeOutput(error, child);
  } finally {
    if (child) await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});

async function eventually<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Never happened: ${label}`);
}

test("Bob starts a conversation, asks it something and brings back its answer, operates it and its project, then deletes it, each after the button", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "control-organize-conversations-"));
  let child: ChildProcess | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const [project] = node.projects;
    const directory = path.join(root, "stubs");
    await mkdir(directory, { recursive: true });
    child = await startNode(environment, node, directory);
    const auth = await signIn(environment, node);
    const sessionsOf = async () => (await api<{ sessions: Array<{ id: string; title: string; harnessId: string }> }>(node, auth, "GET", `/projects/${project.id}/sessions`)).body.sessions;
    const messages = async () => (await api<{ messages: BobMessage[] }>(node, auth, "GET", "/control-center/bob/messages")).body.messages;

    await press(node, auth, await say(node, auth, directory, `start a conversation in ${project.name} to check the menu`, { intent: "start-conversation", projectId: project.id, message: "check the menu" }));
    const started = await eventually(async () => (await sessionsOf()).find((session) => session.title === "check the menu"), "the conversation was started");

    // Asking a conversation, even an idle one off the board, waits for the button; its answer comes back to Bob's chat.
    const ask = await say(node, auth, directory, "ask the check the menu conversation how to review it", { intent: "message-conversation", conversation: "conversation-titled:check the menu", message: "how do I review this?" });
    assert.match(ask.text, /^Send this to "check the menu" in .+\? I'll bring you its answer here\.\nhow do I review this\?$/);
    assert.deepEqual(ask.actions.map((action) => action.label), ["Send it", "Cancel"]);
    assert.match((await press(node, auth, ask)).text, /^Sent to "check the menu"\. I'll bring you its answer here when it is done\.$/);
    const answered = await eventually(async () => (await messages()).find((message) => message.text.startsWith('"check the menu" answered:')), "the answer came back to Bob's chat");
    assert.match(answered.text, /stubbed response/);
    assert.equal(answered.importance, "report");
    assert.deepEqual(answered.actions.map((action) => action.id), ["open"]);

    // A summary is written at once, without a button, and posted in the chat when it is ready.
    const summarizing = await say(node, auth, directory, "write the summary of the check the menu conversation", { intent: "summarize-conversations", conversations: ["conversation-titled:check the menu"] });
    assert.equal(summarizing.text, `Writing the summary of "check the menu". I'll post it here when it is written.`);
    assert.deepEqual(summarizing.actions, []);
    const summary = await eventually(async () => (await messages()).find((message) => message.text.startsWith('"check the menu": summary')), "the summary was posted");
    assert.match(summary.text, /^"check the menu": summary\n\n\*\*Goal\*\* — /);
    assert.deepEqual([summary.importance, summary.via, summary.actions.map((action) => action.id)], ["report", "Organize · summary written", ["open"]]);

    // Bob operates the conversation and its project too, each change after the button. Nothing runs in it now: nothing to stop.
    const menu = "conversation-titled:check the menu";
    const operate = (message: BobMessage) => press(node, auth, message, "operate.run");
    const idle = await say(node, auth, directory, "stop the check the menu conversation", { intent: "stop-conversation", conversation: menu });
    assert.deepEqual([idle.text, idle.actions], ['"check the menu" is not running anything right now.', []]);
    // Auto respond, on and then off.
    const autoOn = await say(node, auth, directory, "turn on auto respond for the check the menu conversation", { intent: "auto-respond", conversation: menu, on: true });
    assert.match(autoOn.text, /^Turn auto respond on for "check the menu" in .+\? I'll answer its routine questions/);
    assert.deepEqual(autoOn.actions.map((action) => [action.id, action.label]), [["operate.run", "Turn it on"], ["organize.cancel", "Cancel"]]);
    assert.match((await operate(autoOn)).text, /^Auto respond is on for "check the menu"\./);
    assert.match((await say(node, auth, directory, "turn on auto respond for the check the menu conversation", { intent: "auto-respond", conversation: menu, on: true })).text, /already on/);
    assert.match((await operate(await say(node, auth, directory, "turn auto respond off for the check the menu conversation", { intent: "auto-respond", conversation: menu, on: false }))).text, /^Auto respond is off for "check the menu"/);
    // Its effort, kept for its next turns.
    const effort = await say(node, auth, directory, "use high effort in the check the menu conversation", { intent: "change-model", conversation: menu, agent: null, model: null, effort: "high" });
    assert.match(effort.text, /^Change "check the menu" in .+ to high effort\?$/);
    assert.equal((await operate(effort)).text, 'Changed "check the menu". Its next turn uses it.');
    // A secret account, beside what it has.
    const account = await api<{ account: { id: string } }>(node, auth, "POST", "/secrets/accounts", { label: "Deploy key", provider: "custom", variables: [{ name: "DEPLOY_TOKEN", kind: "value", value: "test-token" }] });
    assert.equal(account.status, 201, JSON.stringify(account.body));
    const attach = await say(node, auth, directory, "attach the deploy key secret to the check the menu conversation", { intent: "attach-secret", conversation: menu, accountId: account.body.account.id });
    assert.match(attach.text, /^Attach the secret account "Deploy key" to "check the menu"/);
    assert.equal((await operate(attach)).text, 'Attached "Deploy key" to "check the menu".');
    const scope = await api<{ accountIds: string[] }>(node, auth, "GET", `/secrets/scopes/conversation/${encodeURIComponent(`${started.harnessId}:${started.id}`)}`);
    assert.deepEqual(scope.body.accountIds, [account.body.account.id]);
    assert.match((await say(node, auth, directory, "attach the deploy key secret to the check the menu conversation", { intent: "attach-secret", conversation: menu, accountId: account.body.account.id })).text, /already attached/);
    // The project's git, answered at once: where its branch stands, and why its pull requests could not be read.
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: project.path });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "start"], { cwd: project.path });
    const git = await say(node, auth, directory, `what's the git status of ${project.name}?`, { intent: "git-status", projectId: project.id });
    assert.match(git.text, /is on the branch main, with no upstream branch\./);
    assert.match(git.text, /\nI could not read its pull requests: /);
    assert.deepEqual([git.actions, git.via], [[], "Organize · git"]);
    // A task in the project's Tasks list, and a quick note to start later.
    assert.match((await operate(await say(node, auth, directory, `add a task to ${project.name}'s tasks list to speed up the board`, { intent: "add-task", projectId: project.id, title: "Speed up the board", description: "It takes 3 s to draw", start: false }))).text, /^Added "Speed up the board" to the Tasks list of /);
    const tasks = (await api<{ tasks: Array<{ title: string; description: string; status: string }> }>(node, auth, "GET", `/projects/${project.id}/tasks`)).body.tasks;
    assert.deepEqual(tasks.filter((task) => task.title === "Speed up the board").map((task) => [task.description, task.status]), [["It takes 3 s to draw", "backlog"]]);
    assert.match((await operate(await say(node, auth, directory, `add a quick note in ${project.name} to check the invoices`, { intent: "add-note", projectId: project.id, title: "Check the invoices", content: "the November ones" }))).text, /^Saved the quick note "Check the invoices"/);
    const notes = (await api<{ notes: Array<{ title: string; content: string; status: string }> }>(node, auth, "GET", `/projects/${project.id}/quick-notes`)).body.notes;
    assert.deepEqual(notes.filter((entry) => entry.title === "Check the invoices").map((entry) => [entry.content, entry.status]), [["the November ones", "pending"]]);

    // Deleting it is a warning button, and it is gone from the project afterwards.
    const remove = await say(node, auth, directory, "delete the check the menu conversation", { intent: "delete-conversation", conversation: "conversation-titled:check the menu" });
    assert.match(remove.text, /Delete the conversation "check the menu" in .+\? Its whole history goes/);
    assert.equal(remove.actions[0].style, "warn");
    assert.match((await press(node, auth, remove)).text, /Deleted the conversation "check the menu"/);
    assert.equal((await sessionsOf()).some((session) => session.id === started.id), false);
  } catch (error) {
    throw withNodeOutput(error, child);
  } finally {
    if (child) await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});
