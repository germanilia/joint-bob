import { randomUUID } from 'node:crypto';
import { systemAiSettings } from '../system-ai-config.js';
import { systemDecisionKey } from '../system-ai.js';
import { decisionModelTarget } from '../classifiers/conversation-routing.js';
import { askSystemOneChoices, type SystemOneChoice, type SystemOneTarget, type SystemOneQuestion } from '../classifiers/typesafe.js';
import { getTeam, announceTeamChange, type AssistantTeam, type TeamMessage, type TeamRole, type TeamRoute, type TeamSettings, type TeamSubject } from './store.js';
import { conversationDatabase, getTeamMessage, listTeamHistory, directTeamTargets, teamReplyRoute, teamSubjectCandidates, type StoredTeamMessage } from './conversations.js';
import { authorizeTeamTelegram } from './telegram.js';
import { validTeamThresholds, TEAM_ATTENTION_QUESTION, TEAM_MEMORY_QUESTION, teamSubjectQuestion } from './questions.js';

export interface TeamDecision { requestId?: string; attention: 'act' | 'ask' | 'silent' | 'direct'; targets: TeamRole[]; route: TeamRoute; learn: boolean }
export type TeamDecisionFailureCode = 'invalid_input' | 'invalid_settings' | 'access_denied' | 'credentials_unavailable' | 'target_unavailable' | 'evidence_unavailable' | 'decision_unavailable_or_invalid' | 'stale_input';
export interface TeamDecisionRecord {
  id: string; teamId: string; messageId: string; messageRevision: number; createdAt: string;
  model: 'typesafe' | 'laya' | null; target: SystemOneTarget | null;
  settingsRevision: number; settings: TeamSettings;
  evidenceMessageIds: string[]; evidenceRevisions: Record<string, number>; subjectIds: string[];
  answers: Record<string, SystemOneChoice> | null; result: TeamDecision | null;
  status: 'pending' | 'decided' | 'failed';
  waitingReason: 'subject_clarification' | 'decision_failed' | null;
  failure: { code: TeamDecisionFailureCode; message: string } | null;
}
export function proactiveDisposition(choice: 'act' | 'none', confidence: number, settings: TeamSettings): 'act' | 'ask' | 'silent' {
  if (!validTeamThresholds(settings) || !Number.isFinite(confidence) || confidence < 0 || confidence > 1 || choice !== 'act') return 'silent';
  return confidence > settings.actThreshold ? 'act' : confidence > settings.askThreshold ? 'ask' : 'silent';
}
async function decisionDatabase() {
  const db = await conversationDatabase();
  db.exec('CREATE TABLE IF NOT EXISTS assistant_team_decisions (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, message_id TEXT NOT NULL, record TEXT NOT NULL)');
  return db;
}
async function persist(record: TeamDecisionRecord) {
  (await decisionDatabase()).prepare('INSERT INTO assistant_team_decisions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(record.id, record.teamId, record.messageId, JSON.stringify(record));
  announceTeamChange(record.teamId);
}
/** Internal read seam; HTTP consumers must authorize team membership first. Newest attempts first. */
export async function listTeamDecisions(teamId: string, limit = 100): Promise<TeamDecisionRecord[]> {
  const count = Number.isSafeInteger(limit) ? Math.max(1, Math.min(1000, limit)) : 100;
  return (await decisionDatabase()).prepare('SELECT record FROM assistant_team_decisions WHERE team_id=? ORDER BY rowid DESC LIMIT ?').all(teamId, count).map(row => JSON.parse(row.record as string) as TeamDecisionRecord);
}
async function authorized(message: StoredTeamMessage): Promise<boolean> {
  if (message.output) return false;
  try { return (await authorizeTeamTelegram(message.teamId, message.chatId, message.telegramUserId)).accountId === message.accountId; }
  catch { return false; }
}
// Projection only: the full source and edit versions remain in the conversation ledger.
function evidence(message: StoredTeamMessage, history: StoredTeamMessage[], candidates: TeamSubject[], budget: number, redact: (text: string) => string) {
  const project = (m: StoredTeamMessage) => ({ id: m.id, revision: m.revision, accountId: m.accountId, text: redact(m.text).slice(0, 6000), attachments: m.attachments.slice(0, 10).map(a => ({ text: redact(a.extractedText ?? '').slice(0, 2000), problem: a.problem ? redact(a.problem) : undefined })) });
  const state = { message: project(message), history: history.map(project), subjects: candidates.map(s => ({ ...s, title: redact(s.title).slice(0, 160), summary: redact(s.summary).slice(0, 600) })) };
  while (JSON.stringify(state).length > budget && state.history.length) state.history.shift();
  while (JSON.stringify(state).length > budget && state.subjects.length) state.subjects.pop();
  while (JSON.stringify(state).length > budget && state.message.attachments.length) state.message.attachments.pop();
  while (JSON.stringify(state).length > budget && state.message.text.length) state.message.text = state.message.text.slice(0, Math.floor(state.message.text.length / 2));
  return { state: JSON.stringify(state), messages: [state.message, ...state.history], subjects: state.subjects };
}
function safeTarget(target: SystemOneTarget): SystemOneTarget {
  const url = new URL(target.endpoint); url.username = ''; url.password = ''; url.search = ''; url.hash = '';
  return { ...target, endpoint: url.toString() };
}

/** Classification only: never accepts, acknowledges, dispatches or writes memory. */
export async function decideTeamMessage(team: AssistantTeam, input: TeamMessage): Promise<TeamDecision | null> {
  const record: TeamDecisionRecord = { id: randomUUID(), teamId: team.id, messageId: input.id, messageRevision: input.revision, createdAt: new Date().toISOString(), model: null, target: null, settingsRevision: team.revision, settings: team.settings, evidenceMessageIds: [], evidenceRevisions: {}, subjectIds: [], answers: null, result: null, status: 'pending', waitingReason: null, failure: null };
  let stage: TeamDecisionFailureCode = 'invalid_input';
  try {
    if (input.teamId !== team.id) throw new Error();
    const currentTeam = await getTeam(team.id);
    record.settings = currentTeam.settings; record.settingsRevision = currentTeam.revision;
    const message = await getTeamMessage(team.id, input.id);
    if (!message || message.revision !== input.revision || message.accountId !== input.accountId) throw new Error();
    stage = 'access_denied'; if (!await authorized(message)) throw new Error();
    stage = 'invalid_settings'; if (!validTeamThresholds(currentTeam.settings)) throw new Error();
    const targets = await directTeamTargets(message);
    const reply = await teamReplyRoute(message);
    stage = 'credentials_unavailable';
    const model = systemAiSettings().decision.model; record.model = model;
    const key = systemDecisionKey(model);
    stage = 'target_unavailable';
    const selected = await decisionModelTarget(model, key); if (!selected) throw new Error();
    record.target = safeTarget(selected.target);
    stage = 'evidence_unavailable';
    const history: StoredTeamMessage[] = [];
    for (const prior of await listTeamHistory(team.id, message.chatId, message.threadId, 20)) {
      if (prior.telegramMessageId < message.telegramMessageId && await authorized(prior)) history.push(prior);
    }
    const candidates = reply ? [] : await teamSubjectCandidates(team.id, message);
    const redact = await (await import('./memory.js')).teamMemoryRedactor();
    const bounded = evidence(message, history, candidates, Math.min(selected.target.stateCharacters, 24000), redact);
    if (bounded.state.length > selected.target.stateCharacters) throw new Error();
    record.evidenceMessageIds = bounded.messages.map(m => m.id);
    record.evidenceRevisions = Object.fromEntries(bounded.messages.map(m => [m.id, m.revision]));
    record.subjectIds = bounded.subjects.map(s => s.id);
    const requests: import('./assignments.js').OpenTeamRequest[] = [];
    for (const candidate of (await (await import('./assignments.js')).openTeamRequests(message)).filter(r => r.messageId !== message.id).slice(-20)) {
      const source = await getTeamMessage(team.id, candidate.messageId);
      if (source && await authorized(source)) requests.push(candidate);
    }
    const requestCriteria = Object.fromEntries(requests.map((r,i)=>[`request_${i}`, `Additional evidence or continuation of this exact unfinished request, not merely the same broad topic: ${redact(r.text).slice(0,600)} (subject ${r.subjectId}, account ${r.accountId}, message ${r.messageId})`]));
    const questions: Record<string, SystemOneQuestion> = { ...(!targets.length ? { attention: TEAM_ATTENTION_QUESTION } : {}), ...(!reply ? { subject: teamSubjectQuestion(bounded.subjects) } : {}), memory: TEAM_MEMORY_QUESTION, ...(requests.length ? { request: { instructions: 'Is this evidence for an existing unfinished request, or genuinely separate work? Same subject alone does not mean the same request.', criteria: { separate: 'Genuinely separate work or discussion, or insufficient evidence to identify the exact request.', ...requestCriteria } } } : {}) };
    await persist(record);
    stage = 'decision_unavailable_or_invalid';
    const answers = await askSystemOneChoices(selected.target, bounded.state, questions, selected.apiKey);
    if (!answers) throw new Error();
    record.answers = answers;
    // The shared adapter validates the wire; keep this boundary failclosed as well.
    for (const [id, question] of Object.entries(questions)) {
      const answer = answers[id];
      if (!answer || !Object.hasOwn(question.criteria, answer.choice) || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) throw new Error();
    }
    stage = 'stale_input';
    if ((await getTeam(team.id)).revision !== record.settingsRevision || (await getTeamMessage(team.id, message.id))?.revision !== message.revision) throw new Error();
    stage = 'access_denied'; if (!await authorized(message)) throw new Error();
    const route: TeamRoute = reply ?? (answers.subject.choice === 'new' ? { kind: 'new' } : answers.subject.choice === 'clarify' ? { kind: 'clarify' } : { kind: 'continue', subjectId: bounded.subjects[Number(answers.subject.choice.slice('subject_'.length))].id });
    const attention = targets.length ? 'direct' : proactiveDisposition(answers.attention.choice as 'act' | 'none', answers.attention.confidence, currentTeam.settings);
    const requestId = requests.length && answers.request.choice !== 'separate' ? requests[Number(answers.request.choice.slice('request_'.length))].id : undefined;
    record.result = { ...(requestId ? { requestId } : {}), attention, targets: targets.length ? targets : attention === 'silent' ? [] : ['bob'], route, learn: answers.memory.choice === 'learn' };
    record.status = 'decided'; record.waitingReason = route.kind === 'clarify' ? 'subject_clarification' : null;
    await persist(record); return record.result;
  } catch {
    record.status = 'failed'; record.result = null; record.waitingReason = 'decision_failed';
    record.failure = { code: stage, message: 'Team decision could not be completed; no work was dispatched. Resolve the failure before retrying routing.' };
    await persist(record); return null;
  }
}
