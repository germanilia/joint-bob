import type { DatabaseSync } from "node:sqlite";
import { getClusterNode } from "../cluster.js";
import { peerAway } from "../peer-presence.js";
import type { ClusterMember } from "../assistant-teams/access.js";
import { getTeamRequestView, type TeamRequestView } from "../assistant-teams/assignments.js";
import { onTeamChange } from "../assistant-teams/invalidation.js";
import { teamDatabase } from "../assistant-teams/store.js";
import { signedMachinePost } from "./machine-post.js";

// A member's machine that sent work to a team on this machine is told when the request ends, once, over the signed machine
// channel: no one polls. A machine that is away is not tried; what it is owed waits here, on disk, until it returns (or until
// this machine starts again), and its own start also asks (team-follows.ts), so neither side's restart loses the answer.

const NOTICE = "/api/cluster/v2/assistant-teams/notice";
const KEEP_MS = 7 * 24 * 3600_000;
const SEND_TIMEOUT_MS = 8_000;

async function database(): Promise<DatabaseSync> {
  const db = await teamDatabase();
  db.exec("CREATE TABLE IF NOT EXISTS assistant_team_notices (root_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, home_node_id TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL)");
  return db;
}
const ended = (view: TeamRequestView): boolean => view.state !== "running" && view.state !== "queued";

/** Work a member's own machine started: that machine is owed the word when it ends. A person on this machine sees it as it changes. */
export async function watchTeamRequest(member: ClusterMember, teamId: string, rootId: string): Promise<void> {
  if (member.homeNodeId === (await getClusterNode()).id) return;
  const db = await database();
  db.prepare("DELETE FROM assistant_team_notices WHERE state='sent' AND created_at < ?").run(new Date(Date.now() - KEEP_MS).toISOString());
  db.prepare("INSERT OR IGNORE INTO assistant_team_notices VALUES (?,?,?,?,?)").run(rootId, teamId, member.homeNodeId, "pending", new Date().toISOString());
  await flushTeamNotices({ teamId });
}

const sending = new Set<string>();
/** Tells the machines owed a word about a request that has ended, for one team or one machine when named. */
export async function flushTeamNotices(only: { teamId?: string; home?: string } = {}): Promise<void> {
  const db = await database();
  const owed = db.prepare("SELECT root_id, team_id, home_node_id FROM assistant_team_notices WHERE state='pending'").all() as Array<{ root_id: string; team_id: string; home_node_id: string }>;
  for (const row of owed) {
    if ((only.teamId && row.team_id !== only.teamId) || (only.home && row.home_node_id !== only.home) || sending.has(row.root_id)) continue;
    sending.add(row.root_id);
    try {
      const view = await getTeamRequestView(row.team_id, row.root_id);
      // Gone (its team was removed): nothing is owed any more.
      if (!view) { db.prepare("UPDATE assistant_team_notices SET state='sent' WHERE root_id=?").run(row.root_id); continue; }
      if (!ended(view) || peerAway(row.home_node_id)) continue;
      const answer = await signedMachinePost(row.home_node_id, NOTICE, { teamId: row.team_id, request: view }, SEND_TIMEOUT_MS).catch(() => undefined);
      if (answer?.ok) { await answer.body?.cancel(); db.prepare("UPDATE assistant_team_notices SET state='sent' WHERE root_id=?").run(row.root_id); }
      else await answer?.body?.cancel();
    } finally { sending.delete(row.root_id); }
  }
}

let started = false;
/** When a team's request changes it may have ended; and once at start, for what ended while this machine was down. */
export async function startTeamNotices(): Promise<void> {
  if (started) return;
  started = true;
  onTeamChange((teamId) => { void flushTeamNotices({ teamId }).catch((error) => console.warn(`Could not tell a machine its team request ended: ${error instanceof Error ? error.message : error}`)); });
  await flushTeamNotices();
}
