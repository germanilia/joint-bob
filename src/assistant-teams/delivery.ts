import { conversationDatabase, recordTeamOutput } from './conversations.js';
import { requireTeamExecution } from './access.js';
import { teamTelegramConnection } from './telegram-store.js';
import { secretAccountVariable } from '../secrets.js';
import { TELEGRAM_TOKEN_VARIABLE, telegramParts } from '../webhook-telegram.js';
import type { DatabaseSync } from 'node:sqlite';
import { scheduleTeamChange, type TeamRole } from './store.js';

export interface TeamOutbox {
 id: string; teamId: string; rootId: string; assignmentId: string | null;
 kind: 'ack' | 'result' | 'inquiry' | 'clarify'; text: string;
 chatId: string; threadId: number | null; replyTo: number; requestedBy: string;
 role: TeamRole; subjectId: string | null;
 state: 'pending' | 'sending' | 'sent' | 'rejected' | 'uncertain' | 'cancelled';
 receiptId: number | null; retryAt: number | null;
}
export async function deliveryDatabase() {
 const db=await conversationDatabase();
 db.exec(`CREATE TABLE IF NOT EXISTS assistant_team_outbox (id TEXT PRIMARY KEY,team_id TEXT NOT NULL,root_id TEXT NOT NULL,state TEXT NOT NULL,record TEXT NOT NULL);`);
 return db;
}
/** Called inside the accepting/result transaction, with a server-owned destination snapshot. */
export function enqueueTeamOutput(db:DatabaseSync, input:Omit<TeamOutbox,'state'|'receiptId'|'retryAt'>):void {
 for(const [index,text] of telegramParts(input.text).entries()) {
  const record:TeamOutbox={...input,id:`${input.id}:${index}`,text,state:'pending',receiptId:null,retryAt:null};
  db.prepare('INSERT OR IGNORE INTO assistant_team_outbox VALUES(?,?,?,?,?)').run(record.id,record.teamId,record.rootId,record.state,JSON.stringify(record));
  scheduleTeamChange(record.teamId,[record.id]);
 }
}
function save(db:DatabaseSync, row:TeamOutbox) {db.prepare('UPDATE assistant_team_outbox SET state=?,record=? WHERE id=?').run(row.state,JSON.stringify(row),row.id);scheduleTeamChange(row.teamId,[row.id]);}
export async function listTeamOutbox(teamId:string):Promise<TeamOutbox[]> {
 return (await deliveryDatabase()).prepare('SELECT state,record FROM assistant_team_outbox WHERE team_id=? ORDER BY rowid').all(teamId).map(r=>({...JSON.parse(r.record as string),state:r.state}));
}
const active=new Set<string>();
const retryTimers=new Map<string,NodeJS.Timeout>();
function scheduleDefiniteRetry(row:TeamOutbox) {
 if(row.state!=='rejected'||row.retryAt===null||retryTimers.has(row.id))return;
 const delay=Math.min(2147483647,Math.max(1,row.retryAt-Date.now()));
 retryTimers.set(row.id,setTimeout(()=>{retryTimers.delete(row.id);void import('./assignments.js').then(({wakeTeamWork})=>wakeTeamWork(row.teamId));},delay).unref());
}
/** A send claim is durable BEFORE the external call. Unknown effects are never retried. */
export async function deliverTeamOutbox(teamId:string):Promise<void> {
 const db=await deliveryDatabase();
 for(const row of await listTeamOutbox(teamId)) {
  if(active.has(row.id))continue;
  if(row.state==='sending'){row.state='uncertain';save(db,row);continue;}
  if(row.state==='sent') {await mapReceipt(row);continue;}
  if(row.state!=='pending' && !(row.state==='rejected'&&row.retryAt!==null&&row.retryAt<=Date.now())){scheduleDefiniteRetry(row);continue;}
  const separator=row.id.lastIndexOf(':'),part=Number(row.id.slice(separator+1));
  if(part>0&&db.prepare('SELECT state FROM assistant_team_outbox WHERE id=?').get(`${row.id.slice(0,separator)}:${part-1}`)?.state!=='sent')continue;
  // Final output can never overtake a missing/uncertain acknowledgment.
  if(row.kind==='result' && !(await acknowledgmentConfirmed(teamId,row.rootId)))continue;
  active.add(row.id);
  try {
   try{await requireTeamExecution(teamId,row.requestedBy);}catch{row.state='cancelled';save(db,row);continue;}
   const connection=await teamTelegramConnection(teamId), token=connection&&secretAccountVariable([connection.token_account_id],TELEGRAM_TOKEN_VARIABLE);
   if(!token)continue; // No external effect; reconnecting the bot can wake pending output.
   const claimed=db.prepare("UPDATE assistant_team_outbox SET state='sending' WHERE id=? AND state IN ('pending','rejected')").run(row.id);
   if(!claimed.changes)continue;
   row.state='sending';save(db,row);
   try {
    const response=await fetch(`${process.env.JOINT_BOB_TELEGRAM_API||'https://api.telegram.org'}/bot${token}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(15000),body:JSON.stringify({chat_id:row.chatId,text:row.text,...(row.kind==='inquiry'?{reply_markup:{inline_keyboard:[[{text:'Confirm',callback_data:`tc:${Buffer.from(row.id.split(':')[0],'hex').toString('base64url')}`},{text:'Dismiss',callback_data:`td:${Buffer.from(row.id.split(':')[0],'hex').toString('base64url')}`}]]}}:{}),...(row.threadId===null?{}:{message_thread_id:row.threadId}),reply_parameters:{message_id:row.replyTo}})});
    const answer=await response.json() as {ok?:boolean;result?:{message_id?:number};parameters?:{retry_after?:number}};
    if(answer.ok===false){row.state='rejected';const delay=answer.parameters?.retry_after;row.retryAt=Number.isFinite(delay)&&delay!>0?Date.now()+delay!*1000:null;}
    else if(response.ok&&answer.ok===true&&Number.isSafeInteger(answer.result?.message_id)&&answer.result!.message_id!>0){row.state='sent';row.receiptId=answer.result!.message_id!;}
    else row.state='uncertain';
   }catch{row.state='uncertain';}
   save(db,row);scheduleDefiniteRetry(row);
   if(row.state==='sent')await mapReceipt(row);
  }finally{active.delete(row.id);}
 }
}
export async function acknowledgmentConfirmed(teamId:string,rootId:string):Promise<boolean> {
 const rows=(await listTeamOutbox(teamId)).filter(r=>r.rootId===rootId&&r.kind==='ack');
 return rows.length>0&&rows.every(r=>r.state==='sent'&&r.receiptId!==null);
}
async function mapReceipt(row:TeamOutbox) {
 if(!row.receiptId||!row.subjectId||!row.assignmentId)return;
 const db=await deliveryDatabase();
 if(db.prepare('SELECT 1 FROM assistant_team_outputs WHERE team_id=? AND chat_id=? AND message_id=?').get(row.teamId,row.chatId,row.receiptId))return;
 await recordTeamOutput({teamId:row.teamId,chatId:row.chatId,threadId:row.threadId,telegramMessageId:row.receiptId,role:row.role,subjectId:row.subjectId,assignmentId:row.assignmentId,text:row.text});
}
/** After routing, acknowledgments gain the same stable reply subject as the accepted root. */
export async function bindTeamOutputSubject(teamId:string,rootId:string,subjectId:string,assignmentId:string) {
 const db=await deliveryDatabase();
 for(const row of await listTeamOutbox(teamId))if(row.rootId===rootId&&row.kind==='ack'){row.subjectId=subjectId;row.assignmentId=assignmentId;save(db,row);if(row.state==='sent')await mapReceipt(row);}
}
