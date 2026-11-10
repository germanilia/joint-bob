// Two real twin nodes, each with its own HOME, hand a ticket across only once
// neither side is still taking the shared project's files over.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import type { TaskRecord } from "../src/types.js";
import { api, freePort, pairTwinNodes, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";

interface TwinNode extends SeededNode { home: string }
interface TaskReadyPayload {
  type: string;
  engine: string;
  sessionId: string;
  sessionFile: string | null;
  messages: Array<{ text: string }>;
  ownership: unknown;
  executionNodeId: string;
  readOnly: boolean;
}
interface Job { root: string; key: string; claudeExecutable: string; project?: { name: string; path: string }; mirror?: { project: SeededNode["projects"][number]; path: string }; events?: unknown[] }

const username = "admin";
const password = "ticket-handoff-password";

function runScript(dataDir: string, home: string, code: string, args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, "--", ...args], {
      cwd: process.cwd(), env: { ...process.env, HOME: home, JOINT_BOB_DATA_DIR: dataDir }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => status === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || `child exited ${status}`)));
  });
}

/** Seeds one stopped node: its own HOME, an administrator, its identity, one project,
    and any locally originated replication events (which it replicates to its twin once running). */
async function seedNode(job: Job): Promise<TwinNode> {
  const port = await freePort();
  const home = path.join(job.root, `${job.key}-home`);
  const node = { key: job.key, name: `Node ${job.key}`, port, url: `http://127.0.0.1:${port}`, dataDir: path.join(job.root, `${job.key}-data`), cookieName: `mb_session_handoff_${job.key}` };
  await mkdir(home, { recursive: true });
  const output = await runScript(node.dataDir, home, `
    const job = JSON.parse(process.argv[1]);
    const { updateSettings } = await import('./src/settings.ts');
    const { createAdministrator } = await import('./src/auth.ts');
    const { addProject, importProject } = await import('./src/store.ts');
    const { updateClusterNode } = await import('./src/cluster.ts');
    const { receiveReplicationBatch } = await import('./src/replication.ts');
    updateSettings({ pi: { executable: '', configPath: '', sessionPath: '' }, claude: { executable: job.claudeExecutable, configPath: '', sessionPath: '' }, projects: { homePath: job.home + '/JointBob' } });
    createAdministrator(job.username, job.password, false);
    const cluster = await updateClusterNode(job.name, job.url);
    const project = job.mirror ? await importProject(job.mirror.project, job.mirror.path) : await addProject(job.project.name, job.project.path, { synced: true });
    const events = (job.events ?? []).map((event) => JSON.parse(JSON.stringify(event).replaceAll('__NODE__', cluster.id).replaceAll('__PROJECT__', project.id)));
    if (events.length) await receiveReplicationBatch({ events });
    console.log(JSON.stringify({ nodeId: cluster.id, project }));
  `, [JSON.stringify({ ...job, ...node, home, username, password })]);
  const parsed = JSON.parse(output) as { nodeId: string; project: SeededNode["projects"][number] };
  return { ...node, home, nodeId: parsed.nodeId, projects: [parsed.project] };
}

function nodeEnvironment(root: string, nodes: TwinNode[]): DevEnvironment {
  return { root, home: nodes[0].home, username, password, nodes };
}

// Each node runs with its own HOME, so its conversation roots differ from its twin's.
async function startNode(node: TwinNode, extraEnv: Record<string, string> = {}): Promise<ChildProcess> {
  return startDevNode({ root: path.dirname(node.home), home: node.home, username, password, nodes: [node] }, node, extraEnv);
}

function headers(session: SignedIn): Record<string, string> {
  return { Cookie: session.cookie, "x-csrf-token": session.csrfToken, "Content-Type": "application/json" };
}

async function waitForTask(node: TwinNode, auth: SignedIn, projectId: string, taskId: string, predicate: (task: any) => boolean): Promise<any> {
  let last: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const body = await (await fetch(`${node.url}/api/projects/${projectId}/tasks`, { headers: headers(auth) })).json() as { tasks: any[] };
    const task = body.tasks.find((item) => item.id === taskId);
    last = task;
    if (task && predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Task ${taskId} on node ${node.key} never matched: ${JSON.stringify(last)}`);
}

async function waitUntil(what: string, check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function openTaskSocket(node: TwinNode, auth: SignedIn, projectId: string, taskId: string, sessionPath: string, sessionId?: string): Promise<{ socket: WebSocket; ready: TaskReadyPayload }> {
  const url = new URL("/ws", node.url);
  url.protocol = "ws:";
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("taskId", taskId);
  if (sessionId) url.searchParams.set("sessionId", sessionId);
  url.searchParams.set("sessionPath", sessionPath);
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Origin: node.url, Cookie: auth.cookie } });
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Task WebSocket did not send ready"));
    }, 10_000);
    const fail = (error: Error) => { clearTimeout(timeout); reject(error); };
    socket.once("error", fail);
    socket.once("close", (code, reason) => fail(new Error(`Task WebSocket closed before ready (${code}): ${reason}`)));
    socket.on("message", (raw) => {
      const payload = JSON.parse(raw.toString()) as TaskReadyPayload;
      if (payload.type !== "ready") return;
      clearTimeout(timeout);
      socket.off("error", fail);
      resolve({ socket, ready: payload });
    });
  });
}

function nextSocketPayload(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Task WebSocket did not send ${type}`)), 10_000);
    const onMessage = (raw: WebSocket.RawData): void => {
      const payload = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (payload.type !== type) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(payload);
    };
    socket.on("message", onMessage);
  });
}

function taskEvent(task: Record<string, unknown>): Record<string, unknown> {
  return { id: randomUUID(), originNodeId: "__NODE__", entityType: "task", entityKey: `__PROJECT__:${task.id}`, operation: "upsert", payload: { projectId: "__PROJECT__", task, originNodeId: "__NODE__" }, createdAt: task.updatedAt };
}

interface EligibilityEntry { node: { id: string }; eligible: boolean; waitingForSync: boolean; syncStatuses: Array<{ label: string; state: string; remainingFiles: number; remainingBytes: number; message?: string }> }

// The built-in engine runs on both nodes and the test sets each node's phase for the project itself
// (POST /api/file-sync/test-phase): any phase before "builtin" means the node is still taking the files over.
test("a ticket is handed off only once neither node is still taking the project's files over", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-ticket-handoff-gate-"));
  const children: ChildProcess[] = [];
  try {
    const seededTask = { id: "synced-task", title: "Synced", description: "No Git", status: "backlog", engine: "pi", planMode: false, reviewMode: false, phaseConfig: {}, sessionPath: null, worktreePath: null, worktreeBranch: null, mergedAt: null, currentNodeId: "__NODE__", leaseOwnerNodeId: null, leaseExpiresAt: null, executionState: "idle", handoffContext: null, originNodeId: "__NODE__", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    const source = await seedNode({ root, key: "source", claudeExecutable: "", project: { name: "shared", path: path.join(root, "source-project") }, events: [taskEvent(seededTask)] });
    const project = source.projects[0];
    const destination = await seedNode({ root, key: "destination", claudeExecutable: "", mirror: { project, path: path.join(root, "destination-home", "project") } });
    const [sourceId, destinationId] = [source.nodeId, destination.nodeId];
    const task = { ...seededTask, currentNodeId: sourceId, originNodeId: sourceId };
    const engine = async () => ({
      JOINT_BOB_FILE_SYNC: "1", JOINT_BOB_FILE_SYNC_SETTLE_MS: "500", JOINT_BOB_FILE_SYNC_PORT: String(await freePort()),
      JOINT_BOB_FILE_SYNC_LISTEN: "127.0.0.1", JOINT_BOB_FILE_SYNC_TEST_PHASES: "1",
    });
    children.push(await startNode(source, await engine()), await startNode(destination, await engine()));
    await pairTwinNodes(nodeEnvironment(root, [source, destination]));
    const [sourceAuth, destinationAuth] = await Promise.all([signIn(nodeEnvironment(root, [source]), source), signIn(nodeEnvironment(root, [destination]), destination)]);
    await Promise.all([waitForTask(source, sourceAuth, project.id, task.id, () => true), waitForTask(destination, destinationAuth, project.id, task.id, () => true)]);
    const setPhase = async (node: TwinNode, auth: SignedIn, phase: "bootstrapping" | "builtin"): Promise<void> => {
      const answer = await api(node, auth, "POST", "/file-sync/test-phase", { projectId: project.id, phase });
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
    };
    const eligibility = async (node: TwinNode, auth: SignedIn): Promise<{ source: EligibilityEntry; nodes: EligibilityEntry[] }> => {
      const response = await fetch(`${node.url}/api/projects/${project.id}/tasks/${task.id}/eligibility`, { headers: headers(auth) });
      assert.equal(response.status, 200);
      return await response.json() as { source: EligibilityEntry; nodes: EligibilityEntry[] };
    };
    const handoff = () => fetch(`${source.url}/api/projects/${project.id}/tasks/${task.id}/handoff`, { method: "POST", headers: headers(sourceAuth), body: JSON.stringify({ peerId: destinationId }) });
    const moving = { label: "shared", state: "syncing", remainingFiles: 0, remainingBytes: 0, message: "Checking both machines' files" };

    // The destination is still taking the project over: it is not eligible, and the ticket stays put.
    await setPhase(source, sourceAuth, "builtin");
    await setPhase(destination, destinationAuth, "bootstrapping");
    const destinationEntry = (await eligibility(source, sourceAuth)).nodes.find((entry) => entry.node.id === destinationId);
    assert.ok(destinationEntry);
    assert.equal(destinationEntry.eligible, false);
    assert.equal(destinationEntry.waitingForSync, true);
    assert.deepEqual(destinationEntry.syncStatuses.find((status) => status.state === "syncing"), moving);
    assert.equal((await handoff()).status, 409);
    assert.equal((await waitForTask(source, sourceAuth, project.id, task.id, (candidate) => candidate.executionState === "idle")).currentNodeId, sourceId);

    // The source is: both nodes report it as the one being waited for.
    await setPhase(destination, destinationAuth, "builtin");
    await setPhase(source, sourceAuth, "bootstrapping");
    const sourceEntry = (await eligibility(source, sourceAuth)).source;
    assert.equal(sourceEntry.node.id, sourceId);
    assert.equal(sourceEntry.eligible, false);
    assert.equal(sourceEntry.waitingForSync, true);
    assert.deepEqual(sourceEntry.syncStatuses.find((status) => status.state === "syncing"), moving);
    const remoteSourceEntry = (await eligibility(destination, destinationAuth)).source;
    assert.equal(remoteSourceEntry.node.id, sourceId);
    assert.equal(remoteSourceEntry.waitingForSync, true);
    assert.equal(remoteSourceEntry.syncStatuses.find((status) => status.state === "syncing")?.state, "syncing");
    assert.equal((await waitForTask(destination, destinationAuth, project.id, task.id, (candidate) => candidate.executionState === "idle")).currentNodeId, sourceId);

    // Both nodes are on built-in sync: the handoff goes through once their copies agree.
    await setPhase(source, sourceAuth, "builtin");
    let completed = await handoff();
    for (const deadline = Date.now() + 60_000; completed.status !== 200 && Date.now() < deadline; completed = await handoff()) await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(completed.status, 200, `${await completed.text()} ${JSON.stringify(await eligibility(source, sourceAuth))}`);
    await Promise.all([
      waitForTask(source, sourceAuth, project.id, task.id, (candidate) => candidate.currentNodeId === destinationId && candidate.executionState === "idle"),
      waitForTask(destination, destinationAuth, project.id, task.id, (candidate) => candidate.currentNodeId === destinationId && candidate.executionState === "idle"),
    ]);
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});

test("task handoff preserves an undiscovered Claude ticket transcript and moves its ownership", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-ticket-handoff-"));
  const children: ChildProcess[] = [];
  try {
    const sessionId = randomUUID();
    const sourceSessionFile = path.join(root, "source-home", ".claude", "projects", "-legacy-ticket", `${sessionId}.jsonl`);
    const destinationSessionFile = path.join(root, "destination-home", ".claude", "projects", "-legacy-ticket", `${sessionId}.jsonl`);
    const transcript = `${JSON.stringify({ type: "user", sessionId, cwd: "/legacy/ticket", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "preserved ticket message" } })}\n`;
    await Promise.all([
      mkdir(path.dirname(sourceSessionFile), { recursive: true }).then(() => writeFile(sourceSessionFile, transcript)),
      mkdir(path.dirname(destinationSessionFile), { recursive: true }).then(() => writeFile(destinationSessionFile, transcript)),
    ]);
    const now = "2026-01-01T00:00:00.000Z";
    const seededTask = {
      id: "legacy-ticket-task", title: "Legacy ticket", description: "Preserve transcript", attachments: [], status: "done", engine: "claude", planMode: false, reviewMode: false, phaseConfig: {}, sessionPath: `claude:${sourceSessionFile}`, worktreePath: null, worktreeBranch: null, mergedAt: null,
      mergeState: "none", conflictCount: 0, mergeWarning: null, mergeTx: null, mergeDigests: null, runKind: null,
      currentNodeId: "__NODE__", leaseOwnerNodeId: null, leaseExpiresAt: null, executionState: "idle", handoffContext: null, originNodeId: "__NODE__", createdAt: now, updatedAt: now,
    };
    const record = { projectId: "__PROJECT__", engine: "claude", sessionId, createdAt: now, updatedAt: now, originNodeId: "__NODE__", taskId: seededTask.id };
    // Claims are local-first: node A records its own ownership, which replicates to its twin.
    const ownershipRecord = { engine: "claude", sessionId, ownerNodeId: "__NODE__", epoch: 1, status: "owned", transferToNodeId: null };
    const events = [
      taskEvent(seededTask),
      { id: randomUUID(), originNodeId: "__NODE__", entityType: "conversation.record", entityKey: `__PROJECT__:claude:${sessionId}`, operation: "upsert", payload: { projectId: "__PROJECT__", engine: "claude", sessionId, record, updatedAt: now, originNodeId: "__NODE__" }, createdAt: now },
      { id: randomUUID(), originNodeId: "__NODE__", entityType: "conversation.ownership", entityKey: `claude:${sessionId}`, operation: "upsert", payload: { ...ownershipRecord, originNodeId: "__NODE__" }, createdAt: now },
    ];
    const source = await seedNode({ root, key: "source", claudeExecutable: "true", project: { name: "shared", path: path.join(root, "source-project") }, events });
    const project = source.projects[0];
    const destination = await seedNode({ root, key: "destination", claudeExecutable: "true", mirror: { project, path: path.join(root, "destination-home", "project") } });
    const [sourceId, destinationId] = [source.nodeId, destination.nodeId];
    const environment = nodeEnvironment(root, [source, destination]);
    const task = { ...seededTask, currentNodeId: sourceId, originNodeId: sourceId } as TaskRecord;
    children.push(await startNode(source), await startNode(destination));
    await pairTwinNodes(environment);
    const [sourceAuth, destinationAuth] = await Promise.all([signIn(nodeEnvironment(root, [source]), source), signIn(nodeEnvironment(root, [destination]), destination)]);
    await Promise.all([waitForTask(source, sourceAuth, project.id, task.id, () => true), waitForTask(destination, destinationAuth, project.id, task.id, () => true)]);
    const ownershipTarget = `/api/cluster/v2/runtime/sessions/ownership?engine=claude&sessionId=${sessionId}`;
    await waitUntil("replicated ownership", async () => ((await (await signedNodeRequest(environment, source, destination, "GET", ownershipTarget)).json()) as { ownership: { ownerNodeId: string } | null }).ownership?.ownerNodeId === sourceId);

    const handoff = await fetch(`${source.url}/api/projects/${project.id}/tasks/${task.id}/handoff`, { method: "POST", headers: headers(sourceAuth), body: JSON.stringify({ peerId: destinationId }) });
    assert.equal(handoff.status, 200);
    const handedOff = await handoff.json() as { task: TaskRecord };
    assert.equal(handedOff.task.sessionPath, `claude:${destinationSessionFile}`);
    await Promise.all([
      waitForTask(source, sourceAuth, project.id, task.id, (candidate) => candidate.currentNodeId === destinationId && candidate.executionState === "idle"),
      waitForTask(destination, destinationAuth, project.id, task.id, (candidate) => candidate.currentNodeId === destinationId && candidate.executionState === "idle"),
    ]);

    const sourceReplica = await waitForTask(source, sourceAuth, project.id, task.id, (candidate) => candidate.currentNodeId === destinationId);
    assert.equal(sourceReplica.sessionPath, `claude:${sourceSessionFile}`, "Previous owner retains the synchronized conversation pointer");

    // Board cards only carry their node-local task path, not the session id.
    // The owner must recover the stable identity after the source proxies this path.
    const opened = await openTaskSocket(source, sourceAuth, project.id, task.id, sourceReplica.sessionPath!);
    const { ready } = opened;
    assert.equal(ready.engine, "claude");
    assert.equal(ready.sessionId, sessionId);
    assert.equal(ready.sessionFile, `claude:${destinationSessionFile}`);
    assert.equal(ready.messages.some((message: { text: string }) => message.text === "preserved ticket message"), true);
    assert.equal(ready.ownership, null);
    assert.equal(ready.executionNodeId, destinationId);
    assert.equal(ready.readOnly, true);

    const renamed = await fetch(`${destination.url}/api/projects/${project.id}/sessions/title`, {
      method: "PUT",
      headers: headers(destinationAuth),
      body: JSON.stringify({ engine: "claude", sessionId, title: "Mutated title" }),
    });
    assert.equal(renamed.status, 409, "Done conversation title must be immutable");
    const removed = await fetch(`${source.url}/api/projects/${project.id}/sessions?engine=claude&sessionId=${sessionId}&taskId=${task.id}`, {
      method: "DELETE",
      headers: headers(sourceAuth),
    });
    assert.equal(removed.status, 409, "Done conversation transcript must not be removable");

    const rejected = nextSocketPayload(opened.socket, "error");
    opened.socket.send(JSON.stringify({ type: "prompt", message: "mutate a finished ticket" }));
    assert.deepEqual(await rejected, { type: "error", error: "Done ticket conversations are read-only" });
    opened.socket.close();
    const ownership = await (await signedNodeRequest(environment, source, destination, "GET", ownershipTarget)).json() as { ownership: { ownerNodeId: string; status: string } };
    assert.equal(ownership.ownership.ownerNodeId, destinationId);
    assert.equal(ownership.ownership.status, "owned");
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
