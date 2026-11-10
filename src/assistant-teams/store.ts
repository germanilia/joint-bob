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
import { resolveDataDirectory } from '../data-directory.js';
import { recheckTeamActor, requireTeamExecution, type ClusterMember, type TeamMember } from './access.js';

export type TeamRole = 'bob' | 'product' | 'designer' | 'qa' | 'pr_reviewer' | 'support';
export interface TeamSettings { askThreshold: number; actThreshold: number }
export interface AssistantTeam { id: string; clusterId: string; hostNodeId: string; projectId: string; executorAccountId: string; settings: TeamSettings; revision: number }
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
    CREATE TABLE IF NOT EXISTS assistant_team_home_claims (cluster_id TEXT NOT NULL, account_id TEXT NOT NULL, home_node_id TEXT NOT NULL, username TEXT NOT NULL, join_sequence INTEGER NOT NULL, PRIMARY KEY(cluster_id,account_id));`);
    return db;
  }).catch(error => { prepared = undefined; throw error; });
}
const teamColumns = 'id, cluster_id clusterId, host_node_id hostNodeId, project_id projectId, executor_account_id executorAccountId, settings, revision';
function decode(row: unknown): AssistantTeam { const value = row as Omit<AssistantTeam, 'settings'> & { settings: string }; return { ...value, settings: JSON.parse(value.settings) }; }
export async function getTeam(id: string): Promise<AssistantTeam> {
  const row = (await teamDatabase()).prepare(`SELECT ${teamColumns} FROM assistant_teams WHERE id=?`).get(id);
  if (!row) throw new TeamError('Unknown team', 404); return decode(row);
}
export async function listTeams(member: ClusterMember): Promise<AssistantTeam[]> {
  await recheckTeamActor(member);
  return (await teamDatabase()).prepare(`SELECT ${teamColumns} FROM assistant_teams WHERE cluster_id=?`).all(member.clusterId).map(decode);
}
export async function listTeamAgents(id: string): Promise<TeamAgent[]> {
  await getTeam(id);
  return (await teamDatabase()).prepare('SELECT team_id teamId, role, assistant_id assistantId FROM assistant_team_agents WHERE team_id=? ORDER BY role').all(id) as unknown as TeamAgent[];
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
  const team: AssistantTeam = { id: randomUUID(), clusterId: member.clusterId, hostNodeId: host, ...input, settings: { askThreshold: .8, actThreshold: .95 }, revision: 1 };
  try { db.prepare('INSERT INTO assistant_teams VALUES(?,?,?,?,?,?,?)').run(team.id, team.clusterId, host, team.projectId, team.executorAccountId, JSON.stringify(team.settings), 1); }
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
