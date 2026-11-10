import { secretAccountVariable } from '../secrets.js';
import { telegramSetCommands, TELEGRAM_TOKEN_VARIABLE } from '../webhook-telegram.js';
import { getPersonalAssistantById } from '../personal-assistants.js';
import { getTeam, listTeamAgents, teamCoordinator } from './store.js';
import { teamTelegramConnection } from './telegram-store.js';

/** Rebuilds the bot's "/" menu from the member list: one command per role. */
export async function refreshTeamCommands(teamId: string): Promise<void> {
  const known = await teamTelegramConnection(teamId);
  if (!known) return;
  const token = secretAccountVariable([known.token_account_id], TELEGRAM_TOKEN_VARIABLE);
  if (!token) throw new Error('Team bot secret unavailable');
  const team = await getTeam(teamId), coordinator = await teamCoordinator(team);
  const commands = await Promise.all((await listTeamAgents(teamId)).map(async member => {
    const name = (await getPersonalAssistantById(member.assistantId))?.name ?? member.role;
    return { command: member.role, description: `${name}${member.role === coordinator ? ' (coordinator)' : ''}`.slice(0, 256) };
  }));
  await telegramSetCommands(token, commands);
}
