import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type AccountRole = "admin" | "member";

/** An account is a person, not a node: a home node plus a username that never changes
    there. Every node derives the same id, so the id never has to travel or be agreed. */
export function accountIdFor(homeNodeId: string, username: string): string {
  return createHash("sha256").update(`joint-bob-account\n${homeNodeId}\n${username.toLowerCase()}`).digest("hex").slice(0, 32);
}

export function isAccountId(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/* Asked several times for every account id that is worked out. Tables are made when a feature is first
   used and are not dropped while the node runs, so one that was found stays found for the connection.
   A missing one is looked for every time. Nothing is remembered inside a transaction: a rollback
   takes a table made in it away again. */
const tablesFound = new WeakMap<DatabaseSync, Set<string>>();
function tableExists(db: DatabaseSync, name: string): boolean {
  const found = tablesFound.get(db);
  if (found?.has(name)) return true;
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
  if (exists && db.isTransaction === false) { if (found) found.add(name); else tablesFound.set(db, new Set([name])); }
  return exists;
}

/** Twins are one person's machines, so their local users share a home: the lowest node id
    of this node and its twins. Every machine of the pair derives the same account. */
export function canonicalLocalHome(db: DatabaseSync): string {
  if (!tableExists(db, "cluster_node")) return "";
  const local = (db.prepare("SELECT id FROM cluster_node WHERE singleton = 1").get() as { id: string } | undefined)?.id ?? "";
  if (!local || !tableExists(db, "sharing_twins")) return local;
  const twins = db.prepare("SELECT left_node_id AS a, right_node_id AS b FROM sharing_twins WHERE left_node_id = ? OR right_node_id = ?").all(local, local) as unknown as Array<{ a: string; b: string }>;
  return [local, ...twins.flatMap((row) => [row.a, row.b])].sort()[0];
}

/** The account of this node's own user called `username`, if there is one. */
export function localAccountIdIn(db: DatabaseSync, username: string): string | undefined {
  if (!tableExists(db, "users") || !db.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE AND home_node_id IS NULL").get(username)) return undefined;
  const home = canonicalLocalHome(db);
  return home ? accountIdFor(home, username) : undefined;
}
