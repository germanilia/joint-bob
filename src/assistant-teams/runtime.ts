import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { asNode } from '../account-context.js';
import { listLocalUsers } from '../auth.js';
import { getClusterNode } from '../cluster.js';
import { ensureConversationRecord } from '../conversation-records.js';
import { getConversationOwnership } from '../conversation-ownership.js';
import { getSettings } from '../settings.js';
import { setWebhookMemoryEnabled } from '../webhook-memory.js';
import { getHarnessRuntime, listHarnessModels } from '../harnesses.js';
import { addPersonalAssistantTopic, getPersonalAssistant, getPersonalAssistantTurn, listPersonalAssistants, personalAssistantDatabase, savePersonalAssistant, savePersonalAssistantSourceHistory, type PersonalAssistant } from '../personal-assistants.js';
import { requireTeamExecution } from './access.js';
import { getTeam, getTeamAssignment, listTeamAgents, teamDatabase, TeamError, type AssistantTeam, type TeamAgent, type TeamAssignment, type TeamRole } from './store.js';

export const TEAM_ROLES: readonly TeamRole[] = ['bob', 'product', 'designer', 'qa', 'pr_reviewer', 'support'];
const instructions: Record<TeamRole, string> = {
  bob: 'Coordinate the team. Distinguish evidence, proposals and human decisions.',
  product: 'Help clarify product needs, priorities and acceptance criteria.',
  designer: 'Help with design, usability and accessible experiences.',
  qa: 'Check quality and explain reproducible findings and coverage gaps.',
  pr_reviewer: 'Review changes for correctness, security and maintainability.',
  support: 'Help diagnose technical problems and explain practical resolutions.',
};
const initializing = new Map<string, Promise<TeamAgent[]>>();

// Ephemeral, tool-less knowledge sessions are not assistant turns or personal conversations.
const memorySessions = new Set<string>();
export function isTeamMemorySession(projectId: string, conversationId: string): boolean { return memorySessions.has(`${projectId}:${conversationId}`); }
export async function runTeamKnowledgeWriter(teamId: string, material: string, instructions: string): Promise<string> {
  const selected = (await import('../system-ai-config.js')).systemAiSettings().operations.knowledge;
  if (!selected || selected.harnessId !== 'pi') throw new TeamError('Selected knowledge writer unavailable (isolated Pi required)', 503);
  const team = await getTeam(teamId), project = await (await import('../store.js')).getProject(team.projectId);
  if (!project || !selected.provider || !selected.modelId) throw new TeamError('Selected knowledge writer unavailable', 503);
  const id = (await import('../internal-sessions.js')).internalSessionId(), key = `${team.projectId}:${id}`;
  memorySessions.add(key);
  try { return await (await import('../system-ai.js')).withSystemAiProfile('pi', selected.provider, async () => {
    const runtime = await getHarnessRuntime('pi');
    const session = await runtime.open({ projectId: team.projectId, cwd: project.path, sessionId: id });
    let answer = ''; let timer: NodeJS.Timeout | undefined;
    let stop = () => {};
    try {
      const settings = { ...session.settings(), provider: selected.provider, modelId: selected.modelId, reasoning: selected.thinkingLevel, enabledTools: [] };
      await runtime.validateSettings(settings); await session.configure(settings); await session.setTools([]); await session.preflight();
      const done = new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => { reject(new Error('Knowledge writer timed out')); void session.cancel().catch(() => {}); }, 120000);
        stop = session.subscribe(event => {
          if (event.type === 'textDelta') { answer += event.text ?? ''; if (answer.length > 24000) { reject(new Error('Knowledge output limit')); void session.cancel().catch(() => {}); } }
          if (event.type === 'agent_end') resolve();
          if (event.type === 'error') reject(new Error('Knowledge writer failed'));
        });
      });
      await Promise.all([session.prompt({ text: `${instructions}\n\n${material}` }), done]);
      return answer;
    } finally { clearTimeout(timer); stop(); if (session.isBusy()) await session.cancel().catch(() => {}); session.dispose(); }
  }); } finally { memorySessions.delete(key); }
}
async function database() {
  const db = await teamDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS assistant_team_conversations (
    team_id TEXT NOT NULL, subject_id TEXT NOT NULL, assistant_id TEXT NOT NULL,
    project_id TEXT NOT NULL, engine TEXT NOT NULL, conversation_id TEXT NOT NULL UNIQUE,
    PRIMARY KEY(team_id,subject_id,assistant_id));`);
  return db;
}
/** Setup creates configuration only, never opens a runtime or submits a prompt. */
export function initializeTeamAgents(input: AssistantTeam): Promise<TeamAgent[]> {
  const existing = initializing.get(input.id); if (existing) return existing;
  const pending = (async () => {
    const team = await getTeam(input.id);
    if (!isDeepStrictEqual(team, input)) throw new TeamError('Team configuration changed', 409);
    if (team.hostNodeId !== (await getClusterNode()).id) throw new TeamError('Team must initialize on its host', 403);
    const db = await database(); await personalAssistantDatabase();
    const defaults = await asNode(() => getSettings().conversationDefaults.pi);
    for (const role of TEAM_ROLES) {
      if ((await listTeamAgents(team.id)).some(a => a.role === role)) continue;
      // A stable source key also recovers a crash between configuration and mapping writes.
      const sessionId = `team-${team.id}-${role}`;
      let profile = (await listPersonalAssistants(team.executorAccountId)).find(a => a.projectId === team.projectId && a.sessionId === sessionId);
      if (!profile) profile = await savePersonalAssistant(team.executorAccountId, {
        projectId: team.projectId, engine: 'pi', sessionId, nodeId: team.hostNodeId,
        name: role, instructions: instructions[role], allowBrowser: false, allowTerminal: false, mcpServerNames: [],
        executionSettings: { harnessId: 'pi', provider: defaults.provider, modelId: defaults.modelId, reasoning: defaults.thinkingLevel },
      });
      await ensureConversationRecord(team.projectId, 'pi', sessionId, team.hostNodeId);
      await savePersonalAssistantSourceHistory(team.executorAccountId, profile.id, []);
      // Shared subject memory is supplied by the team memory service, not personal notes/tokens.
      setWebhookMemoryEnabled(db, profile.id, false);
      await addPersonalAssistantTopic(team.executorAccountId, profile.id, { projectId: team.projectId, engine: 'pi', sessionId, source: true });
      db.prepare('INSERT OR IGNORE INTO assistant_team_agents VALUES(?,?,?)').run(team.id, role, profile.id);
    }
    return listTeamAgents(team.id);
  })();
  initializing.set(input.id, pending);
  void pending.finally(() => initializing.delete(input.id)).catch(() => {});
  return pending;
}

export async function teamConversation(projectId: string, conversationId: string): Promise<{ teamId: string; role: TeamRole } | null> {
  const db = await database(); await personalAssistantDatabase();
  return db.prepare(`SELECT a.team_id teamId,a.role FROM assistant_team_agents a
    JOIN personal_assistant_topics t ON t.assistant_id=a.assistant_id
    WHERE t.project_id=? AND t.session_id=?`).get(projectId, conversationId) as { teamId: string; role: TeamRole } | undefined ?? null;
}
export async function validateTeamAssignment(assignment: TeamAssignment) {
  const stored = await getTeamAssignment(assignment.id);
  if (!stored || !isDeepStrictEqual(stored, assignment)) throw new TeamError('Invalid or stale team assignment', 403);
  const member = await requireTeamExecution(stored.teamId, stored.requestedBy);
  if (!stored.subjectId || !['accepted', 'queued', 'running'].includes(stored.state)) throw new TeamError('Assignment is not executable', 409);
  const team = await getTeam(stored.teamId);
  const agent = (await listTeamAgents(team.id)).find(a => a.role === stored.role);
  const profile = agent && await getPersonalAssistant(team.executorAccountId, agent.assistantId);
  if (!profile || profile.projectId !== team.projectId || profile.nodeId !== team.hostNodeId) throw new TeamError('Team agent is unavailable on its host', 503);
  return { team, member, profile, assignment: stored };
}
/** Rechecked at queue dispatch, including after a wait. No browser-supplied team claim is trusted. */
export async function teamQueuedTurn(projectId: string, conversationId: string, requestId?: string, accountId?: string, executionAccountId?: string, message?: string | null) {
  const context = await teamConversation(projectId, conversationId); if (!context) return null;
  const db = await database();
  const row = requestId && db.prepare('SELECT record FROM assistant_team_assignments WHERE team_id=? AND request_id=?').get(context.teamId, requestId) as { record: string } | undefined;
  if (!row) throw new TeamError('Team conversation requires a live assignment', 403);
  const validated = await validateTeamAssignment(JSON.parse(row.record));
  const map = db.prepare('SELECT 1 FROM assistant_team_conversations WHERE team_id=? AND subject_id=? AND assistant_id=? AND project_id=? AND conversation_id=?').get(context.teamId, validated.assignment.subjectId!, validated.profile.id, projectId, conversationId);
  if (!map || validated.member.accountId !== accountId || executionAccountId !== validated.team.executorAccountId) throw new TeamError('Assignment destination or initiating member mismatch', 403);
  const turn = await getPersonalAssistantTurn(validated.team.executorAccountId, validated.profile.id, requestId!);
  if (!turn || turn.status !== 'running' || turn.message !== message) throw new TeamError('Team queue requires the server-issued running turn', 403);
  return validated;
}
export async function teamAgentReadiness(profile: PersonalAssistant): Promise<string[]> {
  // Pi's built-in write/edit tools are effect-capable even when the terminal is disabled.
  const { productionGuardStatus } = await import('../guardian/production-rule.js');
  const { getGuardianSettings } = await import('../guardian/settings.js');
  if (productionGuardStatus(getGuardianSettings()) !== 'on') return ['Production-capable team work is blocked: enable the production Guardian guard'];
  if (profile.nodeId !== (await getClusterNode()).id) return ['Team execution host is unavailable'];
  if (!listLocalUsers().some(user => user.accountId === profile.accountId && !user.disabled)) return ['Host execution account is unavailable'];
  if (!profile.executionSettings) return ['Select a local runtime and model'];
  if (profile.executionSettings.harnessId !== 'pi') return ['Team resource isolation is currently supported only by Pi on this host'];
  try {
    const settings = profile.executionSettings;
    const runtime = await getHarnessRuntime(settings.harnessId);
    const problems = await runtime.readiness(process.cwd());
    if (problems.length) return problems;
    const model = (await listHarnessModels(settings.harnessId)).find(item => item.provider === settings.provider && item.id === settings.modelId);
    if (!model || !model.thinkingLevels.includes(settings.reasoning)) return ['Configured model or effort is unavailable on this host'];
    await runtime.validateSettings({ provider: settings.provider, modelId: settings.modelId, reasoning: settings.reasoning });
    return [];
  }
  catch (error) { return [error instanceof Error ? error.message : 'Local runtime unavailable']; }
}
export async function teamAssignmentDestination(assignment: TeamAssignment) {
  const validated = await validateTeamAssignment(assignment);
  const { team, profile } = validated; const db = await database();
  let row = db.prepare('SELECT engine,conversation_id sessionId FROM assistant_team_conversations WHERE team_id=? AND subject_id=? AND assistant_id=?').get(team.id, assignment.subjectId!, profile.id) as { engine: string; sessionId: string } | undefined;
  if (!row) {
    const engine = profile.executionSettings?.harnessId ?? profile.engine;
    db.prepare('INSERT OR IGNORE INTO assistant_team_conversations VALUES(?,?,?,?,?,?)').run(team.id, assignment.subjectId!, profile.id, team.projectId, engine, randomUUID());
    row = db.prepare('SELECT engine,conversation_id sessionId FROM assistant_team_conversations WHERE team_id=? AND subject_id=? AND assistant_id=?').get(team.id, assignment.subjectId!, profile.id) as { engine: string; sessionId: string };
  }
  const ownership = await getConversationOwnership(row.engine, row.sessionId);
  if (ownership && ownership.ownerNodeId !== team.hostNodeId) throw new TeamError('Team conversation is on another execution node', 409);
  await ensureConversationRecord(team.projectId, row.engine, row.sessionId, team.hostNodeId);
  await addPersonalAssistantTopic(team.executorAccountId, profile.id, { projectId: team.projectId, ...row, source: false });
  return { ...validated, destination: row };
}
export async function runTeamTurn(input: { assignment: TeamAssignment; message: string }): Promise<{ text: string; conversationId: string }> {
  const { team, profile } = await validateTeamAssignment(input.assignment);
  // Internal ledger material includes full authorized text and extracted attachments.
  // Browser entry points enforce their own input bound; never silently cut Telegram evidence.
  if (!input.message.trim()) throw new TeamError('Invalid team message', 400);
  const { runPersonalAssistantAutomationTurn } = await import('../server/routes/personal-assistants.js');
  const turn = await asNode(() => runPersonalAssistantAutomationTurn(team.executorAccountId, profile.id, input.assignment.requestId, input.message,
    { label: `Team ${input.assignment.role}`, origin: 'assistant', team: { assignment: input.assignment } }));
  await requireTeamExecution(team.id, input.assignment.requestedBy);
  if (turn.status !== 'completed') throw new TeamError('Team turn has no confirmed result', 409);
  return { text: turn.response ?? '', conversationId: turn.topicId.slice(turn.topicId.indexOf(':') + 1) };
}
