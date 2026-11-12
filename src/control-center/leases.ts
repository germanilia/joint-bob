import type { DatabaseSync } from "node:sqlite";

/**
 * "You're in control": while a person has taken control of a conversation, Bob and auto respond leave it alone. A lease
 * lasts while the person's page keeps renewing it and lapses a minute after the last renewal (a closed window, a lost
 * connection), so nobody is locked out by a page that went away. Kept in memory on the node that owns the conversation.
 */
export const LEASE_MS = 60_000;

/** `keptOut`: the person keeps Bob out of the conversation for good. That lease never lapses and is kept across restarts. */
interface Lease { accountId: string; expiresAt: number; keptOut?: true }

const leases = new Map<string, Lease>();
const key = (projectId: string, conversationId: string) => `${projectId}:${conversationId}`;

/** Takes the lease, or renews it when the same person already holds it. False when someone else holds it. */
export function takeLease(projectId: string, conversationId: string, accountId: string, now = Date.now()): boolean {
  const held = leases.get(key(projectId, conversationId));
  if (held && held.expiresAt > now && held.accountId !== accountId) return false;
  if (held?.keptOut) return true;
  leases.set(key(projectId, conversationId), { accountId, expiresAt: now + LEASE_MS });
  return true;
}

/** Gives the conversation back. Only the holder can. */
export function releaseLease(projectId: string, conversationId: string, accountId: string): boolean {
  const held = leases.get(key(projectId, conversationId));
  if (!held || held.accountId !== accountId) return false;
  leases.delete(key(projectId, conversationId));
  return true;
}

export function isLeased(projectId: string, conversationId: string, now = Date.now()): boolean {
  const held = leases.get(key(projectId, conversationId));
  if (!held) return false;
  if (held.expiresAt <= now) { leases.delete(key(projectId, conversationId)); return false; }
  return true;
}

export function leaseHolder(projectId: string, conversationId: string, now = Date.now()): string | null {
  return isLeased(projectId, conversationId, now) ? leases.get(key(projectId, conversationId))!.accountId : null;
}

/** Conversations the person holds right now, for the board. */
export function heldBy(accountId: string, now = Date.now()): string[] {
  return [...leases].filter(([, lease]) => lease.accountId === accountId && lease.expiresAt > now).map(([id]) => id);
}

export function isKeptOut(projectId: string, conversationId: string): boolean {
  return Boolean(leases.get(key(projectId, conversationId))?.keptOut);
}

function ensureKeptOutSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS control_center_kept_out (
    project_id TEXT NOT NULL, conversation_id TEXT NOT NULL, account_id TEXT NOT NULL, kept_at TEXT NOT NULL, PRIMARY KEY (project_id, conversation_id))`);
}

/** Restores the conversations people keep Bob out of, at startup. */
export function loadKeptOut(db: DatabaseSync): void {
  ensureKeptOutSchema(db);
  const rows = db.prepare("SELECT project_id, conversation_id, account_id FROM control_center_kept_out").all() as Array<{ project_id: string; conversation_id: string; account_id: string }>;
  for (const row of rows) leases.set(key(row.project_id, row.conversation_id), { accountId: row.account_id, expiresAt: Infinity, keptOut: true });
}

/**
 * Keeps Bob out of the conversation until the person lets him back in, or lets him back in. Letting him in leaves an ordinary
 * lease, which lapses unless the person's page renews it. False when someone else holds the conversation.
 */
export function keepBobOut(db: DatabaseSync, projectId: string, conversationId: string, accountId: string, on: boolean, now = Date.now()): boolean {
  ensureKeptOutSchema(db);
  const holder = leaseHolder(projectId, conversationId, now);
  if (holder !== null && holder !== accountId) return false;
  if (on) {
    leases.set(key(projectId, conversationId), { accountId, expiresAt: Infinity, keptOut: true });
    db.prepare("INSERT OR REPLACE INTO control_center_kept_out (project_id, conversation_id, account_id, kept_at) VALUES (?, ?, ?, ?)").run(projectId, conversationId, accountId, new Date(now).toISOString());
    return true;
  }
  db.prepare("DELETE FROM control_center_kept_out WHERE project_id = ? AND conversation_id = ?").run(projectId, conversationId);
  if (holder !== null) leases.set(key(projectId, conversationId), { accountId, expiresAt: now + LEASE_MS });
  return true;
}
