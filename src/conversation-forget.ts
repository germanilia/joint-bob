import type { DatabaseSync } from "node:sqlite";

/* What this machine still holds about a conversation once it is deleted.

   A delete writes a tombstone for every segment and removes the record. The rows below describe
   the conversation or are read when it is listed or opened, so they go in the same transaction,
   here and on every machine that receives the tombstone. Each machine removes its own rows:
   nothing here is sent to other machines.

   Kept on purpose: the tombstones, the usage ledger (model_usage_events, usage_difficulty,
   usage_inventory), quality rows, audit rows, the replication tables, pins, browser profiles and
   their sessions, worktrees, attachments, schedules and their run history, quick notes, the
   assistants' own tables and the skill sharing lists (a skill's list is compared between machines).

   A table that a module has not created yet on this machine is skipped. */

/** Tables whose column holds a session id or a conversation id as it is. */
const BY_ID: Array<[table: string, column: string, extra?: string]> = [
  ["conversation_ownership", "session_id"],
  ["conversation_work", "session_id"],
  ["conversation_turn_failures", "session_id"],
  ["conversation_runtime_leases", "session_id"],
  ["claude_runtime_sessions", "session_id"],
  ["pi_runtime_sessions", "session_id"],
  ["by_the_way_leases", "session_id"],
  ["replicated_review_watermarks", "session_id"],
  ["user_recent_sessions", "session_id"],
  ["user_recent_session_tombstones", "session_id"],
  ["update_recoveries", "session_id"],
  ["cluster_v2_transcript_receipts", "session_id"],
  ["cluster_v2_transcript_conflicts", "session_id"],
  ["control_center_bob_started", "session_id"],
  ["control_center_review_checks", "conversation_id"],
  ["conversation_goals", "conversation_id"],
  ["conversation_auto_responders", "conversation_id"],
  ["conversation_auto_replies", "conversation_id"],
  ["conversation_message_authors", "conversation_id"],
  ["conversation_notification_preferences", "conversation_id"],
  ["conversation_notification_deliveries", "conversation_id"],
  ["webhook_conversation_titles", "conversation_id"],
  ["browser_profile_grants", "conversationId", "scope = 'conversation'"],
  ["name_overrides", "key", "scope IN ('sessions','session_colors','session_classifications','session_done','session_feedback')"],
  ["name_override_tombstones", "key", "scope IN ('sessions','session_colors','session_classifications','session_done','session_feedback')"],
];

/** Tables keyed `<project or engine>:<id>`. The first half may be a project alias, so only the id is compared. */
const BY_KEY_SUFFIX: Array<[table: string, column: string, extra?: string]> = [
  ["queued_prompts", "queue_key"],
  ["queued_prompt_tombstones", "queue_key"],
  ["queued_prompt_sequences", "queue_key"],
  ["queued_prompt_settings", "queue_key"],
  ["queued_prompt_control", "queue_key"],
  ["conversation_routing_state", "queue_key"],
  ["secret_assignments", "scope_id", "scope_type = 'conversation'"],
  ["cluster_v2_local_secret_assignments", "scope_id", "scope_type = 'conversation'"],
];

/** Tables keyed by a transcript path or a composed key that names the id somewhere inside. */
const BY_NAME: Array<[table: string, column: string]> = [
  ["conversation_review_states", "session_path"],
  ["conversation_review_notification_preferences", "session_path"],
  ["transcript_summaries", "file"],
  ["transcript_hashes", "file"],
  ["usage_ingest_files", "file_key"],
  ["claude_runtime_sessions", "transcript_path"],
];

/** How many ids one statement takes. The start-up pass hands over every deleted conversation. */
const CHUNK = 200;

function tables(db: DatabaseSync): Set<string> {
  return new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
}

/** What may stand right before or after an id inside a path or a composed key. A hyphen is not one: ids contain them. */
const DELIMITERS = "/_:\"\\.";

/**
 * Whether `key` names `id` as a whole word: a file `<id>.jsonl`, a Pi file `<time>_<id>.jsonl`, a
 * folder `<id>/`, a key `<project>:<id>` or a JSON list holding it. An id inside a longer name
 * (a worktree folder that ends in another id) does not count.
 */
export function keyNamesConversation(key: string, id: string): boolean {
  for (let from = 0; ;) {
    const at = key.indexOf(id, from);
    if (at < 0) return false;
    const before = at === 0 ? "/" : key[at - 1], after = key[at + id.length] ?? "/";
    if (DELIMITERS.includes(before) && DELIMITERS.includes(after)) return true;
    from = at + 1;
  }
}

function forgetByName(db: DatabaseSync, table: string, column: string, ids: string[]): number {
  let keys: string[];
  if (ids.length <= 8) {
    // A few ids: SQLite finds the rows that hold one of them.
    const holding = db.prepare(`SELECT DISTINCT ${column} AS key FROM ${table} WHERE instr(${column}, ?) > 0`);
    keys = ids.flatMap((id) => (holding.all(id) as Array<{ key: unknown }>).map((row) => row.key).filter((key): key is string => typeof key === "string" && keyNamesConversation(key, id)));
  } else {
    // Many ids (the start-up pass): one pass over the table, each key cut into its words.
    const wanted = new Set(ids);
    keys = (db.prepare(`SELECT DISTINCT ${column} AS key FROM ${table}`).all() as Array<{ key: unknown }>).map((row) => row.key)
      .filter((key): key is string => typeof key === "string" && key.split(/[/_:"\\.]/).some((word) => wanted.has(word)));
  }
  const remove = db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`);
  let removed = 0;
  for (const key of new Set(keys)) removed += Number(remove.run(key).changes);
  return removed;
}

/**
 * Removes this machine's rows about the conversations named by `ids` (every segment's session id
 * and the conversation id). Runs inside the caller's transaction when there is one, so the rows go
 * together with the record. Safe to repeat. Returns how many rows went.
 */
export function forgetConversationRows(db: DatabaseSync, ids: string[]): number {
  const wanted = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
  if (!wanted.length) return 0;
  const present = tables(db);
  let removed = 0;
  for (let start = 0; start < wanted.length; start += CHUNK) {
    const chunk = wanted.slice(start, start + CHUNK), list = JSON.stringify(chunk);
    for (const [table, column, extra] of BY_ID) {
      if (!present.has(table)) continue;
      removed += Number(db.prepare(`DELETE FROM ${table} WHERE ${extra ? `${extra} AND ` : ""}${column} IN (SELECT value FROM json_each(?))`).run(list).changes);
    }
    for (const [table, column, extra] of BY_KEY_SUFFIX) {
      if (!present.has(table)) continue;
      removed += Number(db.prepare(`DELETE FROM ${table} WHERE ${extra ? `${extra} AND ` : ""}substr(${column}, instr(${column}, ':') + 1) IN (SELECT value FROM json_each(?))`).run(list).changes);
    }
    for (const [table, column] of BY_NAME) {
      if (present.has(table)) removed += forgetByName(db, table, column, chunk);
    }
  }
  return removed;
}

/** Every table the delete clears and how its rows name a conversation, for the tests that check each one. */
export function forgottenTables(): Array<{ table: string; column: string; match: "id" | "key suffix" | "name"; extra?: string }> {
  return [
    ...BY_ID.map(([table, column, extra]) => ({ table, column, match: "id" as const, ...(extra ? { extra } : {}) })),
    ...BY_KEY_SUFFIX.map(([table, column, extra]) => ({ table, column, match: "key suffix" as const, ...(extra ? { extra } : {}) })),
    ...BY_NAME.map(([table, column]) => ({ table, column, match: "name" as const })),
  ];
}

/* The bookkeeping of deletes on this machine, three small tables.

   conversation_deletes_pending   The queue of deletes that are not finished. A delete puts its row
       there in the same transaction that writes the tombstone and clears the rows: a person's
       delete, the sweep's, and a tombstone that arrives from another machine, whatever its date.
       The row goes once the file step and the task step both ran without error. A tombstone
       with no row here needs nothing more.
   conversation_deletes_earlier   The deleted conversations this machine already knew when the
       complete delete first ran on it, and whether it had deleted them itself. Releases before
       that removed less, so these may have left files and rows here. They stay until the owner
       ticks the `leftovers` box, which moves them to the queue. One that this machine deleted
       itself and whose transcript is still here is held back and never moved
       (server/conversation-delete.ts, heldBack).
   conversation_retention_marks   When that first run was. */

const prepared = new WeakSet<DatabaseSync>();

/**
 * Creates the delete bookkeeping and, the first time on this machine, writes down the deleted
 * conversations it already knows. Call it before a tombstone is written, so that tombstone is not
 * taken for an earlier one. False while the machine has no identity yet: nothing was deleted here.
 */
export function ensureDeleteQueue(db: DatabaseSync): boolean {
  if (prepared.has(db)) return true;
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_retention_marks (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS conversation_deletes_pending (project_id TEXT NOT NULL, engine TEXT NOT NULL, session_id TEXT NOT NULL, conversation_id TEXT NOT NULL, queued_at TEXT NOT NULL, PRIMARY KEY (engine, session_id));
    CREATE TABLE IF NOT EXISTS conversation_deletes_earlier (engine TEXT NOT NULL, session_id TEXT NOT NULL, made_here INTEGER NOT NULL, PRIMARY KEY (engine, session_id));`);
  const marked = (): boolean => db.prepare("SELECT 1 FROM conversation_retention_marks WHERE key = 'completeDeleteSince'").get() !== undefined;
  if (!marked()) {
    const local = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cluster_node'").get()
      ? db.prepare("SELECT id FROM cluster_node WHERE singleton = 1").get() as { id: string } | undefined
      : undefined;
    if (!local) return false;
    // Inside a caller's transaction this is part of it. On its own it is one transaction, so two connections cannot both take the list.
    const own = (db as unknown as { isTransaction?: boolean }).isTransaction !== true;
    if (own) db.exec("BEGIN IMMEDIATE");
    try {
      if (!marked()) {
        if (hasTombstones(db)) db.prepare("INSERT OR IGNORE INTO conversation_deletes_earlier (engine, session_id, made_here) SELECT engine, session_id, CASE WHEN origin_node_id = ? THEN 1 ELSE 0 END FROM conversation_record_tombstones").run(local.id);
        db.prepare("INSERT OR IGNORE INTO conversation_retention_marks (key, value) VALUES ('completeDeleteSince', ?)").run(new Date().toISOString());
      }
      if (own) db.exec("COMMIT");
    } catch (error) { if (own) db.exec("ROLLBACK"); throw error; }
  }
  prepared.add(db);
  return true;
}

export interface PendingDelete { projectId: string; engine: string; sessionId: string; conversationId: string; queuedAt: string }

/**
 * Puts a delete in the queue, in the caller's transaction. A delete made or received now replaces
 * what was written down about an earlier delete of the same conversation.
 */
export function queueDelete(db: DatabaseSync, projectId: string, engine: string, sessionId: string, conversationId: string): void {
  db.prepare(`INSERT INTO conversation_deletes_pending (project_id, engine, session_id, conversation_id, queued_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(engine, session_id) DO UPDATE SET project_id = excluded.project_id, conversation_id = excluded.conversation_id, queued_at = excluded.queued_at`)
    .run(projectId, engine, sessionId, conversationId, new Date().toISOString());
  db.prepare("DELETE FROM conversation_deletes_earlier WHERE engine = ? AND session_id = ?").run(engine, sessionId);
}

/** The deletes that are not finished, oldest first. */
export function pendingDeletes(db: DatabaseSync): PendingDelete[] {
  if (!ensureDeleteQueue(db)) return [];
  return db.prepare("SELECT project_id AS projectId, engine, session_id AS sessionId, conversation_id AS conversationId, queued_at AS queuedAt FROM conversation_deletes_pending ORDER BY queued_at, engine, session_id").all() as unknown as PendingDelete[];
}

/**
 * Where a queued delete stands. `ready`: the segment has its tombstone and nothing of the
 * conversation is on record, so its files may go. `waiting`: another segment of the same
 * conversation is still on record here, because its own delete has not arrived yet. `ended`: a
 * newer record brought the segment back, so there is nothing to delete any more.
 */
export function pendingDeleteState(db: DatabaseSync, engine: string, sessionId: string): "ready" | "waiting" | "ended" {
  if (!hasTombstones(db) || !db.prepare("SELECT 1 FROM conversation_record_tombstones WHERE engine = ? AND session_id = ? LIMIT 1").get(engine, sessionId)) return "ended";
  if (db.prepare("SELECT 1 FROM conversation_records WHERE session_id = ? LIMIT 1").get(sessionId)) return "ended";
  return db.prepare("SELECT 1 FROM conversation_records WHERE conversation_id = ? LIMIT 1").get(sessionId) ? "waiting" : "ready";
}

/** Takes a delete out of the queue: its files and background tasks are gone, or it has nothing to delete any more. */
export function deleteFinished(db: DatabaseSync, engine: string, sessionId: string): void {
  db.prepare("DELETE FROM conversation_deletes_pending WHERE engine = ? AND session_id = ?").run(engine, sessionId);
}

/** Whether this machine itself deleted the conversation before the complete delete existed, as written down at that first run. */
export function deletedHereEarlier(db: DatabaseSync, engine: string, sessionId: string): boolean {
  if (!ensureDeleteQueue(db)) return false;
  return (db.prepare("SELECT made_here FROM conversation_deletes_earlier WHERE engine = ? AND session_id = ?").get(engine, sessionId) as { made_here: number } | undefined)?.made_here === 1;
}

function hasTombstones(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_record_tombstones'").get() !== undefined;
}

/**
 * Whether a conversation was deleted: one of its ids has a tombstone and no record. A record wins
 * over a tombstone, so nothing is ever taken from a conversation that is on record.
 */
export function conversationForgotten(db: DatabaseSync, sessionId: string): boolean {
  if (!sessionId || !hasTombstones(db)) return false;
  if (!db.prepare("SELECT 1 FROM conversation_record_tombstones WHERE session_id = ? LIMIT 1").get(sessionId)) return false;
  return !db.prepare("SELECT 1 FROM conversation_records WHERE session_id = ? OR conversation_id = ? LIMIT 1").get(sessionId, sessionId);
}

export interface ForgottenConversation {
  projectId: string; engine: string; sessionId: string; deletedAt: string; deletedBy: string;
  /** Known as deleted when the complete delete first ran here: what an earlier release's delete left may still be here. */
  earlier: boolean;
  /** With `earlier`: this machine made that delete itself. */
  madeHere: boolean;
  /** In the queue of unfinished deletes. */
  pending: boolean;
}

function bookkeeping(db: DatabaseSync): { earlier: Map<string, boolean>; pending: Set<string> } {
  const earlier = new Map<string, boolean>(), pending = new Set<string>();
  if (!ensureDeleteQueue(db)) return { earlier, pending };
  for (const row of db.prepare("SELECT engine, session_id, made_here FROM conversation_deletes_earlier").all() as Array<{ engine: string; session_id: string; made_here: number }>) earlier.set(`${row.engine}:${row.session_id}`, row.made_here === 1);
  for (const row of db.prepare("SELECT engine, session_id FROM conversation_deletes_pending").all() as Array<{ engine: string; session_id: string }>) pending.add(`${row.engine}:${row.session_id}`);
  return { earlier, pending };
}

/** Every deleted conversation this machine knows of: a tombstone and no record under that id. */
export function forgottenConversations(db: DatabaseSync): ForgottenConversation[] {
  if (!hasTombstones(db)) return [];
  const recorded = new Set<string>();
  for (const row of db.prepare("SELECT session_id, conversation_id FROM conversation_records").all() as Array<{ session_id: string; conversation_id: string | null }>) {
    recorded.add(row.session_id);
    if (row.conversation_id) recorded.add(row.conversation_id);
  }
  const { earlier, pending } = bookkeeping(db);
  return (db.prepare("SELECT project_id AS projectId, engine, session_id AS sessionId, updated_at AS deletedAt, origin_node_id AS deletedBy FROM conversation_record_tombstones ORDER BY project_id, engine, session_id").all() as Array<{ projectId: string; engine: string; sessionId: string; deletedAt: string; deletedBy: string }>)
    .filter((row) => !recorded.has(row.sessionId))
    .map((row) => { const key = `${row.engine}:${row.sessionId}`; return { ...row, earlier: earlier.has(key), madeHere: earlier.get(key) === true, pending: pending.has(key) }; });
}

/** The conversation an event of another kind is about, or undefined when the event is not about one. */
function eventConversation(entityType: string, payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const value = payload as Record<string, unknown>;
  const text = (field: unknown): string | undefined => typeof field === "string" && field ? field : undefined;
  switch (entityType) {
    case "name.override": return typeof value.scope === "string" && value.scope !== "projects" ? text(value.key) : undefined;
    case "conversation.ownership":
    case "conversation.review":
    case "user.recent": return text(value.sessionId);
    case "conversation.queue":
    case "conversation.routing":
    case "conversation.notification":
    case "conversation.notification.delivered":
    case "conversation.goal":
    case "conversation.author":
    case "control.reviewCheck": return text(value.conversationId);
    default: return undefined;
  }
}

/**
 * Whether a replicated event is about a deleted conversation and would write rows for it again.
 * Such an event is taken and dropped: an event sent before the delete can arrive after it, and the
 * sender must not be asked to send it again. Records, usage and pins are not covered here: records
 * settle against the tombstone themselves, and the usage ledger and pins are kept.
 */
export function eventOfForgottenConversation(db: DatabaseSync, event: { entityType: string; payload: unknown }): boolean {
  const conversationId = eventConversation(event.entityType, event.payload);
  return conversationId !== undefined && conversationForgotten(db, conversationId);
}
