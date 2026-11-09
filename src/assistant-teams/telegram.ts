import { randomBytes, randomUUID } from 'node:crypto';
import { messageFiles } from '../assistant-telegram.js';
import { persistTeamMessage, type StoredTeamMessage, type TeamEntity } from './conversations.js';
import { recheckTeamActor, requireTeamExecution, type TeamMember } from './access.js';
import { TeamError } from './store.js';
import { telegramDatabase, tokenHash, teamTelegramConnection } from './telegram-store.js';
interface Challenge {id:string;team_id:string;account_id:string;kind:string;expires_at:number;state:string;target:string|null;name:string|null}
async function issue(member:TeamMember,kind:string) {
 await recheckTeamActor(member); await requireTeamExecution(member.teamId,member.accountId);
 const db=await telegramDatabase(), id=randomUUID(), code=randomBytes(24).toString('base64url'), expires=Date.now()+600000;
 db.prepare("UPDATE assistant_team_telegram_challenges SET state='replaced' WHERE team_id=? AND account_id=? AND kind=? AND state IN ('issued','pending')").run(member.teamId,member.accountId,kind);
 db.prepare('INSERT INTO assistant_team_telegram_challenges VALUES(?,?,?,?,?,?,?,NULL,NULL)').run(id,member.teamId,member.accountId,kind,tokenHash(code),expires,'issued');
 return {id,code,expiresAt:new Date(expires).toISOString()};
}
export async function issueTeamEnrollment(member:TeamMember): Promise<{id:string;link:string;expiresAt:string}> {
 const known=await teamTelegramConnection(member.teamId); if(!known) throw new TeamError('Connect a team bot first',409);
 const result=await issue(member,'member'); return {id:result.id,link:`https://t.me/${known.bot_username}?start=${result.code}`,expiresAt:result.expiresAt};
}
export async function redeemTeamEnrollment(code:string,telegramUser:{id:string;name:string}): Promise<void> {
 const db=await telegramDatabase();
 const row=db.prepare("SELECT * FROM assistant_team_telegram_challenges WHERE hash=? AND kind='member' AND state='issued' AND expires_at>?").get(tokenHash(code),Date.now()) as Challenge|undefined;
 if(!row) throw new TeamError('Invalid or expired enrollment',403);
 await requireTeamExecution(row.team_id,row.account_id);
 if(!db.prepare("UPDATE assistant_team_telegram_challenges SET state='pending',target=?,name=? WHERE id=? AND state='issued' AND expires_at>?").run(telegramUser.id,telegramUser.name.slice(0,120),row.id,Date.now()).changes) throw new TeamError('Enrollment already redeemed',409);
}
async function confirm(member:TeamMember,id:string,kind:string): Promise<void> {
 await recheckTeamActor(member); await requireTeamExecution(member.teamId,member.accountId);
 const db=await telegramDatabase(); db.exec('BEGIN IMMEDIATE');
 try {
 const row=db.prepare("SELECT * FROM assistant_team_telegram_challenges WHERE id=? AND team_id=? AND account_id=? AND kind=? AND state='pending' AND expires_at>?").get(id,member.teamId,member.accountId,kind,Date.now()) as Challenge|undefined;
 if(!row?.target) throw new TeamError('Invalid pending confirmation',403);
 if(kind==='member') db.prepare('INSERT INTO assistant_team_telegram_members VALUES(?,?,?,?) ON CONFLICT(team_id,account_id) DO UPDATE SET telegram_id=excluded.telegram_id,name=excluded.name').run(member.teamId,member.accountId,row.target,row.name ?? '');
 else db.prepare('INSERT OR IGNORE INTO assistant_team_telegram_groups VALUES(?,?)').run(member.teamId,row.target);
 db.prepare("UPDATE assistant_team_telegram_challenges SET state='confirmed' WHERE id=?").run(id); db.exec('COMMIT');
 } catch(error) {db.exec('ROLLBACK');throw error;}
}
export const confirmTeamEnrollment=(member:TeamMember,id:string):Promise<void>=>confirm(member,id,'member');
export const issueTeamGroupChallenge=(member:TeamMember)=>issue(member,'group');
export const confirmTeamGroup=(member:TeamMember,id:string):Promise<void>=>confirm(member,id,'group');
export async function redeemTeamGroupChallenge(teamId:string,code:string,chatId:string,telegramUserId:string):Promise<void> {
 const db=await telegramDatabase();
 const binding=db.prepare('SELECT account_id FROM assistant_team_telegram_members WHERE team_id=? AND telegram_id=?').get(teamId,telegramUserId) as {account_id:string}|undefined;
 if(!binding) throw new TeamError('Enrollment required',403);
 await requireTeamExecution(teamId,binding.account_id);
 if(!db.prepare("UPDATE assistant_team_telegram_challenges SET state='pending',target=? WHERE team_id=? AND account_id=? AND hash=? AND kind='group' AND state='issued' AND expires_at>?").run(chatId,teamId,binding.account_id,tokenHash(code),Date.now()).changes) throw new TeamError('Invalid group challenge',403);
}
export async function authorizeTeamTelegram(teamId:string,chatId:string,telegramUserId:string):Promise<TeamMember> {
 const db=await telegramDatabase();
 if(!db.prepare('SELECT 1 FROM assistant_team_telegram_groups WHERE team_id=? AND chat_id=?').get(teamId,chatId)) throw new TeamError('Group is not bound',403);
 const row=db.prepare('SELECT account_id FROM assistant_team_telegram_members WHERE team_id=? AND telegram_id=?').get(teamId,telegramUserId) as {account_id:string}|undefined;
 if(!row) throw new TeamError('Sender is not enrolled',403);
 return requireTeamExecution(teamId,row.account_id);
}

/** No model, memory, transcription or download before the complete human/group gate. */
export async function ingestTeamTelegramUpdate(teamId:string,update:unknown):Promise<{message:StoredTeamMessage;duplicate:boolean}|null> {
 if(!update || typeof update!=='object')return null;
 const data=update as Record<string,any>, raw=data.message ?? data.edited_message;
 if(!Number.isSafeInteger(data.update_id)||!raw||!Number.isSafeInteger(raw.message_id)||raw.message_id<=0||!raw.from||raw.from.is_bot||raw.sender_chat||!['group','supergroup'].includes(raw.chat?.type))return null;
 let actor:TeamMember;
 try{actor=await authorizeTeamTelegram(teamId,String(raw.chat.id),String(raw.from.id));}catch(error){if(error instanceof TeamError && error.status===403)return null;throw error;}
 const known=await teamTelegramConnection(teamId);if(!known?.reads_all)throw new TeamError('Whole-group visibility is not ready',409);
 const entities:TeamEntity[]=(Array.isArray(raw.entities ?? raw.caption_entities)?raw.entities ?? raw.caption_entities:[]).filter((e:any)=>typeof e.type==='string'&&Number.isSafeInteger(e.offset)&&Number.isSafeInteger(e.length)&&e.offset>=0&&e.length>0).map((e:any)=>({...e,type:e.type,offset:e.offset,length:e.length}));
 const unsupported=['sticker','contact','location','venue','poll','dice','game','paid_media'].filter(key=>raw[key]!==undefined);
 const message:StoredTeamMessage={id:randomUUID(),teamId,accountId:actor.accountId,telegramUserId:String(raw.from.id),chatId:String(raw.chat.id),telegramMessageId:raw.message_id,threadId:Number.isSafeInteger(raw.message_thread_id)?raw.message_thread_id:null,replyToMessageId:Number.isSafeInteger(raw.reply_to_message?.message_id)?raw.reply_to_message.message_id:null,text:typeof raw.text==='string'?raw.text:typeof raw.caption==='string'?raw.caption:'',revision:1,createdAt:new Date(Number.isFinite(raw.date)?raw.date*1000:Date.now()).toISOString(),entities,attachments:messageFiles(raw),albumId:typeof raw.media_group_id==='string'?raw.media_group_id:null,unsupported,output:false};
 if(Number.isFinite(raw.edit_date))message.editedAt=new Date(raw.edit_date*1000).toISOString();
 if(raw.forward_origin || raw.forward_date)message.entities.push({type:'blockquote',offset:0,length:message.text.length});
 const result=await persistTeamMessage(message,data.update_id,!!data.edited_message);
 if(result.message.attachments.length){const {prepareTeamMessageMedia}=await import('./telegram-media.js');result.message=await prepareTeamMessageMedia(result.message);}
 return result;
}
