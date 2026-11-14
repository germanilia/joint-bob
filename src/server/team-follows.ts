import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { AuthSession } from "../auth.js";
import { getClusterNode } from "../cluster.js";
import { appendBobMessage, bobDatabase } from "../control-center/bob-store.js";
import type { BobTeamHint } from "../control-center/decisions.js";
import { formatTeamRequest, teamReasonText } from "../assistant-teams/control-text.js";
import type { TeamRequestView } from "../assistant-teams/assignments.js";
import { onTeamChange } from "../assistant-teams/invalidation.js";
import { bobSessionFor } from "./control-center-session.js";
import { broadcastToAllClients } from "./realtime.js";
import { hubOverview, hubRequestsOn, type TeamRef } from "./team-hub.js";

// What Bob promised to bring back, kept on disk so that a restart of this machine, or of the team's host, does not lose it. A
// request is settled when its end is known: the host tells this machine when it ends (team-notices.ts), a machine that was away
// asks the host when it returns or starts, and a team on this very machine is seen as it changes. Nothing polls on a timer.

function schema(db: DatabaseSync): DatabaseSync {
  db.exec(`CREATE TABLE IF NOT EXISTS bob_team_follows (
    account_id TEXT NOT NULL, request_id TEXT NOT NULL, team_id TEXT NOT NULL, cluster_id TEXT NOT NULL, host_node_id TEXT NOT NULL,
    label TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (account_id, request_id));
    CREATE TABLE IF NOT EXISTS bob_team_hints (account_id TEXT PRIMARY KEY, teams TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  return db;
}
const database = async (): Promise<DatabaseSync> => schema(await bobDatabase());

/** A request this machine's Bob is waiting on, and for how long it is waited for. */
const KEEP_MS = 14 * 24 * 3600_000;
const ANSWER_CHARS = 4_000;
const changed = (accountId: string): void => broadcastToAllClients({ type: "controlCenterChanged" }, accountId);
const ended = (view: TeamRequestView): boolean => view.state !== "running" && view.state !== "queued";

/** What the host says of an ended request: checked on arrival, as it comes from another machine. */
export const requestViewSchema = z.object({
  id: z.string().max(100), shortId: z.string().max(20), text: z.string().max(25_000), requestedBy: z.string().max(100), chatId: z.string().max(100), createdAt: z.string().max(40), browser: z.boolean(),
  state: z.enum(["running", "queued", "needs_you", "stopped", "done", "cancelled"]),
  assignments: z.array(z.object({
    role: z.string().max(40), state: z.enum(["accepted", "queued", "running", "waiting_for_human", "completed", "failed", "cancelled", "uncertain"]), delegated: z.boolean(),
    reason: z.string().max(500).nullable(), conversationId: z.string().max(100).nullable(), result: z.string().max(10_000).nullable(),
  }).strict()).max(50),
}).strict();

/** What Bob says in the chat when a request has ended: its answer, or why it stopped. Null when the person stopped it themselves. */
export function endText(label: string, view: TeamRequestView): string | null {
  if (view.state === "cancelled") return null;
  const part = view.assignments.find((entry) => !entry.delegated);
  if (view.state === "done") return `${label} answered:\n\n${(part?.result ?? "").trim().slice(0, ANSWER_CHARS) || "(an empty answer)"}`;
  return `${label} ${view.state === "needs_you" ? "is waiting for you" : "stopped without a result"}${part?.reason ? `: ${teamReasonText(part.reason)}` : ""}. Ask me to run it again if you want.\n\n${formatTeamRequest(view)}`;
}

export async function followTeamRequest(accountId: string, ref: TeamRef, label: string, requestId: string): Promise<void> {
  const db = await database();
  db.prepare("DELETE FROM bob_team_follows WHERE created_at < ?").run(new Date(Date.now() - KEEP_MS).toISOString());
  db.prepare("INSERT OR IGNORE INTO bob_team_follows VALUES (?,?,?,?,?,?,?,?)").run(accountId, requestId, ref.teamId, ref.clusterId, ref.hostNodeId, label, "following", new Date().toISOString());
}
/** The person stopped it: there is nothing left to bring back. */
export async function closeTeamFollow(accountId: string, requestId: string): Promise<void> {
  (await database()).prepare("UPDATE bob_team_follows SET state='closed' WHERE account_id=? AND request_id=? AND state='following'").run(accountId, requestId);
}

interface Follow { account_id: string; request_id: string; team_id: string; cluster_id: string; host_node_id: string; label: string }

/** Settles a follow once, however many ways (the host's notice, a pull, a local change) learn of its end at the same time. */
async function settle(follow: Follow, view: TeamRequestView): Promise<boolean> {
  const db = await database();
  if (!db.prepare("UPDATE bob_team_follows SET state='done' WHERE account_id=? AND request_id=? AND state='following'").run(follow.account_id, follow.request_id).changes) return false;
  const text = endText(follow.label, view);
  if (text) appendBobMessage(db, follow.account_id, { role: "bob", text, importance: view.state === "done" ? "report" : "needs-you", via: "Team · its answer" });
  changed(follow.account_id);
  return true;
}

/** The host says a request ended. Only the machine that hosts the follow's team may say so. */
export async function applyTeamNotice(senderNodeId: string, view: TeamRequestView): Promise<number> {
  const rows = (await database()).prepare("SELECT * FROM bob_team_follows WHERE request_id=? AND host_node_id=? AND state='following'").all(view.id, senderNodeId) as unknown as Follow[];
  let settled = 0;
  for (const follow of rows) if (ended(view) && await settle(follow, view)) settled += 1;
  return settled;
}

/**
 * Asks the host about every request still followed (for one host or team when named): this machine just started or the host
 * just came back, so a notice may have been missed. A host that cannot be reached leaves the follow where it is.
 */
export async function resumeTeamFollows(only: { hostNodeId?: string; teamId?: string } = {}): Promise<void> {
  const rows = (await database()).prepare("SELECT * FROM bob_team_follows WHERE state='following'").all() as unknown as Follow[];
  const wanted = rows.filter((row) => (!only.hostNodeId || row.host_node_id === only.hostNodeId) && (!only.teamId || row.team_id === only.teamId));
  const teams = new Map<string, Follow[]>();
  for (const row of wanted) teams.set(`${row.account_id}:${row.team_id}`, [...teams.get(`${row.account_id}:${row.team_id}`) ?? [], row]);
  await Promise.all([...teams.values()].map(async (follows) => {
    const session = bobSessionFor(follows[0].account_id, "follow");
    if (!session) return;
    try {
      const views = await hubRequestsOn(session, { clusterId: follows[0].cluster_id, hostNodeId: follows[0].host_node_id, teamId: follows[0].team_id });
      for (const follow of follows) {
        const view = views.find((candidate) => candidate.id === follow.request_id);
        if (view && ended(view)) await settle(follow, view);
      }
    } catch (error) {
      console.warn(`Could not ask ${follows[0].host_node_id} about the team requests Bob follows: ${error instanceof Error ? error.message : error}`);
    }
  }));
}

let watching = false;
/** A team on this machine changes: the requests followed there may have ended. */
export async function watchLocalTeamFollows(): Promise<void> {
  if (watching) return;
  watching = true;
  const here = (await getClusterNode()).id;
  onTeamChange((teamId) => { void resumeTeamFollows({ hostNodeId: here, teamId }).catch((error) => console.warn(`Could not check the team requests Bob follows: ${error instanceof Error ? error.message : error}`)); });
  await resumeTeamFollows();
}

// ── What the decision model is told of the person's teams ───────────────────────────────────────────────

const HINTS_FRESH_MS = 5 * 60_000;
const refreshing = new Set<string>();

async function refreshHints(session: AuthSession): Promise<BobTeamHint[]> {
  const { teams } = await hubOverview(session, true);
  const hints = teams.map((team) => ({ name: team.clusterName, roles: team.members.map((member) => member.role) }));
  (await database()).prepare("INSERT INTO bob_team_hints VALUES (?,?,?) ON CONFLICT(account_id) DO UPDATE SET teams=excluded.teams, updated_at=excluded.updated_at").run(session.accountId, JSON.stringify(hints), new Date().toISOString());
  return hints;
}

/**
 * The teams of the person's clusters and their members' roles, as last seen: kept on disk, so a restarted machine still knows
 * them. The first time ever it looks (waiting for the network once); after that it is refreshed in the background.
 */
export async function bobTeamHints(session: AuthSession): Promise<BobTeamHint[]> {
  const row = (await database()).prepare("SELECT teams, updated_at FROM bob_team_hints WHERE account_id=?").get(session.accountId) as { teams: string; updated_at: string } | undefined;
  if (!row) return refreshHints(session).catch((error) => { console.warn(`Could not look for the teams of the person's clusters: ${error instanceof Error ? error.message : error}`); return []; });
  if (Date.now() - Date.parse(row.updated_at) > HINTS_FRESH_MS && !refreshing.has(session.accountId)) {
    refreshing.add(session.accountId);
    void refreshHints(session).catch((error) => console.warn(`Could not refresh the teams: ${error instanceof Error ? error.message : error}`)).finally(() => refreshing.delete(session.accountId));
  }
  return z.array(z.object({ name: z.string(), roles: z.array(z.string()) })).parse(JSON.parse(row.teams));
}
