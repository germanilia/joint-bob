import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthSession } from '../auth.js';
import { ensureTelegramSchema, telegramConnection } from '../assistant-telegram.js';
import { getClusterNode } from '../cluster.js';
import { clusterV2Database } from '../cluster-v2-store.js';
import { getSharingCluster } from '../cluster-sharing-policy.js';
import { personalAssistantDatabase, type PersonalAssistant } from '../personal-assistants.js';
import { secretAccountVariable } from '../secrets.js';
import { regenerateWebhookSecret } from '../webhooks.js';
import { TEAM_TELEGRAM_UPDATES, telegramSetWebhook, TELEGRAM_TOKEN_VARIABLE } from '../webhook-telegram.js';
import { WebhookResourceError } from '../webhook-resources.js';
import { urlBases } from '../server/routes/webhooks.js';
import { requireTeamMember } from './access.js';
import { getTeam, isReservedTeamRole, listTeamAgents, saveTeamMembers, TEAM_ROLE_PATTERN, TeamError, announceTeamChange } from './store.js';
import { teamTelegramConnection, telegramDatabase, tokenHash } from './telegram-store.js';
import { refreshTeamCommands } from './telegram-commands.js';

function ensureTeamColumn(db: DatabaseSync): void {
  ensureTelegramSchema(db);
  const columns = db.prepare('PRAGMA table_info(assistant_telegram)').all().map(row => (row as { name: string }).name);
  if (!columns.includes('team_id')) db.exec('ALTER TABLE assistant_telegram ADD COLUMN team_id TEXT');
}
/** The team this Telegram agent's bot serves, if any. */
export async function telegramAgentTeam(assistantId: string): Promise<string | null> {
  const db = await personalAssistantDatabase(); ensureTeamColumn(db);
  return (db.prepare('SELECT team_id teamId FROM assistant_telegram WHERE assistant_id=?').get(assistantId) as { teamId: string | null } | undefined)?.teamId ?? null;
}
/** Teams on this machine the signed-in person belongs to: the choices for a Telegram agent. */
export async function assignableTeams(session: AuthSession): Promise<{ id: string; label: string }[]> {
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  const rows = (await telegramDatabase()).prepare('SELECT id, cluster_id clusterId FROM assistant_teams WHERE host_node_id=?').all(local) as { id: string; clusterId: string }[];
  const teams: { id: string; label: string }[] = [];
  for (const row of rows) {
    try { await requireTeamMember(session, row.id); } catch (error) { if (error instanceof TeamError) continue; throw error; }
    teams.push({ id: row.id, label: `${getSharingCluster(db, row.clusterId).name} team` });
  }
  return teams;
}
function botToken(tokenAccountId: string): string {
  const token = secretAccountVariable([tokenAccountId], TELEGRAM_TOKEN_VARIABLE);
  if (!token) throw new WebhookResourceError("The bot's token is missing. Disconnect and connect the bot again.", 409);
  return token;
}
async function firstBase(): Promise<string> {
  const base = (await urlBases())[0];
  if (!base) throw new WebhookResourceError('This machine has no address Telegram can reach. Join a relay in Settings → Relays first.', 409);
  return base.base;
}
/** A role name made from the assistant's name, unique within the team. */
function roleFor(name: string, taken: string[]): string {
  const stem = name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '').replace(/_+$/, '').slice(0, 28) || 'lead';
  let role = isReservedTeamRole(stem) ? `${stem}_agent` : stem;
  for (let n = 2; taken.includes(role); n++) role = `${stem}_${n}`;
  if (!TEAM_ROLE_PATTERN.test(role)) throw new TeamError('Could not make a role name for this assistant', 400);
  return role;
}

/**
 * Moves the agent's bot to the team: the team answers in Telegram through it and the agent
 * coordinates. Enrollment and group binding stay the team's own steps.
 */
export async function assignTelegramAgentTeam(entry: PersonalAssistant, session: AuthSession, teamId: string | null): Promise<void> {
  const db = await personalAssistantDatabase(); ensureTeamColumn(db);
  const known = telegramConnection(db, entry.id);
  if (!known) throw new WebhookResourceError('This assistant has no Telegram bot', 404);
  const current = await telegramAgentTeam(entry.id);
  if (current === teamId) return;
  if (current) await releaseBot(entry, current);
  if (!teamId) return;
  await requireTeamMember(session, teamId);
  const team = await getTeam(teamId), local = (await getClusterNode()).id;
  if (team.hostNodeId !== local || entry.nodeId !== local) throw new TeamError('The team and the assistant must be on this machine', 409);
  if (await teamTelegramConnection(teamId)) throw new TeamError('This team already has a Telegram bot. Disconnect it in the team settings first.', 409);
  const token = botToken(known.tokenAccountId), headerSecret = randomBytes(32).toString('hex');
  const teams = await telegramDatabase();
  teams.prepare('INSERT INTO assistant_team_telegram VALUES(?,?,?,?,?,?)').run(teamId, known.botId, known.botUsername, known.tokenAccountId, tokenHash(headerSecret), Number(known.readsAllGroupMessages));
  try { await telegramSetWebhook(token, `${await firstBase()}/teamtelegram-${teamId}`, headerSecret, TEAM_TELEGRAM_UPDATES); }
  catch (error) {
    teams.prepare('DELETE FROM assistant_team_telegram WHERE team_id=?').run(teamId);
    throw new TeamError(`Telegram refused the team address: ${error instanceof Error ? error.message.replaceAll(token, '[token]') : 'unknown error'}`, 502);
  }
  db.prepare('UPDATE assistant_telegram SET team_id=? WHERE assistant_id=?').run(teamId, entry.id);
  // The agent joins the team, if it is not in it yet, and coordinates it.
  const members = await listTeamAgents(teamId);
  const own = members.find(member => member.assistantId === entry.id);
  const role = own?.role ?? roleFor(entry.name, members.map(member => member.role));
  await saveTeamMembers(teamId, own ? members : [...members, { teamId, role, assistantId: entry.id }], role, team.revision);
  await refreshTeamCommands(teamId).catch(error => console.warn('Telegram commands were not updated:', error instanceof Error ? error.message : error));
  announceTeamChange(teamId);
}

/** Gives the bot back to the agent alone: a new personal webhook secret, the team keeps its members. */
async function releaseBot(entry: PersonalAssistant, teamId: string): Promise<void> {
  const db = await personalAssistantDatabase(), known = telegramConnection(db, entry.id)!;
  const token = botToken(known.tokenAccountId), headerSecret = randomBytes(32).toString('hex');
  const { secret } = regenerateWebhookSecret(db, known.webhookId);
  await telegramSetWebhook(token, `${await firstBase()}/${secret}`, headerSecret);
  db.prepare('UPDATE assistant_telegram SET header_secret_hash=?, team_id=NULL WHERE assistant_id=?').run(tokenHash(headerSecret), entry.id);
  (await telegramDatabase()).prepare('DELETE FROM assistant_team_telegram WHERE team_id=? AND bot_id=?').run(teamId, known.botId);
  announceTeamChange(teamId);
}
