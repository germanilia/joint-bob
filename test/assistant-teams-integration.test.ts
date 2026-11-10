import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { signedNodeRequest } from './signed-node-request.js';
import { accountIdFor } from '../src/accounts.js';
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from './dev-nodes.js';
import { saveTeamTelegramConnection } from '../src/assistant-teams/telegram-store.js';
import { DEFAULT_GUARDIAN_SETTINGS } from '../src/guardian/rules.js';
import { PRODUCTION_RULE } from '../src/guardian/production-rule.js';
import assert from 'node:assert/strict';
import { fixture } from './assistant-team-fixture.js';
import { recoverTeamWork, readTeamWork, assignmentDatabase, createTeamInquiry, confirmTeamInquiry, runBrowserTeamAssignment, teamWorkStatus } from '../src/assistant-teams/assignments.js';
import { deliverTeamOutbox, listTeamOutbox, enqueueTeamOutput, deliveryDatabase } from '../src/assistant-teams/delivery.js';
import { handleTeamTelegramWebhook } from '../src/server/routes/assistant-team-telegram.js';
import { saveSecretAccount } from '../src/secrets.js';
import { systemAiDefaults } from '../src/system-ai-config.js';
import { save, settingsDatabase } from '../src/settings-store.js';

test('long delivery preserves the final character and every actual chat/thread receipt without resend',async()=>{
 const f=await fixture(),original=globalThis.fetch,sends:any[]=[];
 const text='x'.repeat(12000)+'END';
 globalThis.fetch=async(_url,init)=>{sends.push(JSON.parse(String(init?.body)));return Response.json({ok:true,result:{message_id:8000+sends.length}});};
 try{
  enqueueTeamOutput(await deliveryDatabase(),{id:'long-result',teamId:f.team.id,rootId:'long-root',assignmentId:null,kind:'clarify',text,chatId:'-1',threadId:44,replyTo:12,requestedBy:f.member.accountId,role:'bob',subjectId:null});
  await deliverTeamOutbox(f.team.id);
  assert.equal(sends.map(send=>send.text).join(''),text);
  assert.ok(sends.length>1);assert.ok(sends.every(send=>send.chat_id==='-1'&&send.message_thread_id===44&&send.reply_parameters.message_id===12));
  assert.deepEqual((await listTeamOutbox(f.team.id)).map(row=>row.receiptId),sends.map((_s,i)=>8001+i));
  await deliverTeamOutbox(f.team.id);assert.equal(sends.length,(await listTeamOutbox(f.team.id)).length);
 }finally{globalThis.fetch=original;}
});

test('recovery wake errors have durable sanitized member-visible diagnostics',async()=>{
 const f=await fixture(),db=await assignmentDatabase();
 db.prepare('INSERT INTO assistant_team_outbox VALUES(?,?,?,?,?)').run('broken',f.team.id,'broken','pending','invalid synthetic secret');
 try{
  await assert.rejects(recoverTeamWork(f.team.id));
 }finally{db.prepare('DELETE FROM assistant_team_outbox WHERE id=?').run('broken');}
 const status=await teamWorkStatus(f.member);
 assert.equal(status.failures[0].code,'recovery_failed');assert.doesNotMatch(JSON.stringify(status.failures),/synthetic secret/);
});

test('runtime readiness failure is durably held rather than silently queued for retry',async()=>{
 const f=await fixture();await assert.rejects(runBrowserTeamAssignment(f.member,'qa','outage',randomUUID(),'inspect runtime outage'));
 const w=(await readTeamWork(f.team.id))[0];assert.equal(w.phase,'held');assert.equal(w.reason,'runtime_unavailable');
 await recoverTeamWork(f.team.id);assert.equal((await readTeamWork(f.team.id))[0].phase,'held');
});

// These integration regressions use real ingestion/decision/outbox ledgers, not fake agent receipts.
// Runtime/HTTP streaming journeys are separately named in docs/assistant-teams.md.
test('loose confirmation clarifies, accepted classifier outage is explicit, replay sends neither twice', async()=>{
 const f=await fixture(), original=globalThis.fetch;const sends:any[]=[];
 globalThis.fetch=async(url,init)=>{if(!String(url).includes('/sendMessage'))throw new Error('synthetic outage');sends.push(JSON.parse(String(init?.body)));return Response.json({ok:true,result:{message_id:9000+sends.length}});};
 try {
  await f.message('yes',{message_thread_id:17});await recoverTeamWork(f.team.id);
  assert.equal(sends.length,1);assert.match(sends[0].text,/reply.*exact|specific.*question/i);
  assert.equal(sends[0].message_thread_id,17);assert.equal((await readTeamWork(f.team.id)).length,0);
  await f.message('/qa inspect outage',{message_thread_id:18});await recoverTeamWork(f.team.id);
  assert.match(sends[1].text,/accepted/);assert.match(sends[2].text,/routing.*unavailable|routing.*failed/i);
  assert.equal((await readTeamWork(f.team.id))[0].reason,'decision_failed');
  const count=sends.length;await recoverTeamWork(f.team.id);assert.equal(sends.length,count);
 } finally {globalThis.fetch=original;}
});

test('inquiry buttons authenticate exact chat/thread/receipt and reject outsider or malformed callbacks',async()=>{
 const f=await fixture(),original=globalThis.fetch;const sends:any[]=[];
 globalThis.fetch=async(_url,init)=>{sends.push(JSON.parse(String(init?.body)));return Response.json({ok:true,result:{message_id:9100+sends.length}});};
 try{
  const inquiry=await createTeamInquiry(f.member,await f.message('Investigate',{message_thread_id:12}),['bob'],{kind:'new'});
  await deliverTeamOutbox(f.team.id);
  const buttons=sends[0].reply_markup.inline_keyboard[0];assert.deepEqual(buttons.map((b:any)=>b.text),['Confirm','Dismiss']);
  assert.ok(buttons.every((b:any)=>Buffer.byteLength(b.callback_data)<=64));
  const callback=(data:string,user=7,receipt=9101,thread=12)=>({callback_query:{id:'synthetic',from:{id:user},data,message:{message_id:receipt,message_thread_id:thread,chat:{id:-1,type:'supergroup'}}}});
  await assert.rejects(handleTeamTelegramWebhook(f.team.id,'wrong',callback(buttons[0].callback_data)));
  await assert.rejects(handleTeamTelegramWebhook(f.team.id,'secret',callback(buttons[0].callback_data,999)));
  for(const value of [callback('bad'),callback(buttons[0].callback_data,7,999),callback(buttons[0].callback_data,7,9101,99)])await assert.rejects(handleTeamTelegramWebhook(f.team.id,'secret',value));
  assert.equal((await readTeamWork(f.team.id)).length,0);
  await handleTeamTelegramWebhook(f.team.id,'secret',callback(buttons[1].callback_data));
  await handleTeamTelegramWebhook(f.team.id,'secret',callback(buttons[0].callback_data));
  assert.equal((await assignmentDatabase()).prepare('SELECT state FROM assistant_team_inquiries WHERE id=?').get(inquiry.id)!.state,'dismissed');
  assert.equal((await readTeamWork(f.team.id)).length,0);
  assert.equal((await listTeamOutbox(f.team.id))[0].receiptId,9101);
 }finally{globalThis.fetch=original;}
});

test('proactive accepted media retains full extracted source rather than only caption',async()=>{
 const f=await fixture(),original=globalThis.fetch;
 const secret=await saveSecretAccount({label:'synthetic decision',provider:'typesafe',variables:[{name:'TYPESAFE_AI_API_KEY',kind:'value',value:'synthetic'}]});
 const config=systemAiDefaults();config.decision.typesafeAccountId=secret.id;save(settingsDatabase(),'systemAI',JSON.stringify(config));
 globalThis.fetch=async(url,init)=>{const body=JSON.parse(String(init?.body));if(String(url).includes('/sendMessage'))return Response.json({ok:true,result:{message_id:9201}});return Response.json({answers:Object.fromEntries(Object.keys(body.questions).map(name=>[name,{type:'choice',choice:name==='attention'?'act':name==='subject'?'clarify':'none',confidence:.99}]))});};
 try{
  const source=await f.message('Please inspect attached evidence');const text='full extracted content '.repeat(1100)+' END OF EVIDENCE';
  // Prepared media fixture represents the existing downloader/extractor's persisted result.
  const record={...source,attachments:[{name:'evidence.txt',fileId:'synthetic',path:'/synthetic/evidence.txt',extractedText:text}]};
  f.db.prepare('UPDATE assistant_team_messages SET record=? WHERE id=?').run(JSON.stringify(record),source.id);
  f.db.prepare('UPDATE assistant_team_message_versions SET record=? WHERE message_id=?').run(JSON.stringify(record),source.id);
  await recoverTeamWork(f.team.id);const work=(await readTeamWork(f.team.id))[0];
  assert.ok(work.message.includes(text));assert.match(work.message,/\/synthetic\/evidence.txt/);
  const next=await f.message('Inquiry media');
  const nextRecord={...record,...next,attachments:record.attachments};
  f.db.prepare('UPDATE assistant_team_messages SET record=? WHERE id=?').run(JSON.stringify(nextRecord),next.id);
  f.db.prepare('UPDATE assistant_team_message_versions SET record=? WHERE message_id=?').run(JSON.stringify(nextRecord),next.id);
  const inquiry=await createTeamInquiry(f.member,next,['bob'],{kind:'clarify'});
  await confirmTeamInquiry(f.member,inquiry.id,'confirm');
  assert.ok((await readTeamWork(f.team.id))[1].message.includes(text),'confirmed inquiry also retains its media');
 }finally{globalThis.fetch=original;save(settingsDatabase(),'systemAI',JSON.stringify(systemAiDefaults()));}
});

test('loopback Telegram HTTP → durable queue → Pi tools: four private specialists, final Bob, direct QA and restart', {timeout:120000}, async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'team-integrated-'));const sends:any[]=[],requests:any[]=[];
 const waiters:Array<{match:(body:any)=>boolean;resolve:(body:any)=>void}>=[];
 const waitSend=(match:(body:any)=>boolean)=>new Promise<any>((resolve,reject)=>{
  const existing=sends.find(match);if(existing){resolve(existing);return;}
  const timer=setTimeout(()=>reject(new Error('Expected Telegram output not received')),30000);
  waiters.push({match,resolve:body=>{clearTimeout(timer);resolve(body);}});
 });
 const roles=['product','designer','qa','pr_reviewer'];
 const fixtureServer=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;const input=JSON.parse(raw||'{}');
  if(req.url?.endsWith('/sendMessage')){
   const body={...input,receipt:10000+sends.length};sends.push(body);
   res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,result:{message_id:body.receipt}}));
   for(const waiter of [...waiters])if(waiter.match(body)){waiters.splice(waiters.indexOf(waiter),1);waiter.resolve(body);}return;
  }
  if(input.questions){
   res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({answers:Object.fromEntries(Object.keys(input.questions).map(name=>[name,{type:'choice',choice:name==='attention'?(String(input.state).includes('QUIET_DECISION')?'none':'act'):name==='subject'?'new':(String(input.state).includes('QUIET_DECISION')?'learn':'none'),confidence:.90}]))}));return;
  }
  requests.push(input);
  const lastUser=JSON.stringify([...input.messages].reverse().find((m:any)=>m.role==='user')?.content??'');
  const last=input.messages.at(-1);
  const isBob=input.tools?.some((t:any)=>t.function.name==='mcp__joint_bob__team_delegate');
  let role:string|undefined;
  if(isBob&&last.role!=='tool'){
   const previous=roles.filter(r=>JSON.stringify(input.messages).includes(`PRIVATE_${r}_RESULT`));role=roles[previous.length];
  }
  const delta=role?{role:'assistant',tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:'mcp__joint_bob__team_delegate',arguments:JSON.stringify({role,message:`WORK_${role}`})}}]}:
   {role:'assistant',content:!(input.tools??[]).length?JSON.stringify({topic:'quiet-decision',expectedRevision:0,description:'Synthetic agreed decision',body:'Team agreed to preserve the test fixture. [[testing]]'}):isBob?(last.role==='tool'?'INTERMEDIATE_NOT_PUBLIC':'FINAL_BOB_ONLY'):(roles.some(r=>lastUser.includes(`WORK_${r}`))?`PRIVATE_${roles.find(r=>lastUser.includes(`WORK_${r}`))}_RESULT`:'DIRECT_QA_RESULT')};
  const chunk=(delta:unknown,finish:string|null)=>`data: ${JSON.stringify({id:'integrated',object:'chat.completion.chunk',created:0,model:'dev-model',choices:[{index:0,delta,finish_reason:finish}]})}\n\n`;
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(chunk(delta,null)+chunk({},role?'tool_calls':'stop')+'data: [DONE]\n\n');
 });
 await new Promise<void>(resolve=>fixtureServer.listen(0,'127.0.0.1',resolve));
 let child:Awaited<ReturnType<typeof startDevNode>>|undefined,homeChild:Awaited<ReturnType<typeof startDevNode>>|undefined,outsiderChild:Awaited<ReturnType<typeof startDevNode>>|undefined,db:DatabaseSync|undefined;
 try{
  const env=await seedDevEnvironment(root,1),node=env.nodes[0],url=`http://127.0.0.1:${(fixtureServer.address() as any).port}`;
  await writeFile(path.join(env.home,'.pi','models.json'),JSON.stringify({providers:{'dev-environment':{baseUrl:`${url}/v1`,api:'openai-completions',apiKey:'synthetic',models:[{id:'dev-model'}]}}}));
  const seeded=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','--eval',`
   const {saveSecretAccount}=await import('./src/secrets.ts');
   const {systemAiDefaults}=await import('./src/system-ai-config.ts');
   const {save,settingsDatabase}=await import('./src/settings-store.ts');
   const key=await saveSecretAccount({label:'fixture decision',provider:'typesafe',variables:[{name:'TYPESAFE_AI_API_KEY',kind:'value',value:'synthetic'}]});
   const config=systemAiDefaults();config.decision.typesafeAccountId=key.id;config.operations.knowledge={harnessId:'pi',provider:'dev-environment',modelId:'dev-model',thinkingLevel:'off'};save(settingsDatabase(),'systemAI',JSON.stringify(config));
   const bot=await saveSecretAccount({label:'fixture bot',provider:'custom',variables:[{name:'TELEGRAM_BOT_TOKEN',kind:'value',value:'synthetic'}]});console.log(bot.id);
  `],{env:{...process.env,HOME:env.home,NODE_ENV:'test',JOINT_BOB_DATA_DIR:node.dataDir}});
  const extra={JOINT_BOB_TYPESAFE_ENDPOINT:`${url}/decision`,JOINT_BOB_TELEGRAM_API:url};
  child=await startDevNode(env,node,extra);const auth=await signIn(env,node);
  const homeEnv=await seedDevEnvironment(path.join(root,'member-home'),1,{username:'secondhuman'}),home=homeEnv.nodes[0];
  const outsiderEnv=await seedDevEnvironment(path.join(root,'outsider-home'),1,{username:'outsiderhuman'}),outsider=outsiderEnv.nodes[0];
  homeChild=await startDevNode(homeEnv,home);outsiderChild=await startDevNode(outsiderEnv,outsider);
  const homeAuth=await signIn(homeEnv,home),outsiderAuth=await signIn(outsiderEnv,outsider);
  assert.equal((await fetch(`${node.url}/api/relay/serving`,{method:'PUT',headers:{Cookie:auth.cookie,'x-csrf-token':auth.csrfToken,'Content-Type':'application/json'},body:JSON.stringify({enabled:true,origin:`http://localhost:${node.port}`,environment:'test',requestsEnabled:true,maxMachines:10,monthlyCapGb:0,alertTopic:''})})).status,204);
  for(const [peer,login,label] of [[home,homeAuth,'member'],[outsider,outsiderAuth,'outsider']] as const){
   const token=await api<any>(node,auth,'POST','/relay/serving/tokens',{label});assert.equal((await api(peer,login,'POST','/relays',{link:token.body.link})).status,201);
  }
  const cluster=await api<any>(node,auth,'POST','/clusters',{name:'Integrated fixture'});
  const clusterId=cluster.body.snapshot.body.clusterId;
  const invitation=await api<any>(node,auth,'POST',`/clusters/${clusterId}/invitations`,{expectedEpoch:1});
  assert.equal((await api(home,homeAuth,'POST','/clusters/join',{link:invitation.body.link,requestId:randomUUID()})).status,201);
  const created=await api<any>(node,auth,'POST','/assistant-teams',{clusterId:cluster.body.snapshot.body.clusterId});assert.equal(created.status,201);
  const team=created.body.team,base=`/assistant-teams/${team.id}`;
  assert.equal((await signedNodeRequest(outsiderEnv,outsider,node,'POST','/api/cluster/v2/assistant-teams/get',{member:{clusterId,accountId:accountIdFor(outsider.nodeId,outsiderEnv.username),homeNodeId:outsider.nodeId,username:outsiderEnv.username},teamId:team.id})).status,403);
  // Deliver the real home-generated signed account snapshot explicitly; no replication polling.
  const snapshot=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','--eval',`
   const {accountSnapshotFor}=await import('./src/user-replication.ts');const {clusterV2Database}=await import('./src/cluster-v2-store.ts');
   console.log(JSON.stringify(accountSnapshotFor(await clusterV2Database(),${JSON.stringify(home.nodeId)},${JSON.stringify(node.nodeId)})));
  `],{env:{...process.env,HOME:homeEnv.home,NODE_ENV:'test',JOINT_BOB_DATA_DIR:home.dataDir}});
  assert.equal((await signedNodeRequest(homeEnv,home,node,'POST','/api/cluster/v2/accounts',JSON.parse(snapshot.stdout.trim().split('\n').at(-1)!))).status,200);
  for(const [peer,login] of [[home,homeAuth],[outsider,outsiderAuth]] as const){const me=await api<any>(peer,login,'GET','/social/me');assert.ok(me.body.relays.some((r:any)=>r.relayNodeId===node.nodeId&&r.active),'member and outsider share the real relay');}
  const remoteAuth=await signIn(homeEnv,node);
  assert.equal((await api(node,remoteAuth,'GET',base)).status,200);
  assert.equal((await api(node,auth,'PUT','/guardian',{settings:{...DEFAULT_GUARDIAN_SETTINGS,enabled:true,rules:[PRODUCTION_RULE]}})).status,200);
  // The members are ordinary assistants of the host's owner, picked in with free role names.
  await (await import('./team-members-fixture.js')).addNodeMembers((method,route,body)=>api<any>(node,auth,method as any,route,body),node.projects.map((p:any)=>p.id),team.id,['bob',...roles].map(role=>({role,instructions:`ROLE_${role}`})),'bob',{harnessId:'pi',provider:'dev-environment',modelId:'dev-model',reasoning:'off'});
  await api(node,auth,'GET',`${base}/telegram`);db=new DatabaseSync(path.join(node.dataDir,'node.db'));
  saveTeamTelegramConnection(db,{teamId:team.id,botId:'integration',botUsername:'integration_bot',tokenAccountId:seeded.stdout.trim().split('\n').at(-1)!,headerSecret:'integration-secret',readsAllGroupMessages:true});
  const hook=(value:unknown)=>fetch(`${node.url}/hooks/teamtelegram-${team.id}`,{method:'POST',headers:{'Content-Type':'application/json','x-telegram-bot-api-secret-token':'integration-secret'},body:JSON.stringify(value)});
  const message=(id:number,text:string,extra:object={})=>({update_id:id,message:{message_id:id,date:1,from:{id:7},chat:{id:-1,type:'supergroup'},message_thread_id:42,text,...extra}});
  const enrollment=await api<any>(node,auth,'POST',`${base}/telegram/enrollment`,{});
  assert.equal((await hook(message(1,`/start ${new URL(enrollment.body.link).searchParams.get('start')}`,{chat:{id:7,type:'private'}}))).status,200);
  assert.equal((await api(node,auth,'POST',`${base}/telegram/enrollment/${enrollment.body.id}/confirm`,{})).status,200);
  const group=await api<any>(node,auth,'POST',`${base}/telegram/group`,{});
  assert.equal((await hook(message(2,`/bind ${group.body.code}`))).status,200);
  assert.equal((await api(node,auth,'POST',`${base}/telegram/group/${group.body.id}/confirm`,{})).status,200);
  const remoteEnrollment=await api<any>(node,remoteAuth,'POST',`${base}/telegram/enrollment`,{});
  assert.equal((await hook(message(20,`/start ${new URL(remoteEnrollment.body.link).searchParams.get('start')}`,{from:{id:8},chat:{id:8,type:'private'}}))).status,200);
  assert.equal((await api(node,remoteAuth,'POST',`${base}/telegram/enrollment/${remoteEnrollment.body.id}/confirm`,{})).status,200);
  await stopDevNode(homeChild);homeChild=undefined;
  assert.equal((await hook(message(21,'QUIET_DECISION: preserve the test fixture',{message_thread_id:99}))).status,200);
  assert.equal((await hook(message(3,'Investigate this workflow'))).status,200);
  const question=await waitSend(body=>!!body.reply_markup);
  assert.equal(requests.length,1);assert.equal((requests[0].tools??[]).length,0,'quiet learning starts no agent');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assistant_team_memory_changes WHERE team_id=?').get(team.id)!.n,1);
  assert.equal(sends.length,1,'quiet learning posts nothing');
  assert.equal((await hook({callback_query:{id:'confirm',from:{id:7},data:question.reply_markup.inline_keyboard[0][0].callback_data,message:{message_id:question.receipt,message_thread_id:42,chat:{id:-1,type:'supergroup'}}}})).status,200);
  const final=await waitSend(body=>body.text==='bob: FINAL_BOB_ONLY');
  assert.ok(sends.findIndex(b=>/accepted/.test(b.text))<sends.indexOf(final));
  assert.ok(sends.every(b=>!b.text.includes('PRIVATE_')&&!b.text.includes('INTERMEDIATE_')));
  assert.ok(sends.every(b=>b.chat_id==='-1'&&b.message_thread_id===42&&b.reply_parameters.message_id===3));
  const assignments=db.prepare('SELECT record FROM assistant_team_assignments WHERE team_id=? ORDER BY rowid').all(team.id).map(r=>JSON.parse(String(r.record)));
  assert.deepEqual(assignments.filter(a=>a.parentId).map(a=>a.role),roles);
  assert.ok(assignments.filter(a=>a.parentId).every(a=>a.destination.kind==='bob'));
  assert.equal(new Set(assignments.map(a=>a.subjectId)).size,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assistant_team_conversations WHERE team_id=?').get(team.id)!.n,5);
  const directText='/qa direct verification '+ 'evidence '.repeat(2400)+' END_OF_FULL_INPUT';
  assert.equal((await hook(message(4,directText))).status,200);
  const qa=await waitSend(body=>body.text==='qa: DIRECT_QA_RESULT');assert.equal(qa.reply_parameters.message_id,4);
  assert.ok(requests.some(request=>JSON.stringify(request.messages).includes(directText)),'actual provider receives the full input beyond 20k');
  assert.equal((await api(node,auth,'GET',`${base}/assignments`)).status,200);
  const output=db.prepare('SELECT role FROM assistant_team_outputs WHERE team_id=? AND message_id=?').get(team.id,qa.receipt);assert.equal(output!.role,'qa');
  const firstQa=JSON.parse(String(db.prepare("SELECT record FROM assistant_team_assignments WHERE team_id=? AND json_extract(record,'$.role')='qa' AND json_extract(record,'$.parentId') IS NULL").get(team.id)!.record));
  await Promise.all([hook(message(5,'Follow up from second member',{from:{id:8},reply_to_message:{message_id:qa.receipt}})),hook(message(6,'/qa distinct simultaneous subject',{message_thread_id:43}))]);
  const followup=await waitSend(body=>body.text==='qa: DIRECT_QA_RESULT'&&body.reply_parameters.message_id===5);
  const distinct=await waitSend(body=>body.text==='qa: DIRECT_QA_RESULT'&&body.reply_parameters.message_id===6);
  assert.equal(followup.message_thread_id,42);assert.equal(distinct.message_thread_id,43);
  await api(node,auth,'GET',`${base}/assignments`);
  const roots=db.prepare("SELECT record FROM assistant_team_assignments WHERE team_id=? AND json_extract(record,'$.role')='qa' AND json_extract(record,'$.parentId') IS NULL ORDER BY rowid").all(team.id).map(r=>JSON.parse(String(r.record)));
  const remote=roots.find(a=>a.requestedBy===accountIdFor(home.nodeId,homeEnv.username));assert.ok(remote,'offline-home enrolled member starts work');
  assert.equal(remote.subjectId,firstQa.subjectId);assert.notEqual(roots.find(a=>a.id!==firstQa.id&&a.id!==remote.id)!.subjectId,firstQa.subjectId);
  const workRows=db.prepare('SELECT record FROM assistant_team_work').all().map(r=>JSON.parse(String(r.record)));
  assert.equal(workRows.find(w=>w.assignmentId===remote.id).conversationId,workRows.find(w=>w.assignmentId===firstQa.id).conversationId);
  assert.equal(requests.length,17,'one writer, nine Bob completions including tool returns, four children, three direct QA turns');
  assert.equal(sends.length,9,'one inquiry and four root acknowledgment/result pairs; no child publications');
  const count=requests.length,sendCount=sends.length;
  await stopDevNode(child);child=undefined;child=await startDevNode(env,node,extra);
  assert.equal((await hook(message(3,'Investigate this workflow'))).status,200);
  assert.equal((await hook(message(4,directText))).status,200);
  assert.equal((await api(node,await signIn(env,node),'GET',`${base}/assignments`)).status,200);
  assert.equal(requests.length,count);assert.equal(sends.length,sendCount);
 }finally{if(child)await stopDevNode(child);if(homeChild)await stopDevNode(homeChild);if(outsiderChild)await stopDevNode(outsiderChild);db?.close();await new Promise<void>(resolve=>fixtureServer.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});
