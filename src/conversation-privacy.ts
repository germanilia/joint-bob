import type { DatabaseSync } from "node:sqlite";
import { actingAccount, type ActingAccount } from "./account-context.js";
import { isTrustedTwin } from "./cluster-sharing-policy.js";
import path from "node:path";
import { resolveDataDirectory } from "./data-directory.js";
import { openNodeDatabase } from "./node-database.js";

let database: DatabaseSync | undefined;
function nodeDatabase(): DatabaseSync {
  if (!database) {
    database = openNodeDatabase(path.join(resolveDataDirectory(), "node.db"));
    database.exec("PRAGMA busy_timeout = 5000");
  }
  return database;
}

export interface PrivateConversation {
  sessionId: string;
  homeNodeId: string;
  accountId: string | null;
}

// Kept after deletion so a delayed title, usage event, or tombstone never becomes public.
const ready = new WeakSet<DatabaseSync>();
function ensureSchema(db: DatabaseSync): void {
  if (ready.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS private_conversations (
    session_id TEXT PRIMARY KEY, home_node_id TEXT NOT NULL, account_id TEXT
  )`);
  ready.add(db);
}

export function conversationPrivacy(sessionId: string, db: DatabaseSync = nodeDatabase()): PrivateConversation | undefined {
  ensureSchema(db);
  // Claude subagent transcripts use the parent session ID as the first path component.
  return db.prepare("SELECT session_id sessionId, home_node_id homeNodeId, account_id accountId FROM private_conversations WHERE session_id = ?")
    .get(sessionId.split("/", 1)[0]) as PrivateConversation | undefined;
}

export function keepConversationPrivate(privacy: PrivateConversation, db: DatabaseSync = nodeDatabase()): void {
  ensureSchema(db);
  const previous = conversationPrivacy(privacy.sessionId, db);
  if (previous && (previous.homeNodeId !== privacy.homeNodeId || previous.accountId !== privacy.accountId)) throw new Error("Private conversation owner does not match");
  if (!previous) db.prepare("INSERT INTO private_conversations VALUES (?, ?, ?)").run(privacy.sessionId, privacy.homeNodeId, privacy.accountId);
}

export function privateAttachmentCwd(sessionId: string): string {
  return path.join(resolveDataDirectory(), "private-conversation-attachments", encodeURIComponent(sessionId));
}

export function privateConversationVisible(sessionId: string, account: ActingAccount | undefined = actingAccount()): boolean {
  const privacy = conversationPrivacy(sessionId);
  return !privacy || !account || (!account.isRemoteLogin && !account.viaLiveRelay && (privacy.accountId === null ? account.role === "admin" : privacy.accountId === account.accountId));
}

export function privateConversationMayTravel(db: DatabaseSync, local: string, peer: string, privacy: PrivateConversation): boolean {
  if (local === peer) return true;
  return privacy.accountId === null && isTrustedTwin(db, local, peer)
    && (privacy.homeNodeId === local || privacy.homeNodeId === peer);
}

export function conversationEventPrivacy(db: DatabaseSync, event: { entityType: string; payload: unknown }): PrivateConversation | undefined {
  const payload = event.payload as { scope?: string; key?: string; conversationId?: string; sessionId?: string; event?: { sessionId?: string; conversationId?: string }; record?: { sessionId?: string; conversationId?: string }; thread?: { conversationId?: string } } | null;
  if (!payload) return undefined;
  const ids = [payload.conversationId, payload.sessionId,
    event.entityType === "name.override" && payload.scope !== "projects" ? payload.key : undefined,
    payload.event?.conversationId, payload.event?.sessionId, payload.record?.conversationId, payload.record?.sessionId,
    payload.thread?.conversationId];
  for (const id of ids) if (typeof id === "string") {
    const privacy = conversationPrivacy(id, db);
    if (privacy) return privacy;
  }
  return undefined;
}
