import { randomUUID } from 'node:crypto';
import { announceTeamChange } from './invalidation.js';
export { announceTeamChange, onTeamChange, scheduleTeamChange } from './invalidation.js';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { clusterV2Database } from '../cluster-v2-store.js';
import { getClusterNode } from '../cluster.js';
import { listLocalUsers } from '../auth.js';
import { adminAccountId } from '../ownership.js';
import { asNode } from '../account-context.js';
import { addProject, saveWorkspace } from '../store.js';
import { setWorkspaceSharing } from '../workspace-sharing.js';
import { resolveDataDirectory } from '../data-directory.js';
import { recheckTeamActor, requireTeamExecution, type ClusterMember, type TeamMember } from './access.js';

/** A free role name chosen when an assistant is picked into a team; it is also its Telegram command. */
export type TeamRole = string;
export const TEAM_ROLE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export interface TeamSettings { askThreshold: number; actThreshold: number }
export interface AssistantTeam { id: string; clusterId: string; hostNodeId: string; projectId: string; executorAccountId: string; settings: TeamSettings; revision: number; coordinatorRole: string | null }
export interface TeamAgent { teamId: string; role: TeamRole; assistantId: string }
export interface TeamMessage { id: string; teamId: string; accountId: string; chatId: string; telegramMessageId: number; threadId: number | null; replyToMessageId: number | null; text: string; revision: number; createdAt: string }
export interface TeamSubject { id: string; teamId: string; title: string; summary: string }
export type TeamRoute = { kind: 'new' } | { kind: 'continue'; subjectId: string } | { kind: 'clarify' };
export type AssignmentState = 'accepted' | 'queued' | 'running' | 'waiting_for_human' | 'completed' | 'failed' | 'cancelled' | 'uncertain';
export type ResultDestination = { kind: 'group'; sourceMessageId: string } | { kind: 'bob'; parentAssignmentId: string };
export interface TeamAssignment { id: string; teamId: string; rootId: string; parentId: string | null; subjectId: string | null; role: TeamRole; requestedBy: string; sourceMessageId: string; destination: ResultDestination; state: AssignmentState; requestId: string }
export class TeamError extends Error { constructor(message: string, readonly status: number) { super(message); } }
let prepared: Promise<DatabaseSync> | undefined;
export function teamDatabase(): Promise<DatabaseSync> {
  return prepared ??= clusterV2Database().then(db => {
    db.exec(`CREATE TABLE IF NOT EXISTS assistant_teams (
      id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, host_node_id TEXT NOT NULL, project_id TEXT NOT NULL UNIQUE,
      executor_account_id TEXT NOT NULL, settings TEXT NOT NULL, revision INTEGER NOT NULL, UNIQUE(cluster_id,host_node_id));
    CREATE TABLE IF NOT EXISTS assistant_team_agents (team_id TEXT NOT NULL REFERENCES assistant_teams(id), role TEXT NOT NULL, assistant_id TEXT NOT NULL UNIQUE, PRIMARY KEY(team_id,role));
    CREATE TABLE IF NOT EXISTS assistant_team_assignments (id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES assistant_teams(id), request_id TEXT NOT NULL, record TEXT NOT NULL, UNIQUE(team_id,request_id));
    CREATE TABLE IF NOT EXISTS assistant_team_projects (project_id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, executor_account_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assistant_team_mcp_selection (team_id TEXT NOT NULL, role TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(team_id,role,name));
    CREATE TABLE IF NOT EXISTS assistant_team_browser_selection (team_id TEXT NOT NULL, role TEXT NOT NULL, profile_id TEXT NOT NULL, PRIMARY KEY(team_id,role));
    CREATE TABLE IF NOT EXISTS assistant_team_plugins (team_id TEXT NOT NULL, role TEXT NOT NULL, name TEXT NOT NULL, selected INTEGER NOT NULL, PRIMARY KEY(team_id,role,name));
    CREATE TABLE IF NOT EXISTS assistant_team_home_claims (cluster_id TEXT NOT NULL, account_id TEXT NOT NULL, home_node_id TEXT NOT NULL, username TEXT NOT NULL, join_sequence INTEGER NOT NULL, PRIMARY KEY(cluster_id,account_id));`);
    const columns = db.prepare('PRAGMA table_info(assistant_teams)').all().map(row => (row as { name: string }).name);
    if (!columns.includes('coordinator_role')) {
      db.exec('ALTER TABLE assistant_teams ADD COLUMN coordinator_role TEXT');
      // Teams from the fixed six-role model keep Bob as their coordinator.
      db.exec("UPDATE assistant_teams SET coordinator_role='bob' WHERE id IN (SELECT team_id FROM assistant_team_agents WHERE role='bob')");
    }
    return db;
  }).catch(error => { prepared = undefined; throw error; });
}
const teamColumns = 'id, cluster_id clusterId, host_node_id hostNodeId, project_id projectId, executor_account_id executorAccountId, settings, revision, coordinator_role coordinatorRole';
function decode(row: unknown): AssistantTeam { const value = row as Omit<AssistantTeam, 'settings'> & { settings: string }; return { ...value, settings: JSON.parse(value.settings) }; }
export async function getTeam(id: string): Promise<AssistantTeam> {
  const row = (await teamDatabase()).prepare(`SELECT ${teamColumns} FROM assistant_teams WHERE id=?`).get(id);
  if (!row) throw new TeamError('Unknown team', 404); return decode(row);
}
export async function listTeams(member: ClusterMember): Promise<AssistantTeam[]> {
  await recheckTeamActor(member);
  return (await teamDatabase()).prepare(`SELECT ${teamColumns} FROM assistant_teams WHERE cluster_id=?`).all(member.clusterId).map(decode);
}
export async function selectedTeamMcp(teamId: string, role: TeamRole): Promise<string[]> {
  return (await teamDatabase()).prepare('SELECT name FROM assistant_team_mcp_selection WHERE team_id=? AND role=? ORDER BY name').all(teamId, role).map(row => (row as { name: string }).name);
}
export async function saveTeamMcpSelection(teamId: string, role: TeamRole, names: string[], expectedRevision: number): Promise<number> {
  const db = await teamDatabase();
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('UPDATE assistant_teams SET revision=revision+1 WHERE id=? AND revision=?').run(teamId, expectedRevision).changes) throw new TeamError('Stale team revision', 409);
    db.prepare('DELETE FROM assistant_team_mcp_selection WHERE team_id=? AND role=?').run(teamId, role);
    const insert = db.prepare('INSERT INTO assistant_team_mcp_selection VALUES(?,?,?)');
    for (const name of names) insert.run(teamId, role, name);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  announceTeamChange(teamId);
  return expectedRevision + 1;
}
export async function selectedTeamBrowser(teamId: string, role: TeamRole): Promise<string | null> {
  const row = (await teamDatabase()).prepare('SELECT profile_id FROM assistant_team_browser_selection WHERE team_id=? AND role=?').get(teamId, role) as { profile_id: string } | undefined;
  return row?.profile_id ?? null;
}
export async function saveTeamBrowserSelection(teamId: string, role: TeamRole, profileId: string | null, expectedRevision: number): Promise<number> {
  const db = await teamDatabase(); db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('UPDATE assistant_teams SET revision=revision+1 WHERE id=? AND revision=?').run(teamId, expectedRevision).changes) throw new TeamError('Stale team revision', 409);
    db.prepare('DELETE FROM assistant_team_browser_selection WHERE team_id=? AND role=?').run(teamId, role);
    if (profileId) db.prepare('INSERT INTO assistant_team_browser_selection VALUES(?,?,?)').run(teamId, role, profileId);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  announceTeamChange(teamId); return expectedRevision + 1;
}
export async function listTeamAgents(id: string): Promise<TeamAgent[]> {
  await getTeam(id);
  return (await teamDatabase()).prepare('SELECT team_id teamId, role, assistant_id assistantId FROM assistant_team_agents WHERE team_id=? ORDER BY rowid').all(id) as unknown as TeamAgent[];
}
/** Synchronous view for ledger transactions: member roles in order and the effective coordinator. */
export function teamRolesSync(db: DatabaseSync, teamId: string): { roles: TeamRole[]; coordinator: TeamRole | null } {
  const roles = db.prepare('SELECT role FROM assistant_team_agents WHERE team_id=? ORDER BY rowid').all(teamId).map(row => String((row as { role: string }).role));
  const chosen = (db.prepare('SELECT coordinator_role role FROM assistant_teams WHERE id=?').get(teamId) as { role: string | null } | undefined)?.role ?? null;
  return { roles, coordinator: chosen && roles.includes(chosen) ? chosen : roles[0] ?? null };
}
/** The coordinator monitors, acknowledges and alone delegates. Without one, the first member does. */
export async function teamCoordinator(team: AssistantTeam): Promise<TeamRole | null> {
  const roles = (await listTeamAgents(team.id)).map(agent => agent.role);
  return team.coordinatorRole && roles.includes(team.coordinatorRole) ? team.coordinatorRole : roles[0] ?? null;
}
/** Replaces the member list in one revisioned write. Callers check who may add which assistant. */
export async function saveTeamMembers(teamId: string, members: { role: TeamRole; assistantId: string }[], coordinatorRole: TeamRole | null, expectedRevision: number): Promise<number> {
  const roles = members.map(member => member.role);
  if (roles.some(role => !TEAM_ROLE_PATTERN.test(role)) || new Set(roles).size !== roles.length || new Set(members.map(member => member.assistantId)).size !== members.length) throw new TeamError('Each member needs a unique role name (a-z, 0-9, _) and a different assistant', 400);
  if (coordinatorRole !== null && !roles.includes(coordinatorRole)) throw new TeamError('The coordinator must be a member', 400);
  const db = await teamDatabase(); db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('UPDATE assistant_teams SET revision=revision+1, coordinator_role=? WHERE id=? AND revision=?').run(coordinatorRole, teamId, expectedRevision).changes) throw new TeamError('Stale team revision', 409);
    db.prepare('DELETE FROM assistant_team_agents WHERE team_id=?').run(teamId);
    const insert = db.prepare('INSERT INTO assistant_team_agents VALUES(?,?,?)');
    for (const member of members) insert.run(teamId, member.role, member.assistantId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    if (String(error).includes('UNIQUE')) throw new TeamError('That assistant is already in another team', 409);
    throw error;
  }
  announceTeamChange(teamId);
  return expectedRevision + 1;
}
export async function resolveTeamExecutor(): Promise<string> {
  const accountId = adminAccountId(await teamDatabase());
  if (!accountId || !listLocalUsers().some(u => u.accountId === accountId && !u.disabled)) throw new TeamError('No enabled host execution account', 503);
  return accountId;
}
/** Always allocates a NEW project. Existing personal projects are never adopted. */
export async function prepareTeamProject(member: ClusterMember): Promise<string> {
  await recheckTeamActor(member);
  const executor = await resolveTeamExecutor();
  const project = await asNode(async () => {
    const workspace = await saveWorkspace({ label: `Team ${randomUUID().slice(0, 30)}` });
    // Shared before the project exists, so the project inherits the share: the team's cluster sees the workspace it works in.
    setWorkspaceSharing(await clusterV2Database(), (await getClusterNode()).id, workspace.id, { clusterIds: [member.clusterId], nodeIds: [], relayIds: [] });
    return addProject('Assistant team', path.join(resolveDataDirectory(), 'assistant-teams', 'projects', randomUUID()), { type: workspace.id, teamScope: { clusterId: member.clusterId, executorAccountId: executor } });
  });
  return project.id;
}
export async function createTeam(member: ClusterMember, input: { projectId: string; executorAccountId: string }): Promise<AssistantTeam> {
  await recheckTeamActor(member);
  const db = await teamDatabase(); const host = (await getClusterNode()).id;
  if (input.executorAccountId !== await resolveTeamExecutor()) throw new TeamError('Invalid host execution identity', 403);
  const dedicated = db.prepare('SELECT 1 FROM assistant_team_projects WHERE project_id=? AND cluster_id=? AND executor_account_id=?').get(input.projectId, member.clusterId, input.executorAccountId);
  if (!dedicated) throw new TeamError('A new dedicated team project is required', 409);
  const team: AssistantTeam = { id: randomUUID(), clusterId: member.clusterId, hostNodeId: host, ...input, settings: { askThreshold: .8, actThreshold: .95 }, revision: 1, coordinatorRole: null };
  try { db.prepare('INSERT INTO assistant_teams (id,cluster_id,host_node_id,project_id,executor_account_id,settings,revision,coordinator_role) VALUES(?,?,?,?,?,?,?,NULL)').run(team.id, team.clusterId, host, team.projectId, team.executorAccountId, JSON.stringify(team.settings), 1); }
  catch (error) { if (String(error).includes('UNIQUE')) throw new TeamError('Team already exists for this cluster and host', 409); throw error; }
  announceTeamChange(team.id); return team;
}
export async function saveTeamSettings(member: TeamMember, settings: TeamSettings, expectedRevision: number): Promise<AssistantTeam> {
  await recheckTeamActor(member);
  const team = await getTeam(member.teamId);
  if (team.clusterId !== member.clusterId) throw new TeamError('Wrong cluster', 403);
  if (!Number.isFinite(settings.askThreshold) || !Number.isFinite(settings.actThreshold) || settings.askThreshold < 0 || settings.askThreshold >= settings.actThreshold || settings.actThreshold > 1 || !Number.isSafeInteger(expectedRevision)) throw new TeamError('Invalid thresholds or revision', 400);
  const db = await teamDatabase();
  if (!db.prepare('UPDATE assistant_teams SET settings=?, revision=revision+1 WHERE id=? AND revision=?').run(JSON.stringify(settings), team.id, expectedRevision).changes) throw new TeamError('Stale team revision', 409);
  announceTeamChange(team.id); return getTeam(team.id);
}
/** Base persistence only: dispatch and transitions belong to the assignment service. */
export async function insertTeamAssignment(assignment: TeamAssignment): Promise<void> {
  await requireTeamExecution(assignment.teamId, assignment.requestedBy);
  if (assignment.destination.kind === 'bob') {
    const parent = await getTeamAssignment(assignment.destination.parentAssignmentId);
    if (!parent || parent.teamId !== assignment.teamId || parent.id !== assignment.parentId || parent.rootId !== assignment.rootId) throw new TeamError('Invalid assignment parent', 400);
  } else if (assignment.destination.sourceMessageId !== assignment.sourceMessageId) throw new TeamError('Invalid source destination', 400);
  (await teamDatabase()).prepare('INSERT INTO assistant_team_assignments VALUES(?,?,?,?)').run(assignment.id, assignment.teamId, assignment.requestId, JSON.stringify(assignment));
  announceTeamChange(assignment.teamId);
}
export async function getTeamAssignment(id: string): Promise<TeamAssignment | undefined> {
  const row = (await teamDatabase()).prepare('SELECT record FROM assistant_team_assignments WHERE id=?').get(id) as { record: string } | undefined;
  return row ? JSON.parse(row.record) : undefined;
}
