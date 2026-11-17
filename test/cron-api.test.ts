import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type DatabaseSync } from "node:sqlite";
import type { ChildProcess } from "node:child_process";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, pairTwinNodes } from "./dev-nodes.js";
import type { CronRun } from "../src/cron.js";
import type { Webhook } from "../src/webhooks.js";
import { openNodeDatabase } from "../src/node-database.js";

async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 30000;
  while (!await check()) { if (Date.now() > deadline) throw new Error("Cron state did not settle"); await new Promise(resolve => setTimeout(resolve, 100)); }
}
/** The nodes under test write node.db while the test reads and writes it too. */
function openNodeDb(directory: string): DatabaseSync {
  const db = openNodeDatabase(path.join(directory, "node.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}
function makeDue(directory: string, id: string): void {
  const db = openNodeDb(directory);
  try {
    db.prepare("UPDATE webhooks SET next_run = ? WHERE id = ?").run(Date.now(), id);
  } finally { db.close(); }
}
/** A scheduled automation as the list shows it. */
type Item = Webhook & { lastRun: CronRun | null; nextRun: number };
type Node = Parameters<typeof api>[0];
type Auth = Parameters<typeof api>[1];
/** Commands go to the machine named by `?nodeId=`; without it, to the machine asked. */
const owner = (nodeId?: string) => nodeId ? `?nodeId=${nodeId}` : "";
const projectTarget = (projectId: string) => ({ kind: "project" as const, projectId, engine: "claude" });
const conversationTarget = (projectId: string, sessionId: string, engine: string) => ({ kind: "conversation" as const, projectId, sessionId, engine });
const createAutomation = (node: Node, auth: Auth, input: object, nodeId?: string) => api<{ automation: Item }>(node, auth, "POST", `/automations${owner(nodeId)}`, input);
const updateAutomation = (node: Node, auth: Auth, id: string, input: object, nodeId?: string) => api<{ automation: Item }>(node, auth, "PUT", `/automations/${id}${owner(nodeId)}`, input);
const runAutomation = (node: Node, auth: Auth, id: string, nodeId?: string) => api<{ automation: Item }>(node, auth, "POST", `/automations/${id}/run${owner(nodeId)}`, {});
/** The scheduled automations a machine holds; an unreachable machine lists none. */
const listAutomations = async (node: Node, auth: Auth, nodeId?: string): Promise<Item[]> => {
  const listed = await api<{ automations: Item[] }>(node, auth, "GET", `/automations${owner(nodeId)}`);
  return listed.status === 200 ? listed.body.automations : [];
};
const deleteAutomation = async (node: Node, auth: Auth, id: string, nodeId?: string) =>
  (await fetch(`${node.url}/api/automations/${id}${owner(nodeId)}`, { method: "DELETE", headers: { Cookie: auth.cookie, "x-csrf-token": auth.csrfToken } })).status;

for (const pauseOnFailure of [false, true]) test(`scheduler restart ${pauseOnFailure ? "pauses" : "reschedules"} uncertain dispatch, skips offline occurrences, and never overlaps an active run`, { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cron-restart-"));
  const children: ChildProcess[] = [];
  try {
    const environment = await seedDevEnvironment(root, 1), node = environment.nodes[0];
    const log = path.join(root, "engine.log");
    const env = { JOINT_BOB_TEST_ENGINE_LOG: log, JOINT_BOB_TEST_ENGINE_HOLD_DIR: root };
    children.push(await startDevNode(environment, node, env));
    let auth = await signIn(environment, node);
    // Tests manually make tasks due; keep the natural hourly tick outside the test duration.
    const projectId = node.projects[0].id;
    const input = { trigger: "schedule", target: projectTarget(projectId), name: "Interrupted report", context: "Report", enabled: true, pauseOnFailure, schedule: { frequency: "hourly", hour: 9, minute: (new Date().getUTCMinutes() + 30) % 60, weekday: 1, timezone: "UTC" } };
    const created = await createAutomation(node, auth, input);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const readTask = async (id: string) => (await listAutomations(node, auth)).find(task => task.id === id)!;
    makeDue(node.dataDir, created.body.automation.id);
    await until(async () => (await readTask(created.body.automation.id)).lastRun?.status === "running");
    makeDue(node.dataDir, created.body.automation.id);
    await until(async () => (await readTask(created.body.automation.id)).nextRun > Date.now());
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [`claude:${node.nodeId}`], "an active task must not start a duplicate turn");
    const offline = await createAutomation(node, auth, input);
    assert.equal(offline.status, 201);
    await stopDevNode(children.pop()!);
    makeDue(node.dataDir, offline.body.automation.id);
    children.push(await startDevNode(environment, node, env));
    auth = await signIn(environment, node);
    await until(async () => (await readTask(created.body.automation.id)).lastRun?.status === "failed");
    const interrupted = await readTask(created.body.automation.id);
    assert.equal(interrupted.enabled, !pauseOnFailure, "only opted-in schedules pause after restart");
    assert.match(interrupted.lastRun!.error!, /outcome uncertain/);
    assert.match(interrupted.lastRun!.error!, pauseOnFailure ? /Task paused/ : /next scheduled time/);
    assert.ok(interrupted.nextRun > Date.now(), "restart must not immediately retry an uncertain run");
    const edited = await updateAutomation(node, auth, interrupted.id, { ...input, name: "Recovered report", enabled: false });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.automation.name, "Recovered report", "a recovered paused task must remain editable");
    await until(async () => (await readTask(offline.body.automation.id)).nextRun > Date.now());
    assert.equal((await readTask(offline.body.automation.id)).lastRun, null, "restart must skip even a just-missed offline occurrence");
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [`claude:${node.nodeId}`], "restart must not replay the uncertain turn");
    const resumed = await runAutomation(node, auth, interrupted.id);
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.automation.enabled, true, "running a recovered paused task must resume its schedule");
    assert.ok(resumed.body.automation.nextRun <= Date.now(), "running a recovered task should make it immediately due");
  } finally { await Promise.all(children.map(stopDevNode)); await rm(root, { recursive: true, force: true }); }
});

test("different schedules run concurrently in isolated conversations that join project history", { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cron-parallel-"));
  let child: ChildProcess | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1), node = environment.nodes[0];
    const log = path.join(root, "engine.log");
    child = await startDevNode(environment, node, { JOINT_BOB_TEST_ENGINE_LOG: log, JOINT_BOB_TEST_ENGINE_HOLD_DIR: root });
    const auth = await signIn(environment, node);
    const base = { projectId: node.projects[0].id, trigger: "schedule", target: projectTarget(node.projects[0].id), context: "Parallel report", enabled: true, schedule: { frequency: "hourly", hour: 9, minute: (new Date().getUTCMinutes() + 30) % 60, weekday: 1, timezone: "UTC" } };
    await api(node, auth, "GET", `/projects/${base.projectId}/sessions`); // Initialize review tracking before either run.
    const tasks: Item[] = [];
    for (const name of ["Parallel A", "Parallel B"]) {
      const { projectId: _projectId, ...input } = base;
      const created = await createAutomation(node, auth, { ...input, name, markForReview: name !== "Parallel A" });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      tasks.push(created.body.automation);
    }
    for (const task of tasks) makeDue(node.dataDir, task.id);
    const readTasks = () => listAutomations(node, auth);
    await until(async () => {
      const listed = await readTasks();
      return tasks.every(task => listed.find(candidate => candidate.id === task.id)?.lastRun?.status === "running");
    });
    await until(async () => {
      try {
        return (await readFile(log, "utf8")).trim().split("\n").length >= 2;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    });
    assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 2, "both isolated agents must start before either finishes");
    const history = await api<{ sessions: Array<{ id: string; cronTaskId?: string }> }>(node, auth, "GET", `/projects/${base.projectId}/sessions`);
    const target = history.body.sessions.find(session => session.cronTaskId === tasks[1].id)!;
    assert.ok(target, "the reviewable scheduled run is listed while running");
    const done = await api(node, auth, "PUT", `/projects/${base.projectId}/sessions/done`, { sessionId: target.id, engine: "claude", done: true });
    assert.equal(done.status, 200);
    type Snapshot = { projects: Array<{ projectId: string; sessions: Array<{ id: string; cronTaskId?: string; doneAt?: string }> }> };
    const running = await api<Snapshot>(node, auth, "GET", "/running");
    assert.equal(running.status, 200);
    const runningTarget = running.body.projects.find(project => project.projectId === base.projectId)!.sessions.find(session => session.id === target.id)!;
    assert.equal(runningTarget.cronTaskId, tasks[1].id, "running snapshots retain scheduled provenance for project badge visibility");
    assert.ok(runningTarget.doneAt, "running snapshots retain the done mark for project badge visibility");
    await writeFile(path.join(root, "claude.release"), "");
    await until(async () => {
      const listed = await readTasks();
      return tasks.every(task => listed.find(candidate => candidate.id === task.id)?.lastRun?.status === "succeeded");
    });
    const sessions = await api<{ sessions: Array<{ cronTaskId?: string; reviewState?: string; silentReviewUntil?: string }> }>(node, auth, "GET", `/projects/${base.projectId}/sessions`);
    for (const task of tasks) assert.ok(sessions.body.sessions.some(session => session.cronTaskId === task.id), `${task.name} result missing from project history`);
    assert.equal(sessions.body.sessions.find(session => session.cronTaskId === tasks[0].id)?.reviewState, "reviewed", `silent run should not enter review: ${JSON.stringify(sessions.body.sessions.find(session => session.cronTaskId === tasks[0].id))}`);
    assert.ok(sessions.body.sessions.find(session => session.cronTaskId === tasks[0].id)?.silentReviewUntil, "silent boundary should persist on conversation");
    assert.equal(sessions.body.sessions.find(session => session.cronTaskId === tasks[1].id)?.reviewState, "needs_review", "ordinary run still needs review");
    const pending = await api<Snapshot>(node, auth, "GET", "/reviews/pending");
    assert.equal(pending.status, 200);
    const pendingTarget = pending.body.projects.find(project => project.projectId === base.projectId)!.sessions.find(session => session.id === target.id)!;
    assert.equal(pendingTarget.cronTaskId, tasks[1].id, "review snapshots retain scheduled provenance for project badge visibility");
    assert.equal(pendingTarget.doneAt, runningTarget.doneAt, "review snapshots retain the done mark for project badge visibility");
  } finally {
    if (child) await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});

test("cron API routes to execution owner, persists, runs fresh project conversations and appends through transferred ownership", { timeout: 180000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cron-cluster-"));
  const children: ChildProcess[] = [];
  try {
    const environment = await seedDevEnvironment(root, 2);
    const [a, b] = environment.nodes;
    const log = path.join(root, "engine.log");
    for (const node of [a, b]) children.push(await startDevNode(environment, node, { JOINT_BOB_TEST_ENGINE_LOG: log }));
    await pairTwinNodes(environment);
    const auth = await signIn(environment, a);
    const projectId = a.projects[0].id;
    const input = { trigger: "schedule", target: projectTarget(projectId), name: "Scheduled report", context: "Give a report", enabled: true, markForReview: false, schedule: { frequency: "hourly", hour: 9, minute: (new Date().getUTCMinutes() + 30) % 60, weekday: 1, timezone: "UTC" } };
    const authBInitial = await signIn(environment, b);
    const hostModels = await api<{ models: unknown[] }>(a, auth, "GET", `/automations/options${owner(b.nodeId)}`);
    const directModels = await api<{ models: unknown[] }>(b, authBInitial, "GET", "/automations/options");
    assert.equal(hostModels.status, 200, JSON.stringify(hostModels.body));
    assert.ok(hostModels.body.models.length > 0);
    const withoutTimestamps = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => key === "capturedAt" ? undefined : item));
    assert.deepEqual(withoutTimestamps(hostModels.body), withoutTimestamps(directModels.body), "scheduled model catalog must come from the execution host");
    const listSessions = async (node: typeof a, session: typeof auth) => (await api<{ sessions: Array<{ id: string; harnessId: string; cronTaskId?: string; silentReviewUntil?: string; reviewState?: string }> }>(node, session, "GET", `/projects/${projectId}/sessions`)).body.sessions;
    const unscheduled = (await listSessions(b, authBInitial)).filter(session => session.harnessId === "pi").slice(0, 2);
    assert.equal(unscheduled.length, 2);
    assert.ok(unscheduled.every(session => session.cronTaskId === undefined));
    const pausedInput = { ...input, target: conversationTarget(projectId, unscheduled[0].id, "pi"), enabled: false };
    const pausedCreated = await createAutomation(a, auth, pausedInput, b.nodeId);
    assert.equal(pausedCreated.status, 201, JSON.stringify(pausedCreated.body));
    assert.equal(pausedCreated.body.automation.lastRun, null);
    assert.equal(pausedCreated.body.automation.ownerNodeId, b.nodeId);
    assert.equal((await listSessions(b, authBInitial)).find(session => session.id === unscheduled[0].id)!.cronTaskId, pausedCreated.body.automation.id, "paused schedules classify conversations before their first run");
    await until(async () => (await listSessions(a, auth)).find(session => session.id === unscheduled[0].id)?.cronTaskId === pausedCreated.body.automation.id);
    const retargeted = await updateAutomation(a, auth, pausedCreated.body.automation.id, { ...pausedInput, target: conversationTarget(projectId, unscheduled[1].id, "pi") }, b.nodeId);
    assert.equal(retargeted.status, 200, JSON.stringify(retargeted.body));
    assert.equal((await listSessions(b, authBInitial)).find(session => session.id === unscheduled[1].id)!.cronTaskId, pausedCreated.body.automation.id, "changing target classifies the new conversation");
    assert.equal(await deleteAutomation(a, auth, pausedCreated.body.automation.id, b.nodeId), 204);
    const created = await createAutomation(a, auth, input, b.nodeId);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.automation.id;
    const dbA = openNodeDb(a.dataDir);
    assert.equal(dbA.prepare("SELECT count(*) AS n FROM webhooks WHERE trigger_kind = 'schedule'").get()!.n, 0, "viewing node must not store a dispatchable copy"); dbA.close();
    const readTask = async () => {
      const task = (await listAutomations(a, auth, b.nodeId)).find(task => task.id === id)!;
      if (task?.lastRun?.status === "failed") throw new Error(JSON.stringify(task.lastRun));
      return task;
    };
    makeDue(b.dataDir, id);
    await until(async () => (await readTask()).lastRun?.status === "succeeded");
    const first = (await readTask()).lastRun!.sessionId;
    makeDue(b.dataDir, id);
    await until(async () => { const run = (await readTask()).lastRun; return run?.status === "succeeded" && run.sessionId !== first; });
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [`claude:${b.nodeId}`, `claude:${b.nodeId}`]);
    const sessions = await api<{ sessions: Array<{ id: string; cronTaskId?: string }> }>(b, await signIn(environment, b), "GET", `/projects/${projectId}/sessions`);
    assert.equal(sessions.body.sessions.filter(session => session.cronTaskId === id).length, 2);
    await until(async () => (await api<{ sessions: Array<{ cronTaskId?: string }> }>(a, auth, "GET", `/projects/${projectId}/sessions`)).body.sessions.filter(session => session.cronTaskId === id).length === 2);
    await until(async () => (await listSessions(a, auth)).filter(session => session.cronTaskId === id && session.silentReviewUntil && session.reviewState === "reviewed").length === 2);
    // Seeded transcripts exist on both nodes, so takeover exercises the real
    // ownership fence rather than inventing an unsynchronized draft.
    const existing = (await api<{ sessions: Array<{ id: string; path: string; harnessId: string }> }>(a, auth, "GET", `/projects/${projectId}/sessions`)).body.sessions.find(session => session.harnessId === "claude" && !sessions.body.sessions.some(candidate => candidate.id === session.id && candidate.cronTaskId))!;
    // The automation is saved while node B still owns the conversation: saving one for a conversation
    // that another machine already owns is refused ("Choose the machine that owns this conversation").
    const conversation = await createAutomation(a, auth, { ...input, target: conversationTarget(projectId, existing.id, "claude"), runInWorktree: false }, b.nodeId);
    assert.equal(conversation.status, 201, JSON.stringify(conversation.body));
    const owned = await api(a, auth, "POST", `/projects/${projectId}/sessions/take-ownership`, { sessionId: existing.id, sessionPath: existing.path, peerId: a.nodeId });
    assert.equal(owned.status, 200, JSON.stringify(owned.body));
    const transcriptPath = existing.path.replace(/^claude:/, "");
    const originalTranscript = await readFile(transcriptPath, "utf8");
    const ownerDb = openNodeDb(a.dataDir);
    const busy = { engine: "claude", sessionId: existing.id, summary: { runId: "cron-busy-child", status: "running", tasks: [] } };
    ownerDb.prepare("INSERT INTO conversation_work VALUES (?, ?, ?, ?)").run("claude", existing.id, busy.summary.runId, JSON.stringify(busy));
    ownerDb.close();
    makeDue(b.dataDir, conversation.body.automation.id);
    const executionDb = openNodeDb(b.dataDir);
    try {
      await until(async () => Boolean(executionDb.prepare("SELECT 1 FROM cron_runs WHERE task_id = ?").get(conversation.body.automation.id)));
      await new Promise(resolve => setTimeout(resolve, 1200));
      assert.equal(executionDb.prepare("SELECT status FROM cron_runs WHERE task_id = ?").get(conversation.body.automation.id)!.status, "waiting", "busy remote conversation must remain waiting");
      assert.equal(executionDb.prepare("SELECT owner_node_id FROM conversation_ownership WHERE session_id = ?").get(existing.id)!.owner_node_id, a.nodeId, "waiting must not take ownership");
      assert.equal(await readFile(transcriptPath, "utf8"), originalTranscript, "waiting must not append a prompt");
      const releaseDb = openNodeDb(a.dataDir);
      releaseDb.prepare("DELETE FROM conversation_work WHERE engine = ? AND session_id = ? AND run_id = ?").run("claude", existing.id, busy.summary.runId);
      releaseDb.close();
    } finally { executionDb.close(); }
    await until(async () => {
      const run = (await listAutomations(a, auth, b.nodeId)).find(task => task.id === conversation.body.automation.id)?.lastRun;
      if (run?.status === "failed") throw new Error(JSON.stringify(run));
      return run?.status === "succeeded";
    });
    const appended = await readFile(transcriptPath, "utf8");
    assert.ok(appended.startsWith(originalTranscript), "scheduled continuation preserves original history");
    const additions = appended.slice(originalTranscript.length).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(additions.filter(record => record.type === "user" && record.message.content.includes(input.context)).length, 1, "idle transition appends exactly one scheduled prompt");
    const dbB = openNodeDb(b.dataDir);
    assert.equal(dbB.prepare("SELECT owner_node_id FROM conversation_ownership WHERE session_id = ?").get(existing.id)!.owner_node_id, b.nodeId);
    dbB.close();
    const previousRunId = (await listAutomations(b, authBInitial)).find(task => task.id === conversation.body.automation.id)!.lastRun!.id;
    const peerDb = openNodeDb(b.dataDir);
    assert.ok(Number(peerDb.prepare("UPDATE cluster_v2_peer_endpoints SET url = 'http://127.0.0.1:1' WHERE node_id = ?").run(a.nodeId).changes) > 0, "node B must know node A's endpoint to make it unreachable");
    peerDb.close();
    makeDue(b.dataDir, conversation.body.automation.id);
    await until(async () => {
      const run = (await listAutomations(b, authBInitial)).find(task => task.id === conversation.body.automation.id)?.lastRun;
      if (run?.status === "failed") throw new Error(JSON.stringify(run));
      return run?.status === "succeeded" && run.id !== previousRunId;
    });
    const restorePeerDb = openNodeDb(b.dataDir);
    restorePeerDb.prepare("UPDATE cluster_v2_peer_endpoints SET url = ? WHERE node_id = ?").run(new URL(a.url).origin, a.nodeId);
    restorePeerDb.close();
    const paused = await updateAutomation(a, auth, id, { ...input, enabled: false }, b.nodeId);
    assert.equal(paused.body.automation.enabled, false);
    await stopDevNode(children.pop()!);
    children.push(await startDevNode(environment, b, { JOINT_BOB_TEST_ENGINE_LOG: log }));
    // Until node B answers again, asking it through node A fails and lists nothing.
    await until(async () => (await readTask()).enabled === false);
    assert.equal((await readTask()).lastRun?.status, "succeeded");
    const lockDb = openNodeDb(b.dataDir);
    lockDb.prepare("INSERT OR REPLACE INTO project_locks VALUES (?, ?, ?, ?, ?, ?)").run(projectId, a.nodeId, a.name, new Date().toISOString(), new Date().toISOString(), a.nodeId);
    lockDb.close();
    const authB = await signIn(environment, b);
    assert.equal((await api<{ project: { lock: { nodeId: string } } }>(b, authB, "GET", `/projects/${projectId}`)).body.project.lock.nodeId, a.nodeId, "execution node must see the foreign project lock");
    const locked = await createAutomation(a, auth, input, b.nodeId);
    assert.equal(locked.status, 201);
    assert.equal(locked.body.automation.pauseOnFailure, false, "new schedules retry after failure by default");
    makeDue(b.dataDir, locked.body.automation.id);
    let failed: Item | undefined;
    await until(async () => {
      failed = (await listAutomations(a, auth, b.nodeId)).find(task => task.id === locked.body.automation.id);
      return failed?.lastRun?.finishedAt !== null && failed?.lastRun?.finishedAt !== undefined;
    });
    assert.equal(failed!.lastRun!.status, "failed");
    assert.match(failed!.lastRun!.error!, /Project is locked/);
    assert.equal(failed!.enabled, true, "default schedules must retry at the next occurrence");
    const pausing = await createAutomation(a, auth, { ...input, pauseOnFailure: true }, b.nodeId);
    assert.equal(pausing.status, 201);
    makeDue(b.dataDir, pausing.body.automation.id);
    let pausedAfterFailure: Item | undefined;
    await until(async () => {
      pausedAfterFailure = (await listAutomations(a, auth, b.nodeId)).find(task => task.id === pausing.body.automation.id);
      return pausedAfterFailure?.lastRun?.finishedAt !== null && pausedAfterFailure?.lastRun?.finishedAt !== undefined;
    });
    assert.equal(pausedAfterFailure!.lastRun!.status, "failed");
    assert.equal(pausedAfterFailure!.enabled, false, "opted-in schedules must pause after failure");
    assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 4, "a locked project must not start an agent");
    await api(b, authB, "PUT", `/projects/${projectId}/lock`, { locked: false });
    assert.equal(await deleteAutomation(a, auth, locked.body.automation.id, b.nodeId), 204);
    assert.equal(await deleteAutomation(a, auth, pausing.body.automation.id, b.nodeId), 204);
    const moved = await api<{ automation: Item }>(a, auth, "POST", `/automations/${id}/transfer${owner(b.nodeId)}`, { nodeId: a.nodeId });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.automation.id, id);
    assert.equal(moved.body.automation.ownerNodeId, a.nodeId);
    assert.equal(moved.body.automation.enabled, false);
    assert.equal(moved.body.automation.lastRun?.status, "succeeded");
    assert.equal((await listAutomations(a, auth)).find(task => task.id === id)?.ownerNodeId, a.nodeId);
    assert.equal((await listAutomations(b, authB)).find(task => task.id === id), undefined, "the old owner keeps no copy");
    assert.equal(await deleteAutomation(a, auth, id), 204);
    assert.equal((await listAutomations(a, auth)).find(task => task.id === id), undefined);
  } finally { await Promise.all(children.map(stopDevNode)); await rm(root, { recursive: true, force: true }); }
});
