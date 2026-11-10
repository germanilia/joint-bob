import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { AuthSession } from '../../auth.js';
import { app } from '../state.js';
import { requireClusterMember, requirePeerClusterMember, requireTeamMember, teamMemberFromCluster, teamMembershipRevision, type ClusterMember } from '../../assistant-teams/access.js';
import { createTeam, getTeam, getTeamAssignment, listTeamAgents, listTeams, prepareTeamProject, resolveTeamExecutor, saveTeamSettings, announceTeamChange, onTeamChange, teamDatabase, TeamError } from '../../assistant-teams/store.js';
import { runBrowserTeamAssignment, confirmTeamInquiry, wakeTeamWork, resolveTeamApproval, teamWorkStatus, routeTeamAssignment } from '../../assistant-teams/assignments.js';
import { initializeTeamAgents, teamAgentReadiness } from '../../assistant-teams/runtime.js';
import { getPersonalAssistant, savePersonalAssistant, personalAssistantDatabase } from '../../personal-assistants.js';
import { assistantResourcePreferences, saveResourcePreferences } from './assistant-resources.js';
import { listAssistantFiles, saveAssistantFile, deleteAssistantFile } from '../../assistant-capabilities.js';
import { listWebhookSkills, uploadWebhookSkill, removeWebhookSkill } from '../../webhook-skills.js';
import { asNode } from '../../account-context.js';
import { managedMcpStore } from '../../mcp/agent.js';
import { selectedTeamMcp, saveTeamMcpSelection, selectedTeamBrowser, saveTeamBrowserSelection } from '../../assistant-teams/store.js';
import { teamBrowserProfile } from '../../assistant-teams/browser.js';
import { browserRuntime } from '../browser.js';
import { getClusterNode } from '../../cluster.js';
import { configuredTeamPlugins, teamPlugins } from '../../assistant-teams/plugins.js';
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
async function browserOwner(response: Response, teamId: string) {
  await requireTeamMember(session(response), teamId);
  const team = await getTeam(teamId);
  if (session(response).accountId !== team.executorAccountId || session(response).isRemoteLogin || team.hostNodeId !== (await getClusterNode()).id || (session(response).homeNodeId && session(response).homeNodeId !== team.hostNodeId))
    throw new TeamError('Only the local host execution account can create team browser profiles', 403);
  return team;
}
app.post('/api/assistant-teams/:id/browser-profiles', route(async (request, response) => {
  const team = await browserOwner(response, id.parse(request.params.id));
  const body = z.object({ expectedRevision: revision, label: z.string().trim().min(1).max(80) }).strict().parse(request.body);
  // Allocate a fresh persistent profile on this machine, never copy another profile's cookies.
  // Its first use goes through the normal browser sign-in card and human takeover.
  if (team.revision !== body.expectedRevision) throw new TeamError('Stale team revision', 409);
  const profile = browserRuntime().createTeamProfile(team.projectId, body.label);
  browserRuntime().grantProfileAccess(profile.id, { scope: 'project', projectId: team.projectId }, team.hostNodeId);
  await changeRevision(team.id, body.expectedRevision);
  announceTeamChange(team.id);
  return { profile: { id: profile.id, label: profile.label }, revision: body.expectedRevision + 1 };
}));
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
  announceTeamChange(team.id);
  wakeTeamWork(team.id);
  return { profile: updated, revision: (await getTeam(team.id)).revision, readiness: await asNode(() => teamAgentReadiness(updated)) };
}));
// Only the host execution account can approve its own node-local definition for this exact team.
app.put('/api/assistant-teams/:id/mcp-shares/:name', route(async (request, response) => {
  const teamId = id.parse(request.params.id);
  await requireTeamMember(session(response), teamId);
  const team = await getTeam(teamId);
  if (session(response).accountId !== team.executorAccountId || session(response).isRemoteLogin || (session(response).homeNodeId && session(response).homeNodeId !== team.hostNodeId) || team.hostNodeId !== (await (await import('../../cluster.js')).getClusterNode()).id)
    throw new TeamError('Only the host execution account can share MCP definitions', 403);
  const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/).parse(request.params.name);
  const body = z.object({ enabled: z.boolean(), expectedRevision: revision }).strict().parse(request.body);
  const store = managedMcpStore(team.executorAccountId);
  const server = store.servers()[name];
  if (!server || server.authMode === 'native') throw new TeamError('Shared-connection server not found', 404);
  await changeRevision(team.id, body.expectedRevision);
  store.setTeamShare(name, team.id, body.enabled);
  announceTeamChange(team.id);
  return { revision: (await getTeam(team.id)).revision };
}));
app.put('/api/assistant-teams/:id/plugin-shares/:name', route(async (request, response) => {
  const team = await browserOwner(response, id.parse(request.params.id));
  const name = id.parse(request.params.name);
  if (!configuredTeamPlugins().some(plugin => plugin.name === name)) throw new TeamError('Plugin is not app-configured', 404);
  const body = z.object({ enabled: z.boolean(), expectedRevision: revision }).strict().parse(request.body);
  const db = await teamDatabase(); db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('UPDATE assistant_teams SET revision=revision+1 WHERE id=? AND revision=?').run(team.id, body.expectedRevision).changes) throw new TeamError('Stale team revision', 409);
    db.prepare('DELETE FROM assistant_team_plugins WHERE team_id=? AND name=?').run(team.id, name);
    if (body.enabled) db.prepare('INSERT INTO assistant_team_plugins VALUES(?,?,?,0)').run(team.id, '', name);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  announceTeamChange(team.id);
  return { revision: body.expectedRevision + 1 };
}));
app.get('/api/assistant-teams/:id/agents/:role/resources', route(async (request, response) => {
  const { team, profile } = await agent(request, response);
  // Only resources uploaded to this role. Never call executor-wide inventory or profile listing.
  const store = managedMcpStore(team.executorAccountId);
  const servers = store.servers();
  const selected = await selectedTeamMcp(team.id, roleSchema.parse(request.params.role));
  const shared = Object.entries(servers).filter(([name]) => store.sharedWith(name, team.id));
  const owner = session(response).accountId === team.executorAccountId && !session(response).isRemoteLogin && (!session(response).homeNodeId || session(response).homeNodeId === team.hostNodeId) && team.hostNodeId === (await (await import('../../cluster.js')).getClusterNode()).id;
  const db = await teamDatabase();
  return { revision: team.revision, preferences: await assistantResourcePreferences(profile.id), files: await listAssistantFiles(profile.id),
    skills: listWebhookSkills(await personalAssistantDatabase(), profile.id), plugins: (await teamPlugins(team, roleSchema.parse(request.params.role))).map(({ name, selected, status }) => ({ name, enabled: selected, status })),
    ...(owner ? { ownerPlugins: configuredTeamPlugins().map(plugin => ({ name: plugin.name, shared: Boolean(db.prepare('SELECT 1 FROM assistant_team_plugins WHERE team_id=? AND role=\'\' AND name=?').get(team.id, plugin.name)) })) } : {}),
    browserProfiles: await Promise.all(browserRuntime().allProfiles().filter(item => item.projectId === team.projectId || browserRuntime().profileGrants(item.id).some(grant => grant.scope === 'project' && grant.projectId === team.projectId || grant.scope === 'cluster' && grant.clusterId === team.clusterId)).map(async item => await teamBrowserProfile(team, item.id) ? { id: item.id, label: item.label, selected: item.id === await selectedTeamBrowser(team.id, roleSchema.parse(request.params.role)) } : null)).then(items => items.filter(item => item !== null)),
    selectedBrowserProfileId: await selectedTeamBrowser(team.id, roleSchema.parse(request.params.role)),
    mcpServers: shared.map(([name, server]) => ({ name, type: server.command ? 'stdio' : 'http', status: 'shared', enabled: selected.includes(name) })),
    ...(owner ? { ownerMcpServers: Object.entries(servers).filter(([, server]) => server.authMode !== 'native').map(([name, server]) => ({ name, type: server.command ? 'stdio' : 'http', shared: store.sharedWith(name, team.id) })) } : {}),
    logins: [], savedLogins: [] }; 
}));
app.put('/api/assistant-teams/:id/agents/:role/plugins', route(async (request, response) => {
  const { team } = await agent(request, response);
  const body = z.object({ expectedRevision: revision, names: z.array(id).max(100) }).strict().parse(request.body);
  const available = await teamPlugins(team, roleSchema.parse(request.params.role));
  if (new Set(body.names).size !== body.names.length || body.names.some(name => !available.some(plugin => plugin.name === name && plugin.status === 'ready')))
    throw new TeamError('Plugin is not shared or compatible with Pi', 400);
  const db = await teamDatabase(); db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('UPDATE assistant_teams SET revision=revision+1 WHERE id=? AND revision=?').run(team.id, body.expectedRevision).changes) throw new TeamError('Stale team revision', 409);
    db.prepare('DELETE FROM assistant_team_plugins WHERE team_id=? AND role=?').run(team.id, request.params.role);
    for (const name of body.names) db.prepare('INSERT INTO assistant_team_plugins VALUES(?,?,?,1)').run(team.id, request.params.role, name);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  announceTeamChange(team.id);
  return { revision: body.expectedRevision + 1 };
}));
app.put('/api/assistant-teams/:id/agents/:role/browser', route(async (request, response) => {
  const { team } = await agent(request, response);
  const body = z.object({ expectedRevision: revision, profileId: z.string().uuid().nullable() }).strict().parse(request.body);
  if (body.profileId && !await teamBrowserProfile(team, body.profileId)) throw new TeamError('Browser profile is not shared with this team on its host', 403);
  const next = await saveTeamBrowserSelection(team.id, roleSchema.parse(request.params.role), body.profileId, body.expectedRevision);
  return { revision: next, profileId: body.profileId };
}));
app.put('/api/assistant-teams/:id/agents/:role/resources', route(async (request, response) => {
  const { team, profile } = await agent(request, response);
  const body = z.object({ expectedRevision: revision, disabledSkills: z.array(z.string().min(1).max(200)).max(1000), mcpServerNames: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/)).max(100).optional() }).strict().parse(request.body);
  const names = body.mcpServerNames ?? await selectedTeamMcp(team.id, roleSchema.parse(request.params.role));
  if (new Set(names).size !== names.length || names.some(name => !managedMcpStore(team.executorAccountId).sharedWith(name, team.id))) throw new TeamError('Unknown or unshared team MCP server', 400);
  const available = listWebhookSkills(await personalAssistantDatabase(), profile.id).map(skill => skill.name);
  if (body.disabledSkills.some(name => !available.includes(name))) throw new TeamError('Unknown team skill', 400);
  await saveTeamMcpSelection(team.id, roleSchema.parse(request.params.role), names, body.expectedRevision);
  await saveResourcePreferences(profile.id, { disabledSkills: body.disabledSkills, disabledPlugins: [] });
  announceTeamChange(team.id);
  return { preferences: await assistantResourcePreferences(profile.id), revision: (await getTeam(team.id)).revision };
}));
app.post('/api/assistant-teams/:id/agents/:role/files', route(async (request, response) => {
  const { team, profile } = await agent(request, response);
  const body = z.object({ expectedRevision: revision, name: z.string().min(1).max(240), data: z.string().max(28_000_000) }).strict().parse(request.body);
  await changeRevision(team.id, body.expectedRevision);
  await saveAssistantFile(profile.id, body.name, Buffer.from(body.data, 'base64'));
  announceTeamChange(team.id);
  return { files: await listAssistantFiles(profile.id) };
}));
app.delete('/api/assistant-teams/:id/agents/:role/files', route(async (request, response) => {
  const { team, profile } = await agent(request, response);
  const filePath = z.string().min(1).max(1000).parse(request.query.path);
  await changeRevision(team.id, revision.parse(request.body?.expectedRevision));
  await deleteAssistantFile(profile.id, filePath);
  announceTeamChange(team.id);
  return { files: await listAssistantFiles(profile.id) };
}));
app.post('/api/assistant-teams/:id/agents/:role/skills', route(async (request, response) => {
  const { team, profile } = await agent(request, response);
  const body = z.object({ expectedRevision: revision, files: z.array(z.object({ relativePath: z.string().min(1).max(1000), data: z.string().max(5_592_408) }).strict()).max(100) }).strict().parse(request.body);
  const db = await personalAssistantDatabase();
  await changeRevision(team.id, body.expectedRevision);
  await uploadWebhookSkill(db, profile.id, body.files.map(file => ({ ...file, data: Buffer.from(file.data, 'base64') })));
  announceTeamChange(team.id);
  return { skills: listWebhookSkills(db, profile.id) };
}));
app.delete('/api/assistant-teams/:id/agents/:role/skills/:skillId', route(async (request, response) => {
  const { team, profile } = await agent(request, response); const db = await personalAssistantDatabase();
  const skillId = id.parse(request.params.skillId);
  await changeRevision(team.id, revision.parse(request.body?.expectedRevision));
  await removeWebhookSkill(db, profile.id, skillId);
  announceTeamChange(team.id);
  return { skills: listWebhookSkills(db, profile.id) };
}));
// Explicit member-selected subject execution; no personal topic classifier.
app.post('/api/assistant-teams/:id/agents/:role/turn', route(async (request, response) => {
  const member = await requireTeamMember(session(response), id.parse(request.params.id));
  const role = roleSchema.parse(request.params.role);
  const body = z.object({ subjectId: id, requestId: z.string().uuid(), message: z.string().trim().min(1).max(20000) }).strict().parse(request.body);
  return runBrowserTeamAssignment(member, role, body.subjectId, body.requestId, body.message);
}));
// Execution of an already accepted, selected-subject assignment. Lifecycle/delivery belongs to Task 6.
app.post('/api/assistant-teams/:id/assignments/:assignmentId/run', route(async (request, response) => {
  const member = await requireTeamMember(session(response), id.parse(request.params.id));
  const assignment = await getTeamAssignment(id.parse(request.params.assignmentId));
  if (!assignment || assignment.teamId !== member.teamId || assignment.requestedBy !== member.accountId) throw new TeamError('Assignment is not this initiating member\'s', 403);
  throw new TeamError('Direct assignment reruns are disabled; submit a new member request through the assignment service', 409);
}));

app.post('/api/assistant-teams/:id/assignments/:assignmentId/route', route(async (request, response) => {
  const member = await requireTeamMember(session(response), id.parse(request.params.id));
  const assignment = await getTeamAssignment(id.parse(request.params.assignmentId));
  if (!assignment || assignment.teamId !== member.teamId) throw new TeamError('Unknown team assignment', 404);
  if (assignment.subjectId || !['accepted', 'waiting_for_human'].includes(assignment.state)) throw new TeamError('Assignment is not waiting for a subject', 409);
  const body = z.discriminatedUnion('kind', [z.object({ kind: z.literal('new') }).strict(), z.object({ kind: z.literal('continue'), subjectId: id }).strict(), z.object({ kind: z.literal('clarify') }).strict()]).parse(request.body);
  await routeTeamAssignment(assignment.id, body); wakeTeamWork(member.teamId); return { ok: true };
}));
app.get('/api/assistant-teams/:id/assignments', route(async (request, response) => {
  return teamWorkStatus(await requireTeamMember(session(response), id.parse(request.params.id)));
}));
app.get('/api/assistant-teams/:id/reviews', route(async (request, response) => {
  const member = await requireTeamMember(session(response), id.parse(request.params.id));
  const { allPendingGuardianReviews } = await import('../../guardian/reviews.js');
  return { reviews: allPendingGuardianReviews().filter(review => review.team?.teamId === member.teamId) };
}));
app.post('/api/assistant-teams/:id/assignments/:assignmentId/reviews/:reviewId', route(async (request, response) => {
  const member = await requireTeamMember(session(response), id.parse(request.params.id));
  const body = z.object({ allow: z.boolean() }).strict().parse(request.body);
  await resolveTeamApproval(member, id.parse(request.params.assignmentId), id.parse(request.params.reviewId), body.allow);
  return { ok: true };
}));
app.post('/api/assistant-teams/:id/inquiries/:inquiryId/confirm', route(async (request, response) => {
  const member = await requireTeamMember(session(response), id.parse(request.params.id));
  const body = z.object({ decision: z.enum(['confirm', 'dismiss']) }).strict().parse(request.body);
  await confirmTeamInquiry(member, id.parse(request.params.inquiryId), body.decision);
  wakeTeamWork(member.teamId); return { ok: true };
}));

const memoryPage = z.object({ offset: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();
app.get('/api/assistant-teams/:id/memory/topics', route(async (request, response) => {
  const member = await requireTeamMember(session(response), id.parse(request.params.id));
  const p = memoryPage.parse(request.query);
  return { topics: await (await import('../../assistant-teams/memory.js')).listTeamMemoryTopics(member, p.offset, p.limit) };
}));
app.get('/api/assistant-teams/:id/memory/changes', route(async (request, response) => {
  const member = await requireTeamMember(session(response), id.parse(request.params.id));
  const p = memoryPage.parse(request.query);
  return { changes: await (await import('../../assistant-teams/memory.js')).listTeamMemoryChanges(member, p.offset, p.limit) };
}));
app.get('/api/assistant-teams/:id/memory/status', route(async (request, response) => {
  const member = await requireTeamMember(session(response), id.parse(request.params.id));
  return { learning: await (await import('../../assistant-teams/memory.js')).teamMemoryStatus(member) };
}));
app.get('/api/assistant-teams/:id/memory/topics/:topic', route(async (request, response) => {
  const member = await requireTeamMember(session(response), id.parse(request.params.id));
  return (await import('../../assistant-teams/memory.js')).readTeamMemoryTopic(member, String(request.params.topic));
}));
app.put('/api/assistant-teams/:id/memory/topics/:topic', route(async (request, response) => {
  const member = await requireTeamMember(session(response), id.parse(request.params.id));
  const memory = await import('../../assistant-teams/memory.js');
  const body = memory.teamMemoryWriteSchema.omit({ topic: true }).parse(request.body);
  return memory.writeTeamMemory(member, { ...body, topic: String(request.params.topic) });
}));
app.post('/api/assistant-teams/:id/memory/changes/:changeId/revert', route(async (request, response) => {
  const member = await requireTeamMember(session(response), id.parse(request.params.id));
  const body = z.object({ expectedRevision: z.number().int().positive() }).strict().parse(request.body);
  return (await import('../../assistant-teams/memory.js')).revertTeamMemory(member, id.parse(request.params.changeId), body.expectedRevision);
}));
app.get('/api/assistant-teams/:id/messages/:messageId', route(async (request, response) => {
  const member = await requireTeamMember(session(response), id.parse(request.params.id));
  const message = await (await import('../../assistant-teams/conversations.js')).getTeamMessage(member.teamId, id.parse(request.params.messageId));
  if (!message) throw new TeamError('Team message not found', 404);
  return { message };
}));

app.get('/api/assistant-teams/:id/messages', route(async (request, response) => {
  const member = await requireTeamMember(session(response), id.parse(request.params.id));
  const p = memoryPage.parse(request.query);
  const db = await (await import('../../assistant-teams/conversations.js')).conversationDatabase();
  return { messages: db.prepare('SELECT record FROM assistant_team_messages WHERE team_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?').all(member.teamId, p.limit, p.offset).map(row => JSON.parse(String(row.record))) };
}));
app.get('/api/assistant-teams/:id/decisions', route(async (request, response) => {
  const member = await requireTeamMember(session(response), id.parse(request.params.id));
  const p = memoryPage.parse(request.query);
  const db = await (await import('../../assistant-teams/conversations.js')).conversationDatabase();
  // Initialize the diagnostics schema through its public read seam.
  await (await import('../../assistant-teams/decisions.js')).listTeamDecisions(member.teamId, 1);
  return { decisions: db.prepare('SELECT record FROM assistant_team_decisions WHERE team_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?').all(member.teamId, p.limit, p.offset).map(row => JSON.parse(String(row.record))) };
}));
app.get('/api/assistant-teams/:id/readiness', route(async (request, response) => {
  await requireTeamMember(session(response), id.parse(request.params.id));
  const { systemAiSettings } = await import('../../system-ai-config.js');
  const { systemDecisionKey } = await import('../../system-ai.js');
  const { decisionModelTarget } = await import('../../classifiers/conversation-routing.js');
  const model = systemAiSettings().decision.model;
  let ready = false;
  try { const key = systemDecisionKey(model); ready = Boolean(key && await decisionModelTarget(model, key)); } catch { /* Safe readiness only, never credentials or provider errors. */ }
  const host = await (await import('../../cluster.js')).getClusterNode();
  return { host: { id: host.id, name: host.name }, runtime: 'pi', decision: { model, ready } };
}));
app.get('/api/assistant-teams/:id/events', async (request, response, next) => {
  try {
    const teamId = id.parse(request.params.id), auth = session(response);
    await requireTeamMember(auth, teamId);
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-store');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    let closed = false;
    const send = async (entityIds: string[] = []) => {
      try {
        await requireTeamMember(auth, teamId);
        if (!closed) response.write(`data: ${JSON.stringify({ teamId, entityIds })}\n\n`);
      } catch { response.end(); }
    };
    const dispose = onTeamChange((changed, entityIds) => { if (changed === teamId) void send(entityIds); });
    response.on('close', () => { closed = true; dispose(); });
    await send();
  } catch (error) { if (error instanceof TeamError) response.status(error.status).json({ error: error.message }); else next(error); }
});

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
