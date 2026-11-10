import type { DatabaseSync } from 'node:sqlite';
import type { AuthSession } from '../auth.js';
import { listLocalUsers, listReplicatedUsers, visitorClusterIds, validUsername } from '../auth.js';
import { accountIdFor, canonicalLocalHome } from '../accounts.js';
import { accountInCluster } from '../cluster-accounts.js';
import { getClusterNode } from '../cluster.js';
import { getMembershipSnapshot } from '../cluster-membership.js';
import { pinnedClusterPublicKey, verifyClusterMessage } from '../cluster-identity.js';
import { getTeam, teamDatabase, TeamError } from './store.js';

export interface ClusterMember { clusterId: string; accountId: string; homeNodeId: string; username: string }
export interface TeamMember extends ClusterMember { teamId: string }
const issued = new WeakSet<object>();

/** Only the installed, cryptographically verified snapshot is authoritative. No home-node polling. */
export async function teamMembershipRevision(clusterId: string): Promise<number> {
  try {
    const db = await teamDatabase();
    const snapshot = getMembershipSnapshot(db, clusterId);
    const key = pinnedClusterPublicKey(db, snapshot.signerNodeId);
    const local = (await getClusterNode()).id;
    if (!key || snapshot.signerNodeId !== snapshot.body.managerNodeId || !verifyClusterMessage(key, 'membership-snapshot', JSON.stringify(snapshot.body), snapshot.signature)
      || snapshot.body.closed || !snapshot.body.members.some(m => m.nodeId === local)) throw new Error();
    return snapshot.body.revision;
  } catch { throw new TeamError('Missing, invalid or closed cluster snapshot', 403); }
}

async function verify(member: ClusterMember): Promise<void> {
  await teamMembershipRevision(member.clusterId);
  const db = await teamDatabase();
  verifyReceivedMember(db, member);
}

/** Synchronous form for ordinary project inventory/transcript authorization. */
export function verifyReceivedMember(db: DatabaseSync, member: ClusterMember): void {
  const snapshot = getMembershipSnapshot(db, member.clusterId);
  const key = pinnedClusterPublicKey(db, snapshot.signerNodeId);
  if (!key || snapshot.body.closed || snapshot.signerNodeId !== snapshot.body.managerNodeId
    || !verifyClusterMessage(key, 'membership-snapshot', JSON.stringify(snapshot.body), snapshot.signature)) throw new TeamError('Invalid membership snapshot', 403);
  if (!validUsername(member.username) || accountIdFor(member.homeNodeId, member.username) !== member.accountId
    || !snapshot.body.members.some(m => m.nodeId === member.homeNodeId)) throw new TeamError('Account home is not a cluster member', 403);
  const localHome = canonicalLocalHome(db);
  if (member.homeNodeId === localHome) {
    if (!listLocalUsers().some(u => !u.disabled && u.accountId === member.accountId && u.username === member.username)
      || !accountInCluster(db, member.accountId, member.clusterId)) throw new TeamError('Account is not a cluster member', 403);
  } else {
    const received = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_replication_received'").get()
      ? db.prepare('SELECT accounts FROM account_replication_received WHERE home_node_id=?').get(member.homeNodeId) as { accounts: string } | undefined : undefined;
    if (received && !(JSON.parse(received.accounts) as { accountId: string; clusterIds: string[] }[]).some(a => a.accountId === member.accountId && a.clusterIds.includes(member.clusterId)))
      throw new TeamError('Received account snapshot denies membership', 403);
    const knownVisitor = listReplicatedUsers().some(u => u.homeNodeId === member.homeNodeId && u.username === member.username);
    const visitor = knownVisitor && visitorClusterIds(member.accountId).includes(member.clusterId);
    const claim = db.prepare('SELECT 1 FROM assistant_team_home_claims WHERE cluster_id=? AND account_id=? AND home_node_id=? AND username=? AND join_sequence=?')
      .get(member.clusterId, member.accountId, member.homeNodeId, member.username, snapshot.body.members.find(m => m.nodeId === member.homeNodeId)!.joinSequence);
    // A received visitor update that removes a cluster supersedes older facade claims.
    if (knownVisitor ? !visitor : !claim) throw new TeamError('No authenticated home cluster claim', 403);
  }
}

export async function requireClusterMember(session: AuthSession, clusterId: string): Promise<ClusterMember> {
  const db = await teamDatabase();
  const member = { clusterId, accountId: session.accountId, username: session.username, homeNodeId: session.homeNodeId ?? canonicalLocalHome(db) };
  await verify(member); Object.freeze(member); issued.add(member); return member;
}

/** Called only after the signed machine transport has authenticated senderNodeId. */
export async function requirePeerClusterMember(senderNodeId: string, claim: ClusterMember): Promise<ClusterMember> {
  await teamMembershipRevision(claim.clusterId);
  const db = await teamDatabase();
  const home = getMembershipSnapshot(db, claim.clusterId).body.members.find(m => m.nodeId === senderNodeId);
  if (!home || !validUsername(claim.username) || senderNodeId !== claim.homeNodeId || accountIdFor(senderNodeId, claim.username) !== claim.accountId)
    throw new TeamError('Sender cannot assert this account home', 403);
  db.prepare('INSERT OR REPLACE INTO assistant_team_home_claims VALUES(?,?,?,?,?)').run(claim.clusterId, claim.accountId, claim.homeNodeId, claim.username, home.joinSequence);
  const member = Object.freeze({ ...claim }); await verify(member); issued.add(member); return member;
}

export async function recheckTeamActor(member: ClusterMember): Promise<void> {
  if (!issued.has(member)) throw new TeamError('Unverified team actor', 403);
  await verify(member);
}

export async function requireTeamMember(session: AuthSession, teamId: string): Promise<TeamMember> {
  const team = await getTeam(teamId);
  const member = Object.freeze({ ...await requireClusterMember(session, team.clusterId), teamId });
  issued.add(member); return member;
}

export async function teamMemberFromCluster(member: ClusterMember, teamId: string): Promise<TeamMember> {
  await recheckTeamActor(member);
  if ((await getTeam(teamId)).clusterId !== member.clusterId) throw new TeamError('Wrong cluster', 403);
  const result = Object.freeze({ ...member, teamId }); issued.add(result); return result;
}

/** accountId is the initiating human, not the local runtime owner. */
export async function requireTeamExecution(teamId: string, accountId: string): Promise<TeamMember> {
  const team = await getTeam(teamId);
  if (team.hostNodeId !== (await getClusterNode()).id) throw new TeamError('Team must execute on its host', 403);
  if (!listLocalUsers().some(u => u.accountId === team.executorAccountId && !u.disabled)) throw new TeamError('Host execution account is unavailable', 503);
  const db = await teamDatabase();
  const local = listLocalUsers().find(u => u.accountId === accountId && !u.disabled);
  const visitor = listReplicatedUsers().find(u => accountIdFor(u.homeNodeId, u.username) === accountId);
  const claim = db.prepare('SELECT home_node_id homeNodeId, username FROM assistant_team_home_claims WHERE cluster_id=? AND account_id=?').get(team.clusterId, accountId) as { homeNodeId: string; username: string } | undefined;
  const identity = local ? { homeNodeId: canonicalLocalHome(db), username: local.username } : visitor ?? claim;
  if (!identity) throw new TeamError('Unknown initiating member', 403);
  const member = Object.freeze({ clusterId: team.clusterId, teamId, accountId, homeNodeId: identity.homeNodeId, username: identity.username });
  await verify(member); issued.add(member); return member;
}
