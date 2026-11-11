// Deleting a conversation removes everything this machine holds about it, and nothing of its
// neighbour: the files wherever they lie under the harness folder, the rows in node.db, the
// logs and rows of its finished background tasks. A delete that stops half-way is finished at
// the next start, and events that arrive late do not bring rows back.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSourceTables } from "./source-schema.js";

const exists = (file: string) => access(file).then(() => true, () => false);

interface Conversation { id: string; files: string[]; folder: string; finishedTask: string; runningTask: string; taskFiles: string[] }
interface SupervisorStore {
  reserveTask(task: { id: string; identity: string; name: string; executable: string; args: string[]; cwd: string }): unknown;
  completeTask(id: string, result: { status: string; exitCode: number | null; signal: string | null; error: string | null }): unknown;
  close(): void;
}

async function build() {
  const { resolveDataDirectory } = await import("../src/data-directory.js");
  const root = resolveDataDirectory();
  const sessionRoot = path.join(root, "claude-sessions"), projectPath = path.join(root, "delete-project");
  await mkdir(projectPath, { recursive: true });
  const settings = await import("../src/settings.js");
  settings.updateSettings({
    pi: { executable: "pi", configPath: path.join(root, "pi-config"), sessionPath: path.join(root, "pi-sessions") },
    claude: { executable: "claude", configPath: path.join(root, "claude-config"), sessionPath: sessionRoot },
  });
  const { addProject } = await import("../src/store.js");
  const { claudeProjectDir } = await import("../src/session-paths.js");
  const { getClusterNode } = await import("../src/cluster.js");
  const { ensureConversationRecord } = await import("../src/conversation-records.js");
  const { claimConversationOwnership } = await import("../src/conversation-ownership.js");
  const { setSessionTitle } = await import("../src/names.js");
  const { storeTranscriptSummary } = await import("../src/transcript-summary-store.js");
  const { setConversationNotification } = await import("../src/conversation-notifications.js");
  const { saveUsageEvents } = await import("../src/usage-ledger.js");
  const { setUserPin } = await import("../src/user-pins.js");
  const supervisorModule = "../scripts/supervisor-store.mjs";
  const { openSupervisorStore } = await import(supervisorModule) as { openSupervisorStore: (dataDirectory: string) => SupervisorStore };
  const project = await addProject("Delete fixture", projectPath, { writeInstructions: false });
  const local = await getClusterNode();
  // The project lists `directory`. `elsewhere` is another folder under the same harness folder, as a project that moved leaves behind.
  const directory = claudeProjectDir(projectPath, sessionRoot), elsewhere = claudeProjectDir(path.join(root, "where-the-project-was"), sessionRoot);
  await mkdir(directory, { recursive: true });
  await mkdir(elsewhere, { recursive: true });
  const db = new DatabaseSync(path.join(root, "node.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  await createSourceTables(db, ["supervised_shell_calls"]);
  const line = (id: string, text: string): string => JSON.stringify({ type: "user", uuid: randomUUID(), sessionId: id, cwd: projectPath, timestamp: new Date().toISOString(), message: { role: "user", content: text } }) + "\n";

  const conversation = async (): Promise<Conversation> => {
    const id = randomUUID(), folder = path.join(directory, id);
    const files = [
      path.join(directory, `${id}.jsonl`),
      path.join(folder, "subagents", "agent-a1.jsonl"),
      path.join(folder, "tool-results", "output.txt"),
      path.join(directory, `${id}.jsonl.${randomUUID()}.part`),
      path.join(directory, `${id}.jsonl.force-transfer-${randomUUID()}.bak`),
      path.join(directory, `.${id}.${randomUUID()}.tmp`),
      path.join(directory, `${id}.sync-conflict-20261101-101010-ABCDEFG.jsonl`),
      path.join(elsewhere, `${id}.jsonl`),
    ];
    for (const file of files) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, line(id, `Conversation ${id}`)); }
    await ensureConversationRecord(project.id, "claude", id, local.id);
    await claimConversationOwnership("claude", id, local.id);
    await setSessionTitle(id, `Title of ${id}`);
    storeTranscriptSummary("conversation-digest", `${project.id}:${id}`, { summary: "A digest" });
    storeTranscriptSummary("conversation-chat", JSON.stringify(["admin", project.id, id]), { messages: [], model: null, queue: [], readOnly: true });
    setConversationNotification("admin", project.id, id, true, local.id);
    setUserPin("pinner", { kind: "conversation", projectId: project.id, engine: "claude", sessionId: id }, true, local.id);
    saveUsageEvents([{ id: `usage-${id}`, projectId: project.id, conversationId: id, sessionId: id, engine: "claude", provider: "anthropic", modelId: "m", occurredAt: new Date().toISOString(), requestId: null,
      input: 10, output: 5, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0, reasoning: 0, apiCostUsd: 1.5, pricing: null, usageStatus: "reported",
      difficultyLevel: null, difficultyConfidence: null, difficultyStatus: "not-classified", turnId: null, toolCalls: 0, toolErrors: 0 }] as never, local.id);
    // A finished background task with its log and shell exit file, and one that still runs.
    const finishedTask = randomUUID(), runningTask = randomUUID();
    const store = openSupervisorStore(root);
    try {
      for (const task of [finishedTask, runningTask]) store.reserveTask({ id: task, identity: JSON.stringify([project.id, id]), name: "A task", executable: "/bin/true", args: [], cwd: projectPath });
      store.completeTask(finishedTask, { status: "exited", exitCode: 0, signal: null, error: null });
    } finally { store.close(); }
    const taskFiles = [path.join(root, "background-tasks", `${finishedTask}.log`), path.join(root, "shell-exits", finishedTask)];
    for (const file of [...taskFiles, path.join(root, "background-tasks", `${runningTask}.log`)]) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "output\n"); }
    for (const task of [finishedTask, runningTask]) db.prepare("INSERT INTO supervised_shell_calls VALUES (?, 'returned', 0)").run(task);
    return { id, files, folder, finishedTask, runningTask, taskFiles };
  };

  /** Every table of node.db with rows that hold the id anywhere, and how many. */
  const rowsNaming = (id: string): Record<string, number> => {
    const found: Record<string, number> = {};
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>) {
      const rows = (db.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>).filter((row) => Object.values(row).some((value) => typeof value === "string" && value.includes(id)));
      if (rows.length) found[name] = rows.length;
    }
    return found;
  };
  /** The conversation's tasks still in supervisor.db, with their state. */
  const tasksOf = (id: string): Record<string, string> => {
    const supervisor = new DatabaseSync(path.join(root, "supervisor.db"), { readOnly: true });
    try {
      return Object.fromEntries((supervisor.prepare("SELECT t.id, t.status, (SELECT count(*) FROM supervisor_completions c WHERE c.task_id = t.id) AS completions FROM supervisor_tasks t WHERE t.identity = ?")
        .all(JSON.stringify([project.id, id])) as Array<{ id: string; status: string; completions: number }>).map((row) => [row.id, `${row.status}:${row.completions}`]));
    } finally { supervisor.close(); }
  };
  const filesNaming = async (id: string): Promise<string[]> => (await readdir(sessionRoot, { recursive: true })).filter((name) => name.includes(id));
  /** The session ids in the queue of unfinished deletes. */
  const queued = (): string[] => db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'conversation_deletes_pending'").get()
    ? (db.prepare("SELECT session_id FROM conversation_deletes_pending ORDER BY session_id").all() as Array<{ session_id: string }>).map((row) => row.session_id) : [];
  /**
   * Turns a conversation into one that a release before the complete delete deleted: its record is gone, a tombstone
   * dated then stands, and this machine wrote it down as already deleted when the complete delete first ran here.
   * Its files, rows and task logs are all still here, as such a delete left them when the project did not list the folder.
   */
  const deletedEarlier = (id: string, by: string): void => {
    db.prepare("DELETE FROM conversation_records WHERE session_id = ?").run(id);
    db.prepare("INSERT INTO conversation_record_tombstones (project_id, engine, session_id, updated_at, origin_node_id) VALUES (?, 'claude', ?, '2026-01-01T00:00:00.000Z', ?)").run(project.id, id, by);
    db.prepare("INSERT INTO conversation_deletes_earlier (engine, session_id, made_here) VALUES ('claude', ?, ?)").run(id, by === local.id ? 1 : 0);
  };
  return { root, sessionRoot, project, local, db, directory, conversation, rowsNaming, tasksOf, filesNaming, queued, deletedEarlier };
}

let built: ReturnType<typeof build> | undefined;
const fixture = (): ReturnType<typeof build> => built ??= build();

/** Tables that keep rows of a deleted conversation on purpose. */
const KEPT = new Set(["conversation_record_tombstones", "model_usage_events", "usage_inventory", "usage_difficulty", "user_pins", "replication_outbox", "audit_events"]);

test("a person's delete leaves no file and no row of the conversation, and all of its neighbour's", { timeout: 120_000 }, async () => {
  const f = await fixture();
  const { clearHarnessSessionCache, listHarnessSessions } = await import("../src/harnesses.js");
  const { usageIngestIdle } = await import("../src/usage-ingest.js");
  const { deleteLocalConversation } = await import("../src/server/routes/sessions.js");
  const { deletedConversationKeys } = await import("../src/conversation-records.js");
  const gone = await f.conversation(), neighbour = await f.conversation();
  clearHarnessSessionCache(f.project.id);
  // A listing stores what it read from each transcript and imports its usage: more rows that name the conversation.
  assert.ok((await listHarnessSessions(f.project)).some((session) => session.id === gone.id));
  await usageIngestIdle();
  const before = f.rowsNaming(gone.id), neighbourBefore = f.rowsNaming(neighbour.id);
  for (const table of ["conversation_records", "conversation_ownership", "name_overrides", "transcript_summaries", "conversation_notification_preferences", "usage_ingest_files", "model_usage_events", "user_pins"]) {
    assert.ok(before[table], `the fixture has rows in ${table}: ${JSON.stringify(before)}`);
  }

  await deleteLocalConversation(f.project, "claude", gone.id);

  for (const file of [...gone.files, gone.folder, ...gone.taskFiles]) assert.equal(await exists(file), false, `${file} is still there`);
  assert.deepEqual(await f.filesNaming(gone.id), [], "nothing under the harness folder names the conversation");
  for (const file of [...neighbour.files, neighbour.folder, ...neighbour.taskFiles]) assert.equal(await exists(file), true, `${file} of the neighbour went`);
  const after = f.rowsNaming(gone.id);
  assert.deepEqual(Object.keys(after).filter((table) => !KEPT.has(table)), [], `rows of the deleted conversation remain: ${JSON.stringify(after)}`);
  assert.equal(after.conversation_record_tombstones, 1, "the tombstone stays");
  assert.equal(after.model_usage_events, before.model_usage_events, "the usage ledger keeps its rows");
  assert.equal(after.user_pins, before.user_pins, "pins are not touched");
  assert.ok((await deletedConversationKeys(f.project.id)).has(`claude:${gone.id}`));
  assert.ok(f.db.prepare("SELECT 1 FROM replication_outbox WHERE entity_type = 'conversation.record' AND operation = 'delete' AND entity_key = ?").get(`${f.project.id}:claude:${gone.id}`), "the delete is queued for the other machines");
  assert.deepEqual(f.rowsNaming(neighbour.id), neighbourBefore, "the neighbour keeps every row");
  assert.deepEqual(f.queued(), [], "a delete that finished leaves nothing in the queue");
  // The finished task went with its log, exit file and shell call; the one that still runs is left alone.
  assert.deepEqual(f.tasksOf(gone.id), { [gone.runningTask]: "starting:0" });
  assert.equal(await exists(path.join(f.root, "background-tasks", `${gone.runningTask}.log`)), true);
  assert.deepEqual((f.db.prepare("SELECT task_id FROM supervised_shell_calls WHERE task_id IN (?, ?)").all(gone.finishedTask, gone.runningTask) as Array<{ task_id: string }>).map((row) => row.task_id), [gone.runningTask]);
  assert.deepEqual(f.tasksOf(neighbour.id), { [neighbour.finishedTask]: "exited:1", [neighbour.runningTask]: "starting:0" });
  clearHarnessSessionCache(f.project.id);
  const listed = await listHarnessSessions(f.project);
  assert.equal(listed.some((session) => session.id === gone.id), false);
  assert.ok(listed.some((session) => session.id === neighbour.id));
});

test("an event that arrives after the delete writes no row for the deleted conversation", { timeout: 120_000 }, async () => {
  const f = await fixture();
  const { clearHarnessSessionCache, listHarnessSessions } = await import("../src/harnesses.js");
  const { deleteLocalConversation } = await import("../src/server/routes/sessions.js");
  const { receiveReplicationBatch } = await import("../src/replication.js");
  const gone = await f.conversation(), alive = await f.conversation();
  clearHarnessSessionCache(f.project.id);
  await listHarnessSessions(f.project);
  await deleteLocalConversation(f.project, "claude", gone.id);
  const settled = f.rowsNaming(gone.id);

  // What another machine sent before it heard of the delete: one event of every kind that writes rows about a conversation.
  const peer = randomUUID(), person = "c".repeat(32), at = new Date(Date.now() + 1000).toISOString();
  const late = (id: string) => [
    { entityType: "name.override", entityKey: `sessions:${id}`, operation: "upsert", payload: { scope: "sessions", key: id, name: "A late title", updatedAt: at, originNodeId: peer } },
    { entityType: "name.override", entityKey: `session_done:${id}`, operation: "upsert", payload: { scope: "session_done", key: id, name: at, updatedAt: at, originNodeId: peer } },
    { entityType: "conversation.queue", entityKey: `${f.project.id}:${id}`, operation: "control", payload: { projectId: f.project.id, conversationId: id, id: randomUUID(), prompt: null, createdAt: at, sequence: 5, revision: 1, paused: true } },
    { entityType: "conversation.notification", entityKey: JSON.stringify([person, f.project.id, id]), operation: "upsert", payload: { username: person, projectId: f.project.id, conversationId: id, enabled: true, updatedAt: at, originNodeId: peer } },
    { entityType: "conversation.goal", entityKey: `${f.project.id}:${id}`, operation: "upsert", payload: { projectId: f.project.id, conversationId: id, objective: "A late goal", status: "active", turns: 0, blocker: null, createdAt: at, updatedAt: at, originNodeId: peer } },
    { entityType: "conversation.routing", entityKey: `${f.project.id}:${id}`, operation: "upsert", payload: { projectId: f.project.id, conversationId: id, promptCount: 3, lastEvalOrdinal: null, mode: "manual", updatedAt: at, originNodeId: peer } },
    { entityType: "conversation.ownership", entityKey: `claude:${id}`, operation: "upsert", payload: { engine: "claude", sessionId: id, ownerNodeId: peer, epoch: 9, status: "owned", transferToNodeId: null, originNodeId: peer } },
    { entityType: "conversation.review", entityKey: `${person}:${f.project.id}:claude:${id}`, operation: "upsert", payload: { username: person, projectId: f.project.id, engine: "claude", sessionId: id, reviewedAt: new Date().toISOString(), originNodeId: peer } },
    { entityType: "conversation.author", entityKey: `${f.project.id}:${id}:${"a".repeat(32)}:1`, operation: "upsert", payload: { projectId: f.project.id, conversationId: id, textHash: "a".repeat(32), occurrence: 1, author: { accountId: person, email: null, username: "late", homeNodeId: null }, recordedAt: at } },
    { entityType: "user.recent", entityKey: `${person}:${f.project.id}:claude:${id}`, operation: "delete", payload: { username: person, projectId: f.project.id, engine: "claude", sessionId: id, recent: null, updatedAt: at, originNodeId: peer } },
  ].map((event) => ({ id: randomUUID(), originNodeId: peer, createdAt: at, ...event }));
  const tables = ["name_overrides", "queued_prompt_control", "conversation_notification_preferences", "conversation_goals", "conversation_routing_state", "replicated_review_watermarks", "conversation_message_authors", "user_recent_session_tombstones"];

  // The same events about a conversation that exists are applied: they are well-formed, and each writes a row.
  const aliveBefore = f.rowsNaming(alive.id);
  const aliveEvents = late(alive.id);
  assert.deepEqual(await receiveReplicationBatch({ events: aliveEvents }), aliveEvents.map((event) => event.id));
  const aliveAfter = f.rowsNaming(alive.id);
  for (const table of tables) assert.ok((aliveAfter[table] ?? 0) > (aliveBefore[table] ?? 0), `the ${table} event was applied for a conversation that exists: ${JSON.stringify(aliveAfter)}`);
  assert.equal((f.db.prepare("SELECT owner_node_id FROM conversation_ownership WHERE session_id = ?").get(alive.id) as { owner_node_id: string }).owner_node_id, peer);

  // About the deleted one they are taken, so the sender does not send them again, and dropped.
  const goneEvents = late(gone.id);
  assert.deepEqual(await receiveReplicationBatch({ events: goneEvents }), goneEvents.map((event) => event.id), "every late event is acknowledged");
  assert.deepEqual(f.rowsNaming(gone.id), settled, "no row was written for the deleted conversation");
});

test("a delete that could not finish waits in the queue, hidden from the list, until a later pass finishes it", { timeout: 120_000 }, async () => {
  const f = await fixture();
  const { clearHarnessSessionCache, listHarnessSessions } = await import("../src/harnesses.js");
  const { deleteLocalConversation } = await import("../src/server/routes/sessions.js");
  const { deleteSteps } = await import("../src/server/conversation-delete.js");
  const { removeAllDeletedTranscripts } = await import("../src/server/deleted-transcripts.js");
  const { deletedConversationKeys } = await import("../src/conversation-records.js");
  const { setSessionTitle } = await import("../src/names.js");
  const retention = await import("../src/server/conversation-retention.js");
  const stopped = await f.conversation(), refused = await f.conversation(), neighbour = await f.conversation();
  clearHarnessSessionCache(f.project.id);
  await listHarnessSessions(f.project);
  const all = (conversation: Conversation): string[] => [...conversation.files, conversation.folder, ...conversation.taskFiles];
  const steps = { ...deleteSteps };

  // The machine stops right after the database transaction: no file and no task log has gone yet.
  deleteSteps.files = async () => { throw new Error("the machine stopped here"); };
  try {
    await deleteLocalConversation(f.project, "claude", stopped.id);
    await deleteLocalConversation(f.project, "claude", refused.id);
    // The delete stands: the tombstone is written and the other machines are told. What is left here is in the queue.
    assert.ok((await deletedConversationKeys(f.project.id)).has(`claude:${stopped.id}`));
    assert.deepEqual(f.queued(), [stopped.id, refused.id].sort());
    for (const file of [...all(stopped), ...all(refused)]) assert.equal(await exists(file), true, `${file} is still there after the interruption`);
    assert.deepEqual(f.tasksOf(stopped.id), { [stopped.finishedTask]: "exited:1", [stopped.runningTask]: "starting:0" });
    clearHarnessSessionCache(f.project.id);
    const listed = await listHarnessSessions(f.project);
    assert.equal(listed.some((session) => session.id.includes(stopped.id) || session.id.includes(refused.id)), false, "a file of a deleted conversation is not listed");
    assert.ok(listed.some((session) => session.id === neighbour.id));

    // A pass while the file step still fails leaves both in the queue, to be tried again.
    await removeAllDeletedTranscripts();
    assert.deepEqual(f.queued(), [stopped.id, refused.id].sort());
    for (const file of all(stopped)) assert.equal(await exists(file), true);
  } finally { Object.assign(deleteSteps, steps); }

  // A row that a write racing the delete left behind goes when the delete finishes.
  await setSessionTitle(stopped.id, "A title written after the delete");
  assert.ok(f.rowsNaming(stopped.id).name_overrides);

  // The next start finishes one of them, with every box off, and its row leaves the queue.
  deleteSteps.files = async (projectId, segments, files) => {
    if (segments.some((segment) => segment.sessionId === refused.id)) throw new Error("the disk still refuses this one");
    return steps.files(projectId, segments, files);
  };
  try { await removeAllDeletedTranscripts(); }
  finally { Object.assign(deleteSteps, steps); }
  for (const file of all(stopped)) assert.equal(await exists(file), false, `${file} survived the start-up pass`);
  assert.deepEqual(await f.filesNaming(stopped.id), []);
  assert.deepEqual(f.tasksOf(stopped.id), { [stopped.runningTask]: "starting:0" });
  assert.deepEqual(Object.keys(f.rowsNaming(stopped.id)).filter((table) => !KEPT.has(table)), []);
  assert.deepEqual(f.queued(), [refused.id], "the one whose file step failed again stays");
  for (const file of all(refused)) assert.equal(await exists(file), true);

  // The hourly check works the queue off too.
  assert.equal(await retention.sweepConversationRetention(), 0);
  for (const file of all(refused)) assert.equal(await exists(file), false, `${file} survived the hourly check`);
  assert.deepEqual(f.queued(), []);
  for (const file of all(neighbour)) assert.equal(await exists(file), true, `${file} of the neighbour went`);
  assert.deepEqual(f.tasksOf(neighbour.id), { [neighbour.finishedTask]: "exited:1", [neighbour.runningTask]: "starting:0" });
});

test("what earlier releases' deletes left behind stays with every box off; the box takes it, and never a held-back one", { timeout: 120_000 }, async () => {
  const f = await fixture();
  const { clearHarnessSessionCache } = await import("../src/harnesses.js");
  const { rm } = await import("node:fs/promises");
  const { removeAllDeletedTranscripts } = await import("../src/server/deleted-transcripts.js");
  const retention = await import("../src/server/conversation-retention.js");
  const settings = await import("../src/settings.js");
  // `mistaken`: this machine's old "empty" rule took its record while its transcript lay in a folder the project did not list.
  // `elsewhere`: another machine deleted it back then; this machine still has a copy.
  // `tidy`: this machine deleted it back then and removed its files; only rows are left.
  const mistaken = await f.conversation(), elsewhere = await f.conversation(), tidy = await f.conversation();
  f.deletedEarlier(mistaken.id, f.local.id);
  f.deletedEarlier(elsewhere.id, randomUUID());
  f.deletedEarlier(tidy.id, f.local.id);
  for (const file of [...tidy.files, tidy.folder]) await rm(file, { recursive: true, force: true });
  const before = { mistaken: f.rowsNaming(mistaken.id), elsewhere: f.rowsNaming(elsewhere.id), tidy: f.rowsNaming(tidy.id) };
  assert.ok(before.mistaken.name_overrides && before.elsewhere.name_overrides && before.tidy.name_overrides);
  const untouched = async (conversation: Conversation, rows: Record<string, number>, why: string, files = true): Promise<void> => {
    if (files) for (const file of [...conversation.files, conversation.folder]) assert.equal(await exists(file), true, `${file} was removed ${why}`);
    for (const file of conversation.taskFiles) assert.equal(await exists(file), true, `${file} was removed ${why}`);
    // No row went. A listing may have stored what it read from the transcript again, so a count can only have grown.
    const after = f.rowsNaming(conversation.id);
    for (const [table, count] of Object.entries(rows)) assert.ok((after[table] ?? 0) >= count, `${table} lost rows ${why}: ${JSON.stringify(after)}`);
    assert.deepEqual(f.tasksOf(conversation.id), { [conversation.finishedTask]: "exited:1", [conversation.runningTask]: "starting:0" });
  };

  // Every box off, as a machine is after the update: none of them is in the queue, and nothing of them goes at start or in the hourly check.
  assert.equal(settings.getSettings().conversationRetentionScope.leftovers, false);
  clearHarnessSessionCache(f.project.id);
  const off = await retention.previewConversationRetention();
  assert.deepEqual(off.conversations.held, [`claude:${mistaken.id}`], "the dry run counts the held-back one whatever the boxes say");
  assert.deepEqual(off.conversations.leftover, [], "nothing left behind is removed with the box unticked");
  await removeAllDeletedTranscripts();
  await retention.sweepConversationRetention();
  assert.deepEqual(f.queued(), []);
  await untouched(mistaken, before.mistaken, "with every box off");
  await untouched(elsewhere, before.elsewhere, "with every box off");
  await untouched(tidy, before.tidy, "with every box off", false);

  // The owner ticks "Remove files left behind by conversations that were already deleted".
  settings.updateSettings({ conversationRetentionScope: { leftovers: true } });
  try {
    clearHarnessSessionCache(f.project.id);
    const on = await retention.previewConversationRetention();
    assert.deepEqual(on.conversations.leftover, [`claude:${elsewhere.id}`]);
    assert.deepEqual(on.conversations.held, [`claude:${mistaken.id}`]);
    assert.equal(on.totals.held.conversations, 1);
    assert.ok(on.totals.held.bytes > 0 && on.totals.leftover.bytes > 0);
    await removeAllDeletedTranscripts();
    // The other machine's delete is finished here: files, rows, task logs. So is this machine's own tidy one, which had only rows left.
    for (const conversation of [elsewhere, tidy]) {
      for (const file of [...conversation.files, conversation.folder, ...conversation.taskFiles]) assert.equal(await exists(file), false, `${file} is still there with the box ticked`);
      assert.deepEqual(await f.filesNaming(conversation.id), []);
      assert.deepEqual(Object.keys(f.rowsNaming(conversation.id)).filter((table) => !KEPT.has(table)), []);
      assert.deepEqual(f.tasksOf(conversation.id), { [conversation.runningTask]: "starting:0" });
    }
    assert.deepEqual(f.queued(), [], "what the box queued is finished and gone from the queue");
    // This machine's own early delete, with its transcript still here, is nobody's to clear but the owner's: not at start, not in the hourly check.
    await retention.sweepConversationRetention();
    await untouched(mistaken, before.mistaken, "though it is held back");
    assert.deepEqual((f.db.prepare("SELECT session_id FROM conversation_deletes_earlier").all() as Array<{ session_id: string }>).map((row) => row.session_id), [mistaken.id], "only the held-back one is still written down as an earlier delete");
  } finally { settings.updateSettings({ conversationRetentionScope: { leftovers: false } }); }
});

test("a delete that arrives is carried out at once whatever its date, except over a held-back copy", { timeout: 120_000 }, async () => {
  const f = await fixture();
  const { clearHarnessSessionCache, listHarnessSessions } = await import("../src/harnesses.js");
  const { receiveReplicationBatch } = await import("../src/replication.js");
  const { removeTranscriptsDeletedBy, removeAllDeletedTranscripts } = await import("../src/server/deleted-transcripts.js");
  const retention = await import("../src/server/conversation-retention.js");
  const settings = await import("../src/settings.js");
  const peer = randomUUID();
  const recent = await f.conversation(), early = await f.conversation(), neighbour = await f.conversation();
  // Both are the other machine's to delete, and were last changed long ago.
  f.db.prepare("UPDATE conversation_records SET updated_at = '2025-12-01T00:00:00.000Z', origin_node_id = ? WHERE session_id IN (?, ?)").run(peer, recent.id, early.id);
  const deletion = (id: string, at: string) => ({ id: randomUUID(), originNodeId: peer, entityType: "conversation.record", entityKey: `${f.project.id}:claude:${id}`, operation: "delete",
    payload: { projectId: f.project.id, engine: "claude", sessionId: id, record: null, updatedAt: at, originNodeId: peer }, createdAt: at });
  const arrive = async (id: string, at: string): Promise<void> => {
    const events = [deletion(id, at)];
    assert.deepEqual(await receiveReplicationBatch({ events }), [events[0].id]);
    await removeTranscriptsDeletedBy(events);
  };
  const gone = async (conversation: Conversation, why: string): Promise<void> => {
    for (const file of [...conversation.files, conversation.folder, ...conversation.taskFiles]) assert.equal(await exists(file), false, `${file} ${why}`);
    assert.deepEqual(await f.filesNaming(conversation.id), []);
    assert.deepEqual(Object.keys(f.rowsNaming(conversation.id)).filter((table) => !KEPT.has(table)), [], `rows ${why}`);
    assert.deepEqual(f.tasksOf(conversation.id), { [conversation.runningTask]: "starting:0" });
  };
  assert.equal(Object.values(settings.getSettings().conversationRetentionScope).some(Boolean), false, "every box is off");

  // A delete made now by the other machine.
  await arrive(recent.id, new Date().toISOString());
  await gone(recent, "outlived a delete that arrived");
  // A delete the other machine made long before this machine ran the complete delete, arriving only now:
  // the date says when the owner deleted, not when this machine learned of it. It is carried out all the same.
  await arrive(early.id, "2026-01-01T00:00:00.000Z");
  await gone(early, "outlived a delete that arrived late");
  assert.deepEqual(f.queued(), []);
  for (const file of [...neighbour.files, ...neighbour.taskFiles]) assert.equal(await exists(file), true);

  // A copy that is held back: this machine itself deleted the conversation before the complete delete existed, and its transcript is still here.
  const mistaken = await f.conversation();
  f.deletedEarlier(mistaken.id, f.local.id);
  const before = f.rowsNaming(mistaken.id);
  const held = async (why: string): Promise<void> => {
    for (const file of [...mistaken.files, mistaken.folder, ...mistaken.taskFiles]) assert.equal(await exists(file), true, `${file} ${why}`);
    const after = f.rowsNaming(mistaken.id);
    for (const table of ["name_overrides", "conversation_notification_preferences", "conversation_deletes_earlier"]) assert.ok((after[table] ?? 0) >= before[table], `${table} lost rows ${why}: ${JSON.stringify(after)}`);
    assert.deepEqual(f.queued(), []);
    clearHarnessSessionCache(f.project.id);
    assert.ok((await retention.previewConversationRetention()).conversations.held.includes(`claude:${mistaken.id}`), `it is no longer counted as held back: it ${why}`);
  };
  // The other machine sends back this machine's own tombstone, or an older one: nothing changes.
  await arrive(mistaken.id, "2025-12-31T00:00:00.000Z");
  await held("went when an older delete of it arrived");
  // The other machine deleted the same conversation later, on its side. The tombstone is settled between the machines; the copy here stays.
  await arrive(mistaken.id, new Date().toISOString());
  assert.equal((f.db.prepare("SELECT origin_node_id FROM conversation_record_tombstones WHERE session_id = ?").get(mistaken.id) as { origin_node_id: string }).origin_node_id, peer, "the newer tombstone is kept, as between any two machines");
  await held("went when another machine's later delete of it arrived");
  // Not at start, not in the hourly check, and not with the box ticked either.
  settings.updateSettings({ conversationRetentionScope: { leftovers: true } });
  try { await removeAllDeletedTranscripts(); await retention.sweepConversationRetention(); await held("went with the box ticked"); }
  finally { settings.updateSettings({ conversationRetentionScope: { leftovers: false } }); }
  clearHarnessSessionCache(f.project.id);
  assert.equal((await listHarnessSessions(f.project)).some((session) => session.id.includes(mistaken.id)), false, "a deleted conversation is not listed, whatever is left of it");
});

test("a credential sync pass that queues nothing writes no audit row", async () => {
  const f = await fixture();
  const { enqueueSecretCredentialSync } = await import("../src/secret-replication.js");
  const { ensureAuditSchema } = await import("../src/audit.js");
  ensureAuditSchema(f.db);
  const rows = (): number => Number((f.db.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type = 'secrets.credentials.sync'").get() as { n: number }).n);
  const before = rows(), peer = randomUUID();
  // The twin flush runs this every few seconds. With nothing new to send it enrols nothing.
  for (let pass = 0; pass < 3; pass++) assert.equal(await enqueueSecretCredentialSync([peer]), 0);
  assert.equal(rows(), before, "a pass that changes nothing is not an audit event");
});
