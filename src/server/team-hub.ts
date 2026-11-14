import type { AuthSession } from '../auth.js';
import { getClusterNode } from '../cluster.js';
import { getSharingCluster } from '../cluster-sharing-policy.js';
import { requireClusterMember, type ClusterMember } from '../assistant-teams/access.js';
import { TeamError } from '../assistant-teams/store.js';
import type { TeamRequestView } from '../assistant-teams/assignments.js';
import { signedPost } from './cluster-assistants.js';
import { operate, type Operation } from './routes/assistant-teams.js';
import { peers } from './saved-commands.js';

// A team lives on one machine, its host. Everyone in the team's cluster may steer it from their own machine: this is the one
// place that treats a team on this machine and a team on another cluster member the same. A remote call goes over the signed
// machine channel and names the person's account; the host checks the cluster's signed membership before doing anything.

export interface HubMember { role: string; name: string | null; coordinator: boolean; ready: boolean; uses: string[] }
export interface HubTeam {
  id: string; clusterId: string; clusterName: string; hostNodeId: string; hostName: string; local: boolean;
  coordinatorRole: string | null; members: HubMember[];
}
const TARGET = (operation: Operation): string => `/api/cluster/v2/assistant-teams/${operation}`;
const PEER_TIMEOUT_MS = 8_000;
const CACHE_MS = 20_000;
const held = new Map<string, { at: number; teams: HubTeam[]; unreachable: string[] }>();

/** Runs one team operation on the team's host: here, or on the machine that hosts it. */
async function call<T>(member: ClusterMember, hostNodeId: string, operation: Operation, body: Record<string, unknown>): Promise<T> {
  if (hostNodeId === (await getClusterNode()).id) return await operate(member, operation, body) as T;
  const claim = { clusterId: member.clusterId, accountId: member.accountId, homeNodeId: member.homeNodeId, username: member.username };
  const response = await signedPost(hostNodeId, TARGET(operation), { member: claim, ...body }, PEER_TIMEOUT_MS).catch((error: unknown) => {
    throw new TeamError(`The machine that hosts the team did not answer: ${error instanceof Error ? error.message : String(error)}`, 503);
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) as { error?: string } : {};
  if (!response.ok) throw new TeamError(parsed.error ?? `The machine that hosts the team refused it (${response.status})`, response.status >= 500 ? 502 : response.status);
  return parsed as T;
}

async function teamsOn(member: ClusterMember, hostNodeId: string, clusterName: string, hostName: string): Promise<HubTeam[]> {
  const { teams } = await call<{ teams: Array<{ id: string; hostNodeId: string }> }>(member, hostNodeId, 'list', {});
  return Promise.all(teams.filter(team => team.hostNodeId === hostNodeId).map(async team => {
    const roster = await call<{ host: { name: string }; coordinatorRole: string | null; members: HubMember[] }>(member, hostNodeId, 'roster', { teamId: team.id });
    return { id: team.id, clusterId: member.clusterId, clusterName, hostNodeId, hostName: roster.host.name || hostName, local: hostNodeId === (await getClusterNode()).id, coordinatorRole: roster.coordinatorRole, members: roster.members };
  }));
}

export const hubTeams = async (session: AuthSession, fresh = false): Promise<HubTeam[]> => (await hubOverview(session, fresh)).teams;

/**
 * Every team of the clusters the person joined, on whichever machine hosts it. A machine that cannot be reached offers nothing for
 * now, and its clusters are named `unreachable`: a team there may exist, so no one should be offered a second.
 */
export async function hubOverview(session: AuthSession, fresh = false): Promise<{ teams: HubTeam[]; unreachable: string[] }> {
  const known = held.get(session.accountId);
  if (!fresh && known && Date.now() - known.at < CACHE_MS) return known;
  const context = await peers(), here = await getClusterNode();
  // A person signed in here with their account from another machine is a member through the cluster's signed membership, not a local row.
  const members = new Map<string, ClusterMember>();
  for (const cluster of context.clusters) {
    try { members.set(cluster.id, await requireClusterMember(session, cluster.id)); } catch { /* not a member of this one */ }
  }
  const mine = context.clusters.filter(cluster => members.has(cluster.id)), unreachable = new Set<string>();
  // Another machine takes a request as coming from the person's home machine only, so a visitor steers the teams of the machine they are on.
  const lookups = mine.flatMap(cluster => [here.id, ...members.get(cluster.id)!.homeNodeId === here.id ? context.nodes.filter(node => node.clusterIds.includes(cluster.id)).map(node => node.nodeId) : []].map(async hostNodeId => {
    try {
      const member = members.get(cluster.id)!;
      const hostName = hostNodeId === here.id ? here.name : context.nodes.find(node => node.nodeId === hostNodeId)?.name ?? hostNodeId;
      return await teamsOn(member, hostNodeId, getSharingCluster(context.db, cluster.id).name, hostName);
    } catch (error) {
      console.warn(`Could not list the teams of "${cluster.name}" on ${hostNodeId}: ${error instanceof Error ? error.message : error}`);
      unreachable.add(cluster.id);
      return [];
    }
  }));
  const teams = (await Promise.all(lookups)).flat().sort((a, b) => a.clusterName.localeCompare(b.clusterName) || a.hostName.localeCompare(b.hostName));
  const overview = { at: Date.now(), teams, unreachable: [...unreachable] };
  held.set(session.accountId, overview);
  return overview;
}

/** The teams from the last look, never a wait for the network; a stale look is refreshed in the background for the next message. */
const refreshing = new Set<string>();
export function knownTeams(session: AuthSession): HubTeam[] {
  const known = held.get(session.accountId);
  if ((!known || Date.now() - known.at >= CACHE_MS) && !refreshing.has(session.accountId)) {
    refreshing.add(session.accountId);
    void hubTeams(session, true).catch(error => console.warn(`Could not refresh the teams: ${error instanceof Error ? error.message : error}`)).finally(() => refreshing.delete(session.accountId));
  }
  return known?.teams ?? [];
}

async function teamFor(session: AuthSession, teamId: string): Promise<{ team: HubTeam; member: ClusterMember }> {
  const team = (await hubTeams(session)).find(candidate => candidate.id === teamId) ?? (await hubTeams(session, true)).find(candidate => candidate.id === teamId);
  if (!team) throw new TeamError('No such team among your clusters', 404);
  return { team, member: await requireClusterMember(session, team.clusterId) };
}

export async function hubRequests(session: AuthSession, teamId: string, limit?: number): Promise<TeamRequestView[]> {
  const { team, member } = await teamFor(session, teamId);
  return (await call<{ requests: TeamRequestView[] }>(member, team.hostNodeId, 'requests', { teamId, ...(limit ? { limit } : {}) })).requests;
}
export async function hubAssign(session: AuthSession, teamId: string, role: string | null, message: string, requestId: string): Promise<TeamRequestView> {
  const { team, member } = await teamFor(session, teamId);
  return (await call<{ request: TeamRequestView }>(member, team.hostNodeId, 'assign', { teamId, role, message, requestId })).request;
}
export async function hubCancel(session: AuthSession, teamId: string, ref: string | null): Promise<{ request: TeamRequestView; stopFailures: number }> {
  const { team, member } = await teamFor(session, teamId);
  return call(member, team.hostNodeId, 'cancel', { teamId, ref });
}
export async function hubRetry(session: AuthSession, teamId: string, ref: string | null): Promise<{ previous: TeamRequestView; request: TeamRequestView }> {
  const { team, member } = await teamFor(session, teamId);
  return call(member, team.hostNodeId, 'retry', { teamId, ref });
}
