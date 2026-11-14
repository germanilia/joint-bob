import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createLocalUser } from '../src/auth.js';
import { fixture } from './assistant-team-fixture.js';
import { addClusterLocalMember, removeClusterLocalMember } from '../src/cluster-accounts.js';
import { getTeamAssignment } from '../src/assistant-teams/store.js';
import { acceptTeamAssignment, routeTeamAssignment, recoverTeamWork, publishTeamResult, createTeamInquiry, confirmTeamInquiry, consumeTeamConfirmation, delegateTeamAssignment, assignmentDatabase, readTeamWork } from '../src/assistant-teams/assignments.js';
import { deliverTeamOutbox, listTeamOutbox } from '../src/assistant-teams/delivery.js';
import { teamAssignmentDestination } from '../src/assistant-teams/runtime.js';
import { beginPersonalAssistantTurn, finishPersonalAssistantTurn } from '../src/personal-assistants.js';
import { listTeamTools, callTeamTool } from '../src/assistant-teams/tools.js';
import { promptStarted, promptEnded } from '../src/assistant-collaboration/bridge-tools.js';
import { saveSecretAccount } from '../src/secrets.js';
import { systemAiDefaults } from '../src/system-ai-config.js';
import { save, settingsDatabase } from '../src/settings-store.js';

test('durable acceptance, one acknowledgment, scoped final receipts and unknown delivery holds',async()=>{
 const f=await fixture(); const original=globalThis.fetch; const sends:any[]=[]; let fail=false;
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body)); sends.push(body); if(fail)throw new Error('timeout after send'); return Response.json({ok:true,result:{message_id:1000+sends.length}});};
 try {
 const source=await f.message('/qa /product inspect',{message_thread_id:23});
 const assignments=await acceptTeamAssignment(f.member,source,['qa','product'],null);
 assert.equal(assignments.length,2); assert.equal(sends.length,0,'accept commits before any send');
 assert.deepEqual(await acceptTeamAssignment(f.member,source,['qa','product'],null),assignments);
 await deliverTeamOutbox(f.team.id); assert.equal(sends.length,1); assert.match(sends[0].text,/Bob.*accepted.*queued/is);
 for(const assignment of assignments) await routeTeamAssignment(assignment.id,{kind:'new'});
 assert.equal((await getTeamAssignment(assignments[0].id))!.subjectId,(await getTeamAssignment(assignments[1].id))!.subjectId);
 // Simulate crash after the runtime persisted its confirmed receipt, before the assignment callback.
 for(const originalAssignment of assignments){
 const a=(await getTeamAssignment(originalAssignment.id))!;
 const resolved=await teamAssignmentDestination(a);
 await beginPersonalAssistantTurn(f.team.executorAccountId,resolved.profile.id,a.requestId,`pi:${resolved.destination.sessionId}`,'fixture','assistant');
 await finishPersonalAssistantTurn(f.team.executorAccountId,resolved.profile.id,a.requestId,`${a.role} result`);
 f.db.prepare('UPDATE assistant_team_work SET phase=? WHERE assignment_id=?').run('dispatched',a.id);
 }
 await f.message('yes',{message_thread_id:99});
 await recoverTeamWork(f.team.id);
 assert.equal(sends.length,4);
 const originalReplies=sends.filter(send=>send.message_thread_id===23);
 assert.equal(originalReplies.length,3);assert.match(originalReplies[1].text,/qa/i);assert.match(originalReplies[2].text,/product/i);
 const clarification=sends.find(send=>send.message_thread_id===99);assert.match(clarification.text,/reply.*question/i);
 for(const send of originalReplies){assert.equal(send.chat_id,'-1');assert.equal(send.reply_parameters.message_id,source.telegramMessageId);}
 await recoverTeamWork(f.team.id);assert.equal(sends.length,4);
 assert.ok((await listTeamOutbox(f.team.id)).every(row=>row.state==='sent'&&row.receiptId!>0));
 const [finalInitial]=await acceptTeamAssignment(f.member,await f.message('/qa final timeout'),['qa'],null);
 await deliverTeamOutbox(f.team.id);await routeTeamAssignment(finalInitial.id,{kind:'new'});
 const finalAssignment=(await getTeamAssignment(finalInitial.id))!,finalDestination=await teamAssignmentDestination(finalAssignment);
 await beginPersonalAssistantTurn(f.team.executorAccountId,finalDestination.profile.id,finalAssignment.requestId,`pi:${finalDestination.destination.sessionId}`,'fixture final','assistant');
 const finalText='final stored result '.repeat(400);
 await finishPersonalAssistantTurn(f.team.executorAccountId,finalDestination.profile.id,finalAssignment.requestId,finalText);
 f.db.prepare('UPDATE assistant_team_work SET phase=? WHERE assignment_id=?').run('dispatched',finalAssignment.id);
 fail=true;await recoverTeamWork(f.team.id);fail=false;
 const failedFinal=(await listTeamOutbox(f.team.id)).find(row=>row.assignmentId===finalAssignment.id&&row.kind==='result')!;
 assert.equal(failedFinal.state,'uncertain');assert.equal(sends.length,6);
 await recoverTeamWork(f.team.id);assert.equal(sends.length,6,'unknown final is not resent or rerun');
 assert.equal((await readTeamWork(f.team.id)).find(w=>w.assignmentId===finalAssignment.id)!.result,finalText);
 const uncertain=await acceptTeamAssignment(f.member,await f.message('/qa timeout'),['qa'],null);fail=true;
 await deliverTeamOutbox(f.team.id); assert.equal((await listTeamOutbox(f.team.id)).at(-1)!.state,'uncertain');
 fail=false;await recoverTeamWork(f.team.id);assert.equal(sends.length,7,'uncertain acknowledgment never resent');
 await publishTeamResult(uncertain[0].id);assert.equal(sends.length,7);
 }finally{globalThis.fetch=original;}
});

test('exact inquiry reply and current membership; delegated receipts are internal and durable',async()=>{
 const f=await fixture();const original=globalThis.fetch;let sends=0;
 globalThis.fetch=async()=>Response.json({ok:true,result:{message_id:2000+ ++sends}});
 try{
 const source=await f.message('Could investigate');const inquiry=await createTeamInquiry(f.member,source,['bob'],{kind:'new'});
 await deliverTeamOutbox(f.team.id);assert.equal(sends,1);
 const unrelated=await f.message('yes');
 assert.equal(await consumeTeamConfirmation(unrelated),false);
 assert.equal(await consumeTeamConfirmation({...unrelated,replyToMessageId:2001}),false,'caller-shaped reply metadata cannot approve a question');
 assert.equal((await readTeamWork(f.team.id)).length,0);
 assert.equal(await consumeTeamConfirmation(await f.message('yes',{reply_to_message:{message_id:2001}})),true);
 await confirmTeamInquiry(f.member,inquiry.id,'confirm');const work=await readTeamWork(f.team.id);assert.equal(work.length,1);
 const parent=(await getTeamAssignment(work[0].assignmentId))!;
 // A server-issued running turn, not an arbitrary persisted assignment, grants delegation.
 const resolved=await teamAssignmentDestination(parent);
 await beginPersonalAssistantTurn(f.team.executorAccountId,resolved.profile.id,parent.requestId,`pi:${resolved.destination.sessionId}`,'fixture','assistant');
 promptStarted(f.team.projectId,resolved.destination.sessionId,parent.requestId);
 const identity={account:{accountId:f.member.accountId,username:f.member.username,role:null,homeNodeId:f.member.homeNodeId,isRemoteLogin:false},projectId:f.team.projectId,conversationId:resolved.destination.sessionId,engine:'pi' as const};
 assert.deepEqual((await listTeamTools(identity)).map(t=>t.name),['team_list_agents','team_delegate','team_read_assignment','team_memory_read','team_memory_list','team_memory_write']);
 const child=await delegateTeamAssignment(parent.id,'qa','Check it');
 assert.deepEqual(await delegateTeamAssignment(parent.id,'qa','Check it'),child);
 assert.equal(child.destination.kind,'bob');assert.match((await readTeamWork(f.team.id)).find(w=>w.assignmentId===child.id)!.message,/INTERNAL ONLY/);
 await assert.rejects(delegateTeamAssignment(child.id,'support','loop'),/Bob|live/i);
 for(let i=1;i<10;i++)await delegateTeamAssignment(parent.id,'qa',`Explicit continuation ${i}`);
 await assert.rejects(delegateTeamAssignment(parent.id,'qa','eleventh'),/Ten delegated/);
 assert.equal((await readTeamWork(f.team.id)).length,11);
 promptEnded(f.team.projectId,resolved.destination.sessionId,parent.requestId);
 assert.deepEqual(await listTeamTools(identity),[],'a stale running receipt alone never grants live tools');
 assert.equal((await callTeamTool(identity,'team_delegate',{role:'qa',message:'nonlive'})).isError,true);
 await assert.rejects(delegateTeamAssignment(parent.id,'qa','after turn'),/live/i);
 await publishTeamResult(child.id);assert.equal(sends,1,'child cannot send');
 const next=await createTeamInquiry(f.member,await f.message('second inquiry'),['bob'],{kind:'new'});
 const other=createLocalUser({username:'remainingmember',email:'remaining@example.test'}).user;
 addClusterLocalMember(f.db,f.team.clusterId,other.accountId);
 removeClusterLocalMember(f.db,f.team.clusterId,f.member.accountId);
 await assert.rejects(confirmTeamInquiry(f.member,next.id,'confirm'),/member/i);
 assert.equal((await assignmentDatabase()).prepare('SELECT state FROM assistant_team_inquiries WHERE id=?').get(next.id)!.state,'pending');
 addClusterLocalMember(f.db,f.team.clusterId,f.member.accountId);
 }finally{globalThis.fetch=original;}
});

test('real classifier ordering and 90-percent inquiry dispatch nothing until its exact confirmation',async()=>{
 const f=await fixture(),original=globalThis.fetch;
 const secret=await saveSecretAccount({label:'synthetic central',provider:'typesafe',variables:[{name:'TYPESAFE_AI_API_KEY',kind:'value',value:'synthetic-key'}]});
 const config=systemAiDefaults();config.decision.typesafeAccountId=secret.id;save(settingsDatabase(),'systemAI',JSON.stringify(config));
 const order:string[]=[];let receipt=4000;let expectDirect=false;
 globalThis.fetch=async(input,init)=>{
  const body=JSON.parse(String(init?.body));
  if(String(input).includes('/sendMessage')){order.push(body.text);return Response.json({ok:true,result:{message_id:++receipt}});}
  order.push('classifier');
  if(expectDirect){assert.ok((await readTeamWork(f.team.id)).length>=1);assert.match(order.at(-2)!,/Bob: accepted; queued/);assert.equal(body.questions.attention,undefined);}
  return Response.json({answers:Object.fromEntries(Object.keys(body.questions).map(name=>[name,{type:'choice',choice:name==='attention'?'act':name==='subject'?'new':'none',confidence:name==='attention'?.90:1}]))});
 };
 try{
  await f.message('Investigate the failing case');await recoverTeamWork(f.team.id);assert.equal((await readTeamWork(f.team.id)).length,0);
  const question=(await listTeamOutbox(f.team.id)).find(row=>row.kind==='inquiry')!;assert.equal(question.receiptId,4001);
  await f.message('yes');await recoverTeamWork(f.team.id);assert.equal((await readTeamWork(f.team.id)).length,0);
  await f.message('yes',{reply_to_message:{message_id:question.receiptId}});await recoverTeamWork(f.team.id);
  assert.equal((await readTeamWork(f.team.id)).length,1);assert.ok((await getTeamAssignment((await readTeamWork(f.team.id))[0].assignmentId))!.subjectId);
  expectDirect=true;await f.message('/qa inspect directly');await recoverTeamWork(f.team.id);
  assert.equal((await readTeamWork(f.team.id)).length,2);
 }finally{globalThis.fetch=original;save(settingsDatabase(),'systemAI',JSON.stringify(systemAiDefaults()));}
});

test('crash claims, album consolidation, clarification, send uncertainty and removal are durable',async()=>{
 const f=await fixture();const original=globalThis.fetch;let sends=0;
 globalThis.fetch=async()=>Response.json({ok:true,result:{message_id:3000+ ++sends}});
 try {
  const source=await f.message('/qa recover claimed event');
  const db=await assignmentDatabase();
  const event=db.prepare('SELECT id FROM assistant_team_inbox WHERE message_id=?').get(source.id)!;
  db.prepare('INSERT INTO assistant_team_inbox_claims VALUES(?,?,?)').run(event.id,f.team.id,'claimed');
  await recoverTeamWork(f.team.id);
  assert.equal((await readTeamWork(f.team.id)).length,1,'crash between inbox claim and accept is recovered');
  const recovered=(await readTeamWork(f.team.id))[0];assert.notEqual((await getTeamAssignment(recovered.assignmentId))!.state,'waiting_for_human','a call that names its member does not wait for the classifier');
  await recoverTeamWork(f.team.id);assert.equal((await readTeamWork(f.team.id)).length,1);
  await f.message('/qa album work',{media_group_id:'album-1'});await f.message('',{media_group_id:'album-1'});
  await recoverTeamWork(f.team.id);assert.equal((await readTeamWork(f.team.id)).length,2);
  await f.message('/qa late album component',{media_group_id:'album-1'});await recoverTeamWork(f.team.id);assert.equal((await readTeamWork(f.team.id)).length,2);
  await f.message('/unknown work');await f.message('/qa');await f.message('/qa /unknown work');
  await recoverTeamWork(f.team.id);assert.equal((await readTeamWork(f.team.id)).length,2,'unknown aliases and empty calls clarify without dispatch');
  const [a]=await acceptTeamAssignment(f.member,await f.message('/qa interrupted acknowledgment'),['qa'],null);
  const ack=(await listTeamOutbox(f.team.id)).find(r=>r.rootId===a.rootId&&r.kind==='ack')!;
  db.prepare("UPDATE assistant_team_outbox SET state='sending',record=? WHERE id=?").run(JSON.stringify({...ack,state:'sending'}),ack.id);
  const before=sends;await deliverTeamOutbox(f.team.id);await deliverTeamOutbox(f.team.id);
  assert.equal(sends,before);assert.equal((await listTeamOutbox(f.team.id)).find(r=>r.id===ack.id)!.state,'uncertain');
  const outsider=createLocalUser({username:`outside${randomUUID().slice(0,6)}`,email:'outside@example.test'}).user;
  addClusterLocalMember(f.db,f.team.clusterId,outsider.accountId);removeClusterLocalMember(f.db,f.team.clusterId,f.member.accountId);
  await recoverTeamWork(f.team.id);assert.equal((await getTeamAssignment(a.id))!.state,'cancelled');
 }finally{globalThis.fetch=original;}
});
