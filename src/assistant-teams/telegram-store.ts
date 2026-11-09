import { createHash, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { teamDatabase, TeamError } from './store.js';
export const tokenHash = (value: string): string => createHash('sha256').update(value).digest('hex');
export async function telegramDatabase(): Promise<DatabaseSync> {
 const db = await teamDatabase();
 db.exec(`CREATE TABLE IF NOT EXISTS assistant_team_telegram (
 team_id TEXT PRIMARY KEY, bot_id TEXT UNIQUE NOT NULL, bot_username TEXT NOT NULL, token_account_id TEXT NOT NULL, header_hash TEXT NOT NULL, reads_all INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS assistant_team_telegram_challenges (
 id TEXT PRIMARY KEY, team_id TEXT NOT NULL, account_id TEXT NOT NULL, kind TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL, target TEXT, name TEXT);
 CREATE TABLE IF NOT EXISTS assistant_team_telegram_members (
 team_id TEXT NOT NULL, account_id TEXT NOT NULL, telegram_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(team_id,account_id), UNIQUE(team_id,telegram_id));
 CREATE TABLE IF NOT EXISTS assistant_team_telegram_groups (team_id TEXT NOT NULL, chat_id TEXT NOT NULL, PRIMARY KEY(team_id,chat_id));`);
 return db;
}
export function teamBotInUse(db: DatabaseSync, botId: string): boolean {
 return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='assistant_team_telegram'").get() && !!db.prepare('SELECT 1 FROM assistant_team_telegram WHERE bot_id=?').get(botId);
}
export function saveTeamTelegramConnection(db: DatabaseSync, input: {teamId:string;botId:string;botUsername:string;tokenAccountId:string;headerSecret:string;readsAllGroupMessages:boolean}): void {
 for (const table of ['assistant_telegram','control_center_telegram','assistant_team_telegram']) {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) && db.prepare(`SELECT 1 FROM ${table} WHERE bot_id=?`).get(input.botId)) throw new TeamError('Bot already connected',409);
 }
 db.prepare('INSERT INTO assistant_team_telegram VALUES(?,?,?,?,?,?)').run(input.teamId,input.botId,input.botUsername,input.tokenAccountId,tokenHash(input.headerSecret),Number(input.readsAllGroupMessages));
}
export interface TeamTelegramConnection {team_id:string;bot_id:string;bot_username:string;token_account_id:string;header_hash:string;reads_all:number}
export async function teamTelegramConnection(teamId:string): Promise<TeamTelegramConnection | undefined> {
 return (await telegramDatabase()).prepare('SELECT * FROM assistant_team_telegram WHERE team_id=?').get(teamId) as TeamTelegramConnection | undefined;
}
export async function teamTelegramHeaderValid(teamId:string, header:unknown): Promise<boolean> {
 const row=await teamTelegramConnection(teamId);
 return !!row && typeof header==='string' && timingSafeEqual(Buffer.from(row.header_hash),Buffer.from(tokenHash(header)));
}
