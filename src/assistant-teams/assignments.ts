import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { asNode } from '../account-context.js';
import { recheckTeamActor, requireTeamExecution, type TeamMember } from './access.js';
import { scheduleTeamChange, getTeam, getTeamAssignment, listTeamAgents, teamRolesSync, TeamError, type AssignmentState, type TeamAssignment, type TeamMessage, type TeamRole, type TeamRoute } from './store.js';
import { TEAM_COMMANDS, formatTeamRequest, formatTeamStatus, teamHelp, teamRequestStateLabel, type TeamCommand } from './control-text.js';
import { teamExecutionEvidence, bindTeamMessageSubject, saveTeamSubject, directTeamTargets, getTeamMessage, listPendingTeamEvents, onTeamInbox, type StoredTeamMessage } from './conversations.js';
import { authorizeTeamTelegram } from './telegram.js';
import { acknowledgmentConfirmed, bindTeamOutputSubject, deliverTeamOutbox, deliveryDatabase, enqueueTeamOutput, listTeamOutbox } from './delivery.js';
import { decideTeamMessage, listTeamDecisions } from './decisions.js';
import { runTeamTurn, teamAssignmentDestination, teamAgentReadiness } from './runtime.js';
import { getPersonalAssistantById, getPersonalAssistantTurn } from '../personal-assistants.js';
import { runningPromptRequestId } from '../assistant-collaboration/bridge-tools.js';

interface Root { id:string; teamId:string; source:TeamMessage; browser:boolean; subjectId:string|null }
export interface TeamWork { originalMaterial?:string; assignmentId:string; phase:'queued'|'dispatched'|'done'|'held'; message:string; result:string|null; conversationId:string|null; consumed:boolean; reason:string|null }
export interface TeamInquiry { id:string; teamId:string; source:TeamMessage; roles:TeamRole[]; route:TeamRoute; state:'pending'|'confirmed'|'dismissed'; approvedBy?:string }
export async function assignmentDatabase() {
 const db=await deliveryDatabase();
 db.exec(`CREATE TABLE IF NOT EXISTS assistant_team_failures (id TEXT PRIMARY KEY,team_id TEXT NOT NULL,code TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS assistant_team_roots (id TEXT PRIMARY KEY,team_id TEXT NOT NULL,record TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS assistant_team_work (assignment_id TEXT PRIMARY KEY,phase TEXT NOT NULL,record TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS assistant_team_inquiries (id TEXT PRIMARY KEY,team_id TEXT NOT NULL,state TEXT NOT NULL,record TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS assistant_team_request_evidence (request_id TEXT NOT NULL,team_id TEXT NOT NULL,message_id TEXT NOT NULL,account_id TEXT NOT NULL,PRIMARY KEY(request_id,message_id));
 CREATE TABLE IF NOT EXISTS assistant_team_inbox_claims (event_id TEXT PRIMARY KEY,team_id TEXT NOT NULL,state TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS assistant_team_approvals (review_id TEXT PRIMARY KEY,assignment_id TEXT NOT NULL,state TEXT NOT NULL,record TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS assistant_team_approval_operation ON assistant_team_approvals(assignment_id,json_extract(record,'$.team.requestId'),json_extract(record,'$.team.operationKey'));`);
 return db;
}
function transaction<T>(db:DatabaseSync, fn:()=>T):T {db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}
const key=(...parts:string[])=>createHash('sha256').update(JSON.stringify(parts)).digest('hex');
function rootKey(message:TeamMessage) {const album=(message as StoredTeamMessage).albumId;return key(message.teamId,message.chatId,String(message.threadId),album?`album:${album}`:message.id);}
function saveAssignment(db:DatabaseSync,a:TeamAssignment){db.prepare('UPDATE assistant_team_assignments SET request_id=?,record=? WHERE id=?').run(a.requestId,JSON.stringify(a),a.id);scheduleTeamChange(a.teamId,[a.id]);}
function saveWork(db:DatabaseSync,w:TeamWork){db.prepare('INSERT INTO assistant_team_work VALUES(?,?,?) ON CONFLICT(assignment_id) DO UPDATE SET phase=excluded.phase,record=excluded.record').run(w.assignmentId,w.phase,JSON.stringify(w));const row=db.prepare('SELECT team_id FROM assistant_team_assignments WHERE id=?').get(w.assignmentId);if(row)scheduleTeamChange(String(row.team_id),[w.assignmentId]);}
function work(db:DatabaseSync,id:string):TeamWork|undefined {const row=db.prepare('SELECT phase,record FROM assistant_team_work WHERE assignment_id=?').get(id);return row?{...JSON.parse(row.record as string),phase:row.phase}:undefined;}
function root(db:DatabaseSync,id:string):Root {const row=db.prepare('SELECT record FROM assistant_team_roots WHERE id=?').get(id);if(!row)throw new TeamError('Unknown assignment root',404);return JSON.parse(row.record as string);}
function assignments(db:DatabaseSync,teamId:string):TeamAssignment[] {return db.prepare('SELECT record FROM assistant_team_assignments WHERE team_id=? ORDER BY rowid').all(teamId).map(r=>JSON.parse(r.record as string));}
export async function readTeamWork(teamId:string):Promise<TeamWork[]> {const db=await assignmentDatabase();return assignments(db,teamId).flatMap(a=>{const w=work(db,a.id);return w?[w]:[];});}
/** Member-visible diagnostics include held/uncertain effects; reading does not retry them. */
export async function teamWorkStatus(member:TeamMember) {
 await recheckTeamActor(member);if((await getTeam(member.teamId)).clusterId!==member.clusterId)throw new TeamError('Wrong team',403);
 const db=await assignmentDatabase();
 return {
  failures:db.prepare('SELECT code,created_at createdAt FROM assistant_team_failures WHERE team_id=? ORDER BY rowid DESC LIMIT 100').all(member.teamId),
  assignments:assignments(db,member.teamId),work:await readTeamWork(member.teamId),deliveries:await listTeamOutbox(member.teamId),
  inquiries:db.prepare('SELECT state,record FROM assistant_team_inquiries WHERE team_id=?').all(member.teamId).map(row=>({...JSON.parse(row.record as string),state:row.state})),
  inbox:db.prepare('SELECT i.id,i.message_id messageId,i.state,i.error,c.state claimState FROM assistant_team_inbox i LEFT JOIN assistant_team_inbox_claims c ON c.event_id=i.id WHERE i.team_id=? ORDER BY i.rowid DESC LIMIT 1000').all(member.teamId),
  approvals:db.prepare('SELECT p.state,p.record FROM assistant_team_approvals p JOIN assistant_team_assignments a ON a.id=p.assignment_id WHERE a.team_id=?').all(member.teamId).map(row=>({...JSON.parse(row.record as string),state:row.state})),
 };
}
const coordinatorOf=(db:DatabaseSync,teamId:string)=>teamRolesSync(db,teamId).coordinator??'team';
/** Group-facing notes are signed by the coordinator; the text names it, e.g. "lead: accepted". */
const say=(db:DatabaseSync,teamId:string,text:string)=>`${coordinatorOf(db,teamId)}: ${text}`;
function output(db:DatabaseSync,r:Root,id:string,kind:'ack'|'inquiry'|'clarify'|'result',text:string,assignmentId:string|null=null,role:TeamRole=coordinatorOf(db,r.teamId)) {
 if(r.browser)return;
 enqueueTeamOutput(db,{id,teamId:r.teamId,rootId:r.id,kind,text,assignmentId,role,subjectId:r.subjectId,chatId:r.source.chatId,threadId:r.source.threadId,replyTo:r.source.telegramMessageId,requestedBy:r.source.accountId});
}
async function canonical(member:TeamMember,message:TeamMessage):Promise<StoredTeamMessage> {
 await recheckTeamActor(member);if(member.teamId!==message.teamId)throw new TeamError('Wrong team',403);
 const stored=await getTeamMessage(member.teamId,message.id);
 if(!stored||stored.output||stored.accountId!==message.accountId||stored.accountId!==member.accountId)throw new TeamError('Stored human source required',403);
 await authorizeTeamTelegram(stored.teamId,stored.chatId,stored.telegramUserId);
 await requireTeamExecution(member.teamId,member.accountId);return stored;
}
function accept(db:DatabaseSync,r:Root,roles:TeamRole[],requestedBy:string):TeamAssignment[] {
 db.prepare('INSERT OR IGNORE INTO assistant_team_roots VALUES(?,?,?)').run(r.id,r.teamId,JSON.stringify(r));
 if(!r.browser)db.prepare('INSERT OR IGNORE INTO assistant_team_request_evidence VALUES(?,?,?,?)').run(r.id,r.teamId,r.source.id,r.source.accountId);
 r=root(db,r.id);
 const result:TeamAssignment[]=[];
 for(const role of [...new Set(roles)]) {
  const id=key(r.id,role);const existing=assignments(db,r.teamId).find(a=>a.id===id);
  if(existing){result.push(existing);continue;}
  const a:TeamAssignment={id,teamId:r.teamId,rootId:r.id,parentId:null,subjectId:r.subjectId,role,requestedBy,sourceMessageId:r.source.id,destination:{kind:'group',sourceMessageId:r.source.id},state:r.subjectId?'queued':'accepted',requestId:randomUUID()};
  db.prepare('INSERT INTO assistant_team_assignments VALUES(?,?,?,?)').run(id,a.teamId,a.requestId,JSON.stringify(a));
  saveWork(db,{assignmentId:id,phase:'queued',message:r.source.text,result:null,conversationId:null,consumed:false,reason:null});result.push(a);
 }
 if(result.length)output(db,r,`${r.id}:ack`,'ack',say(db,r.teamId,`accepted; queued for ${result.map(a=>a.role).join(', ')}. This confirms acceptance, not that work has started.`),result[0].id);
 return result;
}
export async function acceptTeamAssignment(member:TeamMember,message:TeamMessage,roles:TeamRole[],subjectId:string|null):Promise<TeamAssignment[]> {
 const source=await canonical(member,message),db=await assignmentDatabase();
 const known=teamRolesSync(db,member.teamId).roles;
 if(!roles.length||roles.some(r=>!known.includes(r)))throw new TeamError('Known target required',400);
 if(subjectId&&!db.prepare('SELECT 1 FROM assistant_team_subjects WHERE team_id=? AND id=? AND chat_id=? AND thread_id IS ?').get(member.teamId,subjectId,source.chatId,source.threadId))throw new TeamError('Unknown scoped subject',403);
 return transaction(db,()=>accept(db,{id:rootKey(source),teamId:source.teamId,source,browser:false,subjectId},roles,member.accountId));
}
export async function routeTeamAssignment(assignmentId:string,route:TeamRoute):Promise<void> {
 const db=await assignmentDatabase(),a=await getTeamAssignment(assignmentId);if(!a)throw new TeamError('Unknown assignment',404);
 await requireTeamExecution(a.teamId,a.requestedBy);const r=root(db,a.rootId);
 transaction(db,()=>{
  if(route.kind==='clarify'){
   for(const target of assignments(db,a.teamId).filter(t=>t.rootId===a.rootId&&!t.parentId&&['accepted','waiting_for_human'].includes(t.state))){target.state='waiting_for_human';saveAssignment(db,target);const w=work(db,target.id)!;w.reason='subject_clarification';saveWork(db,w);}
   output(db,r,`${r.id}:clarify`,'clarify',say(db,r.teamId,'which subject and what work should the team handle?'));return;
  }
  if(!r.subjectId){
   if(route.kind==='continue'){
    if(!db.prepare('SELECT 1 FROM assistant_team_subjects WHERE team_id=? AND id=? AND chat_id=? AND thread_id IS ?').get(a.teamId,route.subjectId,r.source.chatId,r.source.threadId))throw new TeamError('Unknown scoped subject',403);
    r.subjectId=route.subjectId;
   }else{
    r.subjectId=randomUUID();db.prepare('INSERT INTO assistant_team_subjects VALUES(?,?,?,?,?)').run(r.subjectId,a.teamId,r.source.chatId,r.source.threadId,JSON.stringify({id:r.subjectId,teamId:a.teamId,title:r.source.text.slice(0,160),summary:''}));
   }
   db.prepare('UPDATE assistant_team_roots SET record=? WHERE id=?').run(JSON.stringify(r),r.id);
  }
  if(!r.browser)db.prepare('INSERT OR REPLACE INTO assistant_team_message_subjects VALUES(?,?,?)').run(a.teamId,r.source.id,r.subjectId);
  for(const target of assignments(db,a.teamId).filter(t=>t.rootId===a.rootId&&!t.parentId&&['accepted','waiting_for_human'].includes(t.state))){target.subjectId=r.subjectId;target.state='queued';saveAssignment(db,target);}
 });
 if(r.subjectId){
  await bindTeamOutputSubject(a.teamId,r.id,r.subjectId,a.id);
  for(const target of assignments(db,a.teamId).filter(t=>t.rootId===a.rootId&&!t.parentId&&t.state==='queued')){
   const w=work(db,target.id)!;w.originalMaterial??=w.message;w.message=await teamExecutionEvidence(target,w.originalMaterial);saveWork(db,w);
  }
 }
}
export async function createTeamInquiry(member:TeamMember,message:TeamMessage,roles:TeamRole[],route:TeamRoute):Promise<TeamInquiry> {
 const source=await canonical(member,message),db=await assignmentDatabase(),id=key(rootKey(source),'inquiry');
 return transaction(db,()=>{
  const existing=db.prepare('SELECT record FROM assistant_team_inquiries WHERE id=?').get(id);if(existing)return JSON.parse(existing.record as string);
  if(route.kind==='new'){
   const subjectId=randomUUID();
   db.prepare('INSERT INTO assistant_team_subjects VALUES(?,?,?,?,?)').run(subjectId,member.teamId,source.chatId,source.threadId,JSON.stringify({id:subjectId,teamId:member.teamId,title:source.text.slice(0,160),summary:''}));
   route={kind:'continue',subjectId};
  }
  if(route.kind==='continue'){
   if(!db.prepare('SELECT 1 FROM assistant_team_subjects WHERE team_id=? AND id=? AND chat_id=? AND thread_id IS ?').get(member.teamId,route.subjectId,source.chatId,source.threadId))throw new TeamError('Unknown scoped subject',403);
   db.prepare('INSERT OR REPLACE INTO assistant_team_message_subjects VALUES(?,?,?)').run(member.teamId,source.id,route.subjectId);
  }
  const inquiry:TeamInquiry={id,teamId:member.teamId,source,roles,route,state:'pending'};
  db.prepare('INSERT OR IGNORE INTO assistant_team_request_evidence VALUES(?,?,?,?)').run(rootKey(source),member.teamId,source.id,source.accountId);
  db.prepare('INSERT INTO assistant_team_inquiries VALUES(?,?,?,?)').run(id,member.teamId,'pending',JSON.stringify(inquiry));
  output(db,{id:rootKey(source),teamId:member.teamId,source,browser:false,subjectId:null},`${id}:question`,'inquiry',say(db,member.teamId,`shall I investigate this request? Reply to THIS question with “yes” or “no”.\n${source.text.slice(0,1500)}`));
  scheduleTeamChange(member.teamId);
  return inquiry;
 });
}
export interface OpenTeamRequest { id:string; subjectId:string|null; text:string; accountId:string; messageId:string }
function openRequests(db:DatabaseSync,message:TeamMessage):OpenTeamRequest[] {
 const all=assignments(db,message.teamId),result:OpenTeamRequest[]=[];
 const scoped=(source:TeamMessage)=>source.chatId===message.chatId&&source.threadId===message.threadId;
 for(const row of db.prepare("SELECT record FROM assistant_team_inquiries WHERE team_id=? AND state='pending'").all(message.teamId)){
  const q=JSON.parse(row.record as string) as TeamInquiry;
  if(scoped(q.source))result.push({id:rootKey(q.source),subjectId:q.route.kind==='continue'?q.route.subjectId:null,text:q.source.text,accountId:q.source.accountId,messageId:q.source.id});
 }
 for(const row of db.prepare('SELECT record FROM assistant_team_roots WHERE team_id=?').all(message.teamId)){
  const r=JSON.parse(row.record as string) as Root;
  if(!r.browser&&r.subjectId&&scoped(r.source)&&all.some(a=>a.rootId===r.id&&!['completed','failed','cancelled'].includes(a.state))&&!result.some(q=>q.id===r.id))result.push({id:r.id,subjectId:r.subjectId,text:r.source.text,accountId:r.source.accountId,messageId:r.source.id});
 }
 return result;
}
export async function openTeamRequests(message:TeamMessage):Promise<OpenTeamRequest[]>{return openRequests(await assignmentDatabase(),message);}
/** The semantic choice is a locator, not authority. Recheck and attach in one transaction. */
export async function attachTeamRequestEvidence(member:TeamMember,message:TeamMessage,requestId:string):Promise<boolean>{
 const source=await canonical(member,message),db=await assignmentDatabase();
 const candidate=openRequests(db,source).find(r=>r.id===requestId);if(!candidate)return false;
 await requireTeamExecution(member.teamId,candidate.accountId);
 return transaction(db,()=>{
  const request=openRequests(db,source).find(r=>r.id===requestId);if(!request)return false;
  db.prepare('INSERT OR IGNORE INTO assistant_team_request_evidence VALUES(?,?,?,?)').run(requestId,member.teamId,source.id,source.accountId);
  if(request.subjectId)db.prepare('INSERT OR REPLACE INTO assistant_team_message_subjects VALUES(?,?,?)').run(member.teamId,source.id,request.subjectId);
  scheduleTeamChange(member.teamId,[requestId]);return true;
 });
}
function mediaText(messages:StoredTeamMessage[]):string {
 return messages.map(m=>[m.text,...m.attachments.map(file=>[file.name,file.path,file.extractedText,file.problem].filter(Boolean).join(': '))].filter(Boolean).join('\n')).join('\n');
}
export async function confirmTeamInquiry(member:TeamMember,inquiryId:string,decision:'confirm'|'dismiss'):Promise<void> {
 await recheckTeamActor(member);await requireTeamExecution(member.teamId,member.accountId);
 const db=await assignmentDatabase(),row=db.prepare('SELECT record FROM assistant_team_inquiries WHERE id=? AND team_id=?').get(inquiryId,member.teamId);
 if(!row)throw new TeamError('Unknown inquiry',404);const inquiry:TeamInquiry=JSON.parse(row.record as string);if(inquiry.state!=='pending')return;
 // Also recheck the original request's member; a removed actor cannot leave executable work behind.
 await requireTeamExecution(member.teamId,inquiry.source.accountId);
 let material:string|undefined;
 if(decision==='confirm'){
  const source=await getTeamMessage(member.teamId,inquiry.source.id);if(!source)throw new TeamError('Inquiry source unavailable',409);
  const components=source.albumId?db.prepare('SELECT record FROM assistant_team_messages WHERE team_id=? AND chat_id=? AND thread_id IS ?').all(member.teamId,source.chatId,source.threadId).map(r=>JSON.parse(r.record as string) as StoredTeamMessage).filter(m=>m.albumId===source.albumId&&!m.output):[source];
  const prepared:StoredTeamMessage[]=[];
  for(const component of components){await authorizeTeamTelegram(member.teamId,component.chatId,component.telegramUserId);prepared.push(await (await import('./telegram-media.js')).prepareTeamMessageMedia(component));}
  material=mediaText(prepared);
 }
 const accepted=transaction(db,()=>{
  if(!db.prepare("UPDATE assistant_team_inquiries SET state=? WHERE id=? AND state='pending'").run(decision==='confirm'?'confirmed':'dismissed',inquiry.id).changes)return [];
  inquiry.state=decision==='confirm'?'confirmed':'dismissed';inquiry.approvedBy=member.accountId;
  db.prepare('UPDATE assistant_team_inquiries SET record=? WHERE id=?').run(JSON.stringify(inquiry),inquiry.id);
  const result=decision==='confirm'?accept(db,{id:rootKey(inquiry.source),teamId:member.teamId,source:inquiry.source,browser:false,subjectId:null},inquiry.roles,inquiry.source.accountId):[];
  for(const a of result){const w=work(db,a.id)!;w.message=material!;saveWork(db,w);}
  return result;
 });
 scheduleTeamChange(member.teamId);
 for(const a of accepted)await routeTeamAssignment(a.id,inquiry.route);
}
/** Callback data is a locator, not authority: bind the enrolled human to the actual sent question. */
export async function consumeTeamCallback(teamId:string,input:unknown):Promise<void> {
 const callback=input as {data?:unknown;from?:{id?:unknown;is_bot?:boolean};message?:{message_id?:unknown;message_thread_id?:unknown;chat?:{id?:unknown;type?:string}}};
 const match=typeof callback?.data==='string'?/^t([cd]):([A-Za-z0-9_-]{43})$/.exec(callback.data):null;
 const message=callback?.message;
 if(!match||callback.from?.is_bot||!Number.isSafeInteger(callback.from?.id)||!Number.isSafeInteger(message?.message_id)||!Number.isSafeInteger(message?.chat?.id)||!['group','supergroup'].includes(message?.chat?.type??''))throw new TeamError('Invalid inquiry callback',400);
 const member=await authorizeTeamTelegram(teamId,String(message!.chat!.id),String(callback.from!.id));
 const inquiryId=Buffer.from(match[2],'base64url').toString('hex');
 const sent=(await listTeamOutbox(teamId)).find(row=>row.id===`${inquiryId}:question:0`&&row.kind==='inquiry'&&row.state==='sent'&&row.receiptId===message!.message_id&&row.chatId===String(message!.chat!.id)&&row.threadId===(message!.message_thread_id??null));
 if(!sent)throw new TeamError('Callback does not match a delivered inquiry',400);
 await confirmTeamInquiry(member,inquiryId,match[1]==='c'?'confirm':'dismiss');wakeTeamWork(teamId);
}
export async function consumeTeamConfirmation(input:StoredTeamMessage):Promise<boolean> {
 const message=await getTeamMessage(input.teamId,input.id);
 if(!message||message.output||!message.replyToMessageId||! /^(yes|confirm|no|dismiss)[.!]?$/i.test(message.text.trim()))return false;
 const member=await authorizeTeamTelegram(message.teamId,message.chatId,message.telegramUserId);
 if(message.accountId!==member.accountId)throw new TeamError('Human confirmation required',403);
 const sent=(await listTeamOutbox(message.teamId)).find(r=>r.kind==='inquiry'&&r.state==='sent'&&r.chatId===message.chatId&&r.threadId===message.threadId&&r.receiptId===message.replyToMessageId);
 if(!sent)return false;
 await confirmTeamInquiry(member,sent.id.split(':')[0],/^(yes|confirm)/i.test(message.text.trim())?'confirm':'dismiss');return true;
}
/** The running request and real runtime receipt are both required, even for direct internal callers. */
export async function requireLiveTeamBob(parentId:string) {
 const a=await getTeamAssignment(parentId),db=await assignmentDatabase();
 if(!a||a.role!==teamRolesSync(db,a.teamId).coordinator)throw new TeamError('Only the live coordinator can delegate',403);
 const resolved=await teamAssignmentDestination(a),turn=await getPersonalAssistantTurn(resolved.profile.accountId,resolved.profile.id,a.requestId);
 if(!turn||turn.status!=='running'||runningPromptRequestId(resolved.team.projectId,resolved.destination.sessionId)!==a.requestId)throw new TeamError('Live coordinator turn required',403);
 return resolved;
}
export async function delegateTeamAssignment(parentId:string,role:TeamRole,message:string):Promise<TeamAssignment> {
 const {assignment:parent}=await requireLiveTeamBob(parentId),db=await assignmentDatabase(),id=key(parent.id,parent.requestId,role,message);
 const {roles,coordinator}=teamRolesSync(db,parent.teamId);
 if(!roles.includes(role)||role===coordinator||!message.trim()||message.length>18000)throw new TeamError('Known member and nonempty request required',400);
 const child=transaction(db,()=>{
  const all=assignments(db,parent.teamId),existing=all.find(a=>a.id===id);if(existing)return existing;
  if(all.filter(a=>a.rootId===parent.rootId&&a.parentId).length>=10){const w=work(db,parent.id)!;w.reason='delegation_limit';saveWork(db,w);return null;}
  const a:TeamAssignment={...parent,id,parentId:parent.id,role,destination:{kind:'bob',parentAssignmentId:parent.id},state:'queued',requestId:randomUUID()};
  db.prepare('INSERT INTO assistant_team_assignments VALUES(?,?,?,?)').run(id,a.teamId,a.requestId,JSON.stringify(a));
  saveWork(db,{assignmentId:id,phase:'queued',message:`INTERNAL ONLY — report to ${coordinator}, never publish to Telegram.\n${message}`,result:null,conversationId:null,consumed:false,reason:null});return a;
 });
 if(!child)throw new TeamError('Ten delegated turns reached; human continuation required',409);
 wakeTeamWork(parent.teamId);return child;
}
const executing=new Set<string>();
/** Capability listing may occur while a real dispatcher is opening Pi, just before promptStarted. */
export function teamDispatchActive(assignmentId:string):boolean {return executing.has(assignmentId);}
async function complete(a:TeamAssignment,text:string,conversationId:string) {
 const db=await assignmentDatabase();transaction(db,()=>{const current=assignments(db,a.teamId).find(t=>t.id===a.id)!;if(current.requestId!==a.requestId||current.state==='cancelled')return;const w=work(db,a.id)!;w.phase='done';w.result=text;w.conversationId=conversationId;current.state='completed';saveWork(db,w);saveAssignment(db,current);});
}
/** The group learns that a member stopped; an unknown outcome is never replayed, so the way on is a new request (/retry). */
function reportStopped(db:DatabaseSync,a:TeamAssignment):void {
 const r=root(db,a.rootId);
 output(db,r,`${a.id}:stopped`,'clarify',say(db,a.teamId,`${a.role} stopped without a result${a.parentId?' (delegated work)':''}. Whatever it already did stays done. Send /retry ${r.id.slice(0,6)} to run the request again as a new one, or /cancel ${r.id.slice(0,6)} to drop it.`),a.id);
}
async function dispatch(a:TeamAssignment):Promise<void> {
 if(executing.has(a.id))return;executing.add(a.id);
 try {
  const db=await assignmentDatabase(),w=work(db,a.id);if(!w||w.phase!=='queued'||!a.subjectId)return;
  try {await requireTeamExecution(a.teamId,a.requestedBy);}catch{a.state='cancelled';w.phase='held';w.reason='membership_removed_before_dispatch';transaction(db,()=>{saveAssignment(db,a);saveWork(db,w);});return;}
  const resolved=await teamAssignmentDestination(a),problems=await asNode(()=>teamAgentReadiness(resolved.profile));
  if(problems.length){w.reason=problems.join('\n');saveWork(db,w);throw new TeamError(w.reason,503);}
  if(!a.parentId){w.originalMaterial??=w.message;w.message=await teamExecutionEvidence(a,w.originalMaterial);}
  a.state='running';w.phase='dispatched';w.reason=null;
  transaction(db,()=>{saveAssignment(db,a);saveWork(db,w);});
  try{const result=await runTeamTurn({assignment:a,message:w.message});await complete(a,result.text,result.conversationId);}
  catch{const current=work(db,a.id)!,latest=await getTeamAssignment(a.id);if(current.phase!=='done'&&latest?.state!=='cancelled'){a.state='uncertain';current.phase='held';current.reason='dispatch_outcome_unknown';transaction(db,()=>{saveAssignment(db,a);saveWork(db,current);reportStopped(db,a);});await deliverTeamOutbox(a.teamId);}}
 }catch(error){
  const db=await assignmentDatabase(),w=work(db,a.id);
  // Only pre-dispatch failures are known not to have run. Never reset uncertain runtime effects.
  if(w?.phase==='queued'){
   transaction(db,()=>{a.state='failed';w.phase='held';w.reason='runtime_unavailable';saveAssignment(db,a);saveWork(db,w);
    output(db,root(db,a.rootId),`${a.id}:runtime-failed`,'clarify',say(db,a.teamId,'the selected host runtime is unavailable. No alternative host or model was used. Check team readiness before submitting a new request.'),a.id);
   });
   await deliverTeamOutbox(a.teamId);
  }
  throw error;
 }finally{executing.delete(a.id);}
}
async function advanceParent(a:TeamAssignment):Promise<void> {
 const db=await assignmentDatabase(),w=work(db,a.id)!;
 const children=assignments(db,a.teamId).filter(c=>c.parentId===a.id),unread=children.filter(c=>!work(db,c.id)?.consumed);
 if(w.phase!=='done')return;
 if(w.reason!=='delegation_limit') {
  if(!unread.length)return;
  if(unread.some(c=>work(db,c.id)?.phase!=='done')) {
   const held=unread.some(c=>work(db,c.id)?.phase==='held');a.state=held?'waiting_for_human':'queued';w.reason=held?'child_outcome_requires_reconciliation':'waiting_for_children';
   transaction(db,()=>{saveAssignment(db,a);saveWork(db,w);});return;
  }
 }
 transaction(db,()=>{
  if(w.reason==='delegation_limit'){a.state='waiting_for_human';w.phase='held';output(db,root(db,a.rootId),`${a.rootId}:limit`,'clarify',say(db,a.teamId,'ten delegated turns reached. Please give a new explicit request to continue.'));}
  else {
   delete w.originalMaterial;
   w.message=`Continue the original request using these stored INTERNAL ONLY child results. Do not repeat completed delegations.\nOriginal request: ${root(db,a.rootId).source.text}\n${unread.map(c=>`${c.role} (${c.id}): ${work(db,c.id)!.result}`).join('\n')}`;
   if(w.message.length>20000){a.state='waiting_for_human';w.phase='held';w.reason='child_results_exceed_context';}
   else {a.requestId=randomUUID();a.state='queued';w.phase='queued';w.result=null;w.reason=null;for(const c of unread){const child=work(db,c.id)!;child.consumed=true;saveWork(db,child);}}
  }
  saveAssignment(db,a);saveWork(db,w);
 });
}
export async function publishTeamResult(assignmentId:string):Promise<void> {
 const db=await assignmentDatabase(),a=await getTeamAssignment(assignmentId);if(!a||a.destination.kind!=='group')return;
 const w=work(db,a.id);if(!w||w.phase!=='done'||a.state!=='completed')return;
 if(assignments(db,a.teamId).some(c=>c.parentId===a.id&&(!work(db,c.id)?.consumed||work(db,c.id)?.phase!=='done')))return;
 try{await requireTeamExecution(a.teamId,a.requestedBy);}catch{w.reason='membership_removed_before_publication';saveWork(db,w);return;}
 const r=root(db,a.rootId);if(r.browser)return;
 if(!await acknowledgmentConfirmed(a.teamId,a.rootId))return;
 transaction(db,()=>output(db,r,`${a.id}:result`,'result',`${a.role}: ${w.result||'(No text result)'}`,a.id,a.role));
 await deliverTeamOutbox(a.teamId);
}
/** Reconcile confirmed runtime receipts, never redispatch an unknown external effect. */
export async function recoverTeamWork(teamId:string):Promise<void> {
 try{await recoverTeamWorkOnce(teamId);}
 catch(error){
  const db=await assignmentDatabase();
  db.prepare('INSERT INTO assistant_team_failures VALUES(?,?,?,?)').run(randomUUID(),teamId,'recovery_failed',new Date().toISOString());
  scheduleTeamChange(teamId);throw error;
 }
}
async function recoverTeamWorkOnce(teamId:string):Promise<void> {
 const db=await assignmentDatabase();
 await processInbox(teamId);
 await deliverTeamOutbox(teamId);
 for(let a of assignments(db,teamId)) {
  if(executing.has(a.id))continue;const w=work(db,a.id);if(!w)continue;
  if(w.phase==='queued') {
   try{await requireTeamExecution(teamId,a.requestedBy);}catch{a.state='cancelled';w.phase='held';w.reason='membership_removed_before_dispatch';transaction(db,()=>{saveAssignment(db,a);saveWork(db,w);});continue;}
  }
  if(w.phase==='dispatched'||(w.phase==='held'&&w.reason==='dispatch_outcome_unknown')) {
   const agent=(await listTeamAgents(teamId)).find(t=>t.role===a.role),owner=agent&&await getPersonalAssistantById(agent.assistantId),receipt=owner&&await getPersonalAssistantTurn(owner.accountId,owner.id,a.requestId);
   if(receipt?.status==='completed')await complete(a,receipt.response??'',receipt.topicId.slice(receipt.topicId.indexOf(':')+1));
   else{a.state='uncertain';w.phase='held';w.reason='dispatch_outcome_unknown';transaction(db,()=>{saveAssignment(db,a);saveWork(db,w);reportStopped(db,a);});await deliverTeamOutbox(teamId);continue;}
  }
  a=(await getTeamAssignment(a.id))!;if(a.role===teamRolesSync(db,teamId).coordinator)await advanceParent(a);
  a=(await getTeamAssignment(a.id))!;
  if(a.state==='queued'&&a.subjectId&&work(db,a.id)?.phase==='queued') {
   // Do not wait here: Bob may be running while his child is queued. Completion wakes the durable ledger.
   void dispatch(a).catch(()=>{}).finally(()=>{if(work(db,a.id)?.phase==='done')wakeTeamWork(teamId);});
  }else await publishTeamResult(a.id);
 }
}
const outageNoticeAt=new Map<string,number>();
/** Unaddressed messages are read only through the decision model, so while it is down the group hears about it once an hour instead of silence. */
function noteDecisionUnavailable(db:DatabaseSync,message:TeamMessage):void {
 if(Date.now()-(outageNoticeAt.get(message.teamId)??0)<3_600_000)return;
 outageNoticeAt.set(message.teamId,Date.now());
 const roles=teamRolesSync(db,message.teamId).roles,r:Root={id:rootKey(message),teamId:message.teamId,source:message,browser:false,subjectId:null};
 output(db,r,`${r.id}:decision-down`,'clarify',say(db,message.teamId,`I cannot read the group right now because the decision model is unavailable, so messages not addressed to a role are not being picked up.${roles.length?` Calls such as /${roles[0]} … still work.`:''}`));
}
async function processInbox(teamId:string) {
 const db=await assignmentDatabase();
 for(const event of await listPendingTeamEvents(teamId,1000)) {
  const claim=db.prepare('SELECT state FROM assistant_team_inbox_claims WHERE event_id=?').get(event.id);
  if(claim&&claim.state!=='claimed'){db.prepare("UPDATE assistant_team_inbox SET state='decided' WHERE id=?").run(event.id);continue;}
  let message=await getTeamMessage(teamId,event.messageId);if(!message)continue;
  if(message.albumId&&(albumReadyAt.get(rootKey(message))??0)>Date.now())continue;
  let components=[message];
  if(message.albumId){
   components=db.prepare('SELECT record FROM assistant_team_messages WHERE team_id=? AND chat_id=? AND thread_id IS ?').all(teamId,message.chatId,message.threadId).map(r=>JSON.parse(r.record as string) as StoredTeamMessage).filter(m=>m.albumId===message!.albumId&&!m.output);
   message=components.find(m=>m.text.trim())??message;
  }
  const albumClaim=message.albumId?`album:${rootKey(message)}`:null;
  if(!claim&&albumClaim&&db.prepare('SELECT 1 FROM assistant_team_inbox_claims WHERE event_id=?').get(albumClaim)){db.prepare("UPDATE assistant_team_inbox SET state='decided' WHERE id=?").run(event.id);continue;}
  // An interrupted decision is held. Album claim and event claim commit together.
  transaction(db,()=>{db.prepare("INSERT OR IGNORE INTO assistant_team_inbox_claims VALUES(?,?,'claimed')").run(event.id,teamId);if(albumClaim)db.prepare("INSERT OR IGNORE INTO assistant_team_inbox_claims VALUES(?,?,'claimed')").run(albumClaim,teamId);});
  try {
   const member=await authorizeTeamTelegram(teamId,message.chatId,message.telegramUserId);
   if(await consumeTeamConfirmation(message))continue;
   if(/^(yes|no|confirm|dismiss)[.!]?$/i.test(message.text.trim())){
    const r:Root={id:rootKey(message),teamId,source:message,browser:false,subjectId:null};
    output(db,r,`${r.id}:clarify`,'clarify',say(db,teamId,'please reply to the exact inquiry question or use its Confirm / Dismiss buttons.'));continue;
   }
   const targets=await directTeamTargets(message);
   const emptyCall=/^(?:\s*[/@][\w]+(?:@[\w]+)?\s*)+$/.test(message.text);
   const { teamTelegramConnection }=await import('./telegram-store.js');
   const bot=(await teamTelegramConnection(teamId))?.bot_username.toLowerCase();
   const command=teamCommandOf(message.text,bot);
   if(command){await runTeamCommand(db,member,message,command);continue;}
   const leading=message.text.match(/^\s*(?:[/@]\S+(?:\s+|$))+/)?.[0].trim().split(/\s+/)??[];
   const unknownCall=(/^\s*[/@]/.test(message.text)&&!targets.length)||leading.some(token=>{const [alias,suffix]=token.slice(1).toLowerCase().split('@');return ![...teamRolesSync(db,teamId).roles,bot].includes(alias)||(suffix!==undefined&&suffix!==bot);});
   if(emptyCall||unknownCall){const r:Root={id:rootKey(message),teamId,source:message,browser:false,subjectId:null};output(db,r,`${r.id}:clarify`,'clarify',say(db,teamId,`name a team role (${teamRolesSync(db,teamId).roles.map(role=>'/'+role).join(', ')}) and describe the work to do.`));continue;}
   // Album components share this key. A late component is context only, not another dispatch.
   if(!claim&&db.prepare('SELECT 1 FROM assistant_team_roots WHERE id=?').get(rootKey(message)))continue;
   let accepted=targets.length&&!(await openTeamRequests(message)).length?await acceptTeamAssignment(member,message,targets,null):[];
   const { prepareTeamMessageMedia }=await import('./telegram-media.js');
   const media:StoredTeamMessage[]=[];
   for(const component of components){await authorizeTeamTelegram(teamId,component.chatId,component.telegramUserId);media.push(await prepareTeamMessageMedia(component));}
   const enriched=mediaText(media);
   for(const a of accepted){const w=work(db,a.id)!;w.message=enriched;saveWork(db,w);}
   await deliverTeamOutbox(teamId); // Durable accept -> single acknowledgment -> classifier.
   const previous=claim?(await listTeamDecisions(teamId,1000)).find(d=>d.messageId===message!.id):undefined;
   const decision=previous?previous.result:await decideTeamMessage(await getTeam(teamId),message);
   if(!decision){
    // A call that names its member needs no decision to start: it runs as a new request. Only unaddressed messages wait on the model.
    if(targets.length){
     if(!accepted.length){accepted=await acceptTeamAssignment(member,message,targets,null);await deliverTeamOutbox(teamId);}
     for(const a of accepted){const w=work(db,a.id)!;w.message=enriched;saveWork(db,w);await routeTeamAssignment(a.id,{kind:'new'});}
     continue;
    }
    noteDecisionUnavailable(db,message);await deliverTeamOutbox(teamId);continue;
   }
   if(decision.learn)await (await import('./memory.js')).learnTeamMessage(teamId,message.id);
   if(decision.requestId && await attachTeamRequestEvidence(member,message,decision.requestId))continue;
   if(decision.attention==='ask'){await createTeamInquiry(member,message,decision.targets,decision.route);continue;}
   if(decision.attention==='silent'){
    if(decision.route.kind!=='clarify'){
     const subjectId=decision.route.kind==='continue'?decision.route.subjectId:randomUUID();
     if(decision.route.kind==='new')await saveTeamSubject({id:subjectId,teamId,title:message.text.slice(0,160),summary:''},message.chatId,message.threadId);
     await bindTeamMessageSubject(teamId,message.id,subjectId);
    }
    continue;
   }
   if(!accepted.length)accepted=await acceptTeamAssignment(member,message,decision.targets,null);
   for(const a of accepted){const w=work(db,a.id)!;w.message=enriched;saveWork(db,w);await routeTeamAssignment(a.id,decision.route);}
  }catch{transaction(db,()=>{
   db.prepare("UPDATE assistant_team_inbox_claims SET state='held' WHERE event_id=?").run(event.id);
   db.prepare("UPDATE assistant_team_inbox SET error='team_processing_refused' WHERE id=?").run(event.id);
   for(const a of assignments(db,teamId).filter(a=>a.rootId===rootKey(message!)&&a.state==='accepted')){a.state='waiting_for_human';const w=work(db,a.id)!;w.reason='routing_or_access_refused';saveAssignment(db,a);saveWork(db,w);}
  });}
  finally{transaction(db,()=>{db.prepare("UPDATE assistant_team_inbox SET state='decided' WHERE id=?").run(event.id);db.prepare("UPDATE assistant_team_inbox_claims SET state='decided' WHERE event_id=? AND state='claimed'").run(event.id);});}
 }
}
const wakes=new Map<string,Promise<void>>();const dirty=new Set<string>();let started=false;
const albumReadyAt=new Map<string,number>();
const albumTimers=new Map<string,NodeJS.Timeout>();
export function wakeTeamWork(teamId:string):void {
 if(!started)return;dirty.add(teamId);if(wakes.has(teamId))return;
 const pending=(async()=>{while(dirty.delete(teamId))await recoverTeamWork(teamId);})();wakes.set(teamId,pending);
 void pending.catch(()=>{}).finally(()=>{wakes.delete(teamId);if(dirty.has(teamId))wakeTeamWork(teamId);});
}
/** Real startup plus inbox/receipt events; no periodic polling or retry of unknown work. */
export async function startTeamWork():Promise<void> {
 if(started)return;
 await (await import('./memory.js')).replayTeamMemory();
 started=true;
 onTeamInbox(event=>{void getTeamMessage(event.teamId,event.messageId).then(message=>{
  if(!message?.albumId){wakeTeamWork(event.teamId);return;}
  const id=rootKey(message);clearTimeout(albumTimers.get(id));albumReadyAt.set(id,Date.now()+750);
  albumTimers.set(id,setTimeout(()=>{albumTimers.delete(id);albumReadyAt.delete(id);wakeTeamWork(event.teamId);},750).unref());
 });});
 const db=await assignmentDatabase();
 // Guardian's live operation died with the process. No approval is replayed into a new operation.
 db.prepare("UPDATE assistant_team_approvals SET state='blocked_restart' WHERE state='pending'").run();
 for(const row of db.prepare('SELECT id FROM assistant_teams').all())wakeTeamWork(row.id as string);
}
/** Runtime receipt callback is a wake hint only; the persisted turn is authoritative after a restart. */
export async function teamTurnReceipt(assistantId:string):Promise<void> {
 const db=await assignmentDatabase(),row=db.prepare('SELECT team_id FROM assistant_team_agents WHERE assistant_id=?').get(assistantId);if(row)wakeTeamWork(row.team_id as string);
}

export async function bindTeamGuardianReview(projectId:string,conversationId:string,operationKey:string) {
 const { teamConversation, validateTeamAssignment }=await import('./runtime.js');
 const context=await teamConversation(projectId,conversationId),requestId=runningPromptRequestId(projectId,conversationId);
 if(!context||!requestId)throw new TeamError('Live team review required',403);
 const db=await assignmentDatabase(),a=assignments(db,context.teamId).find(a=>a.requestId===requestId);
 if(!a)throw new TeamError('Review assignment missing',403);
 const validated=await validateTeamAssignment(a),receipt=await getPersonalAssistantTurn(validated.profile.accountId,validated.profile.id,requestId);
 if(!receipt||receipt.status!=='running'||receipt.topicId!==`pi:${conversationId}`)throw new TeamError('Review does not match running operation conversation',403);
 return {teamId:a.teamId,assignmentId:a.id,requestId,requestedBy:a.requestedBy,operationKey};
}
export async function resolveTeamApproval(member:TeamMember,assignmentId:string,reviewId:string,allow:boolean):Promise<void> {
 if(typeof allow!=='boolean')throw new TeamError('Explicit human decision required',400);
 const { decideTeamGuardianReview }=await import('../guardian/reviews.js');
 if(!await decideTeamGuardianReview(member,assignmentId,reviewId,allow?'allow':'block'))throw new TeamError('Review is not open for this assignment or was already answered',409);
}

/** Browser entry points use the same ledger and dispatcher, but never manufacture Telegram destinations. */
export async function runBrowserTeamAssignment(member:TeamMember,role:TeamRole,subjectId:string,requestId:string,message:string):Promise<{text:string;conversationId:string}> {
 await recheckTeamActor(member);await requireTeamExecution(member.teamId,member.accountId);
 if(!message.trim()||message.length>20000)throw new TeamError('Invalid team message',400);
 const db=await assignmentDatabase(),id=key(member.teamId,'browser',requestId);
 if(!teamRolesSync(db,member.teamId).roles.includes(role))throw new TeamError('Unknown team role',404);
 const existing=assignments(db,member.teamId).find(a=>a.requestId===requestId||a.rootId===id);
 if(existing){const r=root(db,existing.rootId);if(existing.requestedBy!==member.accountId||existing.role!==role||r.source.text!==message||existing.subjectId!==subjectId)throw new TeamError('Request ID belongs to another assignment',409);}
 const a=existing??transaction(db,()=>{
  const source:TeamMessage={id:requestId,teamId:member.teamId,accountId:member.accountId,chatId:'browser',telegramMessageId:0,threadId:null,replyToMessageId:null,text:message,revision:1,createdAt:new Date().toISOString()};
  db.prepare('INSERT OR IGNORE INTO assistant_team_subjects VALUES(?,?,?,?,?)').run(subjectId,member.teamId,'browser',null,JSON.stringify({id:subjectId,teamId:member.teamId,title:message.slice(0,160),summary:''}));
  const accepted=accept(db,{id,teamId:member.teamId,source,browser:true,subjectId},[role],member.accountId)[0];accepted.requestId=requestId;saveAssignment(db,accepted);return accepted;
 });
 await dispatch(a);
 const w=work(db,a.id)!;
 if(assignments(db,a.teamId).some(c=>c.parentId===a.id&&!work(db,c.id)?.consumed)){wakeTeamWork(a.teamId);throw new TeamError('Delegated work outstanding; root answer is not ready',409);}
 if(w.phase!=='done')throw new TeamError(w.reason??'Team work is still pending',409);
 return {text:w.result??'',conversationId:w.conversationId!};
}

/* ---- Steering the team: status, cancel and retry. Telegram's /status /cancel /retry and the app's Bob share these. ---- */
export type TeamRequestState='running'|'queued'|'needs_you'|'stopped'|'done'|'cancelled';
/** What a person sees of one request: its members' parts, including anything delegated. */
export interface TeamRequestView { id:string; shortId:string; text:string; requestedBy:string; chatId:string; createdAt:string; browser:boolean; state:TeamRequestState; assignments:{ role:TeamRole; state:AssignmentState; delegated:boolean; reason:string|null; conversationId:string|null; result:string|null }[] }
function requestStateOf(states:AssignmentState[]):TeamRequestState {
 if(states.includes('running'))return 'running';
 if(states.some(state=>state==='queued'||state==='accepted'))return 'queued';
 if(states.includes('waiting_for_human'))return 'needs_you';
 if(states.some(state=>state==='uncertain'||state==='failed'))return 'stopped';
 return states.every(state=>state==='cancelled')?'cancelled':'done';
}
/** Newest first. */
function requestViews(db:DatabaseSync,teamId:string):TeamRequestView[] {
 const all=assignments(db,teamId);
 return db.prepare('SELECT record FROM assistant_team_roots WHERE team_id=? ORDER BY rowid DESC').all(teamId).map(row=>JSON.parse(row.record as string) as Root).flatMap(r=>{
  const mine=all.filter(a=>a.rootId===r.id);
  if(!mine.length)return [];
  return [{id:r.id,shortId:r.id.slice(0,6),text:r.source.text,requestedBy:r.source.accountId,chatId:r.source.chatId,createdAt:r.source.createdAt,browser:r.browser,state:requestStateOf(mine.map(a=>a.state)),
   assignments:mine.map(a=>{const w=work(db,a.id);return {role:a.role,state:a.state,delegated:Boolean(a.parentId),reason:w?.reason??null,conversationId:w?.conversationId??null,
    // What a member answered is read; delegated parts stay internal to the coordinator, who writes the answer.
    result:!a.parentId&&w?.phase==='done'?(w.result??'').slice(0,6000):null};})}];
 });
}
export async function listTeamRequests(member:TeamMember,limit=50):Promise<TeamRequestView[]> {
 await recheckTeamActor(member);if((await getTeam(member.teamId)).clusterId!==member.clusterId)throw new TeamError('Wrong team',403);
 return requestViews(await assignmentDatabase(),member.teamId).slice(0,limit);
}
/** A role picks that member's newest fitting request, a hex prefix picks one request, nothing picks the newest from this chat. */
function pickRequest(db:DatabaseSync,teamId:string,views:TeamRequestView[],ref:string|null,states:TeamRequestState[],chatId?:string):TeamRequestView {
 let candidates=views.filter(view=>states.includes(view.state));
 if(ref&&teamRolesSync(db,teamId).roles.includes(ref))candidates=candidates.filter(view=>view.assignments.some(a=>a.role===ref));
 else if(ref){
  const named=/^[0-9a-f]{4,64}$/.test(ref)?views.find(view=>view.id.startsWith(ref)):undefined;
  if(!named)throw new TeamError(`No request or role is called ${ref}`,404);
  if(!states.includes(named.state))throw new TeamError(`${named.shortId} is ${teamRequestStateLabel(named.state)}, so there is nothing to do with it`,409);
  return named;
 }
 else if(chatId)candidates=candidates.filter(view=>view.chatId===chatId);
 if(!candidates.length)throw new TeamError('Nothing here applies: no request is in a state this works on',404);
 return candidates[0];
}
/** Stops a request: its waiting and uncertain work is cancelled for good, and a running turn is told to stop. */
export async function cancelTeamRequest(member:TeamMember,ref:string|null,chatId?:string):Promise<{request:TeamRequestView;stopFailures:number}> {
 await recheckTeamActor(member);await requireTeamExecution(member.teamId,member.accountId);
 const db=await assignmentDatabase(),request=pickRequest(db,member.teamId,requestViews(db,member.teamId),ref,['running','queued','needs_you','stopped'],chatId);
 // Where a running turn is must be read while it is still a live assignment: a cancelled one no longer resolves.
 const running:{role:TeamRole;turn:{projectId:string;engine:string;sessionId:string}|null}[]=[];
 for(const a of assignments(db,member.teamId).filter(a=>a.rootId===request.id&&a.state==='running')){
  try{const {team,destination}=await teamAssignmentDestination(a);running.push({role:a.role,turn:{projectId:team.projectId,engine:destination.engine,sessionId:destination.sessionId}});}
  catch{running.push({role:a.role,turn:null});}
 }
 transaction(db,()=>{
  for(const a of assignments(db,member.teamId).filter(a=>a.rootId===request.id&&!['completed','cancelled'].includes(a.state))){
   a.state='cancelled';saveAssignment(db,a);
   const w=work(db,a.id);if(w&&w.phase!=='done'){w.phase='held';w.reason='cancelled_by_human';saveWork(db,w);}
  }
 });
 let stopFailures=0;
 for(const {role,turn} of running){
  try{
   if(!turn)throw new Error('its conversation could not be found');
   const {stopConversationTurn}=await import('../server/conversation-prompt.js');
   await stopConversationTurn({...turn,label:'Team cancel'});
  }catch(error){stopFailures++;console.warn(`Could not stop the running turn of ${role}: ${error instanceof Error?error.message:error}`);}
 }
 wakeTeamWork(member.teamId);
 return {request:requestViews(db,member.teamId).find(view=>view.id===request.id)!,stopFailures};
}
/** Runs a stopped request again as a NEW request: an unknown outcome is never replayed under its old identity. */
export async function retryTeamRequest(member:TeamMember,ref:string|null,chatId?:string):Promise<{previous:TeamRequestView;request:TeamRequestView}> {
 await recheckTeamActor(member);await requireTeamExecution(member.teamId,member.accountId);
 const db=await assignmentDatabase(),previous=pickRequest(db,member.teamId,requestViews(db,member.teamId),ref,['stopped','needs_you','cancelled'],chatId);
 const old=root(db,previous.id),stored=old.browser?null:await getTeamMessage(member.teamId,old.source.id);
 const material=stored?mediaText([await (await import('./telegram-media.js')).prepareTeamMessageMedia(stored)]):old.source.text;
 const roles=[...new Set(assignments(db,member.teamId).filter(a=>a.rootId===old.id&&!a.parentId).map(a=>a.role))].filter(role=>teamRolesSync(db,member.teamId).roles.includes(role));
 if(!roles.length)throw new TeamError('None of the members that request was for is in the team any more',409);
 const fresh:Root={...old,id:key(old.id,'retry',randomUUID())};
 const created=transaction(db,()=>{
  for(const a of assignments(db,member.teamId).filter(a=>a.rootId===old.id&&!['completed','cancelled'].includes(a.state))){
   a.state='cancelled';saveAssignment(db,a);const w=work(db,a.id);if(w&&w.phase!=='done'){w.phase='held';w.reason='cancelled_by_human';saveWork(db,w);}
  }
  const result=accept(db,fresh,roles,member.accountId);
  for(const a of result){const w=work(db,a.id)!;w.message=material;saveWork(db,w);}
  return result;
 });
 for(const a of created)await routeTeamAssignment(a.id,fresh.subjectId?{kind:'continue',subjectId:fresh.subjectId}:{kind:'new'});
 wakeTeamWork(member.teamId);
 const views=requestViews(db,member.teamId);
 return {previous:views.find(view=>view.id===old.id)!,request:views.find(view=>view.id===fresh.id)!};
}
/** `/status@TheBot qa` and the like; a command for another bot, or an unknown word, is not ours. */
function teamCommandOf(text:string,bot:string|undefined):{name:TeamCommand;argument:string}|null {
 const match=/^\s*\/([a-z]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/i.exec(text);
 const name=match?.[1].toLowerCase() as TeamCommand|undefined;
 if(!match||!name||!(TEAM_COMMANDS as readonly string[]).includes(name))return null;
 if(match[2]&&match[2].toLowerCase()!==bot)return null;
 return {name,argument:(match[3]??'').trim().split(/\s+/)[0]??''};
}
async function runTeamCommand(db:DatabaseSync,member:TeamMember,message:StoredTeamMessage,command:{name:TeamCommand;argument:string}):Promise<void> {
 const r:Root={id:rootKey(message),teamId:message.teamId,source:message,browser:false,subjectId:null};
 const reply=(text:string)=>output(db,r,`${r.id}:command`,'clarify',say(db,message.teamId,text));
 const ref=command.argument||null,everything:TeamRequestState[]=['running','queued','needs_you','stopped','done','cancelled'];
 try {
  if(command.name==='help'||command.name==='team'){const {roles,coordinator}=teamRolesSync(db,message.teamId);reply(teamHelp(roles,coordinator));}
  else if(command.name==='status'){
   const views=requestViews(db,message.teamId),isRole=Boolean(ref&&teamRolesSync(db,message.teamId).roles.includes(ref));
   reply(ref&&!isRole?formatTeamRequest(pickRequest(db,message.teamId,views,ref,everything)):formatTeamStatus(isRole?views.filter(view=>view.assignments.some(a=>a.role===ref)):views,isRole?ref:null));
  }
  else if(command.name==='cancel'){const {request,stopFailures}=await cancelTeamRequest(member,ref,message.chatId);reply(`cancelled ${request.shortId} (${[...new Set(request.assignments.map(a=>a.role))].join(', ')}).${stopFailures?' A running turn could not be stopped; it may still finish, but its result will be dropped.':''}`);}
  else{const {previous,request}=await retryTeamRequest(member,ref,message.chatId);reply(`running ${previous.shortId} again as ${request.shortId}.`);}
 }catch(error){reply(error instanceof TeamError?error.message:'That did not work; try again in a moment.');}
 await deliverTeamOutbox(message.teamId);
}

/** Work for someone who is not in the Telegram group (the app, a member's Bob): the same ledger and dispatcher, no group messages. Returns at once; progress is read with listTeamRequests. */
export async function startTeamRequest(member:TeamMember,role:TeamRole|null,message:string,requestId:string):Promise<TeamRequestView> {
 await recheckTeamActor(member);await requireTeamExecution(member.teamId,member.accountId);
 if(!message.trim()||message.length>20000)throw new TeamError('Invalid team message',400);
 const db=await assignmentDatabase(),{roles,coordinator}=teamRolesSync(db,member.teamId),target=role??coordinator;
 if(!target||!roles.includes(target))throw new TeamError(role?'Unknown team role':'This team has no members yet',role?404:409);
 const id=key(member.teamId,'browser',requestId);
 const existing=assignments(db,member.teamId).find(a=>a.rootId===id);
 if(existing){const r=root(db,id);if(existing.requestedBy!==member.accountId||existing.role!==target||r.source.text!==message)throw new TeamError('Request ID belongs to another assignment',409);}
 else transaction(db,()=>{
  const subjectId=randomUUID(),source:TeamMessage={id:requestId,teamId:member.teamId,accountId:member.accountId,chatId:'browser',telegramMessageId:0,threadId:null,replyToMessageId:null,text:message,revision:1,createdAt:new Date().toISOString()};
  db.prepare('INSERT OR IGNORE INTO assistant_team_subjects VALUES(?,?,?,?,?)').run(subjectId,member.teamId,'browser',null,JSON.stringify({id:subjectId,teamId:member.teamId,title:message.slice(0,160),summary:''}));
  const accepted=accept(db,{id,teamId:member.teamId,source,browser:true,subjectId},[target],member.accountId)[0];accepted.requestId=requestId;saveAssignment(db,accepted);
 });
 wakeTeamWork(member.teamId);
 return requestViews(db,member.teamId).find(view=>view.id===id)!;
}
