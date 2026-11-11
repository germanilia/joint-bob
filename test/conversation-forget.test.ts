// What a delete clears from the database, table by table. Every table is created here from the
// statement its own module runs, read out of the source, so a column this delete names that the
// module no longer has fails the test.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { dropConversationGrantsInDatabase } from "../src/browser-store.js";
import { createSourceTables, fillRow } from "./source-schema.js";
import { conversationForgotten, deletedHereEarlier, deleteFinished, ensureDeleteQueue, eventOfForgottenConversation, forgetConversationRows, forgottenConversations, forgottenTables, keyNamesConversation, pendingDeleteState, pendingDeletes, queueDelete } from "../src/conversation-forget.js";

async function schema(tables: string[]): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  // This one builds its columns from a constant; its own module creates it.
  dropConversationGrantsInDatabase(db, "p", "c");
  await createSourceTables(db, tables);
  return db;
}

/** Values for columns a CHECK limits. */
const FIXED: Record<string, Record<string, unknown>> = {
  conversation_goals: { status: "active" },
  conversation_auto_responders: { status: "active" },
  conversation_routing_state: { mode: "auto" },
  conversation_ownership: { status: "owned" },
  name_overrides: { scope: "sessions" },
  name_override_tombstones: { scope: "session_done" },
  secret_assignments: { scope_type: "conversation" },
  cluster_v2_local_secret_assignments: { scope_type: "conversation" },
  browser_profile_grants: { scope: "conversation" },
};

function insert(db: DatabaseSync, table: string, column: string, key: string): void {
  fillRow(db, table, { ...FIXED[table], [column]: key });
}

const keysNaming = (id: string): string[] => [
  `/sessions/-Users-me-project/${id}.jsonl`,
  `/pi/sessions/2026-01-01T10-00-00-000Z_${id}.jsonl`,
  `/sessions/-Users-me-project/${id}/subagents/agent-a1.jsonl`,
  `claude:/sessions/-Users-me-project/${id}.jsonl`,
  `draft:claude:${id}`,
  `project-1:${id}`,
  JSON.stringify(["user-1", "project-1", id]),
  `project-1:${id}:claude:${id}:/sessions/-Users-me-project/${id}.jsonl`,
];
/** Keys that hold the id inside a longer name and belong to something else. */
const keysNotNaming = (id: string): string[] => [
  `/sessions/-Users-me-worktrees-app-${id}/another.jsonl`,
  `/sessions/-Users-me-project/${id}0.jsonl`,
  `/sessions/-Users-me-project/a${id}.jsonl`,
];

interface Row { table: string; column: string; key: string; extra?: string }

/** How many rows hold `key`; `extra` narrows it to the rows that are about a conversation. */
function count(db: DatabaseSync, row: Row): number {
  return Number((db.prepare(`SELECT count(*) AS n FROM ${row.table} WHERE ${row.column} = ?${row.extra ? ` AND ${row.extra}` : ""}`).get(row.key) as { n: number }).n);
}

test("a path or key names a conversation only as a whole word", () => {
  const id = randomUUID();
  for (const key of keysNaming(id)) assert.equal(keyNamesConversation(key, id), true, key);
  for (const key of keysNotNaming(id)) assert.equal(keyNamesConversation(key, id), false, key);
});

test("the delete clears every listed table of the conversation and leaves a neighbour's rows", async () => {
  const tables = forgottenTables();
  const db = await schema([...new Set(tables.map((entry) => entry.table))]);
  const seed = (id: string): Row[] => {
    const rows: Row[] = [];
    for (const { table, column, match, extra } of tables) {
      const keys = match === "id" ? [id] : match === "key suffix" ? [`${table.includes("secret") ? "claude" : "project-1"}:${id}`] : keysNaming(id);
      for (const key of keys) { insert(db, table, column, key); rows.push({ table, column, key, extra }); }
    }
    return rows;
  };
  const gone = randomUUID(), neighbour = randomUUID();
  const own = seed(gone), others = seed(neighbour);
  const lookalikes = tables.filter((entry) => entry.match === "name").flatMap(({ table, column }) => keysNotNaming(gone).map((key): Row => { insert(db, table, column, key); return { table, column, key }; }));
  // Rows of the same tables under the same key that are about something other than a conversation.
  db.prepare("INSERT INTO name_overrides (scope, key, name, updated_at, origin_node_id) VALUES ('projects', ?, 'A project', 'now', 'node')").run(gone);
  db.prepare("INSERT INTO secret_assignments (scope_type, scope_id, account_id) VALUES ('project', ?, 'account')").run(`claude:${gone}`);
  db.prepare("INSERT INTO browser_profile_grants (profileId, scope, projectId, conversationId, createdAt) VALUES ('profile', 'project', 'project-1', ?, 'now')").run(gone);
  const unrelated: Row[] = [
    { table: "name_overrides", column: "key", key: gone, extra: "scope = 'projects'" },
    { table: "secret_assignments", column: "scope_id", key: `claude:${gone}`, extra: "scope_type = 'project'" },
    { table: "browser_profile_grants", column: "conversationId", key: gone, extra: "scope = 'project'" },
  ];

  assert.ok(forgetConversationRows(db, [gone]) >= own.length, "every seeded row is counted");
  for (const row of own) assert.equal(count(db, row), 0, `${row.table} still holds ${row.key}`);
  for (const row of [...others, ...lookalikes, ...unrelated]) assert.equal(count(db, row), 1, `${row.table} lost ${row.key}`);
  assert.equal(forgetConversationRows(db, [gone]), 0, "a second run finds nothing");

  // Many ids at once take the other path through the name-keyed tables: the start-up pass.
  const many = Array.from({ length: 12 }, () => randomUUID());
  const seeded = many.map(seed);
  forgetConversationRows(db, many);
  for (const row of seeded.flat()) assert.equal(count(db, row), 0, `${row.table} still holds ${row.key} after the many-id run`);
  for (const row of [...others, ...lookalikes, ...unrelated]) assert.equal(count(db, row), 1, `${row.table} lost ${row.key} in the many-id run`);
  db.close();
});

test("what must be kept is in no delete statement, and a missing table is skipped", () => {
  const cleared = new Set(forgottenTables().map((entry) => entry.table));
  for (const kept of ["conversation_record_tombstones", "conversation_records", "model_usage_events", "usage_difficulty", "usage_inventory", "audit_events", "user_pins",
    "replication_outbox", "replication_inbox", "replication_deliveries", "browser_profiles", "browser_sessions", "browser_downloads", "quality_observations", "quality_feedback",
    "tasks", "cron_tasks", "cron_runs", "quick_notes", "personal_assistants", "personal_assistant_topics", "assistant_team_conversations", "skill_scope_shares", "webhook_conversation_workspaces"]) {
    assert.equal(cleared.has(kept), false, `${kept} must not be cleared`);
  }
  const empty = new DatabaseSync(":memory:");
  assert.equal(forgetConversationRows(empty, [randomUUID()]), 0);
  assert.equal(conversationForgotten(empty, randomUUID()), false);
  assert.deepEqual(forgottenConversations(empty), []);
  empty.close();
});

test("a conversation counts as deleted only with a tombstone and no record", async () => {
  const db = await schema(["conversation_records", "conversation_record_tombstones"]);
  const tombstone = (id: string): void => { db.prepare("INSERT INTO conversation_record_tombstones (project_id, engine, session_id, updated_at, origin_node_id) VALUES ('project-1', 'claude', ?, 'now', 'node')").run(id); };
  const record = (id: string, conversationId: string | null = null): void => { db.prepare("INSERT INTO conversation_records (project_id, engine, session_id, created_at, updated_at, origin_node_id, conversation_id) VALUES ('project-1', 'claude', ?, 'now', 'now', 'node', ?)").run(id, conversationId); };
  const deleted = randomUUID(), recorded = randomUUID(), both = randomUUID(), logical = randomUUID(), segment = randomUUID();
  tombstone(deleted); record(recorded); tombstone(both); record(both);
  // A switched conversation: its first segment has a tombstone, a later segment is still on record.
  tombstone(logical); record(segment, logical);
  assert.equal(conversationForgotten(db, deleted), true);
  assert.equal(conversationForgotten(db, recorded), false);
  assert.equal(conversationForgotten(db, both), false, "a record wins over a tombstone");
  assert.equal(conversationForgotten(db, logical), false, "a conversation with a segment on record is not deleted");
  assert.equal(conversationForgotten(db, randomUUID()), false, "an unknown conversation is not deleted");
  assert.deepEqual(forgottenConversations(db).map((row) => row.sessionId), [deleted]);

  const about = (entityType: string, payload: Record<string, unknown>): boolean => eventOfForgottenConversation(db, { entityType, payload });
  for (const id of [deleted, recorded]) {
    const expected = id === deleted;
    assert.equal(about("name.override", { scope: "sessions", key: id }), expected);
    assert.equal(about("name.override", { scope: "session_done", key: id }), expected);
    for (const type of ["conversation.ownership", "conversation.review", "user.recent"]) assert.equal(about(type, { sessionId: id }), expected, type);
    for (const type of ["conversation.queue", "conversation.routing", "conversation.notification", "conversation.notification.delivered", "conversation.goal", "conversation.author", "control.reviewCheck"]) {
      assert.equal(about(type, { conversationId: id }), expected, type);
    }
  }
  // A project can share an id with nothing; its name is not a conversation's. Usage, pins and records are never dropped here.
  assert.equal(about("name.override", { scope: "projects", key: deleted }), false);
  for (const type of ["model.usage", "usage.difficulty", "user.pin", "conversation.record", "task"]) assert.equal(about(type, { sessionId: deleted, conversationId: deleted }), false, type);
  db.close();
});

test("the first run writes down the deletes a machine already knew; later ones go through the queue", async () => {
  const db = await schema(["conversation_records", "conversation_record_tombstones", "cluster_node"]);
  const local = randomUUID(), other = randomUUID();
  const tombstone = (id: string, by: string): void => { db.prepare("INSERT INTO conversation_record_tombstones (project_id, engine, session_id, updated_at, origin_node_id) VALUES ('project-1', 'claude', ?, 'then', ?)").run(id, by); };
  const record = (id: string, conversationId: string | null = null): void => { db.prepare("INSERT INTO conversation_records (project_id, engine, session_id, created_at, updated_at, origin_node_id, conversation_id) VALUES ('project-1', 'claude', ?, 'now', 'now', 'node', ?)").run(id, conversationId); };
  const own = randomUUID(), theirs = randomUUID();
  tombstone(own, local); tombstone(theirs, other);

  // A machine with no identity yet has deleted nothing: the tables are there, the list is not taken.
  assert.equal(ensureDeleteQueue(db), false);
  assert.deepEqual(pendingDeletes(db), []);
  assert.deepEqual(forgottenConversations(db).map((row) => [row.earlier, row.pending]), [[false, false], [false, false]]);

  fillRow(db, "cluster_node", { singleton: 1, id: local });
  assert.equal(ensureDeleteQueue(db), true);
  const known = Object.fromEntries(forgottenConversations(db).map((row) => [row.sessionId, row]));
  assert.deepEqual([known[own].earlier, known[own].madeHere, known[own].pending], [true, true, false], "a delete this machine made before");
  assert.deepEqual([known[theirs].earlier, known[theirs].madeHere, known[theirs].pending], [true, false, false], "a delete another machine made before");
  assert.equal(deletedHereEarlier(db, "claude", own), true);
  assert.equal(deletedHereEarlier(db, "claude", theirs), false);
  assert.deepEqual(pendingDeletes(db), [], "none of them is put in the queue by itself");

  // A tombstone written from now on is not an earlier one, and a second call does not take the list again.
  const fresh = randomUUID();
  tombstone(fresh, other);
  assert.equal(ensureDeleteQueue(db), true);
  assert.equal(forgottenConversations(db).find((row) => row.sessionId === fresh)!.earlier, false);

  // The queue: a row per unfinished delete, and queueing an earlier delete takes it off the list of earlier ones.
  queueDelete(db, "project-1", "claude", fresh, fresh);
  queueDelete(db, "project-1", "claude", theirs, theirs);
  assert.deepEqual(pendingDeletes(db).map((row) => row.sessionId).sort(), [fresh, theirs].sort());
  const queued = Object.fromEntries(forgottenConversations(db).map((row) => [row.sessionId, row]));
  assert.deepEqual([queued[theirs].earlier, queued[theirs].pending], [false, true]);
  assert.deepEqual([queued[own].earlier, queued[own].pending], [true, false]);

  // Where a queued delete stands.
  assert.equal(pendingDeleteState(db, "claude", fresh), "ready");
  const later = randomUUID();
  record(later, fresh); // another segment of the same conversation, whose own delete has not arrived
  assert.equal(pendingDeleteState(db, "claude", fresh), "waiting");
  db.prepare("DELETE FROM conversation_records WHERE session_id = ?").run(later);
  record(fresh); // a newer record brought it back
  assert.equal(pendingDeleteState(db, "claude", fresh), "ended");
  assert.equal(pendingDeleteState(db, "claude", randomUUID()), "ended", "no tombstone, nothing to delete");
  deleteFinished(db, "claude", fresh);
  deleteFinished(db, "claude", theirs);
  assert.deepEqual(pendingDeletes(db), []);
  db.close();
});
