import type { DatabaseSync } from "node:sqlite";
import type { BobMessage } from "./bob-store.js";

/**
 * A conversation under Needs you that the person put aside: it leaves Needs you and its counts, and Bob does not push messages
 * about it to Telegram while a chosen time has not come; on the board it comes back sooner when something new happens in it. Kept with the person's account and sent
 * to their other machines (bob-sync.ts); the newest write wins.
 */
export interface Snooze {
  accountId: string;
  projectId: string;
  conversationId: string;
  /** When it comes back on its own; null keeps it aside until something new happens. Woken early, it is the moment of waking. */
  until: string | null;
  snoozedAt: string;
  /** The Guardian reviews already waiting when it was put aside; a new one brings it back. */
  reviewIds: string[];
  updatedAt: string;
}

/** What the board needs to know about a conversation to tell whether its snooze still holds. */
export interface SnoozeSubject { running: boolean; updatedAt: string | null | undefined; reviewIds: string[] }

export function ensureSnoozeSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS control_center_snoozes (
    account_id TEXT NOT NULL, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL, until TEXT, snoozed_at TEXT NOT NULL,
    review_ids TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (account_id, project_id, conversation_id))`);
}

interface Row { account_id: string; project_id: string; conversation_id: string; until: string | null; snoozed_at: string; review_ids: string; updated_at: string }

const fromRow = (row: Row): Snooze => ({
  accountId: row.account_id, projectId: row.project_id, conversationId: row.conversation_id, until: row.until,
  snoozedAt: row.snoozed_at, reviewIds: JSON.parse(row.review_ids) as string[], updatedAt: row.updated_at,
});

export function readSnooze(db: DatabaseSync, accountId: string, projectId: string, conversationId: string): Snooze | undefined {
  ensureSnoozeSchema(db);
  const row = db.prepare("SELECT * FROM control_center_snoozes WHERE account_id = ? AND project_id = ? AND conversation_id = ?").get(accountId, projectId, conversationId) as Row | undefined;
  return row ? fromRow(row) : undefined;
}

export function listSnoozes(db: DatabaseSync, accountId: string): Snooze[] {
  ensureSnoozeSchema(db);
  return (db.prepare("SELECT * FROM control_center_snoozes WHERE account_id = ?").all(accountId) as unknown as Row[]).map(fromRow);
}

const listeners = new Set<(snooze: Snooze) => void>();

/** Hears each snooze written on this machine, so the person's other machines can follow. */
export function onSnoozeWritten(listener: (snooze: Snooze) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stores a snooze without telling anyone: for one that arrives from the person's other machine. */
export function storeSnooze(db: DatabaseSync, snooze: Snooze): void {
  ensureSnoozeSchema(db);
  db.prepare(`INSERT INTO control_center_snoozes (account_id, project_id, conversation_id, until, snoozed_at, review_ids, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, project_id, conversation_id) DO UPDATE SET until = excluded.until, snoozed_at = excluded.snoozed_at,
    review_ids = excluded.review_ids, updated_at = excluded.updated_at`)
    .run(snooze.accountId, snooze.projectId, snooze.conversationId, snooze.until, snooze.snoozedAt, JSON.stringify(snooze.reviewIds), snooze.updatedAt);
}

export function writeSnooze(db: DatabaseSync, snooze: Snooze): void {
  storeSnooze(db, snooze);
  for (const listener of listeners) listener(snooze);
}

/**
 * The snooze holds while its time has not come and nothing new happened: no Guardian review it did not see, and, for one not
 * running, no activity after it was put aside. A running one with a review waiting writes as it waits, so its activity is not news.
 */
export function snoozeHolds(snooze: Snooze, subject: SnoozeSubject, now: number): boolean {
  if (snooze.until !== null && Date.parse(snooze.until) <= now) return false;
  if (subject.reviewIds.some((id) => !snooze.reviewIds.includes(id))) return false;
  return subject.running || !subject.updatedAt || Date.parse(subject.updatedAt) <= Date.parse(snooze.snoozedAt);
}

/** Snoozes whose time has not come, by `projectId:conversationId`. Activity since is the board's to judge (snoozeHolds). */
export function asideNow(snoozes: Snooze[], now = Date.now()): Map<string, Snooze> {
  return new Map(snoozes.filter((snooze) => snooze.until === null || Date.parse(snooze.until) > now).map((snooze) => [`${snooze.projectId}:${snooze.conversationId}`, snooze]));
}

/** The conversations a Bob message is about, from its buttons: `projectId:conversationId` keys. */
export function conversationsOfMessage(message: Pick<BobMessage, "actions">): string[] {
  const keys = new Set<string>();
  for (const action of message.actions) {
    const data = action.data as { projectId?: unknown; conversationId?: unknown; open?: { projectId?: unknown; conversationId?: unknown } } | undefined;
    for (const ref of [data, data?.open]) {
      if (typeof ref?.projectId === "string" && typeof ref.conversationId === "string") keys.add(`${ref.projectId}:${ref.conversationId}`);
    }
  }
  return [...keys];
}

/**
 * Whether a message only concerns conversations put aside for a while whose time has not come. One put aside until something
 * changes is not held back: a new message about it is that change.
 */
export function aboutSnoozedOnly(db: DatabaseSync, accountId: string, message: Pick<BobMessage, "actions">, now = Date.now()): boolean {
  const keys = conversationsOfMessage(message);
  if (!keys.length) return false;
  const aside = new Set(listSnoozes(db, accountId).filter((snooze) => snooze.until !== null && Date.parse(snooze.until) > now).map((snooze) => `${snooze.projectId}:${snooze.conversationId}`));
  return keys.every((key) => aside.has(key));
}
