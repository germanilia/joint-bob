// The retention sweep in both of its reaches. With `full` off it deletes what it always did: only
// what the project's list shows. With `full` on it reaches every conversation on record, with the
// exemptions. The dry run reports what a sweep then deletes. Background runs go after seven days.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { RetentionSwitches } from "../src/server/conversation-retention.js";
import { createSourceTables, fillRow } from "./source-schema.js";

const DAY = 86_400_000, HOUR = 3_600_000;
const exists = (file: string) => access(file).then(() => true, () => false);
const off: RetentionSwitches = { full: false, includeUnrecorded: false, includeScheduled: false, includeTickets: false, leftovers: false, backgroundRuns: false };
const full: RetentionSwitches = { ...off, full: true };

async function build() {
  const { resolveDataDirectory } = await import("../src/data-directory.js");
  const root = resolveDataDirectory();
  const sessionRoot = path.join(root, "claude-sessions"), piRoot = path.join(root, "pi-sessions");
  const settings = await import("../src/settings.js");
  settings.updateSettings({
    pi: { executable: "pi", configPath: path.join(root, "pi-config"), sessionPath: piRoot },
    claude: { executable: "claude", configPath: path.join(root, "claude-config"), sessionPath: sessionRoot },
  });
  assert.equal(settings.getSettings().conversationRetentionDays, 40);
  const { addProject } = await import("../src/store.js");
  const { claudeProjectDir } = await import("../src/session-paths.js");
  const { getClusterNode } = await import("../src/cluster.js");
  const { ensureConversationRecord, listConversationRecords, deletedConversationKeys } = await import("../src/conversation-records.js");
  const { clearHarnessSessionCache } = await import("../src/harnesses.js");
  const retention = await import("../src/server/conversation-retention.js");
  const local = await getClusterNode();
  // The fixture writes single rows into tables that refer to others (a topic to its assistant), so this connection does not check references.
  const db = new DatabaseSync(path.join(root, "node.db"), { enableForeignKeyConstraints: false });
  db.exec("PRAGMA busy_timeout = 5000");
  // Another folder under the same harness folder that no project lists.
  const elsewhere = claudeProjectDir(path.join(root, "no-project-here"), sessionRoot);
  await mkdir(elsewhere, { recursive: true });

  const project = async (name: string) => {
    const projectPath = path.join(root, name);
    await mkdir(projectPath, { recursive: true });
    const record = await addProject(name, projectPath, { writeInstructions: false });
    const directory = claudeProjectDir(projectPath, sessionRoot);
    await mkdir(directory, { recursive: true });
    /** A Claude transcript last written `age` ago, on record unless told otherwise. */
    const transcript = async (age: number, options: { id?: string; record?: boolean; origin?: string; taskId?: string; directory?: string } = {}): Promise<{ id: string; file: string }> => {
      const id = options.id ?? randomUUID(), file = path.join(options.directory ?? directory, `${id}.jsonl`), at = new Date(Date.now() - age);
      await writeFile(file, JSON.stringify({ type: "user", uuid: randomUUID(), sessionId: id, cwd: projectPath, timestamp: at.toISOString(), message: { role: "user", content: `Written ${Math.round(age / DAY)} days ago` } }) + "\n");
      await utimes(file, at, at);
      if (options.record !== false) await ensureConversationRecord(record.id, "claude", id, options.origin ?? local.id, options.taskId);
      return { id, file };
    };
    return { record, projectPath, directory, transcript };
  };
  const sweep = async (switches: RetentionSwitches): Promise<{ deleted: number; previewed: string[] }> => {
    clearHarnessSessionCache();
    const preview = await retention.previewConversationRetention(switches);
    clearHarnessSessionCache();
    const deleted = await retention.sweepConversationRetention(Date.now(), switches);
    return { deleted, previewed: [...preview.conversations.expired, ...preview.conversations.empty].sort() };
  };
  const recorded = async (projectId: string): Promise<Set<string>> => new Set((await listConversationRecords(projectId)).map((entry) => entry.sessionId));
  return { root, sessionRoot, piRoot, elsewhere, local, db, project, sweep, recorded, retention, deletedConversationKeys, clearHarnessSessionCache };
}

let built: ReturnType<typeof build> | undefined;
const fixture = (): ReturnType<typeof build> => built ??= build();

test("with 55 recent conversations in the list, the 10 old ones are out of today's reach and within the full one", { timeout: 300_000 }, async () => {
  const f = await fixture();
  const window = await f.project("window-project");
  const recent: Array<{ id: string; file: string }> = [], old: Array<{ id: string; file: string }> = [];
  for (let index = 0; index < 55; index++) recent.push(await window.transcript((index + 1) * HOUR));
  for (let index = 0; index < 10; index++) old.push(await window.transcript((45 + index) * DAY));
  const oldKeys = old.map((entry) => `claude:${entry.id}`).sort();

  // Today's reach: the list shows the 50 most recent, so no old conversation is ever looked at.
  const today = await f.sweep(off);
  assert.deepEqual(today, { deleted: 0, previewed: [] });
  for (const entry of [...recent, ...old]) assert.equal(await exists(entry.file), true);
  // The boxes that widen the full reach do nothing on their own.
  assert.deepEqual(await f.sweep({ ...off, includeUnrecorded: true, includeScheduled: true, includeTickets: true }), { deleted: 0, previewed: [] });
  for (const entry of old) assert.equal(await exists(entry.file), true);

  // The full reach: the dry run names the 10, the sweep deletes them and nothing else.
  f.clearHarnessSessionCache();
  const preview = await f.retention.previewConversationRetention(full);
  assert.deepEqual([...preview.conversations.expired].sort(), oldKeys);
  assert.deepEqual(preview.conversations.empty, []);
  assert.equal(preview.totals.expired.conversations, 10);
  assert.equal(preview.totals.expired.files, 10);
  assert.ok(preview.totals.expired.bytes > 0);
  assert.deepEqual(preview.projects.map((entry) => [entry.name, entry.expired.conversations, entry.empty.conversations]), [["window-project", 10, 0]]);
  assert.deepEqual(preview.switches, full);
  for (const entry of old) assert.equal(await exists(entry.file), true, "a dry run deletes nothing");

  const swept = await f.sweep(full);
  assert.equal(swept.deleted, 10);
  assert.deepEqual(swept.previewed, oldKeys, "the dry run reports what the sweep then deletes");
  for (const entry of old) assert.equal(await exists(entry.file), false);
  for (const entry of recent) assert.equal(await exists(entry.file), true);
  const tombstones = await f.deletedConversationKeys(window.record.id);
  assert.deepEqual([...tombstones].sort(), oldKeys);
  const records = await f.recorded(window.record.id);
  assert.equal(records.size, 55);
  assert.deepEqual(await f.sweep(full), { deleted: 0, previewed: [] }, "nothing is left for a second pass");
});

test("the full sweep keeps every exempt conversation, and each switch releases only its own kind", { timeout: 300_000 }, async () => {
  const f = await fixture();
  const { setUserPin } = await import("../src/user-pins.js");
  const { enqueuePrompt } = await import("../src/prompt-queue.js");
  const { markCronConversation, setWebhookConversationHistory } = await import("../src/conversation-records.js");
  const { conversationLeaseRunning } = await import("../src/conversation-runtime.js");
  const { getConversationOwnership } = await import("../src/conversation-ownership.js");
  const exempt = await f.project("exempt-project");
  const OLD = 45 * DAY, other = randomUUID();
  const plain = await exempt.transcript(OLD);
  const kept: Record<string, { id: string; file: string }> = {};
  for (const name of ["pinned", "queued", "task running", "recovery pending", "run on another machine", "assistant", "assistant topic", "assistant team", "schedule target", "webhook target"]) kept[name] = await exempt.transcript(OLD);
  kept.recent = await exempt.transcript(5 * DAY);
  kept["another machine's"] = await exempt.transcript(OLD, { origin: other });
  kept["outside every project"] = await exempt.transcript(OLD, { record: false, directory: f.elsewhere });
  // Three ticket conversations: one whose ticket is gone, one whose ticket is done, one whose ticket is still worked on.
  const ticket = await exempt.transcript(OLD, { taskId: "ticket-1" });
  const doneTicket = await exempt.transcript(OLD);
  kept["unfinished ticket"] = await exempt.transcript(OLD);
  const { receiveReplicationBatch } = await import("../src/replication.js");
  const tickets = [["done-ticket", "done", doneTicket], ["open-ticket", "in_progress", kept["unfinished ticket"]]] as const;
  await receiveReplicationBatch({ events: tickets.map(([id, status, conversation]) => {
    const task = { id, title: "A ticket", description: "synthetic", status, engine: "claude" as const, planMode: false, reviewMode: false, phaseConfig: {}, sessionPath: `claude:${conversation.file}`, worktreePath: null, worktreeBranch: null, mergedAt: null,
      currentNodeId: f.local.id, leaseOwnerNodeId: null, leaseExpiresAt: null, executionState: "idle" as const, handoffContext: null, originNodeId: f.local.id, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    return { id: randomUUID(), originNodeId: f.local.id, entityType: "task", entityKey: `${exempt.record.id}:${id}`, operation: "upsert", payload: { projectId: exempt.record.id, task, originNodeId: f.local.id }, createdAt: task.updatedAt };
  }) });
  const scheduled = await exempt.transcript(OLD), webhookMade = await exempt.transcript(OLD);
  const unrecorded = await exempt.transcript(OLD, { record: false });

  setUserPin("admin", { kind: "conversation", projectId: exempt.record.id, engine: "claude", sessionId: kept.pinned.id }, true, f.local.id);
  enqueuePrompt(`${exempt.record.id}:${kept.queued.id}`, "Continue", "Continue", { messageText: "Continue", promptSuffix: "", displaySuffix: "", attachmentPaths: [], settings: null } as never);
  const supervisorModule = "../scripts/supervisor-store.mjs";
  const { openSupervisorStore } = await import(supervisorModule) as { openSupervisorStore: (dataDirectory: string) => { reserveTask(task: Record<string, unknown>): unknown; close(): void } };
  const store = openSupervisorStore(f.root);
  try { store.reserveTask({ id: randomUUID(), identity: JSON.stringify([exempt.record.id, kept["task running"].id]), name: "A task", executable: "/bin/true", args: [], cwd: exempt.projectPath }); }
  finally { store.close(); }
  await createSourceTables(f.db, ["update_recoveries", "personal_assistants", "personal_assistant_topics", "assistant_team_conversations", "cron_tasks", "webhooks"]);
  fillRow(f.db, "update_recoveries", { session_id: kept["recovery pending"].id, status: "pending" });
  conversationLeaseRunning("claude", kept["run on another machine"].id); // opens the lease table
  fillRow(f.db, "conversation_runtime_leases", { engine: "claude", session_id: kept["run on another machine"].id, owner_node_id: other, updated_at: new Date().toISOString(), expires_at: new Date(Date.now() + HOUR).toISOString() });
  assert.equal(conversationLeaseRunning("claude", kept["run on another machine"].id), true);
  fillRow(f.db, "personal_assistants", { session_id: kept.assistant.id });
  fillRow(f.db, "personal_assistant_topics", { session_id: kept["assistant topic"].id });
  fillRow(f.db, "assistant_team_conversations", { conversation_id: kept["assistant team"].id });
  fillRow(f.db, "cron_tasks", { input: JSON.stringify({ sessionId: kept["schedule target"].id }) });
  fillRow(f.db, "webhooks", { session_id: kept["webhook target"].id, target_kind: "conversation" });
  await getConversationOwnership("claude", kept["another machine's"].id); // opens the ownership table
  fillRow(f.db, "conversation_ownership", { engine: "claude", session_id: kept["another machine's"].id, owner_node_id: other, status: "owned" });
  await markCronConversation(exempt.record.id, "claude", scheduled.id, randomUUID(), f.local.id);
  setWebhookConversationHistory(f.db, exempt.record.id, webhookMade.id, randomUUID(), false, f.local.id);

  const everything = async (): Promise<void> => { for (const [name, entry] of Object.entries(kept)) assert.equal(await exists(entry.file), true, `the ${name} conversation was deleted`); };
  const key = (entry: { id: string }): string => `claude:${entry.id}`;

  // Only the plain old conversation goes.
  f.clearHarnessSessionCache();
  const preview = await f.retention.previewConversationRetention(full);
  assert.deepEqual(preview.conversations.expired, [key(plain)]);
  for (const reason of ["pinned", "owned by another machine", "an assistant's conversation", "the target of a scheduled task or webhook", "a finished ticket's conversation", "an unfinished ticket's conversation", "made by a scheduled task or webhook", "running, open or waiting"]) {
    assert.ok(preview.kept[reason], `the dry run says what it keeps for being ${reason}: ${JSON.stringify(preview.kept)}`);
  }
  assert.deepEqual(await f.sweep(full), { deleted: 1, previewed: [key(plain)] });
  assert.equal(await exists(plain.file), false);
  await everything();
  for (const entry of [ticket, doneTicket, scheduled, webhookMade, unrecorded]) assert.equal(await exists(entry.file), true);

  // Conversations a scheduled task or a webhook made, one per run.
  assert.deepEqual(await f.sweep({ ...full, includeScheduled: true }), { deleted: 2, previewed: [key(scheduled), key(webhookMade)].sort() });
  assert.equal(await exists(scheduled.file), false);
  assert.equal(await exists(webhookMade.file), false);
  for (const entry of [ticket, doneTicket, unrecorded]) assert.equal(await exists(entry.file), true);

  // Conversations of finished tickets: the done one and the one whose ticket is gone. The ticket still worked on keeps its own.
  assert.deepEqual(await f.sweep({ ...full, includeTickets: true }), { deleted: 2, previewed: [key(ticket), key(doneTicket)].sort() });
  assert.equal(await exists(ticket.file), false);
  assert.equal(await exists(doneTicket.file), false);
  assert.equal(await exists(unrecorded.file), true);

  // Transcripts without a record: the one in the project's folder goes, the one outside every project never does.
  assert.deepEqual(await f.sweep({ ...full, includeUnrecorded: true }), { deleted: 1, previewed: [key(unrecorded)] });
  assert.equal(await exists(unrecorded.file), false);

  // With every switch on, what is exempt by rule is still there.
  assert.deepEqual(await f.sweep({ ...full, includeUnrecorded: true, includeScheduled: true, includeTickets: true }), { deleted: 0, previewed: [] });
  await everything();
  const records = await f.recorded(exempt.record.id);
  for (const [name, entry] of Object.entries(kept)) if (name !== "outside every project") assert.ok(records.has(entry.id), `the ${name} conversation lost its record`);
});

test("background runs go seven days after their last activity, except a side chat's agent", { timeout: 120_000 }, async () => {
  const f = await fixture();
  const { internalSessionId } = await import("../src/internal-sessions.js");
  const { saveChatState } = await import("../src/conversation-chat.js");
  const { storeTranscriptSummary, storedTranscriptSummary } = await import("../src/transcript-summary-store.js");
  const project = await f.project("background-project");
  const source = await project.transcript(DAY);
  const gone = await project.transcript(8 * DAY, { id: internalSessionId(), record: false });
  const young = await project.transcript(6 * DAY, { id: internalSessionId(), record: false });
  const sideChat = await project.transcript(8 * DAY, { id: internalSessionId(), record: false });
  // A run's own folder (sub-agent transcripts) goes with it.
  const subagent = path.join(project.directory, gone.id, "subagents", "agent-a1.jsonl");
  await mkdir(path.dirname(subagent), { recursive: true });
  await writeFile(subagent, "{}\n");
  const eightDays = new Date(Date.now() - 8 * DAY);
  await utimes(subagent, eightDays, eightDays);
  // The other harness keeps all its transcripts in one folder, named `<time>_<id>.jsonl`.
  await mkdir(f.piRoot, { recursive: true });
  const piId = internalSessionId(), piFile = path.join(f.piRoot, `2026-01-01T10-00-00-000Z_${piId}.jsonl`);
  await writeFile(piFile, JSON.stringify({ type: "session", version: 3, id: piId, timestamp: eightDays.toISOString(), cwd: project.projectPath }) + "\n");
  await utimes(piFile, eightDays, eightDays);
  storeTranscriptSummary("pi-summary-v1", piFile, { id: piId });
  storeTranscriptSummary("pi-summary-v1", young.file, { id: young.id });
  // The side chat of a conversation resumes its agent's session later: its state names it.
  saveChatState({ userId: "admin", projectId: project.record.id, conversationId: source.id }, { messages: [], model: null, queue: [], readOnly: true,
    agent: { harnessId: "claude", sessionId: sideChat.id, sessionPath: `claude:${sideChat.file}`, cwd: project.projectPath } });

  // Until the owner ticks the box, no background run goes, however old.
  f.clearHarnessSessionCache();
  for (const switches of [off, full, { ...full, includeUnrecorded: true, includeScheduled: true, includeTickets: true, leftovers: true }]) {
    assert.deepEqual((await f.retention.previewConversationRetention(switches)).conversations.background, []);
    await f.retention.sweepConversationRetention(Date.now(), switches);
    for (const file of [gone.file, subagent, piFile]) assert.equal(await exists(file), true, `${file} went with the box unticked`);
  }

  const runs = { ...off, backgroundRuns: true };
  f.clearHarnessSessionCache();
  const preview = await f.retention.previewConversationRetention(runs);
  assert.deepEqual([...preview.conversations.background].sort(), [`claude:${gone.id}`, `pi:${piId}`].sort());
  assert.equal(preview.totals.background.conversations, 2);
  assert.equal(preview.totals.background.files, 3, "the run's transcript, its sub-agent's and the other harness's run");

  // Background runs are no conversations: the sweep's count does not include them.
  assert.equal(await f.retention.sweepConversationRetention(Date.now(), runs), 0);
  for (const file of [gone.file, subagent, piFile]) assert.equal(await exists(file), false, `${file} is still there`);
  assert.equal(await exists(path.join(project.directory, gone.id)), false);
  assert.equal(await exists(young.file), true, "a run younger than seven days stays");
  assert.equal(await exists(sideChat.file), true, "the session a side chat resumes stays");
  assert.equal(await exists(source.file), true);
  assert.equal(storedTranscriptSummary("pi-summary-v1", piFile), undefined, "what was stored about the run goes with it");
  assert.ok(storedTranscriptSummary("pi-summary-v1", young.file));
  const again = await f.retention.previewConversationRetention(runs);
  assert.deepEqual(again.conversations.background, []);
});

test("a record is not empty while its transcript lies anywhere under the harness folder", { timeout: 120_000 }, async () => {
  const f = await fixture();
  const { ensureConversationRecord } = await import("../src/conversation-records.js");
  const { claimConversationOwnership } = await import("../src/conversation-ownership.js");
  const { listHarnessSessions } = await import("../src/harnesses.js");
  const moved = await f.project("moved-project");
  // A conversation of two days ago whose transcript lies in the folder the project had before it moved.
  const real = await moved.transcript(2 * DAY, { directory: f.elsewhere });
  await claimConversationOwnership("claude", real.id, f.local.id);
  // A conversation that was opened and never used: a record and nothing else.
  const unused = randomUUID();
  await ensureConversationRecord(moved.record.id, "claude", unused, f.local.id);
  await claimConversationOwnership("claude", unused, f.local.id);
  const twoHours = new Date(Date.now() - 2 * HOUR).toISOString();
  f.db.prepare("UPDATE conversation_records SET created_at = ?, updated_at = ? WHERE project_id = ?").run(twoHours, twoHours, moved.record.id);
  f.clearHarnessSessionCache();
  const listed = await listHarnessSessions(moved.record);
  assert.equal(listed.find((session) => session.id === real.id)?.draft, true, "the list shows it as a draft: it does not look in that folder");

  for (const switches of [off, full]) {
    const preview = await f.retention.previewConversationRetention(switches);
    assert.equal(preview.conversations.empty.includes(`claude:${real.id}`), false, `full ${switches.full}: a conversation with a transcript is not empty`);
  }
  f.clearHarnessSessionCache();
  await f.retention.sweepConversationRetention(Date.now(), off);
  const records = await f.recorded(moved.record.id);
  assert.ok(records.has(real.id), "the record of a conversation whose transcript exists stays");
  assert.equal(await exists(real.file), true);
  assert.equal(records.has(unused), false, "a conversation that was never used goes after an hour");
  assert.ok((await f.deletedConversationKeys(moved.record.id)).has(`claude:${unused}`));
});
