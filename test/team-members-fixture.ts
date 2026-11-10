// Test setup only: picks six ordinary assistants into a team under the old role names.
import { asNode } from '../src/account-context.js';
import { ensureConversationRecord } from '../src/conversation-records.js';
import { addPersonalAssistantTopic, listPersonalAssistants, personalAssistantDatabase, savePersonalAssistant, savePersonalAssistantSourceHistory } from '../src/personal-assistants.js';
import { getSettings } from '../src/settings.js';
import { setWebhookMemoryEnabled } from '../src/webhook-memory.js';
import { getTeam, listTeamAgents, saveTeamMembers, type AssistantTeam, type TeamAgent } from '../src/assistant-teams/store.js';

export const TEST_ROLES = ['bob', 'product', 'designer', 'qa', 'pr_reviewer', 'support'] as const;
const seeding = new Map<string, Promise<TeamAgent[]>>();

export function seedTeamMembers(team: AssistantTeam): Promise<TeamAgent[]> {
  const existing = seeding.get(team.id); if (existing) return existing;
  const pending = (async () => {
    if ((await listTeamAgents(team.id)).length) return listTeamAgents(team.id);
    const db = await personalAssistantDatabase();
    const defaults = await asNode(() => getSettings().conversationDefaults.pi);
    const members: { role: string; assistantId: string }[] = [];
    for (const role of TEST_ROLES) {
      const sessionId = `team-${team.id}-${role}`;
      const profile = (await listPersonalAssistants(team.executorAccountId)).find(a => a.sessionId === sessionId) ?? await savePersonalAssistant(team.executorAccountId, {
        projectId: team.projectId, engine: 'pi', sessionId, nodeId: team.hostNodeId, name: role, instructions: `The ${role} member.`,
        allowBrowser: false, allowTerminal: false, mcpServerNames: [],
        executionSettings: { harnessId: 'pi', provider: defaults.provider, modelId: defaults.modelId, reasoning: defaults.thinkingLevel },
      });
      await ensureConversationRecord(team.projectId, 'pi', sessionId, team.hostNodeId);
      await savePersonalAssistantSourceHistory(team.executorAccountId, profile.id, []);
      setWebhookMemoryEnabled(db, profile.id, false);
      await addPersonalAssistantTopic(team.executorAccountId, profile.id, { projectId: team.projectId, engine: 'pi', sessionId, source: true });
      members.push({ role, assistantId: profile.id });
    }
    await saveTeamMembers(team.id, members, 'bob', (await getTeam(team.id)).revision);
    return listTeamAgents(team.id);
  })();
  seeding.set(team.id, pending);
  void pending.finally(() => seeding.delete(team.id)).catch(() => {});
  return pending;
}

/** For a team on a separate dev node: role rows only, enough for routing and acceptance. */
export function seedNodeMemberRows(db: import('node:sqlite').DatabaseSync, teamId: string, roles: readonly string[] = TEST_ROLES): void {
  const insert = db.prepare('INSERT OR IGNORE INTO assistant_team_agents VALUES(?,?,?)');
  for (const role of roles) insert.run(teamId, role, `fixture-${teamId}-${role}`);
  db.prepare('UPDATE assistant_teams SET coordinator_role=? WHERE id=?').run(roles[0], teamId);
}

type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
/** For a team on a dev node: real assistants made from seeded conversations, picked in as members. */
export async function addNodeMembers(call: Call, projectIds: string[], teamId: string, members: { role: string; instructions?: string }[], coordinatorRole: string,
  executionSettings: { harnessId: string; provider: string; modelId: string; reasoning: string }): Promise<Record<string, { id: string }>> {
  const sessions: { projectId: string; id: string; harnessId: string }[] = [];
  for (const projectId of projectIds) for (const entry of (await call('GET', `/projects/${projectId}/sessions`)).body.sessions) sessions.push({ projectId, ...entry });
  if (sessions.length < members.length) throw new Error('Not enough seeded conversations for the team members');
  const created: Record<string, { id: string }> = {};
  for (const [index, member] of members.entries()) {
    const source = sessions[index];
    const response = await call('POST', '/personal-assistants', { projectId: source.projectId, engine: source.harnessId, sessionId: source.id, name: member.role, instructions: member.instructions ?? `The ${member.role} member.`, allowTerminal: false, executionSettings });
    if (response.status !== 201 && response.status !== 200) throw new Error(`Assistant creation failed: ${JSON.stringify(response.body)}`);
    created[member.role] = response.body.assistant;
  }
  const team = (await call('GET', `/assistant-teams/${teamId}`)).body.team;
  const saved = await call('PUT', `/assistant-teams/${teamId}/members`, { expectedRevision: team.revision, coordinatorRole, members: members.map(member => ({ role: member.role, assistantId: created[member.role].id })) });
  if (saved.status !== 200) throw new Error(`Saving members failed: ${JSON.stringify(saved.body)}`);
  return created;
}
