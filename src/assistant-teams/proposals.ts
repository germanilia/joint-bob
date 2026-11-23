import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { asNode } from '../account-context.js';
import { listAssistantFiles } from '../assistant-capabilities.js';
import { announceAssistantChanges } from '../assistant-collaboration/twin-sync.js';
import { assistantMemoryEnabled } from '../assistant-resources.js';
import { getClusterNode } from '../cluster.js';
import { ensureConversationRecord } from '../conversation-records.js';
import { getHarness, getHarnessRuntime, listHarnessModels, listHarnesses, listHarnessSessions } from '../harnesses.js';
import { ensureSessionTitle } from '../names.js';
import {
  assistantLoginProfileIds,
  getPersonalAssistantById,
  listPersonalAssistants,
  listPersonalAssistantTopics,
  personalAssistantDatabase,
  savePersonalAssistant,
  type PersonalAssistant,
  type PersonalAssistantExecutionSettings,
} from '../personal-assistants.js';
import { resourceInventory } from '../resource-inventory.js';
import {
  conversationScopeId,
  getScopeSecretAccounts,
  listSecretAccounts,
  setScopeSecretAccounts,
  type SecretAccount,
} from '../secrets.js';
import { parseResourceFrontmatter } from '../skills.js';
import { validateSkillName } from '../skill-sharing.js';
import { getProject } from '../store.js';
import { isHarnessId } from '../types.js';
import { readWebhookMemory } from '../webhook-memory.js';
import { WebhookResourceError } from '../webhook-resources.js';
import { listWebhookSkills, removeWebhookSkill, uploadWebhookSkill, WEBHOOK_SKILL_MAX_FILES } from '../webhook-skills.js';
import { recheckTeamActor, requireTeamExecution, type TeamMember } from './access.js';
import {
  announceTeamChange,
  getTeam,
  isReservedTeamRole,
  listTeamAgents,
  saveTeamMembers,
  TEAM_ROLE_PATTERN,
  teamCoordinator,
  teamDatabase,
  TeamError,
  type TeamAssignment,
  type TeamRole,
} from './store.js';

const roleSchema = z.string().regex(TEAM_ROLE_PATTERN);
const resourceNameList = z.array(z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/)).max(1000);
const executionSettingsSchema = z.object({
  harnessId: z.string().min(1).max(50),
  provider: z.string().min(1).max(100),
  modelId: z.string().min(1).max(200),
  reasoning: z.string().min(1).max(100),
}).strict();
const skillFileSchema = z.object({
  relativePath: z.string().min(1).max(1000),
  content: z.string().max(500_000),
}).strict();

export const teamProposalChangeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('update_assistant'),
    role: roleSchema,
    name: z.string().trim().min(1).max(100).optional(),
    instructions: z.string().max(20_000).optional(),
    allowTerminal: z.boolean().optional(),
    allowBrowser: z.boolean().optional(),
    mcpServerNames: z.array(z.string().min(1).max(200)).max(100).nullable().optional(),
    executionSettings: executionSettingsSchema.optional(),
    disabledSkills: resourceNameList.optional(),
    disabledPlugins: resourceNameList.optional(),
  }).strict(),
  z.object({
    kind: z.literal('attach_secret'),
    role: roleSchema,
    secretAccountId: z.string().uuid(),
  }).strict(),
  z.object({
    kind: z.literal('detach_secret'),
    role: roleSchema,
    secretAccountId: z.string().uuid(),
  }).strict(),
  z.object({
    kind: z.literal('upsert_skill'),
    role: roleSchema,
    files: z.array(skillFileSchema).min(1).max(WEBHOOK_SKILL_MAX_FILES),
  }).strict(),
  z.object({
    kind: z.literal('delete_skill'),
    role: roleSchema,
    skillName: z.string().trim().min(1).max(200),
  }).strict(),
  z.object({
    kind: z.literal('attach_login'),
    role: roleSchema,
    profileId: z.string().uuid(),
  }).strict(),
  z.object({
    kind: z.literal('detach_login'),
    role: roleSchema,
    profileId: z.string().uuid(),
  }).strict(),
  z.object({
    kind: z.literal('create_member'),
    role: roleSchema,
    name: z.string().trim().min(1).max(100),
    instructions: z.string().max(20_000),
    allowTerminal: z.boolean().optional(),
    allowBrowser: z.boolean().optional(),
    mcpServerNames: z.array(z.string().min(1).max(200)).max(100).nullable().optional(),
    executionSettings: executionSettingsSchema.optional(),
    secretAccountIds: z.array(z.string().uuid()).max(20).optional(),
    skills: z.array(z.object({ files: z.array(skillFileSchema).min(1).max(WEBHOOK_SKILL_MAX_FILES) }).strict()).max(10).optional(),
  }).strict(),
  z.object({
    kind: z.literal('add_member'),
    role: roleSchema,
    assistantId: z.string().min(1).max(200),
  }).strict(),
  z.object({
    kind: z.literal('rename_role'),
    role: roleSchema,
    newRole: roleSchema,
  }).strict(),
  z.object({
    kind: z.literal('remove_member'),
    role: roleSchema,
  }).strict(),
]);

export const teamProposalInputSchema = z.object({
  summary: z.string().trim().min(1).max(300),
  rationale: z.string().trim().min(1).max(2000),
  changes: z.array(teamProposalChangeSchema).min(1).max(20),
}).strict();

export type TeamProposalChange = z.infer<typeof teamProposalChangeSchema>;
export type TeamProposalState = 'pending' | 'approved' | 'rejected' | 'applied' | 'failed' | 'cancelled';

export interface TeamProposalPreviewItem {
  kind: TeamProposalChange['kind'];
  role: string;
  headline: string;
  detail: string;
}

export interface TeamProposal {
  id: string;
  teamId: string;
  assignmentId: string;
  rootId: string;
  requestedBy: string;
  proposedByRole: TeamRole;
  summary: string;
  rationale: string;
  changes: TeamProposalChange[];
  previews: TeamProposalPreviewItem[];
  state: TeamProposalState;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  appliedSummary?: string[];
  error?: string;
}

export interface SecretMetadataSummary {
  id: string;
  label: string;
  provider: string;
  variables: Array<{ name: string; kind: 'value' | 'file' }>;
  websiteOrigin?: string;
}

export async function proposalDatabase(): Promise<DatabaseSync> {
  const db = await teamDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS assistant_team_proposals (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    assignment_id TEXT NOT NULL,
    root_id TEXT NOT NULL,
    state TEXT NOT NULL,
    record TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS assistant_team_proposals_team ON assistant_team_proposals(team_id, state);
  CREATE INDEX IF NOT EXISTS assistant_team_proposals_assignment ON assistant_team_proposals(assignment_id, state);`);
  return db;
}

/** Compact base64url representation of a UUID for Telegram 64-byte callback_data. */
export function encodeProposalCallbackId(uuid: string): string {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex').toString('base64url');
}

export function decodeProposalCallbackId(token: string): string | null {
  const bytes = Buffer.from(token, 'base64url');
  if (bytes.length !== 16) return null;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function secretSummary(account: SecretAccount): SecretMetadataSummary {
  return {
    id: account.id,
    label: account.label,
    provider: account.provider,
    variables: account.variables.map(v => ({ name: v.name, kind: v.kind })),
    ...(account.websiteOrigin ? { websiteOrigin: account.websiteOrigin } : {}),
  };
}

/** Metadata-only view of all secrets available on this host node that can be attached to team assistants. Never includes values. */
export async function listNodeAttachableSecrets(teamId: string): Promise<SecretMetadataSummary[]> {
  const team = await getTeam(teamId);
  const all = await asNode(() => listSecretAccounts());
  return all
    .filter(account => !account.projectId || account.projectId === team.projectId)
    .map(secretSummary);
}

/** Metadata-only list of secrets currently attached to an assistant (from its source conversation). */
export async function listAssistantAttachedSecrets(profile: PersonalAssistant): Promise<SecretMetadataSummary[]> {
  if (!isHarnessId(profile.engine)) return [];
  const attached = await asNode(async () => {
    const scope = conversationScopeId(profile.engine, profile.sessionId);
    const { accountIds } = await getScopeSecretAccounts('conversation', scope);
    if (!accountIds.length) return [];
    const byId = new Map((await listSecretAccounts()).map(account => [account.id, account]));
    return accountIds.flatMap(id => {
      const account = byId.get(id);
      return account ? [secretSummary(account)] : [];
    });
  });
  return attached;
}

/**
 * Ensures an assistant's attached secrets (stored on its source conversation) are also attached to a target conversation
 * (including team conversations in the team's shared project).
 */
export async function syncAssistantSecretsToConversation(profile: PersonalAssistant, engine: string, sessionId: string): Promise<void> {
  if (!isHarnessId(profile.engine) || !isHarnessId(engine)) return;
  await asNode(async () => {
    const sourceScope = conversationScopeId(profile.engine, profile.sessionId);
    const targetScope = conversationScopeId(engine, sessionId);
    if (sourceScope === targetScope) return;
    const [source, target] = await Promise.all([
      getScopeSecretAccounts('conversation', sourceScope),
      getScopeSecretAccounts('conversation', targetScope),
    ]);
    if (!source.accountIds.length) return;
    const merged = [...new Set([...target.accountIds, ...source.accountIds])];
    if (merged.length !== target.accountIds.length) {
      await setScopeSecretAccounts('conversation', targetScope, merged);
    }
  });
}

async function allAssistantConversations(profile: PersonalAssistant): Promise<Array<{ projectId: string; engine: string; sessionId: string }>> {
  const db = await personalAssistantDatabase();
  const seen = new Set<string>();
  const list: Array<{ projectId: string; engine: string; sessionId: string }> = [];
  const add = (projectId: string, engine: string, sessionId: string) => {
    const key = `${engine}:${sessionId}`;
    if (!isHarnessId(engine) || seen.has(key)) return;
    seen.add(key);
    list.push({ projectId, engine, sessionId });
  };
  add(profile.projectId, profile.engine, profile.sessionId);
  const topics = await listPersonalAssistantTopics(profile.accountId, profile.id) ?? [];
  for (const topic of topics) add(topic.projectId, topic.engine, topic.sessionId);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='assistant_team_conversations'").get()) {
    const rows = db.prepare('SELECT project_id projectId, engine, conversation_id sessionId FROM assistant_team_conversations WHERE assistant_id=?').all(profile.id) as Array<{ projectId: string; engine: string; sessionId: string }>;
    for (const row of rows) add(row.projectId, row.engine, row.sessionId);
  }
  return list;
}

async function attachOrDetachAssistantSecret(profile: PersonalAssistant, secretAccountId: string, mode: 'attach' | 'detach'): Promise<void> {
  const conversations = await allAssistantConversations(profile);
  await asNode(async () => {
    for (const conv of conversations) {
      const scope = conversationScopeId(conv.engine, conv.sessionId);
      const { accountIds } = await getScopeSecretAccounts('conversation', scope);
      const next = mode === 'attach'
        ? (accountIds.includes(secretAccountId) ? accountIds : [...accountIds, secretAccountId])
        : accountIds.filter(id => id !== secretAccountId);
      if (next.length !== accountIds.length) {
        await setScopeSecretAccounts('conversation', scope, next);
      }
    }
  });
}

async function invalidateAssistantLiveSessions(profile: PersonalAssistant, resetToolBaseline: boolean, disposeIdleSessions: boolean): Promise<void> {
  if (resetToolBaseline) {
    const db = await personalAssistantDatabase();
    db.prepare('UPDATE personal_assistant_topics SET baseline_tools=NULL WHERE assistant_id=?').run(profile.id);
    db.prepare('UPDATE personal_assistants SET baseline_tools=NULL WHERE id=?').run(profile.id);
  }
  if (disposeIdleSessions) {
    try {
      const { findHarnessSession, disposeHarnessSession, harnessSessionBusy } = await import('../server/harness-sessions.js');
      for (const conv of await allAssistantConversations(profile)) {
        const shared = findHarnessSession(conv.projectId, conv.engine, conv.sessionId);
        if (shared && !harnessSessionBusy(shared)) {
          try { disposeHarnessSession(shared); } catch { /* busy or already disposed */ }
        }
      }
    } catch { /* harness sessions module may not be initialized in isolated unit tests */ }
  }
}

async function roleUsageMap(teamId: string): Promise<Map<string, { assignmentCount: number; completedCount: number; failedCount: number; lastUsedAt: string | null }>> {
  const db = await proposalDatabase();
  const map = new Map<string, { assignmentCount: number; completedCount: number; failedCount: number; lastUsedAt: string | null }>();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='assistant_team_assignments'").get()) return map;
  const rows = db.prepare('SELECT record FROM assistant_team_assignments WHERE team_id=? ORDER BY rowid').all(teamId) as Array<{ record: string }>;
  const roots = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='assistant_team_roots'").get()
    ? new Map((db.prepare('SELECT id, record FROM assistant_team_roots WHERE team_id=?').all(teamId) as Array<{ id: string; record: string }>).map(r => [r.id, (JSON.parse(r.record) as { source?: { createdAt?: string } }).source?.createdAt ?? null]))
    : new Map<string, string | null>();
  for (const row of rows) {
    const a = JSON.parse(row.record) as TeamAssignment;
    const entry = map.get(a.role) ?? { assignmentCount: 0, completedCount: 0, failedCount: 0, lastUsedAt: null };
    entry.assignmentCount += 1;
    if (a.state === 'completed') entry.completedCount += 1;
    if (a.state === 'failed' || a.state === 'uncertain') entry.failedCount += 1;
    const at = roots.get(a.rootId) ?? null;
    if (at && (!entry.lastUsedAt || at > entry.lastUsedAt)) entry.lastUsedAt = at;
    map.set(a.role, entry);
  }
  return map;
}

async function resourcePreferencesOf(assistantId: string): Promise<{ disabledSkills: string[]; disabledPlugins: string[] }> {
  const db = await personalAssistantDatabase();
  const row = db.prepare('SELECT disabled_skills skills, disabled_plugins plugins FROM personal_assistant_resources WHERE assistant_id=?').get(assistantId) as { skills: string; plugins: string } | undefined;
  return row ? { disabledSkills: JSON.parse(row.skills) as string[], disabledPlugins: JSON.parse(row.plugins) as string[] } : { disabledSkills: [], disabledPlugins: [] };
}

async function saveAssistantResourcePreferences(assistantId: string, preferences: { disabledSkills: string[]; disabledPlugins: string[] }): Promise<void> {
  const db = await personalAssistantDatabase();
  db.prepare(`INSERT INTO personal_assistant_resources (assistant_id, disabled_skills, disabled_plugins) VALUES (?,?,?)
    ON CONFLICT(assistant_id) DO UPDATE SET disabled_skills=excluded.disabled_skills, disabled_plugins=excluded.disabled_plugins`)
    .run(assistantId, JSON.stringify([...new Set(preferences.disabledSkills)].sort()), JSON.stringify([...new Set(preferences.disabledPlugins)].sort()));
}

/** Rich summary of all members in this team for the coordinator's `team_list_agents` tool. */
export async function listTeamAgentSummaries(teamId: string) {
  const team = await getTeam(teamId);
  const coordinator = await teamCoordinator(team);
  const members = await listTeamAgents(teamId);
  const usage = await roleUsageMap(teamId);
  const db = await personalAssistantDatabase();
  const { teamAgentReadiness } = await import('./runtime.js');
  return Promise.all(members.map(async member => {
    const profile = await getPersonalAssistantById(member.assistantId);
    const stats = usage.get(member.role) ?? { assignmentCount: 0, completedCount: 0, failedCount: 0, lastUsedAt: null };
    if (!profile) {
      return {
        role: member.role,
        assistantId: member.assistantId,
        assistant: null,
        coordinator: member.role === coordinator,
        ready: false,
        readinessProblems: ['Assistant was deleted'],
        usage: stats,
      };
    }
    const [readinessProblems, attachedSecrets, prefs, logins] = await Promise.all([
      asNode(() => teamAgentReadiness(profile)),
      listAssistantAttachedSecrets(profile),
      resourcePreferencesOf(profile.id),
      assistantLoginProfileIds(profile.id),
    ]);
    const ownSkills = listWebhookSkills(db, profile.id).map(skill => ({ name: skill.name, description: skill.description }));
    return {
      role: member.role,
      assistantId: profile.id,
      assistant: profile.name,
      coordinator: member.role === coordinator,
      ready: readinessProblems.length === 0,
      readinessProblems,
      executionSettings: profile.executionSettings,
      engine: profile.executionSettings?.harnessId ?? profile.engine,
      allowTerminal: profile.allowTerminal,
      allowBrowser: profile.allowBrowser,
      mcpServerNames: profile.mcpServerNames,
      attachedSecrets,
      ownSkills,
      disabledSkills: prefs.disabledSkills,
      disabledPlugins: prefs.disabledPlugins,
      loginCount: logins.length,
      instructionsPreview: profile.instructions.slice(0, 300),
      usage: stats,
    };
  }));
}

async function listSkillFolderFiles(skillDir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix = ''): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
      if (out.length >= 50) return;
    }
  };
  try { await walk(skillDir); } catch { /* ignore unreadable folder */ }
  return out.sort();
}

/** Full configuration, instructions, skills, secrets, logins, files, memory, and usage for one member of this team. */
export async function inspectTeamAgent(teamId: string, role: string) {
  const team = await getTeam(teamId);
  const coordinator = await teamCoordinator(team);
  const member = (await listTeamAgents(teamId)).find(item => item.role === role);
  if (!member) throw new TeamError(`Unknown team role: ${role}`, 404);
  const profile = await getPersonalAssistantById(member.assistantId);
  if (!profile) throw new TeamError(`Assistant for role ${role} no longer exists`, 404);
  const db = await personalAssistantDatabase();
  const { teamAgentReadiness } = await import('./runtime.js');
  const [readinessProblems, attachedSecrets, prefs, logins, files, usage] = await Promise.all([
    asNode(() => teamAgentReadiness(profile)),
    listAssistantAttachedSecrets(profile),
    resourcePreferencesOf(profile.id),
    assistantLoginProfileIds(profile.id),
    listAssistantFiles(profile.id).catch(() => []),
    roleUsageMap(teamId),
  ]);
  const ownSkills = await Promise.all(listWebhookSkills(db, profile.id).map(async skill => {
    let skillMd = '';
    try { skillMd = (await readFile(path.join(skill.path, 'SKILL.md'), 'utf8')).slice(0, 8000); } catch { /* missing */ }
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      files: await listSkillFolderFiles(skill.path),
      skillMd,
    };
  }));
  let memoryExcerpt = '';
  if (assistantMemoryEnabled(db, profile.id)) {
    try { memoryExcerpt = (await readWebhookMemory(profile.id)).content.slice(0, 4000); } catch { /* ignore */ }
  }
  return {
    role: member.role,
    assistantId: profile.id,
    name: profile.name,
    coordinator: member.role === coordinator,
    ready: readinessProblems.length === 0,
    readinessProblems,
    instructions: profile.instructions,
    executionSettings: profile.executionSettings,
    engine: profile.executionSettings?.harnessId ?? profile.engine,
    allowTerminal: profile.allowTerminal,
    allowBrowser: profile.allowBrowser,
    mcpServerNames: profile.mcpServerNames,
    attachedSecrets,
    ownSkills,
    disabledSkills: prefs.disabledSkills,
    disabledPlugins: prefs.disabledPlugins,
    logins,
    files: files.slice(0, 50),
    memoryExcerpt,
    usage: usage.get(member.role) ?? { assignmentCount: 0, completedCount: 0, failedCount: 0, lastUsedAt: null },
  };
}

/** Everything available on this host node to equip or create team assistants. Never exposes secret values. */
export async function readTeamNodeCatalog(teamId: string) {
  const team = await getTeam(teamId);
  const project = await asNode(() => getProject(team.projectId));
  const secrets = await listNodeAttachableSecrets(teamId);
  const inventory = await asNode(() => resourceInventory({ projectPath: project?.path, projectId: team.projectId, ignoreAssistantPreferences: true })).catch(() => ({ skills: [], plugins: [], mcpServers: [] }));
  const harnesses = await Promise.all(listHarnesses().filter(adapter => adapter.runtime).map(async adapter => {
    try {
      const runtime = await getHarnessRuntime(adapter.id);
      const problems = await runtime.readiness(project?.path ?? process.cwd());
      const models = problems.length ? [] : (await listHarnessModels(adapter.id)).map(model => ({
        provider: model.provider,
        modelId: model.id,
        label: model.label,
        thinkingLevels: model.thinkingLevels,
      }));
      return { harnessId: adapter.id, label: adapter.label, ready: problems.length === 0, problems, models: models.slice(0, 60) };
    } catch (error) {
      return { harnessId: adapter.id, label: adapter.label, ready: false, problems: [error instanceof Error ? error.message : String(error)], models: [] };
    }
  }));
  let browserProfiles: Array<{ id: string; label: string; sites: string[] }> = [];
  try {
    const { browserRuntime } = await import('../server/browser.js');
    browserProfiles = (await browserRuntime().profiles(team.projectId)).map(profile => ({ id: profile.id, label: profile.label, sites: profile.sites ?? [] }));
  } catch { /* browser runtime may not be initialized in unit tests */ }
  const existingTeamAssistantIds = new Set((await listTeamAgents(teamId)).map(a => a.assistantId));
  const availableAssistants = (await listPersonalAssistants(team.executorAccountId))
    .filter(profile => (!profile.nodeId || profile.nodeId === team.hostNodeId) && !existingTeamAssistantIds.has(profile.id))
    .map(profile => ({
      id: profile.id,
      name: profile.name,
      allowTerminal: profile.allowTerminal,
      allowBrowser: profile.allowBrowser,
      executionSettings: profile.executionSettings,
    }));
  return {
    secrets,
    mcpServers: [...new Map(inventory.mcpServers.map(s => [s.name, { name: s.name, source: s.source }])).values()],
    skills: inventory.skills.slice(0, 100).map(s => ({ name: s.name, description: s.description, origin: s.origin, harnesses: s.harnesses })),
    plugins: inventory.plugins.slice(0, 100).map(p => ({ name: p.name, source: p.source, harnesses: p.harnesses })),
    harnesses,
    browserProfiles,
    availableAssistants,
  };
}

export interface AssignmentTraceSummary {
  conversationId: string | null;
  engine: string | null;
  messageCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  attribution?: { harnessId: string; provider: string; modelId: string; reasoning: string };
  toolCalls: Array<{ toolName: string; target?: string; isError?: boolean; durationMs?: number; excerpt?: string }>;
}

/** Bounded execution trace of an assignment's latest turn from its harness transcript, for coordinator review. */
export async function readAssignmentTrace(teamId: string, assignment: TeamAssignment, conversationId: string | null): Promise<AssignmentTraceSummary | null> {
  if (!conversationId) return null;
  try {
    const team = await getTeam(teamId);
    const project = await asNode(() => getProject(team.projectId));
    if (!project) return null;
    const db = await proposalDatabase();
    const row = db.prepare('SELECT engine FROM assistant_team_conversations WHERE team_id=? AND conversation_id=?').get(teamId, conversationId) as { engine: string } | undefined;
    const engine = row?.engine;
    if (!engine || !isHarnessId(engine)) return null;
    const sessions = await listHarnessSessions(project, [], [conversationId], 200);
    const summary = sessions.find(s => s.harnessId === engine && s.id === conversationId)
      ?? sessions.find(s => s.segments?.some(seg => seg.engine === engine && seg.sessionId === conversationId));
    const sessionPath = summary && summary.harnessId === engine && summary.id === conversationId
      ? summary.path
      : summary?.segments?.find(seg => seg.engine === engine && seg.sessionId === conversationId)?.path;
    if (!sessionPath) return { conversationId, engine, messageCount: 0, toolCallCount: 0, toolErrorCount: 0, toolCalls: [] };
    const messages = await getHarness(engine).sessions.loadMessages(project, sessionPath);
    // Focus on the latest turn (from the last user message forward) so multi-turn conversations stay concise.
    let lastUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { lastUserIndex = i; break; }
    }
    const turnMessages = lastUserIndex >= 0 ? messages.slice(lastUserIndex + 1) : messages.slice(-30);
    const toolCalls = turnMessages
      .filter(m => m.toolName || m.role === 'tool' || m.role === 'toolResult')
      .slice(0, 25)
      .map(m => ({
        toolName: m.toolName ?? m.role,
        ...(m.toolTarget?.target ? { target: m.toolTarget.target.slice(0, 140) } : m.toolTarget?.skill ? { target: `skill:${m.toolTarget.skill}` } : {}),
        ...(m.isError ? { isError: true } : {}),
        ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {}),
        ...(m.isError && m.text ? { excerpt: m.text.slice(0, 240) } : {}),
      }));
    const attribution = [...turnMessages].reverse().find(m => m.attribution)?.attribution;
    return {
      conversationId,
      engine,
      messageCount: turnMessages.length,
      toolCallCount: toolCalls.length,
      toolErrorCount: toolCalls.filter(t => t.isError).length,
      ...(attribution ? { attribution } : {}),
      toolCalls,
    };
  } catch {
    return null;
  }
}

export function formatTraceForReview(trace: AssignmentTraceSummary | null): string {
  if (!trace || (!trace.toolCallCount && !trace.attribution)) return '';
  const bits: string[] = [];
  if (trace.attribution) bits.push(`model=${trace.attribution.harnessId}/${trace.attribution.provider}/${trace.attribution.modelId} (${trace.attribution.reasoning})`);
  bits.push(`tools=${trace.toolCallCount} (${trace.toolErrorCount} errors)`);
  const calls = trace.toolCalls.slice(0, 12).map(t =>
    `${t.toolName}${t.target ? `(${t.target})` : ''}${t.isError ? ` [ERROR${t.excerpt ? `: ${t.excerpt.replace(/\s+/g, ' ').slice(0, 120)}` : ''}]` : ''}${t.durationMs ? ` ${t.durationMs}ms` : ''}`
  );
  return `[Trace: ${bits.join(', ')}${calls.length ? `; calls: ${calls.join(' -> ')}` : ''}]`;
}

async function validateExecutionSettingsChoice(settings: PersonalAssistantExecutionSettings): Promise<void> {
  if (!isHarnessId(settings.harnessId)) throw new TeamError(`Unknown harness: ${settings.harnessId}`, 400);
  const adapter = listHarnesses().find(candidate => candidate.id === settings.harnessId);
  if (!adapter?.runtime) throw new TeamError(`Harness ${settings.harnessId} is unavailable on this host`, 400);
  const runtime = await getHarnessRuntime(settings.harnessId);
  const problems = await runtime.readiness(process.cwd());
  if (problems.length) throw new TeamError(problems.join('; '), 400);
  const model = (await listHarnessModels(settings.harnessId)).find(candidate => candidate.id === settings.modelId && candidate.provider === settings.provider);
  if (!model || !model.thinkingLevels.includes(settings.reasoning)) {
    throw new TeamError(`Model ${settings.provider}/${settings.modelId} with effort "${settings.reasoning}" is unavailable on ${settings.harnessId}`, 400);
  }
  await runtime.validateSettings({ provider: settings.provider, modelId: settings.modelId, reasoning: settings.reasoning });
}

function validateSkillFiles(files: Array<{ relativePath: string; content: string }>): { name: string; description: string } {
  const index = files.findIndex(file => file.relativePath === 'SKILL.md');
  if (index < 0) throw new TeamError('Skill bundle must contain SKILL.md', 400);
  const frontmatter = parseResourceFrontmatter(files[index].content);
  const name = frontmatter.name?.trim() ?? '';
  try { validateSkillName(name); } catch { throw new TeamError('SKILL.md must declare a valid skill name', 400); }
  const description = frontmatter.description?.trim() ?? '';
  if (!description) throw new TeamError('SKILL.md must declare a description', 400);
  if (description.length > 2000) throw new TeamError('Skill description must be at most 2,000 characters', 400);
  return { name, description };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Validates every change in a bundle against this team and builds human-readable previews. */
async function validateAndPreviewChanges(teamId: string, changes: TeamProposalChange[]): Promise<TeamProposalPreviewItem[]> {
  const team = await getTeam(teamId);
  const coordinator = await teamCoordinator(team);
  const members = await listTeamAgents(teamId);
  const secrets = new Map((await listNodeAttachableSecrets(teamId)).map(s => [s.id, s]));
  const simulatedRoles = new Map<string, { assistantId: string | null; profile: PersonalAssistant | null }>();
  for (const m of members) {
    simulatedRoles.set(m.role, { assistantId: m.assistantId, profile: (await getPersonalAssistantById(m.assistantId)) ?? null });
  }
  const previews: TeamProposalPreviewItem[] = [];
  for (const change of changes) {
    if (change.kind === 'create_member') {
      if (isReservedTeamRole(change.role)) throw new TeamError(`Role "${change.role}" is a reserved team command`, 400);
      if (simulatedRoles.has(change.role)) throw new TeamError(`Role "${change.role}" already exists in this team`, 409);
      if (change.executionSettings) await validateExecutionSettingsChoice(change.executionSettings);
      for (const secretId of change.secretAccountIds ?? []) {
        if (!secrets.has(secretId)) throw new TeamError(`Secret ${secretId} is not available in this node's attachable pool`, 404);
      }
      const skillNames: string[] = [];
      for (const skill of change.skills ?? []) skillNames.push(validateSkillFiles(skill.files).name);
      simulatedRoles.set(change.role, { assistantId: null, profile: null });
      const parts = [
        `Create assistant "${change.name}" as /${change.role}`,
        change.executionSettings ? `${change.executionSettings.harnessId} · ${change.executionSettings.modelId} (${change.executionSettings.reasoning})` : null,
        change.allowTerminal !== undefined ? `terminal=${change.allowTerminal ? 'on' : 'off'}` : null,
        change.allowBrowser !== undefined ? `browser=${change.allowBrowser ? 'on' : 'off'}` : null,
        change.secretAccountIds?.length ? `secrets: ${change.secretAccountIds.map(id => secrets.get(id)!.label).join(', ')}` : null,
        skillNames.length ? `skills: ${skillNames.join(', ')}` : null,
      ].filter(Boolean);
      previews.push({
        kind: change.kind,
        role: change.role,
        headline: parts.join(' · '),
        detail: `Instructions:\n${clip(change.instructions, 1200)}`,
      });
      continue;
    }
    if (change.kind === 'add_member') {
      if (isReservedTeamRole(change.role)) throw new TeamError(`Role "${change.role}" is a reserved team command`, 400);
      if (simulatedRoles.has(change.role)) throw new TeamError(`Role "${change.role}" already exists in this team`, 409);
      const profile = await getPersonalAssistantById(change.assistantId);
      if (!profile || (profile.nodeId && profile.nodeId !== team.hostNodeId)) throw new TeamError('Assistant must exist on this team host machine', 404);
      for (const existing of simulatedRoles.values()) if (existing.assistantId === profile.id) throw new TeamError(`Assistant "${profile.name}" is already in this team`, 409);
      simulatedRoles.set(change.role, { assistantId: profile.id, profile });
      previews.push({ kind: change.kind, role: change.role, headline: `Add "${profile.name}" to team as /${change.role}`, detail: `Assistant ID: ${profile.id}` });
      continue;
    }
    const target = simulatedRoles.get(change.role);
    if (!target) throw new TeamError(`Unknown team role: ${change.role}`, 404);
    if (change.kind === 'remove_member') {
      if (change.role === coordinator) throw new TeamError('Cannot remove the team coordinator', 400);
      simulatedRoles.delete(change.role);
      previews.push({ kind: change.kind, role: change.role, headline: `Remove /${change.role}${target.profile ? ` ("${target.profile.name}")` : ''} from this team`, detail: 'The assistant is removed from this team roster; its underlying personal assistant record is kept.' });
      continue;
    }
    if (change.kind === 'rename_role') {
      if (isReservedTeamRole(change.newRole)) throw new TeamError(`Role "${change.newRole}" is a reserved team command`, 400);
      if (simulatedRoles.has(change.newRole)) throw new TeamError(`Role "${change.newRole}" already exists in this team`, 409);
      simulatedRoles.delete(change.role);
      simulatedRoles.set(change.newRole, target);
      previews.push({ kind: change.kind, role: change.role, headline: `Rename role /${change.role} → /${change.newRole}`, detail: `Telegram command changes from /${change.role} to /${change.newRole}.` });
      continue;
    }
    if (change.kind === 'attach_secret' || change.kind === 'detach_secret') {
      const secret = secrets.get(change.secretAccountId);
      if (!secret) throw new TeamError(`Secret ${change.secretAccountId} is not available in this node's attachable pool`, 404);
      const vars = secret.variables.map(v => v.name).join(', ');
      previews.push({
        kind: change.kind,
        role: change.role,
        headline: `${change.kind === 'attach_secret' ? 'Attach' : 'Detach'} secret "${secret.label}" (${secret.provider}) ${change.kind === 'attach_secret' ? 'to' : 'from'} /${change.role}`,
        detail: `Variables: ${vars || '(none)'}`,
      });
      continue;
    }
    if (change.kind === 'upsert_skill') {
      const meta = validateSkillFiles(change.files);
      const skillMd = change.files.find(f => f.relativePath === 'SKILL.md')!.content;
      previews.push({
        kind: change.kind,
        role: change.role,
        headline: `Install/update skill "${meta.name}" on /${change.role} (${change.files.length} file${change.files.length === 1 ? '' : 's'})`,
        detail: `${meta.description}\nFiles: ${change.files.map(f => f.relativePath).join(', ')}\n\n${clip(skillMd, 1500)}`,
      });
      continue;
    }
    if (change.kind === 'delete_skill') {
      previews.push({
        kind: change.kind,
        role: change.role,
        headline: `Remove skill "${change.skillName}" from /${change.role}`,
        detail: `Deletes assistant-specific skill "${change.skillName}".`,
      });
      continue;
    }
    if (change.kind === 'attach_login' || change.kind === 'detach_login') {
      previews.push({
        kind: change.kind,
        role: change.role,
        headline: `${change.kind === 'attach_login' ? 'Attach' : 'Detach'} browser login profile ${change.profileId} on /${change.role}`,
        detail: `Profile ID: ${change.profileId}`,
      });
      continue;
    }
    // update_assistant
    if (change.executionSettings) await validateExecutionSettingsChoice(change.executionSettings);
    const current = target.profile;
    const summaryParts: string[] = [];
    const detailLines: string[] = [];
    if (change.name !== undefined) {
      summaryParts.push(`name="${change.name}"`);
      detailLines.push(`Name: ${current?.name ?? '(new)'} → ${change.name}`);
    }
    if (change.allowTerminal !== undefined) {
      summaryParts.push(`terminal=${change.allowTerminal ? 'on' : 'off'}`);
      detailLines.push(`Terminal: ${current ? (current.allowTerminal ? 'on' : 'off') : '?'} → ${change.allowTerminal ? 'on' : 'off'}`);
    }
    if (change.allowBrowser !== undefined) {
      summaryParts.push(`browser=${change.allowBrowser ? 'on' : 'off'}`);
      detailLines.push(`Browser: ${current ? (current.allowBrowser ? 'on' : 'off') : '?'} → ${change.allowBrowser ? 'on' : 'off'}`);
    }
    if (change.mcpServerNames !== undefined) {
      const label = change.mcpServerNames === null ? 'all installed' : (change.mcpServerNames.join(', ') || 'none');
      summaryParts.push(`MCP=[${label}]`);
      detailLines.push(`MCP servers: ${label}`);
    }
    if (change.executionSettings !== undefined) {
      const es = change.executionSettings;
      const before = current?.executionSettings ? `${current.executionSettings.harnessId}/${current.executionSettings.provider}/${current.executionSettings.modelId} (${current.executionSettings.reasoning})` : (current?.engine ?? 'default');
      const after = `${es.harnessId}/${es.provider}/${es.modelId} (${es.reasoning})`;
      summaryParts.push(`model=${es.harnessId}:${es.modelId} (${es.reasoning})`);
      detailLines.push(`Runtime/Model: ${before} → ${after}`);
    }
    if (change.disabledSkills !== undefined) {
      summaryParts.push(`disabledSkills=${change.disabledSkills.length}`);
      detailLines.push(`Disabled skills: ${change.disabledSkills.join(', ') || 'none'}`);
    }
    if (change.disabledPlugins !== undefined) {
      summaryParts.push(`disabledPlugins=${change.disabledPlugins.length}`);
      detailLines.push(`Disabled plugins: ${change.disabledPlugins.join(', ') || 'none'}`);
    }
    if (change.instructions !== undefined) {
      summaryParts.push('update instructions');
      detailLines.push(`New instructions:\n${clip(change.instructions, 1500)}`);
    }
    if (!summaryParts.length) throw new TeamError(`update_assistant for /${change.role} has no fields to change`, 400);
    previews.push({
      kind: change.kind,
      role: change.role,
      headline: `Update /${change.role}: ${summaryParts.join(', ')}`,
      detail: detailLines.join('\n'),
    });
  }
  return previews;
}

export function formatProposalForTelegram(proposal: TeamProposal): string {
  const bullets = proposal.previews.map((item, idx) => `${idx + 1}. ${item.headline}`).join('\n');
  const text = [
    `${proposal.proposedByRole}: approval requested — ${proposal.summary}`,
    `Why: ${clip(proposal.rationale, 500)}`,
    '',
    'Proposed permanent changes:',
    bullets,
    '',
    'Tap Approve or Reject below (or reply "approve" / "reject" to this message). Changes apply immediately and I will continue the task.',
  ].join('\n');
  return clip(text, 3500);
}

/** Creates a durable pending proposal from the live coordinator and routes the approval prompt to Telegram or UI. */
export async function createTeamProposal(assignmentId: string, rawInput: unknown): Promise<TeamProposal> {
  const input = teamProposalInputSchema.parse(rawInput);
  const { requireLiveTeamBob, enqueueProposalApprovalOutput } = await import('./assignments.js');
  const { team, assignment } = await requireLiveTeamBob(assignmentId);
  const previews = await validateAndPreviewChanges(team.id, input.changes);
  const proposal: TeamProposal = {
    id: randomUUID(),
    teamId: team.id,
    assignmentId: assignment.id,
    rootId: assignment.rootId,
    requestedBy: assignment.requestedBy,
    proposedByRole: assignment.role,
    summary: input.summary,
    rationale: input.rationale,
    changes: input.changes,
    previews,
    state: 'pending',
    createdAt: new Date().toISOString(),
  };
  const db = await proposalDatabase();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO assistant_team_proposals (id, team_id, assignment_id, root_id, state, record) VALUES (?, ?, ?, ?, ?, ?)')
      .run(proposal.id, proposal.teamId, proposal.assignmentId, proposal.rootId, proposal.state, JSON.stringify(proposal));
    enqueueProposalApprovalOutput(db, proposal, formatProposalForTelegram(proposal));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  announceTeamChange(team.id, [proposal.id, assignment.id]);
  const { deliverTeamOutbox } = await import('./delivery.js');
  await deliverTeamOutbox(team.id).catch(() => {});
  return proposal;
}

export async function getTeamProposal(proposalId: string): Promise<TeamProposal | undefined> {
  const row = (await proposalDatabase()).prepare('SELECT state, record FROM assistant_team_proposals WHERE id=?').get(proposalId) as { state: TeamProposalState; record: string } | undefined;
  return row ? { ...JSON.parse(row.record) as TeamProposal, state: row.state } : undefined;
}

export async function listTeamProposals(teamId: string, limit = 50): Promise<TeamProposal[]> {
  const rows = (await proposalDatabase()).prepare('SELECT state, record FROM assistant_team_proposals WHERE team_id=? ORDER BY rowid DESC LIMIT ?').all(teamId, Math.max(1, Math.min(limit, 200))) as Array<{ state: TeamProposalState; record: string }>;
  return rows.map(row => ({ ...JSON.parse(row.record) as TeamProposal, state: row.state }));
}

export function hasPendingTeamProposalForAssignment(db: DatabaseSync, assignmentId: string): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='assistant_team_proposals'").get()) return false;
  return Boolean(db.prepare("SELECT 1 FROM assistant_team_proposals WHERE assignment_id=? AND state='pending' LIMIT 1").get(assignmentId));
}

export function cancelPendingProposalsForRoot(db: DatabaseSync, teamId: string, rootId: string): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='assistant_team_proposals'").get()) return;
  const rows = db.prepare("SELECT id, record FROM assistant_team_proposals WHERE team_id=? AND root_id=? AND state='pending'").all(teamId, rootId) as Array<{ id: string; record: string }>;
  for (const row of rows) {
    const proposal = { ...JSON.parse(row.record) as TeamProposal, state: 'cancelled' as const };
    db.prepare("UPDATE assistant_team_proposals SET state='cancelled', record=? WHERE id=? AND state='pending'").run(JSON.stringify(proposal), row.id);
  }
}

async function applyProposalChanges(teamId: string, changes: TeamProposalChange[]): Promise<string[]> {
  const applied: string[] = [];
  const touchedAssistants = new Map<string, { profile: PersonalAssistant; resetBaseline: boolean; disposeSessions: boolean }>();
  const markTouched = (profile: PersonalAssistant, resetBaseline: boolean, disposeSessions: boolean) => {
    const existing = touchedAssistants.get(profile.id);
    touchedAssistants.set(profile.id, {
      profile,
      resetBaseline: (existing?.resetBaseline ?? false) || resetBaseline,
      disposeSessions: (existing?.disposeSessions ?? false) || disposeSessions,
    });
  };
  let rosterChanged = false;
  const secrets = new Map((await listNodeAttachableSecrets(teamId)).map(s => [s.id, s]));

  const resolveMemberProfile = async (role: string): Promise<PersonalAssistant> => {
    const member = (await listTeamAgents(teamId)).find(m => m.role === role);
    if (!member) throw new TeamError(`Role /${role} is no longer in this team`, 404);
    const profile = await getPersonalAssistantById(member.assistantId);
    if (!profile) throw new TeamError(`Assistant for /${role} no longer exists`, 404);
    return profile;
  };

  for (const change of changes) {
    if (change.kind === 'create_member') {
      const team = await getTeam(teamId);
      const localNodeId = (await getClusterNode()).id;
      const engine = change.executionSettings?.harnessId ?? 'pi';
      if (change.executionSettings) await validateExecutionSettingsChoice(change.executionSettings);
      const sessionId = randomUUID();
      await asNode(async () => {
        await ensureConversationRecord(team.projectId, engine, sessionId, localNodeId);
        await ensureSessionTitle(sessionId, change.name);
      });
      const created = await savePersonalAssistant(team.executorAccountId, {
        projectId: team.projectId,
        engine,
        sessionId,
        nodeId: localNodeId,
        name: change.name,
        instructions: change.instructions,
        allowTerminal: change.allowTerminal ?? true,
        allowBrowser: change.allowBrowser ?? true,
        mcpServerNames: change.mcpServerNames ?? null,
        executionSettings: change.executionSettings ?? null,
      });
      const db = await personalAssistantDatabase();
      for (const secretId of change.secretAccountIds ?? []) {
        if (!secrets.has(secretId)) throw new TeamError(`Secret ${secretId} unavailable`, 404);
        await attachOrDetachAssistantSecret(created, secretId, 'attach');
      }
      for (const skill of change.skills ?? []) {
        await uploadWebhookSkill(db, created.id, skill.files.map(f => ({ relativePath: f.relativePath, data: Buffer.from(f.content, 'utf8') })));
      }
      const currentMembers = await listTeamAgents(teamId);
      const currentTeam = await getTeam(teamId);
      await saveTeamMembers(teamId, [...currentMembers.map(m => ({ role: m.role, assistantId: m.assistantId })), { role: change.role, assistantId: created.id }], currentTeam.coordinatorRole, currentTeam.revision);
      rosterChanged = true;
      applied.push(`Created "${created.name}" and added to team as /${change.role}`);
      continue;
    }

    if (change.kind === 'add_member') {
      const team = await getTeam(teamId);
      const profile = await getPersonalAssistantById(change.assistantId);
      if (!profile || (profile.nodeId && profile.nodeId !== team.hostNodeId)) throw new TeamError('Assistant unavailable on team host', 404);
      const currentMembers = await listTeamAgents(teamId);
      await saveTeamMembers(teamId, [...currentMembers.map(m => ({ role: m.role, assistantId: m.assistantId })), { role: change.role, assistantId: profile.id }], team.coordinatorRole, team.revision);
      rosterChanged = true;
      applied.push(`Added "${profile.name}" to team as /${change.role}`);
      continue;
    }

    if (change.kind === 'remove_member') {
      const team = await getTeam(teamId);
      const coordinator = await teamCoordinator(team);
      if (change.role === coordinator) throw new TeamError('Cannot remove the team coordinator', 400);
      const currentMembers = await listTeamAgents(teamId);
      const remaining = currentMembers.filter(m => m.role !== change.role).map(m => ({ role: m.role, assistantId: m.assistantId }));
      if (remaining.length === currentMembers.length) throw new TeamError(`Role /${change.role} is not in this team`, 404);
      await saveTeamMembers(teamId, remaining, team.coordinatorRole, team.revision);
      rosterChanged = true;
      applied.push(`Removed /${change.role} from team`);
      continue;
    }

    if (change.kind === 'rename_role') {
      const team = await getTeam(teamId);
      const currentMembers = await listTeamAgents(teamId);
      if (!currentMembers.some(m => m.role === change.role)) throw new TeamError(`Role /${change.role} is not in this team`, 404);
      const updated = currentMembers.map(m => ({ role: m.role === change.role ? change.newRole : m.role, assistantId: m.assistantId }));
      const nextCoordinator = team.coordinatorRole === change.role ? change.newRole : team.coordinatorRole;
      await saveTeamMembers(teamId, updated, nextCoordinator, team.revision);
      rosterChanged = true;
      applied.push(`Renamed role /${change.role} → /${change.newRole}`);
      continue;
    }

    const profile = await resolveMemberProfile(change.role);

    if (change.kind === 'attach_secret' || change.kind === 'detach_secret') {
      const secret = secrets.get(change.secretAccountId);
      if (!secret) throw new TeamError(`Secret ${change.secretAccountId} is unavailable on this node`, 404);
      await attachOrDetachAssistantSecret(profile, change.secretAccountId, change.kind === 'attach_secret' ? 'attach' : 'detach');
      markTouched(profile, false, false);
      applied.push(`${change.kind === 'attach_secret' ? 'Attached' : 'Detached'} secret "${secret.label}" (${secret.provider}) ${change.kind === 'attach_secret' ? 'to' : 'from'} /${change.role}`);
      continue;
    }

    if (change.kind === 'upsert_skill') {
      const db = await personalAssistantDatabase();
      const decoded = change.files.map(file => ({ relativePath: file.relativePath, data: Buffer.from(file.content, 'utf8') }));
      let installedName: string;
      try {
        installedName = (await uploadWebhookSkill(db, profile.id, decoded)).name;
      } catch (error) {
        const taken = error instanceof WebhookResourceError && error.statusCode === 409 ? /skill named (.+)$/.exec(error.message)?.[1] : undefined;
        const existing = taken ? listWebhookSkills(db, profile.id).find(skill => skill.name === taken) : undefined;
        if (!existing) throw error;
        installedName = (await uploadWebhookSkill(db, profile.id, decoded, {}, existing.id)).name;
      }
      markTouched(profile, false, false);
      applied.push(`Installed/updated skill "${installedName}" on /${change.role}`);
      continue;
    }

    if (change.kind === 'delete_skill') {
      const db = await personalAssistantDatabase();
      const existing = listWebhookSkills(db, profile.id).find(skill => skill.name === change.skillName);
      if (!existing) throw new TeamError(`Skill "${change.skillName}" not found on /${change.role}`, 404);
      await removeWebhookSkill(db, profile.id, existing.id);
      markTouched(profile, false, false);
      applied.push(`Removed skill "${change.skillName}" from /${change.role}`);
      continue;
    }

    if (change.kind === 'attach_login' || change.kind === 'detach_login') {
      const db = await personalAssistantDatabase();
      const { syncAssistantLoginGrants } = await import('../server/routes/assistant-resources.js');
      if (change.kind === 'attach_login') {
        db.prepare('INSERT OR IGNORE INTO personal_assistant_logins (assistant_id, profile_id, created_at) VALUES (?,?,?)').run(profile.id, change.profileId, new Date().toISOString());
        await syncAssistantLoginGrants(profile.id, profile.accountId);
        applied.push(`Attached browser login ${change.profileId} to /${change.role}`);
      } else {
        db.prepare('DELETE FROM personal_assistant_logins WHERE assistant_id=? AND profile_id=?').run(profile.id, change.profileId);
        db.prepare('DELETE FROM personal_assistant_login_grants WHERE assistant_id=? AND profile_id=?').run(profile.id, change.profileId);
        applied.push(`Detached browser login ${change.profileId} from /${change.role}`);
      }
      markTouched(profile, false, false);
      continue;
    }

    // update_assistant
    if (change.executionSettings) await validateExecutionSettingsChoice(change.executionSettings);
    const updated = await savePersonalAssistant(profile.accountId, {
      projectId: profile.projectId,
      engine: profile.engine,
      sessionId: profile.sessionId,
      name: change.name ?? profile.name,
      instructions: change.instructions ?? profile.instructions,
      classifierId: profile.classifierId,
      allowBrowser: change.allowBrowser ?? profile.allowBrowser,
      allowTerminal: change.allowTerminal ?? profile.allowTerminal,
      mcpServerNames: change.mcpServerNames === undefined ? profile.mcpServerNames : change.mcpServerNames,
      executionSettings: change.executionSettings === undefined ? profile.executionSettings : change.executionSettings,
    }, profile.id);
    if (change.disabledSkills !== undefined || change.disabledPlugins !== undefined) {
      const currentPrefs = await resourcePreferencesOf(profile.id);
      await saveAssistantResourcePreferences(profile.id, {
        disabledSkills: change.disabledSkills ?? currentPrefs.disabledSkills,
        disabledPlugins: change.disabledPlugins ?? currentPrefs.disabledPlugins,
      });
    }
    const toolsChanged = change.allowTerminal !== undefined || change.allowBrowser !== undefined || change.mcpServerNames !== undefined;
    const harnessChanged = change.executionSettings !== undefined && change.executionSettings.harnessId !== (profile.executionSettings?.harnessId ?? profile.engine);
    markTouched(updated, toolsChanged, toolsChanged || harnessChanged);
    applied.push(`Updated /${change.role}`);
  }

  for (const { profile, resetBaseline, disposeSessions } of touchedAssistants.values()) {
    await invalidateAssistantLiveSessions(profile, resetBaseline, disposeSessions);
  }
  if (rosterChanged) {
    void (await import('./telegram-commands.js')).refreshTeamCommands(teamId).catch(error => {
      console.warn('Telegram commands were not updated:', error instanceof Error ? error.message : error);
    });
  }
  announceAssistantChanges();
  announceTeamChange(teamId);
  return applied;
}

/**
 * Approves or rejects a pending proposal. Any enrolled team member may decide.
 * On approval, changes apply live immediately and the coordinator automatically resumes its task.
 */
export async function decideTeamProposal(member: TeamMember, proposalId: string, decision: 'approve' | 'reject'): Promise<TeamProposal> {
  await recheckTeamActor(member);
  await requireTeamExecution(member.teamId, member.accountId);
  const db = await proposalDatabase();
  const existing = await getTeamProposal(proposalId);
  if (!existing || existing.teamId !== member.teamId) throw new TeamError('Unknown team proposal', 404);
  if (existing.state !== 'pending') return existing;

  const decidedAt = new Date().toISOString();
  const claimedState: TeamProposalState = decision === 'approve' ? 'approved' : 'rejected';
  const claimed: TeamProposal = { ...existing, state: claimedState, decidedAt, decidedBy: member.accountId };
  const changed = db.prepare("UPDATE assistant_team_proposals SET state=?, record=? WHERE id=? AND team_id=? AND state='pending'")
    .run(claimedState, JSON.stringify(claimed), proposalId, member.teamId).changes;
  if (!changed) return (await getTeamProposal(proposalId))!;

  let finalProposal: TeamProposal = claimed;
  if (decision === 'approve') {
    try {
      const appliedSummary = await applyProposalChanges(member.teamId, existing.changes);
      finalProposal = { ...claimed, state: 'applied', appliedSummary };
    } catch (error) {
      finalProposal = { ...claimed, state: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
    db.prepare('UPDATE assistant_team_proposals SET state=?, record=? WHERE id=?').run(finalProposal.state, JSON.stringify(finalProposal), proposalId);
  }

  const { resumeAssignmentAfterProposal } = await import('./assignments.js');
  await resumeAssignmentAfterProposal(finalProposal);
  announceTeamChange(member.teamId, [finalProposal.id, finalProposal.assignmentId]);
  return finalProposal;
}
