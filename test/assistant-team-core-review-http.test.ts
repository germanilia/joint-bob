import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { type DatabaseSync } from "node:sqlite";
import path from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';
import { seedDevEnvironment, startDevNode, stopDevNode, api, signIn } from './dev-nodes.js';
import { signedNodeRequest } from './signed-node-request.js';
import { accountIdFor } from '../src/accounts.js';
import { saveTeamTelegramConnection } from '../src/assistant-teams/telegram-store.js';
import { listResourceShares } from '../src/cluster-sharing-policy.js';
import { DEFAULT_GUARDIAN_SETTINGS } from '../src/guardian/rules.js';
import { PRODUCTION_RULE } from '../src/guardian/production-rule.js';
import { openNodeDatabase } from "../src/node-database.js";

 test('team transcript sockets close on cluster-only account revocation and local leave; authorized continuation stays live', {timeout:120000},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'team-core-http-'));
 const inputs:any[]=[];let receipt=1000;
 let finalResolve!:()=>void;const final=new Promise<void>(resolve=>{finalResolve=resolve;});
 const external=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw||'{}');
  if(req.url?.endsWith('/sendMessage')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,result:{message_id:++receipt}}));if(body.text==='qa: VERIFIED_RESULT')finalResolve();return;}
  if(body.questions){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({answers:Object.fromEntries(Object.keys(body.questions).map(k=>[k,{type:'choice',choice:k==='subject'?'new':k==='request'?'separate':'none',confidence:.99}]))}));return;}
  inputs.push(body);res.setHeader('Content-Type','text/event-stream');
  for(const [delta,finish] of [[{role:'assistant',content:'VERIFIED_RESULT'},null],[{},'stop']])res.write(`data: ${JSON.stringify({id:'regression',object:'chat.completion.chunk',model:'dev-model',choices:[{index:0,delta,finish_reason:finish}]})}\n\n`);
  res.end('data: [DONE]\n\n');
 });
 await new Promise<void>(resolve=>external.listen(0,'127.0.0.1',resolve));
 const children:Awaited<ReturnType<typeof startDevNode>>[]=[];let db:DatabaseSync|undefined;const streams:AbortController[]=[];const sockets:WebSocket[]=[];
 try{
 const env=await seedDevEnvironment(path.join(root,'host'),1),node=env.nodes[0];
 const homeEnv=await seedDevEnvironment(path.join(root,'home'),1,{username:'independent'}),home=homeEnv.nodes[0];
 const endpoint=`http://127.0.0.1:${(external.address() as {port:number}).port}`;
 await writeFile(path.join(env.home,'.pi','models.json'),JSON.stringify({providers:{'dev-environment':{baseUrl:`${endpoint}/v1`,api:'openai-completions',apiKey:'synthetic',models:[{id:'dev-model'}]}}}));
 const seed=async(environment:typeof env,code:string)=>{
  const result=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','--eval',code],{env:{...process.env,HOME:environment.home,NODE_ENV:'test',JOINT_BOB_DATA_DIR:environment.nodes[0].dataDir}});
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!);
 };
 const secrets=await seed(env,`
 const {saveSecretAccount}=await import('./src/secrets.ts');const {systemAiDefaults}=await import('./src/system-ai-config.ts');const {save,settingsDatabase}=await import('./src/settings-store.ts');
 const key=await saveSecretAccount({label:'decision',provider:'typesafe',variables:[{name:'TYPESAFE_AI_API_KEY',kind:'value',value:'synthetic'}]});const config=systemAiDefaults();config.decision.typesafeAccountId=key.id;save(settingsDatabase(),'systemAI',JSON.stringify(config));
 const bot=await saveSecretAccount({label:'bot',provider:'custom',variables:[{name:'TELEGRAM_BOT_TOKEN',kind:'value',value:'synthetic'}]});console.log(JSON.stringify({bot:bot.id}));`);
 children.push(await startDevNode(env,node,{JOINT_BOB_TYPESAFE_ENDPOINT:`${endpoint}/decision`,JOINT_BOB_TELEGRAM_API:endpoint}),await startDevNode(homeEnv,home));
 const auth=await signIn(env,node),ha=await signIn(homeEnv,home);
 const made=await api<any>(home,ha,'POST','/clusters',{name:'selected'}),clusterId=made.body.snapshot.body.clusterId;
 const invite=await api<any>(home,ha,'POST',`/clusters/${clusterId}/invitations`,{expectedEpoch:1});
 assert.equal((await api(node,auth,'POST','/clusters/join',{link:invite.body.link,requestId:randomUUID()})).status,201);
 const second=await api<any>(home,ha,'POST','/clusters',{name:'retained membership'});
 const secondInvite=await api<any>(home,ha,'POST',`/clusters/${second.body.snapshot.body.clusterId}/invitations`,{expectedEpoch:1});
 assert.equal((await api(node,auth,'POST','/clusters/join',{link:secondInvite.body.link,requestId:randomUUID()})).status,201);
 const broad=await api<any>(node,auth,'POST','/clusters',{name:'unrelated broad workspace'});
 const shared=await api(node,auth,'PUT',`/clusters/${broad.body.snapshot.body.clusterId}/sharing`,{projectIds:[],workspaceIds:['personal'],confirmOwnedData:true});assert.equal(shared.status,200,JSON.stringify(shared.body));
 const madeTeam=await api<any>(node,auth,'POST','/assistant-teams',{clusterId});assert.equal(madeTeam.status,201,JSON.stringify(madeTeam.body));const team=madeTeam.body.team,base=`/assistant-teams/${team.id}`;
 db=openNodeDatabase(path.join(node.dataDir,'node.db'));
 assert.deepEqual(listResourceShares(db,'project',team.projectId).map(s=>s.clusterId),[clusterId],'no unrelated personal-workspace inheritance');
 const claimOnly={clusterId,homeNodeId:home.nodeId,username:'claimonly',accountId:accountIdFor(home.nodeId,'claimonly')};
 const facade=(member:unknown)=>signedNodeRequest(homeEnv,home,node,'POST','/api/cluster/v2/assistant-teams/get',{member,teamId:team.id});
 assert.equal((await facade(claimOnly)).status,200);
 const snapshot=await seed(homeEnv,`const {accountSnapshotFor}=await import('./src/user-replication.ts');const {clusterV2Database}=await import('./src/cluster-v2-store.ts');console.log(JSON.stringify(accountSnapshotFor(await clusterV2Database(),${JSON.stringify(home.nodeId)},${JSON.stringify(node.nodeId)})));`);
 assert.equal((await signedNodeRequest(homeEnv,home,node,'POST','/api/cluster/v2/accounts',snapshot)).status,200);
 assert.equal((await facade(claimOnly)).status,403,'snapshot omission also revokes a claim-only account');
 const remote=await signIn(homeEnv,node);const member={clusterId,homeNodeId:home.nodeId,username:homeEnv.username,accountId:accountIdFor(home.nodeId,homeEnv.username)};
 assert.equal((await facade(member)).status,200);
 assert.equal((await api(node,remote,'GET',`/projects/${team.projectId}/sessions`)).status,200,'independent member uses ordinary history APIs');
 assert.equal((await api(node,auth,'PUT','/guardian',{settings:{...DEFAULT_GUARDIAN_SETTINGS,enabled:true,rules:[PRODUCTION_RULE]}})).status,200);
 const picked=await (await import('./team-members-fixture.js')).addNodeMembers((method,route,body)=>api<any>(node,auth,method as any,route,body),node.projects.map((p:any)=>p.id),team.id,[{role:'bob'},{role:'qa',instructions:'TEAM_QA_ONLY'}],'bob',{harnessId:'pi',provider:'dev-environment',modelId:'dev-model',reasoning:'off'});
 await api(node,auth,'GET',`${base}/telegram`);
 saveTeamTelegramConnection(db,{teamId:team.id,botId:'fixture',botUsername:'regression_bot',tokenAccountId:secrets.bot,headerSecret:'fixture-secret',readsAllGroupMessages:true});
 // Seed through real ingestion, then bind quiet discussion to its classified subjects.
 const evidence=await seed(env,`
 const {telegramDatabase}=await import('./src/assistant-teams/telegram-store.ts');const {ingestTeamTelegramUpdate}=await import('./src/assistant-teams/telegram.ts');const {saveTeamSubject,bindTeamMessageSubject,finishTeamEvent,listPendingTeamEvents}=await import('./src/assistant-teams/conversations.ts');
 const db=await telegramDatabase(),teamId=${JSON.stringify(team.id)},accountId=${JSON.stringify(member.accountId)};
 db.prepare('INSERT INTO assistant_team_telegram_members VALUES(?,?,?,?)').run(teamId,accountId,'8','independent');db.prepare('INSERT INTO assistant_team_telegram_groups VALUES(?,?)').run(teamId,'-1');
 for(const [id,text,subject] of [[1,'QUIET_FAILURE save basket returns 503','checkout'],[2,'OTHER_TOPIC_DO_NOT_LEAK','marketing']]){
 const result=await ingestTeamTelegramUpdate(teamId,{update_id:id,message:{message_id:id,date:1,from:{id:8},chat:{id:-1,type:'supergroup'},text}});
 await saveTeamSubject({id:subject,teamId,title:subject,summary:''},'-1',null);await bindTeamMessageSubject(teamId,result.message.id,subject);
 }
 for(const event of await listPendingTeamEvents(teamId))await finishTeamEvent(teamId,event.id,'decided');console.log(JSON.stringify({ok:true}));`);assert.equal(evidence.ok,true);
 const hook=(id:number,text:string)=>fetch(`${node.url}/hooks/teamtelegram-${team.id}`,{method:'POST',headers:{'Content-Type':'application/json','x-telegram-bot-api-secret-token':'fixture-secret'},body:JSON.stringify({update_id:id,message:{message_id:id,date:1,from:{id:8},chat:{id:-1,type:'supergroup'},text,reply_to_message:{message_id:1}}})});
 assert.equal((await hook(3,'/qa investigate that')).status,200);
 await final;
 assert.equal(inputs.length,1);const sent=JSON.stringify(inputs[0].messages);
 assert.match(sent,/QUIET_FAILURE/,'real provider receives preceding discussion');assert.match(sent,new RegExp(member.accountId));assert.doesNotMatch(sent,/OTHER_TOPIC_DO_NOT_LEAK|Scroll reference turn/);
 const listing=await api<any>(node,remote,'GET',`/projects/${team.projectId}/sessions`);assert.equal(listing.status,200);const conversation=String(db.prepare('SELECT conversation_id FROM assistant_team_conversations WHERE team_id=?').get(team.id)!.conversation_id);const actual=listing.body.sessions.find((s:any)=>s.id===conversation);assert.ok(actual,'ordinary list includes dispatched role conversation');
 const url=new URL('/ws',node.url.replace(/^http/,'ws'));url.searchParams.set('projectId',team.projectId);url.searchParams.set('sessionPath',actual.path);
 const socket=new WebSocket(url,{headers:{Cookie:remote.cookie,Origin:node.url}});
 sockets.push(socket);
 const received:any[]=[];socket.on('message',raw=>received.push(JSON.parse(String(raw))));
 const wsClosed=new Promise<number>(resolve=>socket.once('close',code=>resolve(code)));
 const transcript=await new Promise<any>((resolve,reject)=>{const timeout=setTimeout(()=>{socket.close();reject(new Error('ordinary transcript unavailable'));},15000);
  socket.on('message',raw=>{const event=JSON.parse(String(raw));if(event.type==='ready'){clearTimeout(timeout);resolve(event);}if(event.type==='error'){clearTimeout(timeout);socket.close();reject(new Error(JSON.stringify(event)));}});socket.on('error',reject);
 });
 assert.match(JSON.stringify(transcript),/VERIFIED_RESULT/,'ordinary transcript contains actual turn output');
 const controller=new AbortController();streams.push(controller);
 const response=await fetch(`${node.url}/api${base}/events`,{headers:{Cookie:remote.cookie},signal:controller.signal});assert.equal(response.status,200);
 const reader=response.body!.getReader();await reader.read();
 const retained={...snapshot,accounts:snapshot.accounts.map((a:any)=>({...a,clusterIds:a.clusterIds.filter((id:string)=>id!==clusterId)}))};
 assert.ok(retained.accounts.some((a:any)=>a.accountId===member.accountId&&a.clusterIds.length),'real visitor retains another cluster');
 assert.equal((await signedNodeRequest(homeEnv,home,node,'POST','/api/cluster/v2/accounts',retained)).status,200);
 assert.equal((await api(node,remote,'GET','/projects')).status,200,'login stays alive');
 let closeTimer:NodeJS.Timeout|undefined;
 try { assert.equal(await Promise.race([wsClosed,new Promise((_,reject)=>{closeTimer=setTimeout(()=>reject(new Error('revoked team transcript socket stayed attached')),3000);})]),1008); }
 finally {clearTimeout(closeTimer);socket.close();}
 const afterRevocation=received.length;
 const localSocket=new WebSocket(url,{headers:{Cookie:auth.cookie,Origin:node.url}});
 sockets.push(localSocket);
 const waitEvent=(ws:WebSocket,type:string)=>new Promise<any>((resolve,reject)=>{
  const timer=setTimeout(()=>{ws.off('message',listen);reject(new Error(`Missing ${type}`));},15000);
  const listen=(raw:WebSocket.RawData)=>{const event=JSON.parse(String(raw));if(event.type===type){clearTimeout(timer);ws.off('message',listen);resolve(event);}};ws.on('message',listen);
 });
 await waitEvent(localSocket,'ready');
 const continued=waitEvent(localSocket,'agent_end');
 const continuation=await api<any>(node,auth,'POST',`${base}/agents/qa/turn`,{subjectId:'checkout',message:'Authorized continuation after visitor revocation',requestId:randomUUID()});
 assert.equal(continuation.status,200,JSON.stringify(continuation.body));
 assert.equal(continuation.body.conversationId,conversation,'continuation uses the subscribed transcript');
 await continued;
 assert.equal(inputs.length,2,'authorized member continues through loopback model');
 assert.equal(received.length,afterRevocation,'revoked visitor receives no continuation events');
 // No refresh or poll: receiving the signed account change closes the idle revoked stream.
 let ended=false;while(!ended){ended=(await reader.read()).done;}
 assert.equal((await facade(member)).status,403);assert.equal((await facade(claimOnly)).status,403);
 const count=inputs.length;assert.equal((await hook(4,'/qa revoked request')).status,200);assert.equal(inputs.length,count,'revoked Telegram identity fails before inference');
 assert.equal((await api(node,remote,'GET',`/projects/${team.projectId}/sessions`)).status,404);
 assert.equal(received.length,afterRevocation,'revoked socket receives no further frames');
 // Re-admit by a newer received snapshot; an older facade alone was insufficient.
 assert.equal((await signedNodeRequest(homeEnv,home,node,'POST','/api/cluster/v2/accounts',snapshot)).status,200);
 const admitted=await signIn(homeEnv,node),membershipAbort=new AbortController();streams.push(membershipAbort);
 const membershipStream=await fetch(`${node.url}/api${base}/events`,{headers:{Cookie:admitted.cookie},signal:membershipAbort.signal});const membershipReader=membershipStream.body!.getReader();await membershipReader.read();
 // Keep another local member so leaving removes only the person, not the host node.
 await seed(env,`const {createLocalUser}=await import('./src/auth.ts');const {addClusterLocalMember}=await import('./src/cluster-accounts.ts');const {clusterV2Database}=await import('./src/cluster-v2-store.ts');const {user}=createLocalUser({username:'remaining',email:'remaining@example.test'});addClusterLocalMember(await clusterV2Database(),${JSON.stringify(clusterId)},user.accountId);console.log('{}');`);
 const localFrames:any[]=[];localSocket.on('message',raw=>localFrames.push(String(raw)));
 const localClosed=new Promise<number>(resolve=>localSocket.once('close',code=>resolve(code)));
 assert.equal((await api(node,auth,'POST',`/clusters/${clusterId}/leave`,{expectedEpoch:1})).status,200);
 let localTimer:NodeJS.Timeout|undefined;
 try {assert.equal(await Promise.race([localClosed,new Promise((_,reject)=>{localTimer=setTimeout(()=>reject(new Error('local leave kept transcript attached')),3000);})]),1008);}
 finally {clearTimeout(localTimer);localSocket.close();}
 assert.equal((await api(node,auth,'GET','/projects')).status,200,'local login remains alive');
 assert.equal((await api(node,admitted,'GET',base)).status,200,'other cluster member remains authorized');
 assert.equal(localFrames.length,0,'local leave receives no new transcript frames');
 const closed=await api<any>(home,ha,'POST',`/clusters/${clusterId}/close`,{expectedEpoch:1});assert.equal(closed.status,200,JSON.stringify(closed.body));
 assert.equal((await signedNodeRequest(homeEnv,home,node,'POST','/api/cluster/v2/membership/snapshot',{snapshot:closed.body.snapshot})).status,200);
 ended=false;while(!ended){ended=(await membershipReader.read()).done;}
 assert.equal((await api(node,admitted,'GET',base)).status,403);
 }finally{for(const socket of sockets)socket.terminate();for(const stream of streams)stream.abort();for(const child of children)await stopDevNode(child);db?.close();await new Promise<void>(resolve=>external.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
 });
