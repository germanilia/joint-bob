import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { asNode } from '../../account-context.js';
import type { AuthSession } from '../../auth.js';
import { browserWebUrlSchema, type BrowserActor, type BrowserSessionView } from '../../browser-types.js';
import { getClusterNode } from '../../cluster.js';
import { clusterV2Database } from '../../cluster-v2-store.js';
import { ensureConversationRecord } from '../../conversation-records.js';
import { ensureSessionTitle } from '../../names.js';
import { assistantLoginProfileIds, getPersonalAssistantById, personalAssistantDatabase, savePersonalAssistant, type PersonalAssistant } from '../../personal-assistants.js';
import { resourceInventory } from '../../resource-inventory.js';
import { saveSecretAccount } from '../../secrets.js';
import { KOKORO_VOICES, voiceLabel } from '../../story-settings.js';
import { getProject } from '../../store.js';
import { requireTeamMember } from '../../assistant-teams/access.js';
import {
  attachOrDetachAssistantSecret,
  invalidateAssistantLiveSessions,
  listAssistantAttachedSecrets,
  readAssignmentExecutionDetail,
  readTeamNodeCatalog,
} from '../../assistant-teams/proposals.js';
import { decideTeamAutomationRequest, listTeamAutomations } from '../../assistant-teams/automations.js';
import { announceTeamChange, getTeam, listTeamAgents, saveTeamMembers, TEAM_ROLE_PATTERN, TeamError } from '../../assistant-teams/store.js';
import { WebhookResourceError } from '../../webhook-resources.js';
import { announceAssistantChanges } from '../../assistant-collaboration/twin-sync.js';
import { browserOperation, browserRuntime } from '../browser.js';
import { ensureSecretSharingSchema, secretGrants, setSecretGrants } from '../scoped-credentials.js';
import { app } from '../state.js';
import { localVoiceStatus } from '../story-voice.js';
import { assistantResourcePreferences, saveResourcePreferences, syncAssistantLoginGrants } from './assistant-resources.js';

const teamIdSchema = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/);
const roleSchema = z.string().regex(TEAM_ROLE_PATTERN);
const resourceNameList = z.array(z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/)).max(1000);

function authSession(response: Response): AuthSession {
  const value = response.locals.authSession as AuthSession | undefined;
  if (!value) throw new TeamError('Authentication required', 401);
  return value;
}

function teamRoute(handler: (request: Request, response: Response) => Promise<unknown>) {
  return (request: Request, response: Response, next: NextFunction): void => {
    handler(request, response).then(result => response.json(result)).catch(error => {
      if (error instanceof TeamError) { response.status(error.status).json({ error: error.message }); return; }
      if (error instanceof WebhookResourceError) { response.status(error.statusCode).json({ error: error.message }); return; }
      if (error instanceof z.ZodError) { response.status(400).json({ error: error.issues[0]?.message || 'Invalid team request' }); return; }
      next(error);
    });
  };
}

async function resolveTeamMemberProfile(teamId: string, role: string): Promise<{ team: Awaited<ReturnType<typeof getTeam>>; profile: PersonalAssistant }> {
  const team = await getTeam(teamId);
  const agent = (await listTeamAgents(teamId)).find(item => item.role === role);
  if (!agent) throw new TeamError(`Role /${role} is not in this team`, 404);
  const profile = await getPersonalAssistantById(agent.assistantId);
  if (!profile) throw new TeamError(`Assistant for /${role} no longer exists`, 404);
  return { team, profile };
}

function assertMemberEditable(session: AuthSession, team: Awaited<ReturnType<typeof getTeam>>, profile: PersonalAssistant): void {
  if (profile.accountId !== session.accountId && team.executorAccountId !== session.accountId) {
    throw new TeamError('Only this assistant\'s owner or team host can edit its connections', 403);
  }
}

async function humanActor(session: AuthSession): Promise<BrowserActor> {
  return { kind: 'human', id: `${(await getClusterNode()).id}:${session.userId}` };
}

async function loginState(profileId: string, entry: PersonalAssistant) {
  const runtime = browserRuntime();
  const profile = runtime.profile(profileId);
  const holder = runtime.profileHolder(profileId);
  let state: 'idle' | 'in-use' | 'needs-sign-in' = 'idle';
  let session: BrowserSessionView | null = null;
  if (holder) {
    session = await runtime.get(holder.id);
    state = session.loginRequest ? 'needs-sign-in' : 'in-use';
  }
  return { profileId, label: profile.label, sites: profile.sites ?? [], state, sessionId: session?.id ?? null, sourceConversation: holder?.conversationId === entry.sessionId };
}

async function syncMemberLoginGrants(profile: PersonalAssistant, teamProjectId: string): Promise<void> {
  await syncAssistantLoginGrants(profile.id, profile.accountId);
  const profileIds = await assistantLoginProfileIds(profile.id);
  if (!profileIds.length) return;
  const db = await personalAssistantDatabase();
  const runtime = browserRuntime();
  const local = (await getClusterNode()).id;
  const teamConvs = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='assistant_team_conversations'").get()
    ? db.prepare('SELECT project_id projectId, conversation_id conversationId FROM assistant_team_conversations WHERE assistant_id=?').all(profile.id) as Array<{ projectId: string; conversationId: string }>
    : [];
  for (const profileId of profileIds) {
    const grants = runtime.profileGrants(profileId);
    for (const conv of [{ projectId: teamProjectId, conversationId: profile.sessionId }, ...teamConvs]) {
      if (grants.some(grant => grant.scope === 'conversation' && grant.projectId === conv.projectId && grant.conversationId === conv.conversationId)) continue;
      runtime.grantProfileAccess(profileId, { scope: 'conversation', projectId: conv.projectId, conversationId: conv.conversationId }, local);
    }
  }
}

const DEFAULT_CHIEF_INSTRUCTIONS =
  'You are the Chief (user-facing coordinator) of this Assistant Team. You are the single point of contact for the user: design, split, add, update, or remove specialist roles with team_node_catalog and team_propose_changes (with human approval), keep agents in Auto mode unless a specific model is requested, delegate specialist tasks via team_delegate, review every completed specialist result and execution trace immediately, review and approve/reject specialist automation and scheduled task requests with team_decide_automation, and update collective team memory (scope "team") when durable rules or workflows emerge.';

const chiefSetupSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('existing'),
    assistantId: teamIdSchema,
    role: roleSchema.default('chief'),
  }).strict(),
  z.object({
    mode: z.literal('create'),
    name: z.string().trim().min(1).max(80),
    role: roleSchema.default('chief'),
    instructions: z.string().max(20_000).optional(),
    harnessId: z.string().min(1).max(50).optional(),
    executionSettings: z.object({
      harnessId: z.string().min(1).max(50),
      provider: z.string().min(1).max(100),
      modelId: z.string().min(1).max(200),
      reasoning: z.string().min(1).max(100),
    }).strict().nullable().optional(),
  }).strict(),
]);

const memberConnectionsUpdateSchema = z.object({
  allowBrowser: z.boolean().optional(),
  allowTerminal: z.boolean().optional(),
  mcpServerNames: z.array(z.string().min(1).max(200)).max(100).nullable().optional(),
  disabledSkills: resourceNameList.optional(),
  disabledPlugins: resourceNameList.optional(),
  secretAccountIds: z.array(z.string().uuid()).max(50).optional(),
}).strict();

const memberSecretCreateSchema = z.object({
  label: z.string().trim().min(1).max(100),
  provider: z.enum(['custom', 'google', 'elevenlabs', 'github', 'jira', 'aws', 'openai', 'cloudflare', 'stripe', 'gitlab']).default('custom'),
  variables: z.array(z.object({
    name: z.string().trim().min(1).max(120).regex(/^[A-Z][A-Z0-9_]*$/, 'Use UPPER_SNAKE_CASE variable names'),
    value: z.string().min(1).max(200_000),
  }).strict()).min(1).max(20),
}).strict();

const newLoginSchema = z.object({ label: z.string().trim().min(1).max(80), url: browserWebUrlSchema }).strict();

export function registerAssistantTeamUxRoutes(): void {
  // Wizard Step 1: create or assign the team's Chief coordinator in one step.
  app.post('/api/assistant-teams/:id/chief', teamRoute(async (request, response) => {
    const auth = authSession(response);
    const teamId = teamIdSchema.parse(request.params.id);
    await requireTeamMember(auth, teamId);
    const input = chiefSetupSchema.parse(request.body);
    const team = await getTeam(teamId);
    const localNodeId = (await getClusterNode()).id;
    let assistantId: string;
    if (input.mode === 'existing') {
      const profile = await getPersonalAssistantById(input.assistantId);
      if (!profile || profile.nodeId !== team.hostNodeId) throw new TeamError('Pick an assistant on the team host', 400);
      if (profile.accountId !== auth.accountId) throw new TeamError('Only its owner can add an assistant to a team', 403);
      assistantId = profile.id;
    } else {
      const engine = input.executionSettings?.harnessId ?? input.harnessId ?? 'pi';
      const sessionId = randomUUID();
      await asNode(async () => {
        await ensureConversationRecord(team.projectId, engine, sessionId, localNodeId);
        await ensureSessionTitle(sessionId, input.name);
      });
      const created = await savePersonalAssistant(team.executorAccountId, {
        projectId: team.projectId,
        engine,
        sessionId,
        nodeId: localNodeId,
        name: input.name,
        instructions: input.instructions?.trim() || DEFAULT_CHIEF_INSTRUCTIONS,
        allowTerminal: true,
        allowBrowser: true,
        mcpServerNames: null,
        executionSettings: input.executionSettings ?? null,
      });
      assistantId = created.id;
    }
    const existing = (await listTeamAgents(teamId)).filter(m => m.role !== input.role && m.assistantId !== assistantId);
    const nextMembers = [{ role: input.role, assistantId }, ...existing.map(m => ({ role: m.role, assistantId: m.assistantId }))];
    const revision = await saveTeamMembers(teamId, nextMembers, input.role, team.revision);
    announceAssistantChanges();
    return { revision, role: input.role, assistantId };
  }));

  // Host catalog (metadata only, never secret values) + local Kokoro voice options for wizard & settings.
  app.get('/api/assistant-teams/:id/catalog', teamRoute(async (request, response) => {
    const auth = authSession(response);
    const teamId = teamIdSchema.parse(request.params.id);
    await requireTeamMember(auth, teamId);
    const catalog = await readTeamNodeCatalog(teamId);
    const host = await getClusterNode();
    return {
      host: { id: host.id, name: host.name },
      catalog,
      voice: {
        local: localVoiceStatus(),
        kokoroVoices: KOKORO_VOICES.map(id => ({ id, label: voiceLabel(id) })),
      },
    };
  }));

  // Detailed redacted execution trace for one assignment (Execution Detail modal).
  app.get('/api/assistant-teams/:id/assignments/:assignmentId/trace', teamRoute(async (request, response) => {
    const auth = authSession(response);
    const teamId = teamIdSchema.parse(request.params.id);
    await requireTeamMember(auth, teamId);
    const assignmentId = z.string().min(1).max(200).parse(request.params.assignmentId);
    return { trace: await readAssignmentExecutionDetail(teamId, assignmentId) };
  }));

  // In-context member connections view (works for both standalone and team-created assistants).
  app.get('/api/assistant-teams/:id/members/:role/connections', teamRoute(async (request, response) => {
    const auth = authSession(response);
    const teamId = teamIdSchema.parse(request.params.id);
    const role = roleSchema.parse(request.params.role);
    await requireTeamMember(auth, teamId);
    const { team, profile } = await resolveTeamMemberProfile(teamId, role);
    const project = await asNode(() => getProject(team.projectId));
    if (!project) throw new TeamError('Team project unavailable', 404);
    const host = await getClusterNode();
    const harness = profile.executionSettings?.harnessId ?? profile.engine;
    const [inventory, preferences, attachedSecrets, catalog] = await Promise.all([
      asNode(() => resourceInventory({ projectPath: project.path, projectId: project.id, conversationId: profile.sessionId, ignoreAssistantPreferences: true })),
      assistantResourcePreferences(profile.id),
      listAssistantAttachedSecrets(profile, team.projectId),
      readTeamNodeCatalog(teamId),
    ]);
    const usable = (activation: Record<string, { enabled: boolean } | undefined> | undefined) => !activation || activation[harness] === undefined || Boolean(activation[harness]?.enabled);
    const skills = inventory.skills.filter(skill => skill.harnesses.includes(harness as never) && usable(skill.activation))
      .map(skill => ({ name: skill.name, description: skill.description, origin: skill.origin, enabled: !preferences.disabledSkills.includes(skill.name) }));
    const mcpServers = [...new Map(inventory.mcpServers.map(server => [server.name, server])).values()]
      .map(server => ({ name: server.name, source: server.source, enabled: profile.mcpServerNames === null || profile.mcpServerNames.includes(server.name) }));
    const attachedLoginIds = await assistantLoginProfileIds(profile.id);
    let logins: Awaited<ReturnType<typeof loginState>>[] = [];
    let savedLogins: Array<{ profileId: string; label: string; sites: string[] }> = [];
    try {
      logins = await Promise.all(attachedLoginIds.map(profileId => loginState(profileId, profile)));
      const listed = await browserOperation({ operation: 'profiles', args: { projectId: team.projectId, conversationId: profile.sessionId } }, await humanActor(auth), host.id) as { profiles: Array<{ id: string; label: string; sites?: string[] }> };
      savedLogins = listed.profiles.filter(item => !attachedLoginIds.includes(item.id)).map(item => ({ profileId: item.id, label: item.label, sites: item.sites ?? [] }));
    } catch { /* browser runtime may be idle */ }
    return {
      role,
      host: { id: host.id, name: host.name },
      editable: profile.accountId === auth.accountId || team.executorAccountId === auth.accountId,
      profile: {
        id: profile.id,
        name: profile.name,
        engine: profile.engine,
        allowBrowser: profile.allowBrowser,
        allowTerminal: profile.allowTerminal,
        mcpServerNames: profile.mcpServerNames,
        executionSettings: profile.executionSettings,
      },
      attachedSecrets,
      availableSecrets: catalog.secrets,
      unusableSecrets: catalog.unusableSecrets,
      mcpServers,
      skills,
      logins,
      savedLogins,
    };
  }));

  // Update member connections (MCP servers, skills, browser/terminal toggles, attached secrets).
  app.put('/api/assistant-teams/:id/members/:role/connections', teamRoute(async (request, response) => {
    const auth = authSession(response);
    const teamId = teamIdSchema.parse(request.params.id);
    const role = roleSchema.parse(request.params.role);
    await requireTeamMember(auth, teamId);
    const { team, profile } = await resolveTeamMemberProfile(teamId, role);
    assertMemberEditable(auth, team, profile);
    const input = memberConnectionsUpdateSchema.parse(request.body);
    let updatedProfile = profile;
    if (input.allowBrowser !== undefined || input.allowTerminal !== undefined || input.mcpServerNames !== undefined) {
      updatedProfile = await savePersonalAssistant(profile.accountId, {
        projectId: profile.projectId,
        engine: profile.engine,
        sessionId: profile.sessionId,
        nodeId: profile.nodeId,
        name: profile.name,
        instructions: profile.instructions,
        allowBrowser: input.allowBrowser ?? profile.allowBrowser,
        allowTerminal: input.allowTerminal ?? profile.allowTerminal,
        mcpServerNames: input.mcpServerNames !== undefined ? input.mcpServerNames : profile.mcpServerNames,
        classifierId: profile.classifierId,
        executionSettings: profile.executionSettings,
      });
    }
    if (input.disabledSkills !== undefined || input.disabledPlugins !== undefined) {
      const currentPrefs = await assistantResourcePreferences(profile.id);
      await saveResourcePreferences(profile.id, {
        disabledSkills: input.disabledSkills ?? currentPrefs.disabledSkills,
        disabledPlugins: input.disabledPlugins ?? currentPrefs.disabledPlugins,
      });
    }
    if (input.secretAccountIds !== undefined) {
      const currentIds = new Set((await listAssistantAttachedSecrets(updatedProfile)).map(s => s.id));
      const wantedIds = new Set(input.secretAccountIds);
      const usable = new Set((await readTeamNodeCatalog(teamId)).secrets.map(s => s.id));
      for (const secretId of wantedIds) {
        if (!currentIds.has(secretId)) {
          if (!usable.has(secretId)) throw new TeamError('Selected secret is not usable in this team project', 400);
          await attachOrDetachAssistantSecret(updatedProfile, secretId, 'attach');
        }
      }
      for (const secretId of currentIds) {
        if (!wantedIds.has(secretId)) await attachOrDetachAssistantSecret(updatedProfile, secretId, 'detach');
      }
    }
    await invalidateAssistantLiveSessions(updatedProfile, true, true);
    announceAssistantChanges();
    announceTeamChange(teamId);
    return { ok: true };
  }));

  // Create a new secret directly in Joint Bob Secrets (never touches chat) and attach it to this team member.
  app.post('/api/assistant-teams/:id/members/:role/secrets', teamRoute(async (request, response) => {
    const auth = authSession(response);
    const teamId = teamIdSchema.parse(request.params.id);
    const role = roleSchema.parse(request.params.role);
    await requireTeamMember(auth, teamId);
    const { team, profile } = await resolveTeamMemberProfile(teamId, role);
    assertMemberEditable(auth, team, profile);
    const input = memberSecretCreateSchema.parse(request.body);
    const created = await saveSecretAccount({
      provider: input.provider,
      label: input.label,
      replicate: false,
      variables: input.variables.map(item => ({ name: item.name, kind: 'value' as const, value: item.value })),
    });
    const db = await clusterV2Database();
    const localNodeId = (await getClusterNode()).id;
    ensureSecretSharingSchema(db);
    const existingGrants = secretGrants(db, localNodeId, created.id);
    if (!existingGrants.some(grant => grant.clusterId === team.clusterId && grant.nodeId === null)) {
      setSecretGrants(db, localNodeId, created.id, [...existingGrants, { clusterId: team.clusterId, nodeId: null }]);
    }
    await attachOrDetachAssistantSecret(profile, created.id, 'attach');
    await invalidateAssistantLiveSessions(profile, false, true);
    announceAssistantChanges();
    announceTeamChange(teamId);
    response.status(201);
    return { secret: { id: created.id, label: created.label, provider: created.provider, variableNames: created.variables.map(v => v.name) } };
  }));

  // Open a new persistent live Homeserver browser profile for this team member.
  app.post('/api/assistant-teams/:id/members/:role/logins', teamRoute(async (request, response) => {
    const auth = authSession(response);
    const teamId = teamIdSchema.parse(request.params.id);
    const role = roleSchema.parse(request.params.role);
    await requireTeamMember(auth, teamId);
    const { team, profile } = await resolveTeamMemberProfile(teamId, role);
    assertMemberEditable(auth, team, profile);
    const input = newLoginSchema.parse(request.body);
    const local = await getClusterNode();
    const started = await browserOperation({
      operation: 'start',
      args: { projectId: team.projectId, engine: profile.engine, conversationId: profile.sessionId, appNodeId: local.id, url: input.url, profileName: input.label },
    }, await humanActor(auth), local.id) as { session: BrowserSessionView };
    const profileId = started.session.profileId;
    if (!profileId) throw new TeamError('Browser started without a saved profile', 500);
    const db = await personalAssistantDatabase();
    db.prepare('INSERT OR IGNORE INTO personal_assistant_logins (assistant_id, profile_id, created_at) VALUES (?,?,?)').run(profile.id, profileId, new Date().toISOString());
    await syncMemberLoginGrants(profile, team.projectId);
    announceAssistantChanges();
    announceTeamChange(teamId);
    response.status(201);
    return { login: await loginState(profileId, profile), session: { id: started.session.id, nodeId: local.id } };
  }));

  // Reopen an attached browser profile live on Homeserver (e.g., QR / SSO re-auth).
  app.post('/api/assistant-teams/:id/members/:role/logins/:profileId/open', teamRoute(async (request, response) => {
    const auth = authSession(response);
    const teamId = teamIdSchema.parse(request.params.id);
    const role = roleSchema.parse(request.params.role);
    const profileId = z.string().uuid().parse(request.params.profileId);
    await requireTeamMember(auth, teamId);
    const { team, profile } = await resolveTeamMemberProfile(teamId, role);
    assertMemberEditable(auth, team, profile);
    if (!(await assistantLoginProfileIds(profile.id)).includes(profileId)) throw new TeamError('Login not found', 404);
    const url = z.object({ url: browserWebUrlSchema.optional() }).strict().parse(request.body ?? {}).url;
    const local = await getClusterNode();
    const started = await browserOperation({
      operation: 'start',
      args: { projectId: team.projectId, engine: profile.engine, conversationId: profile.sessionId, appNodeId: local.id, profileId, ...(url ? { url } : {}) },
    }, await humanActor(auth), local.id) as { session: BrowserSessionView };
    return { login: await loginState(profileId, profile), session: { id: started.session.id, nodeId: local.id } };
  }));

  // Attach an existing saved browser profile to this team member.
  app.post('/api/assistant-teams/:id/members/:role/logins/attach', teamRoute(async (request, response) => {
    const auth = authSession(response);
    const teamId = teamIdSchema.parse(request.params.id);
    const role = roleSchema.parse(request.params.role);
    await requireTeamMember(auth, teamId);
    const { team, profile } = await resolveTeamMemberProfile(teamId, role);
    assertMemberEditable(auth, team, profile);
    const { profileId } = z.object({ profileId: z.string().uuid() }).strict().parse(request.body);
    const db = await personalAssistantDatabase();
    db.prepare('INSERT OR IGNORE INTO personal_assistant_logins (assistant_id, profile_id, created_at) VALUES (?,?,?)').run(profile.id, profileId, new Date().toISOString());
    await syncMemberLoginGrants(profile, team.projectId);
    announceAssistantChanges();
    announceTeamChange(teamId);
    response.status(201);
    return { login: await loginState(profileId, profile) };
  }));

  // Detach a saved browser profile from this team member.
  app.delete('/api/assistant-teams/:id/members/:role/logins/:profileId', teamRoute(async (request, response) => {
    const auth = authSession(response);
    const teamId = teamIdSchema.parse(request.params.id);
    const role = roleSchema.parse(request.params.role);
    const profileId = z.string().uuid().parse(request.params.profileId);
    await requireTeamMember(auth, teamId);
    const { team, profile } = await resolveTeamMemberProfile(teamId, role);
    assertMemberEditable(auth, team, profile);
    const db = await personalAssistantDatabase();
    db.prepare('DELETE FROM personal_assistant_logins WHERE assistant_id=? AND profile_id=?').run(profile.id, profileId);
    announceAssistantChanges();
    announceTeamChange(teamId);
    return { ok: true };
  }));

  // List live team automations/schedules and specialist automation requests awaiting Chief approval.
  app.get('/api/assistant-teams/:id/automations', teamRoute(async (request, response) => {
    const auth = authSession(response);
    const teamId = teamIdSchema.parse(request.params.id);
    await requireTeamMember(auth, teamId);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).strict().parse(request.query);
    return listTeamAutomations(teamId, limit);
  }));

  // Human team member can also approve or reject a specialist automation request directly from Team UI.
  app.post('/api/assistant-teams/:id/automations/requests/:requestId/decide', teamRoute(async (request, response) => {
    const auth = authSession(response);
    const teamId = teamIdSchema.parse(request.params.id);
    const member = await requireTeamMember(auth, teamId);
    const requestId = z.string().uuid().parse(request.params.requestId);
    const body = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(500).optional() }).strict().parse(request.body);
    return { request: await decideTeamAutomationRequest(teamId, requestId, body.decision, { kind: 'human', accountId: member.accountId }, body.note) };
  }));
}
