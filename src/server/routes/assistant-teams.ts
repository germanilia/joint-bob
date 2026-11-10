import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { AuthSession } from '../../auth.js';
import { app } from '../state.js';
import { requireClusterMember, requirePeerClusterMember, requireTeamMember, teamMemberFromCluster, teamMembershipRevision, type ClusterMember } from '../../assistant-teams/access.js';
import { createTeam, getTeam, getTeamAssignment, listTeamAgents, listTeams, prepareTeamProject, resolveTeamExecutor, saveTeamSettings, announceTeamChange, onTeamChange, teamDatabase, TeamError } from '../../assistant-teams/store.js';
import { runBrowserTeamAssignment, confirmTeamInquiry, wakeTeamWork, resolveTeamApproval, teamWorkStatus, routeTeamAssignment } from '../../assistant-teams/assignments.js';
import { teamAgentReadiness } from '../../assistant-teams/runtime.js';
import { assistantLoginProfileIds, getPersonalAssistantById, listPersonalAssistants, personalAssistantDatabase, type PersonalAssistant } from '../../personal-assistants.js';
import { listWebhookSkills } from '../../webhook-skills.js';
import { asNode } from '../../account-context.js';
import { saveTeamMembers, teamCoordinator, TEAM_ROLE_PATTERN } from '../../assistant-teams/store.js';
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
    if (existing) throw new TeamError('Team already exists for this cluster and host', 409);
    const executorAccountId = await resolveTeamExecutor();
    const projectId = await prepareTeamProject(member);
    const team = await createTeam(member, { projectId, executorAccountId });
    return { team, snapshotRevision };
  }
  const target = input as { teamId: string };
  const actor = await teamMemberFromCluster(member, target.teamId);
  if (operation === 'get') {
    return { team: await getTeam(target.teamId), snapshotRevision };
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

const roleSchema = z.string().regex(TEAM_ROLE_PATTERN);
/** What a picked assistant brings with it, shown to everyone who can call it through the team. */
async function assistantUses(profile: PersonalAssistant): Promise<string[]> {
  const db = await personalAssistantDatabase();
  const skills = listWebhookSkills(db, profile.id).length, logins = (await assistantLoginProfileIds(profile.id)).length;
  return [
    profile.executionSettings ? `${profile.executionSettings.harnessId} · ${profile.executionSettings.modelId}` : `${profile.engine}`,
    profile.mcpServerNames === null ? 'all its MCP servers' : profile.mcpServerNames.length ? `MCP: ${profile.mcpServerNames.join(', ')}` : '',
    profile.allowBrowser ? `browser${logins ? ` with ${logins} saved login${logins === 1 ? '' : 's'}` : ''}` : '',
    profile.allowTerminal ? 'terminal' : '',
    skills ? `${skills} skill${skills === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
}
const memberSummary = async (profile: PersonalAssistant) => ({ id: profile.id, name: profile.name, ownerAccountId: profile.accountId, uses: await assistantUses(profile) });
app.get('/api/assistant-teams/:id/agents', route(async (request, response) => {
  const teamId = id.parse(request.params.id); await requireTeamMember(session(response), teamId);
  const team = await getTeam(teamId), coordinator = await teamCoordinator(team);
  return { revision: team.revision, coordinatorRole: coordinator, agents: await Promise.all((await listTeamAgents(teamId)).map(async item => {
    const profile = await getPersonalAssistantById(item.assistantId);
    if (!profile) return { ...item, coordinator: item.role === coordinator, profile: null, readiness: ['This assistant was deleted'] };
    return { ...item, coordinator: item.role === coordinator, profile: await memberSummary(profile), readiness: await asNode(() => teamAgentReadiness(profile)) };
  })) };
}));
// For now members come from the team's own machine: the assistants you own there.
app.get('/api/assistant-teams/:id/available-assistants', route(async (request, response) => {
  const teamId = id.parse(request.params.id); await requireTeamMember(session(response), teamId);
  const team = await getTeam(teamId), members = new Set((await listTeamAgents(teamId)).map(item => item.assistantId));
  const mine = (await listPersonalAssistants(session(response).accountId)).filter(profile => profile.nodeId === team.hostNodeId);
  return { assistants: await Promise.all(mine.map(async profile => ({ ...await memberSummary(profile), inTeam: members.has(profile.id) }))) };
}));
app.put('/api/assistant-teams/:id/members', route(async (request, response) => {
  const teamId = id.parse(request.params.id); await requireTeamMember(session(response), teamId);
  const body = z.object({ expectedRevision: revision, coordinatorRole: roleSchema.nullable(),
    members: z.array(z.object({ role: roleSchema, assistantId: id }).strict()).max(20) }).strict().parse(request.body);
  const team = await getTeam(teamId), current = new Set((await listTeamAgents(teamId)).map(item => item.assistantId));
  for (const member of body.members) {
    const profile = await getPersonalAssistantById(member.assistantId);
    if (!profile || profile.nodeId !== team.hostNodeId) throw new TeamError('Pick an assistant on the team machine', 400);
    // It brings its owner's sign-ins and tools, so only its owner may put it in a team.
    if (!current.has(profile.id) && profile.accountId !== session(response).accountId) throw new TeamError('Only its owner can add an assistant to a team', 403);
  }
  const saved = await saveTeamMembers(teamId, body.members, body.coordinatorRole, body.expectedRevision);
  void (await import('../../assistant-teams/telegram-commands.js')).refreshTeamCommands(teamId).catch(error => console.warn('Telegram commands were not updated:', error instanceof Error ? error.message : error));
  return { revision: saved };
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
  return { host: { id: host.id, name: host.name }, decision: { model, ready } };
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
