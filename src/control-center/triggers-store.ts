import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * The webhook log: each call a webhook accepted, kept per person, with how the conversation its run started ended. It is
 * read in the control center when the person wants to; nothing here goes to Bob's chat. `seen` is from before the log, when
 * a bell counted what was new.
 */
export type TriggerState = "new" | "seen" | "dismissed";

export interface Trigger {
  id: string;
  accountId: string;
  webhookId: string;
  webhookName: string;
  projectId: string;
  projectName: string;
  /** What the call says, in a line and in two. Derived from the payload and cut to size. */
  title: string;
  summary: string;
  /** A bounded excerpt of the call, shown to Bob's agent as data. Never sent to the page. */
  text: string;
  receivedAt: string;
  state: TriggerState;
  /** How its conversation ended, in a few words: "settled", "in hand: “…”", "needs you: “…”"; empty until Bob knows. */
  label: string;
  /** Why, in a sentence, when Bob found out. */
  reason: string;
  /** The run the webhook started for this call, to follow it: null for a call stored before this was kept. */
  requestId: string | null;
  /** The conversation that worked on it, once Bob found it. */
  conversationId: string | null;
  conversationTitle: string | null;
}

export type NewTrigger = Pick<Trigger, "webhookId" | "webhookName" | "projectId" | "projectName" | "title" | "summary" | "text"> & { receivedAt?: string; requestId?: string | null };
export type TriggerOutcome = Pick<Trigger, "label" | "reason" | "conversationId" | "conversationTitle">;

/** What a person keeps in their log; older ones go first. */
export const KEPT_TRIGGERS = 200;

export function ensureTriggerSchema(db: DatabaseSync): void {
  // urgency, rated_by, confidence and snoozed_until are from when calls were rated for Bob's chat; old rows keep them.
  db.exec(`CREATE TABLE IF NOT EXISTS control_center_triggers (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, webhook_id TEXT NOT NULL, webhook_name TEXT NOT NULL,
    project_id TEXT NOT NULL, project_name TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, text TEXT NOT NULL,
    received_at TEXT NOT NULL, state TEXT NOT NULL, urgency TEXT NOT NULL, rated_by TEXT NOT NULL, confidence REAL,
    label TEXT NOT NULL, reason TEXT NOT NULL, snoozed_until TEXT);
    CREATE INDEX IF NOT EXISTS control_center_triggers_account ON control_center_triggers(account_id, received_at DESC);`);
  const columns = new Set((db.prepare("PRAGMA table_info(control_center_triggers)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!columns.has("request_id")) db.exec("ALTER TABLE control_center_triggers ADD COLUMN request_id TEXT");
  if (!columns.has("conversation_id")) db.exec("ALTER TABLE control_center_triggers ADD COLUMN conversation_id TEXT; ALTER TABLE control_center_triggers ADD COLUMN conversation_title TEXT");
}

interface Row {
  id: string; account_id: string; webhook_id: string; webhook_name: string; project_id: string; project_name: string; title: string; summary: string; text: string;
  received_at: string; state: TriggerState; label: string; reason: string; request_id: string | null; conversation_id: string | null; conversation_title: string | null;
}

const fromRow = (row: Row): Trigger => ({
  id: row.id, accountId: row.account_id, webhookId: row.webhook_id, webhookName: row.webhook_name, projectId: row.project_id, projectName: row.project_name,
  title: row.title, summary: row.summary, text: row.text, receivedAt: row.received_at, state: row.state, label: row.label, reason: row.reason,
  requestId: row.request_id, conversationId: row.conversation_id, conversationTitle: row.conversation_title,
});

/** Stores a new call for one person and drops their oldest beyond what is kept. */
export function insertTrigger(db: DatabaseSync, accountId: string, input: NewTrigger): Trigger {
  const id = randomUUID();
  db.prepare(`INSERT INTO control_center_triggers (id, account_id, webhook_id, webhook_name, project_id, project_name, title, summary, text, received_at, state, urgency, rated_by, confidence, label, reason, snoozed_until, request_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 'unrated', 'none', NULL, '', '', NULL, ?)`)
    .run(id, accountId, input.webhookId, input.webhookName, input.projectId, input.projectName, input.title, input.summary, input.text, input.receivedAt ?? new Date().toISOString(), input.requestId ?? null);
  db.prepare(`DELETE FROM control_center_triggers WHERE account_id = ? AND id NOT IN
    (SELECT id FROM control_center_triggers WHERE account_id = ? ORDER BY received_at DESC, rowid DESC LIMIT ${KEPT_TRIGGERS})`).run(accountId, accountId);
  return getTrigger(db, accountId, id)!;
}

export function getTrigger(db: DatabaseSync, accountId: string, id: string): Trigger | undefined {
  const row = db.prepare("SELECT * FROM control_center_triggers WHERE account_id = ? AND id = ?").get(accountId, id) as unknown as Row | undefined;
  return row ? fromRow(row) : undefined;
}

/** The person's log, not cleared, newest first. At most what is kept, so a page can be cut from the result. */
export function listTriggers(db: DatabaseSync, accountId: string): Trigger[] {
  return (db.prepare("SELECT * FROM control_center_triggers WHERE account_id = ? AND state <> 'dismissed' ORDER BY received_at DESC, rowid DESC").all(accountId) as unknown as Row[]).map(fromRow);
}

/** Followed until settled: settled is how a call ends, so its conversation is not read again. */
const FOLLOWED = "state <> 'dismissed' AND request_id IS NOT NULL AND label <> 'settled'";

/** A person's calls whose webhook run is known and that are not settled, newest first: the ones Bob follows to their end. */
export function followedTriggers(db: DatabaseSync, accountId: string): Trigger[] {
  return (db.prepare(`SELECT * FROM control_center_triggers WHERE account_id = ? AND ${FOLLOWED} ORDER BY received_at DESC, rowid DESC`)
    .all(accountId) as unknown as Row[]).map(fromRow);
}

/** Whether Bob follows any call in a project: a turn ending there may settle one. */
export function followsCallsIn(db: DatabaseSync, projectId: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM control_center_triggers WHERE project_id = ? AND ${FOLLOWED} LIMIT 1`).get(projectId));
}

/** When the oldest call without its run came in; undefined when every call has its run or none can. */
export function oldestUnmatchedTrigger(db: DatabaseSync): string | undefined {
  return (db.prepare("SELECT min(received_at) at FROM control_center_triggers WHERE request_id IS NULL AND state <> 'dismissed'").get() as { at: string | null }).at ?? undefined;
}

/** Notes how a call's conversation ended. Returns whether it says anything new. */
export function noteTriggerOutcome(db: DatabaseSync, id: string, outcome: TriggerOutcome): boolean {
  return db.prepare(`UPDATE control_center_triggers SET label = ?, reason = ?, conversation_id = ?, conversation_title = ?
    WHERE id = ? AND (label, reason, coalesce(conversation_id, ''), coalesce(conversation_title, '')) IS NOT (?, ?, ?, ?)`)
    .run(outcome.label, outcome.reason, outcome.conversationId, outcome.conversationTitle, id, outcome.label, outcome.reason, outcome.conversationId ?? "", outcome.conversationTitle ?? "").changes > 0;
}

/** A run is accepted within moments of its call; further apart, it is another call's. */
const SAME_CALL_MS = 10_000;

/**
 * Calls stored before their run was kept with them get it now: the run the same webhook accepted closest to when the call
 * came in, within a few seconds, that no other trigger of the same person has. Returns how many were matched.
 */
export function matchTriggerRuns(db: DatabaseSync, runs: Array<{ requestId: string; sourceId: string; acceptedAt: string }>): number {
  const unmatched = db.prepare("SELECT * FROM control_center_triggers WHERE request_id IS NULL AND state <> 'dismissed'").all() as unknown as Row[];
  const taken = new Set((db.prepare("SELECT account_id || ':' || request_id key FROM control_center_triggers WHERE request_id IS NOT NULL").all() as Array<{ key: string }>).map((row) => row.key));
  let matched = 0;
  for (const row of unmatched) {
    const at = Date.parse(row.received_at);
    const run = runs
      .filter((candidate) => candidate.sourceId === row.webhook_id && Math.abs(Date.parse(candidate.acceptedAt) - at) < SAME_CALL_MS && !taken.has(`${row.account_id}:${candidate.requestId}`))
      .sort((left, right) => Math.abs(Date.parse(left.acceptedAt) - at) - Math.abs(Date.parse(right.acceptedAt) - at))[0];
    if (!run) continue;
    db.prepare("UPDATE control_center_triggers SET request_id = ? WHERE id = ?").run(run.requestId, row.id);
    taken.add(`${row.account_id}:${run.requestId}`);
    matched += 1;
  }
  return matched;
}

const marks = (ids: string[]): string => ids.map(() => "?").join(", ");

/** Clears the named calls from the log, or all of them. Returns how many were cleared. */
export function dismissTriggers(db: DatabaseSync, accountId: string, which: string[] | "all"): number {
  if (which === "all") return Number(db.prepare("UPDATE control_center_triggers SET state = 'dismissed' WHERE account_id = ? AND state <> 'dismissed'").run(accountId).changes);
  if (!which.length) return 0;
  return Number(db.prepare(`UPDATE control_center_triggers SET state = 'dismissed' WHERE account_id = ? AND state <> 'dismissed' AND id IN (${marks(which)})`).run(accountId, ...which).changes);
}

/** What the page is sent: everything but the account and the payload excerpt. */
export function publicTrigger(trigger: Trigger) {
  return {
    id: trigger.id, webhookId: trigger.webhookId, webhookName: trigger.webhookName, projectId: trigger.projectId, projectName: trigger.projectName,
    title: trigger.title, summary: trigger.summary, receivedAt: trigger.receivedAt, outcome: { label: trigger.label, reason: trigger.reason },
    conversation: trigger.conversationId ? { id: trigger.conversationId, title: trigger.conversationTitle ?? "" } : null,
  };
}
