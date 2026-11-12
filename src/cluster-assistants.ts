import type { DatabaseSync } from "node:sqlite";
import { settingsDatabase } from "./settings-store.js";

// A cluster assistant is an assistant made for a cluster: it lives on a host machine, in a project shared with the cluster
// (so its turns run on the cluster's subscriptions), and the cluster's members ask it through their own Bob. This table says
// which assistants on this machine are that, for which cluster, and who made them.

export interface ClusterAssistantRecord { assistantId: string; clusterId: string; createdBy: string; createdAt: string }

function database(): DatabaseSync {
  const db = settingsDatabase();
  db.exec("CREATE TABLE IF NOT EXISTS cluster_assistants (assistant_id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL)");
  return db;
}

/** A machine that never had an assistant has no assistants table yet, and so hosts no cluster assistant. */
function hasAssistants(db: DatabaseSync): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='personal_assistants'").get());
}

const COLUMNS = "c.assistant_id assistantId, c.cluster_id clusterId, c.created_by createdBy, c.created_at createdAt";

export function markClusterAssistant(assistantId: string, clusterId: string, createdBy: string): void {
  database().prepare("INSERT INTO cluster_assistants (assistant_id, cluster_id, created_by, created_at) VALUES (?, ?, ?, ?)").run(assistantId, clusterId, createdBy, new Date().toISOString());
}

/** The cluster an assistant on this machine was made for; undefined for a person's own assistant, or one that was deleted. */
export function clusterAssistant(assistantId: string): ClusterAssistantRecord | undefined {
  const db = database();
  if (!hasAssistants(db)) return undefined;
  return db.prepare(`SELECT ${COLUMNS} FROM cluster_assistants c JOIN personal_assistants a ON a.id = c.assistant_id WHERE c.assistant_id = ?`).get(assistantId) as ClusterAssistantRecord | undefined;
}

/** The cluster assistants this machine hosts, oldest first. */
export function hostedClusterAssistants(): ClusterAssistantRecord[] {
  const db = database();
  if (!hasAssistants(db)) return [];
  return db.prepare(`SELECT ${COLUMNS} FROM cluster_assistants c JOIN personal_assistants a ON a.id = c.assistant_id ORDER BY c.created_at, c.assistant_id`).all() as unknown as ClusterAssistantRecord[];
}

/** The cluster whose assistants live in this project; undefined for any other project. Every conversation in it is a cluster assistant's. */
export function clusterOfAssistantsProject(projectId: string): string | undefined {
  const db = database();
  if (!hasAssistants(db)) return undefined;
  const row = db.prepare("SELECT c.cluster_id clusterId FROM cluster_assistants c JOIN personal_assistants a ON a.id = c.assistant_id WHERE a.project_id = ? LIMIT 1").get(projectId) as { clusterId: string } | undefined;
  return row?.clusterId;
}

export function forgetClusterAssistant(assistantId: string): void {
  database().prepare("DELETE FROM cluster_assistants WHERE assistant_id = ?").run(assistantId);
}
