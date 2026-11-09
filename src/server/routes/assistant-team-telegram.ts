import { randomBytes } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { app, requestInterceptors } from '../state.js';
import { requireTeamMember } from '../../assistant-teams/access.js';
import { TeamError } from '../../assistant-teams/store.js';
import { telegramDatabase, saveTeamTelegramConnection, teamTelegramConnection, teamTelegramHeaderValid } from '../../assistant-teams/telegram-store.js';
import { issueTeamEnrollment, confirmTeamEnrollment, issueTeamGroupChallenge, confirmTeamGroup, redeemTeamEnrollment, redeemTeamGroupChallenge, ingestTeamTelegramUpdate } from '../../assistant-teams/telegram.js';
import { telegramBot, telegramSetWebhook, TELEGRAM_TOKEN_VARIABLE } from '../../webhook-telegram.js';
import { saveSecretAccount, deleteSecretAccount, secretAccountVariable } from '../../secrets.js';
import { urlBases } from './webhooks.js';
const wrap=(fn:(req:Request,res:Response)=>Promise<unknown>)=>(req:Request,res:Response,next:NextFunction)=>{void fn(req,res).then(value=>res.json(value)).catch(error=>{if(error instanceof TeamError) res.status(error.status).json({error:error.message});else next(error);});};
const member=(req:Request,res:Response)=>requireTeamMember(res.locals.authSession,String(req.params.id));
app.get('/api/assistant-teams/:id/telegram',wrap(async(req,res)=>{
 const actor=await member(req,res), row=await teamTelegramConnection(actor.teamId), db=await telegramDatabase();
 return {connected:!!row,botUsername:row?.bot_username,ready:row?.reads_all===1,visibility:row?.reads_all ? 'Whole-group visibility enabled' : 'Disable BotFather privacy mode and refresh visibility', confidentiality:'Telegram group members can see delivered replies. App enrollment does not hide Telegram history.',pending:db.prepare("SELECT id,kind,target,name,expires_at expiresAt FROM assistant_team_telegram_challenges WHERE team_id=? AND account_id=? AND state='pending'").all(actor.teamId,actor.accountId)};
}));
app.post('/api/assistant-teams/:id/telegram/connect',wrap(async(req,res)=>{
 const actor=await member(req,res); const token=req.body?.token;
 if(typeof token!=='string'||!token.trim()) throw new TeamError('Bot token required',400);
 const db=await telegramDatabase(); if(await teamTelegramConnection(actor.teamId)) throw new TeamError('Team already connected',409);
 const bases=await urlBases(), base=bases.find(b=>b.id===req.body.baseId) ?? (!req.body.baseId ? bases[0] : undefined);
 if(!base) throw new TeamError('No reachable webhook address',409);
 let bot; try {bot=await telegramBot(token);} catch {throw new TeamError('Telegram bot verification failed',502);}
 const headerSecret=randomBytes(32).toString('hex');
 const account=await saveSecretAccount({label:'Team Telegram bot',provider:'custom',replicate:false,variables:[{name:TELEGRAM_TOKEN_VARIABLE,kind:'value',value:token}]});
 try {saveTeamTelegramConnection(db,{teamId:actor.teamId,botId:bot.id,botUsername:bot.username,tokenAccountId:account.id,headerSecret,readsAllGroupMessages:bot.readsAllGroupMessages});}
 catch(error){await deleteSecretAccount(account.id);throw error;}
 try {await telegramSetWebhook(token,`${base.base}/teamtelegram-${actor.teamId}`,headerSecret);}
 catch {db.prepare('DELETE FROM assistant_team_telegram WHERE team_id=?').run(actor.teamId);await deleteSecretAccount(account.id);throw new TeamError('Telegram webhook registration failed',502);}
 return {connected:true,botUsername:bot.username,ready:bot.readsAllGroupMessages};
}));
app.post('/api/assistant-teams/:id/telegram/refresh',wrap(async(req,res)=>{
 const actor=await member(req,res),known=await teamTelegramConnection(actor.teamId);
 if(!known)throw new TeamError('Connect a team bot first',409);
 const token=secretAccountVariable([known.token_account_id],TELEGRAM_TOKEN_VARIABLE);if(!token)throw new TeamError('Bot secret unavailable',409);
 let bot;try{bot=await telegramBot(token);}catch{throw new TeamError('Telegram readiness check failed',502);}
 if(bot.id!==known.bot_id)throw new TeamError('Bot identity changed',409);
 (await telegramDatabase()).prepare('UPDATE assistant_team_telegram SET reads_all=?,bot_username=? WHERE team_id=?').run(Number(bot.readsAllGroupMessages),bot.username,actor.teamId);
 return {botUsername:bot.username,ready:bot.readsAllGroupMessages};
}));
app.post('/api/assistant-teams/:id/telegram/enrollment',wrap(async(req,res)=>issueTeamEnrollment(await member(req,res))));
app.post('/api/assistant-teams/:id/telegram/enrollment/:enrollmentId/confirm',wrap(async(req,res)=>{await confirmTeamEnrollment(await member(req,res),String(req.params.enrollmentId));return {confirmed:true};}));
app.post('/api/assistant-teams/:id/telegram/group',wrap(async(req,res)=>issueTeamGroupChallenge(await member(req,res))));
app.post('/api/assistant-teams/:id/telegram/group/:challengeId/confirm',wrap(async(req,res)=>{await confirmTeamGroup(await member(req,res),String(req.params.challengeId));return {confirmed:true};}));

export async function handleTeamTelegramWebhook(teamId:string,header:unknown,update:unknown):Promise<void> {
 if(!await teamTelegramHeaderValid(teamId,header)) throw new TeamError('Invalid webhook secret',401);
 const data=update as {message?:{text?:string;from?:{id:number;is_bot?:boolean;first_name?:string};chat?:{id:number;type:string}}};
 if((update as {edited_message?:unknown})?.edited_message){await ingestTeamTelegramUpdate(teamId,update);return;}
 const msg=data?.message; if(!msg?.from || msg.from.is_bot || !msg.chat) return;
 const start=/^\/start ([A-Za-z0-9_-]+)$/.exec(msg.text ?? '');
 if(msg.chat.type==='private') {
  if(start){
   const db=await telegramDatabase(); const {tokenHash}=await import('../../assistant-teams/telegram-store.js');
   if(db.prepare('SELECT 1 FROM assistant_team_telegram_challenges WHERE team_id=? AND hash=?').get(teamId,tokenHash(start[1]))) await redeemTeamEnrollment(start[1],{id:String(msg.from.id),name:msg.from.first_name ?? String(msg.from.id)});
  } return;
 }
 if(!['group','supergroup'].includes(msg.chat.type)) return;
 const challenge=/^\/bind ([A-Za-z0-9_-]+)$/.exec(msg.text ?? '');
 if(challenge){await redeemTeamGroupChallenge(teamId,challenge[1],String(msg.chat.id),String(msg.from.id));return;}
 await ingestTeamTelegramUpdate(teamId,update);
}
requestInterceptors.unshift((req,res)=>{
 const match=/^\/hooks\/teamtelegram-([a-zA-Z0-9_-]+)$/.exec((req.url ?? '').split('?')[0]); if(!match)return false;
 void (async()=>{
  if(req.method!=='POST')throw new TeamError('POST required',405);
  if(!await teamTelegramHeaderValid(match[1],req.headers['x-telegram-bot-api-secret-token']))throw new TeamError('Invalid webhook secret',401);
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>256*1024)throw new TeamError('Update too large',413);chunks.push(chunk);}
  let update:unknown;try{update=JSON.parse(Buffer.concat(chunks).toString());}catch{throw new TeamError('Invalid JSON',400);}
  await handleTeamTelegramWebhook(match[1],req.headers['x-telegram-bot-api-secret-token'],update);
  res.writeHead(200,{'Content-Type':'application/json'}).end('{}');
 })().catch(error=>{req.resume();if(!res.headersSent)res.writeHead(error instanceof TeamError ? error.status : 500).end('Telegram update not accepted');});
 return true;
});
