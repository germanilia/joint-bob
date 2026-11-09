import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { AuthSession } from '../../auth.js';
import { app } from '../state.js';
import { requireClusterMember, requirePeerClusterMember, requireTeamMember, teamMemberFromCluster, teamMembershipRevision, type ClusterMember } from '../../assistant-teams/access.js';
import { createTeam, getTeam, getTeamAssignment, insertTeamAssignment, listTeamAgents, listTeams, prepareTeamProject, resolveTeamExecutor, saveTeamSettings, announceTeamChange, teamDatabase, TeamError } from '../../assistant-teams/store.js';
import { initializeTeamAgents, runTeamTurn, teamAgentReadiness } from '../../assistant-teams/runtime.js';
import { getPersonalAssistant, savePersonalAssistant, personalAssistantDatabase } from '../../personal-assistants.js';
import { assistantResourcePreferences, saveResourcePreferences } from './assistant-resources.js';
import { listAssistantFiles, saveAssistantFile, deleteAssistantFile } from '../../assistant-capabilities.js';
import { listWebhookSkills, uploadWebhookSkill, removeWebhookSkill } from '../../webhook-skills.js';
import { asNode } from '../../account-context.js';
import { WebhookResourceError } from '../../webhook-resources.js';

const id = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/);
const clusterId = z.string().uuid();
const settings = z.object({ askThreshold: z.number().finite(), actThreshold: z.number().finite() }).strict();
const revision = z.number().int().positive();
const operations = {
  list: z.object({}).strict(),
  create: z.object({}).strict(),
  get: z.object({ teamId: id }).strict(),
  settings: z.object({ teamId: id, settings, expectedRevision: revision }).strict(),
};
type Operation = keyof typeof operations;
function route(handler: (request: Request, response: Response) => Promise<unknown>) {
  return (request: Request, response: Response, next: NextFunction): void => {
    handler(request, response).then(result => response.json(result)).catch(error => {
      if (error instanceof TeamError) { response.status(error.status).json({ error: error.message }); return; }
      if (error instanceof WebhookResourceError) { response.status(error.statusCode).json({ error: error.message }); return; }
      if (error instanceof z.ZodError) { response.status(400).json({ error: 'Invalid team request' }); return; }
      next(error);
    });
  };
}
async function operate(member: ClusterMember, operation: Operation, body: unknown): Promise<unknown> {
  const input = operations[operation].parse(body);
  const snapshotRevision = await teamMembershipRevision(member.clusterId);
  if (operation === 'list') return { teams: await listTeams(member), snapshotRevision };
  if (operation === 'create') {
    const existing = (await listTeams(member))[0];
    if (existing) { await initializeTeamAgents(existing); throw new TeamError('Team already exists for this cluster and host', 409); }
    const executorAccountId = await resolveTeamExecutor();
    const projectId = await prepareTeamProject(member);
    const team = await createTeam(member, { projectId, executorAccountId });
    await initializeTeamAgents(team);
    return { team, snapshotRevision };
  }
  const target = input as { teamId: string };
  const actor = await teamMemberFromCluster(member, target.teamId);
  if (operation === 'get') {
    const team = await getTeam(target.teamId); await initializeTeamAgents(team);
    return { team, snapshotRevision };
  }
  const update = operations.settings.parse(input);
  return { team: await saveTeamSettings(actor, update.settings, update.expectedRevision), snapshotRevision };
}
function session(response: Response): AuthSession {
  const value = response.locals.authSession as AuthSession | undefined;
  if (!value) throw new TeamError('Authentication required', 401); return value;
}
app.get('/api/assistant-teams', route(async (request, response) => {
  const input = z.object({ clusterId }).strict().parse(request.query);
  return operate(await requireClusterMember(session(response), input.clusterId), 'list', {});
}));
app.post('/api/assistant-teams', route(async (request, response) => {
  const input = z.object({ clusterId }).strict().parse(request.body);
  const result = await operate(await requireClusterMember(session(response), input.clusterId), 'create', {});
  response.status(201); return result;
}));
app.get('/api/assistant-teams/:id', route(async (request, response) => {
  const teamId = id.parse(request.params.id);
  return operate(await requireTeamMember(session(response), teamId), 'get', { teamId });
}));
app.put('/api/assistant-teams/:id/settings', route(async (request, response) => {
  const input = z.object({ settings, expectedRevision: revision }).strict().parse(request.body);
  const teamId = id.parse(request.params.id);
  return operate(await requireTeamMember(session(response), teamId), 'settings', { ...input, teamId });
}));

const roleSchema = z.enum(['bob', 'product', 'designer', 'qa', 'pr_reviewer', 'support']);
async function agent(request: Request, response: Response) {
  const teamId = id.parse(request.params.id);
  await requireTeamMember(session(response), teamId);
  const team = await getTeam(teamId); await initializeTeamAgents(team);
  const role = roleSchema.parse(request.params.role);
  const entry = (await listTeamAgents(teamId)).find(item => item.role === role)!;
  const profile = await getPersonalAssistant(team.executorAccountId, entry.assistantId);
  if (!profile) throw new TeamError('Team agent unavailable', 503);
  return { team, profile };
}
async function changeRevision(teamId: string, expected: number) {
  if (!(await teamDatabase()).prepare('UPDATE assistant_teams SET revision=revision+1 WHERE id=? AND revision=?').run(teamId, expected).changes) throw new TeamError('Stale team revision', 409);
  announceTeamChange(teamId);
}
app.get('/api/assistant-teams/:id/agents', route(async (request, response) => {
  const teamId = id.parse(request.params.id); await requireTeamMember(session(response), teamId);
  const team = await getTeam(teamId); const agents = await initializeTeamAgents(team);
  return { revision: team.revision, agents: await Promise.all(agents.map(async item => {
    const profile = (await getPersonalAssistant(team.executorAccountId, item.assistantId))!;
    return { ...item, profile, readiness: await asNode(() => teamAgentReadiness(profile)) };
  })) };
}));
app.put('/api/assistant-teams/:id/agents/:role', route(async (request, response) => {
  const { team, profile } = await agent(request, response);
  const body = z.object({ expectedRevision: revision, name: z.string().trim().min(1).max(100), instructions: z.string().max(20000),
    allowTerminal: z.boolean(), executionSettings: z.object({ harnessId: z.literal('pi'), provider: z.string().min(1).max(100), modelId: z.string().min(1).max(200), reasoning: z.string().min(1).max(100) }).strict() }).strict().parse(request.body);
  await changeRevision(team.id, body.expectedRevision);
  const updated = await savePersonalAssistant(team.executorAccountId, { ...profile, ...body }, profile.id);
  return { profile: updated, revision: (await getTeam(team.id)).revision, readiness: await asNode(() => teamAgentReadiness(updated)) };
}));
app.get('/api/assistant-teams/:id/agents/:role/resources', route(async (request, response) => {
  const { team, profile } = await agent(request, response);
  // Only resources uploaded to this role. Never call executor-wide inventory or profile listing.
  return { revision: team.revision, preferences: await assistantResourcePreferences(profile.id), files: await listAssistantFiles(profile.id),
    skills: listWebhookSkills(await personalAssistantDatabase(), profile.id), plugins: [], mcpServers: [], logins: [], savedLogins: [] };
}));
app.put('/api/assistant-teams/:id/agents/:role/resources', route(async (request, response) => {
  const { team, profile } = await agent(request, response);
  const body = z.object({ expectedRevision: revision, disabledSkills: z.array(z.string().min(1).max(200)).max(1000) }).strict().parse(request.body);
  const available = listWebhookSkills(await personalAssistantDatabase(), profile.id).map(skill => skill.name);
  if (body.disabledSkills.some(name => !available.includes(name))) throw new TeamError('Unknown team skill', 400);
  await changeRevision(team.id, body.expectedRevision);
  await saveResourcePreferences(profile.id, { disabledSkills: body.disabledSkills, disabledPlugins: [] });
  return { preferences: await assistantResourcePreferences(profile.id), revision: (await getTeam(team.id)).revision };
}));
app.post('/api/assistant-teams/:id/agents/:role/files', route(async (request, response) => {
  const { team, profile } = await agent(request, response);
  const body = z.object({ name: z.string().min(1).max(240), data: z.string().max(28_000_000) }).strict().parse(request.body);
  await saveAssistantFile(profile.id, body.name, Buffer.from(body.data, 'base64'));
  announceTeamChange(team.id);
  return { files: await listAssistantFiles(profile.id) };
}));
app.delete('/api/assistant-teams/:id/agents/:role/files', route(async (request, response) => {
  const { team, profile } = await agent(request, response);
  await deleteAssistantFile(profile.id, z.string().min(1).max(1000).parse(request.query.path));
  announceTeamChange(team.id);
  return { files: await listAssistantFiles(profile.id) };
}));
app.post('/api/assistant-teams/:id/agents/:role/skills', route(async (request, response) => {
  const { team, profile } = await agent(request, response);
  const body = z.object({ files: z.array(z.object({ relativePath: z.string().min(1).max(1000), data: z.string().max(5_592_408) }).strict()).max(100) }).strict().parse(request.body);
  const db = await personalAssistantDatabase();
  await uploadWebhookSkill(db, profile.id, body.files.map(file => ({ ...file, data: Buffer.from(file.data, 'base64') })));
  announceTeamChange(team.id);
  return { skills: listWebhookSkills(db, profile.id) };
}));
app.delete('/api/assistant-teams/:id/agents/:role/skills/:skillId', route(async (request, response) => {
  const { team, profile } = await agent(request, response); const db = await personalAssistantDatabase();
  await removeWebhookSkill(db, profile.id, id.parse(request.params.skillId));
  announceTeamChange(team.id);
  return { skills: listWebhookSkills(db, profile.id) };
}));
// Explicit member-selected subject execution; no personal topic classifier.
app.post('/api/assistant-teams/:id/agents/:role/turn', route(async (request, response) => {
  const member = await requireTeamMember(session(response), id.parse(request.params.id));
  const role = roleSchema.parse(request.params.role);
  const body = z.object({ subjectId: id, requestId: z.string().uuid(), message: z.string().trim().min(1).max(20000) }).strict().parse(request.body);
  const team = await getTeam(member.teamId); await initializeTeamAgents(team);
  const assignmentId = body.requestId;
  let assignment = await getTeamAssignment(assignmentId);
  if (!assignment) {
    assignment = { id: assignmentId, teamId: team.id, rootId: assignmentId, parentId: null, subjectId: body.subjectId, role, requestedBy: member.accountId, sourceMessageId: body.requestId, destination: { kind: 'group', sourceMessageId: body.requestId }, state: 'accepted', requestId: body.requestId };
    try { await insertTeamAssignment(assignment); }
    catch (error) {
      if (!String(error).includes('UNIQUE')) throw error;
      const existing = await getTeamAssignment(assignmentId); if (!existing) throw error;
      assignment = existing;
    }
  }
  if (assignment.teamId !== team.id || assignment.role !== role || assignment.subjectId !== body.subjectId || assignment.requestedBy !== member.accountId) throw new TeamError('Request ID belongs to another assignment', 409);
  return runTeamTurn({ assignment, message: body.message });
}));
// Execution of an already accepted, selected-subject assignment. Lifecycle/delivery belongs to Task 6.
app.post('/api/assistant-teams/:id/assignments/:assignmentId/run', route(async (request, response) => {
  const member = await requireTeamMember(session(response), id.parse(request.params.id));
  const assignment = await getTeamAssignment(id.parse(request.params.assignmentId));
  if (!assignment || assignment.teamId !== member.teamId || assignment.requestedBy !== member.accountId) throw new TeamError('Assignment is not this initiating member\'s', 403);
  const body = z.object({ message: z.string().trim().min(1).max(20000) }).strict().parse(request.body);
  return runTeamTurn({ assignment, message: body.message });
}));

// Not a generic account proxy: the signed home asserts exactly one account's selected
// cluster membership. Middleware verifies signature, nonce, recipient and relay sender.
app.post('/api/cluster/v2/assistant-teams/:operation', route(async (request, response) => {
  if (response.locals.machineProtocol !== 2) throw new TeamError('Signed machine request required', 403);
  const operation = request.params.operation as Operation;
  if (!Object.hasOwn(operations, operation)) throw new TeamError('Unknown team operation', 404);
  const { member, ...body } = z.object({ member: z.object({ clusterId, accountId: id, homeNodeId: z.string().uuid(), username: z.string().min(1).max(80) }).strict() }).passthrough().parse(request.body);
  // Validate the operation BEFORE persisting any home assertion.
  operations[operation].parse(body);
  return operate(await requirePeerClusterMember(String(response.locals.machineNodeId), member), operation, body);
}));
