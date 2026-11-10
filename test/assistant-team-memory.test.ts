import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { seedDevEnvironment, startDevNode, stopDevNode, signIn, api } from './dev-nodes.js';
import { DEFAULT_GUARDIAN_SETTINGS } from '../src/guardian/rules.js';
import { PRODUCTION_RULE } from '../src/guardian/production-rule.js';
import { fixture } from './assistant-team-fixture.js';
import { onTopicApplied } from '../src/control-center/memory-store.js';
import { writeTeamMemory, readTeamMemory, teamMemoryRoot, listTeamMemoryChanges, listTeamMemoryTopics, revertTeamMemory, replayTeamMemory, learnTeamMessage, teamMemoryStatus } from '../src/assistant-teams/memory.js';

test('journaled team topics: CAS, evidence isolation, links, paging, safe revert and no personal replication', async()=>{
 const f=await fixture(), other=await fixture(); const m=await f.message('Proposal: ship Friday; human disagreement remains unresolved');
 const {saveTeamSubject,bindTeamMessageSubject,bindTeamConversation}=await import('../src/assistant-teams/conversations.js');
 const {listTeamAgents}=await import('../src/assistant-teams/store.js');
 await saveTeamSubject({id:'release-subject',teamId:f.team.id,title:'Release',summary:'Proposal'},m.chatId,m.threadId);
 await bindTeamMessageSubject(f.team.id,m.id,'release-subject');const conversationId=crypto.randomUUID();
 await bindTeamConversation(f.team.id,'release-subject',(await listTeamAgents(f.team.id))[0].assistantId,conversationId);
 let replicated=0; const stop=onTopicApplied(()=>replicated++);
 try {
 const input={topic:'release',expectedRevision:0,description:'Release proposal',body:'Proposal, not agreement. [[testing]]',sourceMessageIds:[m.id]};
 const results=await Promise.allSettled([writeTeamMemory(f.member,input),writeTeamMemory(f.member,input)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.status,409);
 const text=await readTeamMemory(f.team.id,'release'); assert.match(text,/Proposal/); assert.match(text,new RegExp(m.id)); assert.match(text,new RegExp(m.accountId)); assert.match(text,new RegExp(conversationId));
 assert.match(readFileSync(path.join(teamMemoryRoot(f.team.id),'INDEX.md'),'utf8'),/\[\[release\]\]/);
 assert.deepEqual((await listTeamMemoryTopics(f.member,0,1))[0].links,['testing']);
 assert.equal((await listTeamMemoryTopics(f.member,1,1)).length,0);
 await assert.rejects(writeTeamMemory(other.member,input),{status:403});
 const change=(await listTeamMemoryChanges(f.member))[0];
 await writeTeamMemory(f.member,{...input,expectedRevision:1,body:'Newer decision'});
 await assert.rejects(revertTeamMemory(f.member,change.id,1),{status:409});
 assert.match(await readTeamMemory(f.team.id,'release'),/Newer/);
 assert.equal(replicated,0);
 }finally{stop();}
});

test('secrets are stripped before persistence; outsider evidence and forged members fail closed',async()=>{
 const f=await fixture();const {saveSecretAccount}=await import('../src/secrets.js');
 const secret='synthetic-configured-memory-secret';await saveSecretAccount({label:'redact fixture',provider:'custom',variables:[{name:'PRIVATE_TOKEN',kind:'value',value:secret}]});
 await writeTeamMemory(f.member,{topic:'redacted',expectedRevision:0,description:secret,body:secret+' sk-provider-shaped-123456789',sourceMessageIds:[]});
 const all=JSON.stringify(await listTeamMemoryChanges(f.member))+await readTeamMemory(f.team.id,'redacted');assert.ok(!all.includes(secret));assert.doesNotMatch(all,/sk-provider-shaped-123456789/);
 await assert.rejects(writeTeamMemory({...f.member},{topic:'forged',expectedRevision:0,description:'No',body:'No',sourceMessageIds:[]}),{status:403});
 const m=await f.message('Outsider must not learn');m.telegramUserId='999';f.db.prepare('UPDATE assistant_team_messages SET record=? WHERE id=?').run(JSON.stringify(m),m.id);
 const original=fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('No inference');};
 try{await learnTeamMessage(f.team.id,m.id);assert.equal(calls,0);assert.equal((await listTeamMemoryTopics(f.member)).length,1);
 await assert.rejects(writeTeamMemory(f.member,{topic:'outsider',expectedRevision:0,description:'No',body:'No',sourceMessageIds:[m.id]}),{status:403});}
 finally{globalThis.fetch=original;}
});

test('all six live roles have scoped memory tools, only Bob has delegation; stale roles have neither',async()=>{
 const f=await fixture();const {acceptTeamAssignment,routeTeamAssignment}=await import('../src/assistant-teams/assignments.js');
 const {getTeamAssignment}=await import('../src/assistant-teams/store.js');const {teamAssignmentDestination,TEAM_ROLES}=await import('../src/assistant-teams/runtime.js');
 const {beginPersonalAssistantTurn}=await import('../src/personal-assistants.js');const {promptStarted,promptEnded}=await import('../src/assistant-collaboration/bridge-tools.js');const {listTeamTools,callTeamTool}=await import('../src/assistant-teams/tools.js');
 for(const role of TEAM_ROLES){
  const [a]=await acceptTeamAssignment(f.member,await f.message('/'+role+' memory'),[role],null);await routeTeamAssignment(a.id,{kind:'new'});
  const resolved=await teamAssignmentDestination((await getTeamAssignment(a.id))!);await beginPersonalAssistantTurn(f.team.executorAccountId,resolved.profile.id,a.requestId,`pi:${resolved.destination.sessionId}`,'memory','assistant');
  promptStarted(f.team.projectId,resolved.destination.sessionId,a.requestId);
  const identity={account:{accountId:f.member.accountId,username:f.member.username,role:null,homeNodeId:f.member.homeNodeId,isRemoteLogin:false},projectId:f.team.projectId,conversationId:resolved.destination.sessionId,engine:'pi' as const};
  try{const names=(await listTeamTools(identity)).map(t=>t.name);assert.ok(names.includes('team_memory_write'));assert.equal(names.includes('team_delegate'),role==='bob');
   assert.ok(!(await callTeamTool(identity,'team_memory_list',{})).isError);
   if(role!=='bob')assert.equal((await callTeamTool(identity,'team_delegate',{role:'qa',message:'forbidden'})).isError,true);
  }finally{promptEnded(f.team.projectId,resolved.destination.sessionId,a.requestId);}
  assert.deepEqual(await listTeamTools(identity),[]);assert.equal((await callTeamTool(identity,'team_memory_read',{topic:'release'})).isError,true);
 }
});

test('selected decision/writer unavailable is visible and never falls back',async()=>{
 const f=await fixture();const {systemAiDefaults}=await import('../src/system-ai-config.js');const {save,settingsDatabase}=await import('../src/settings-store.js');const {saveSecretAccount}=await import('../src/secrets.js');
 const secret=await saveSecretAccount({label:'unavailable classifier',provider:'custom',variables:[{name:'TYPESAFE_AI_API_KEY',kind:'value',value:'synthetic-unavailable-key'}]});
 const config=systemAiDefaults();config.decision.typesafeAccountId=secret.id;save(settingsDatabase(),'systemAI',JSON.stringify(config));
 const original=fetch;let calls=0;globalThis.fetch=async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));return Response.json({answers:Object.fromEntries(Object.keys(body.questions).map(k=>[k,{type:'choice',choice:k==='memory'?'learn':k==='attention'?'none':'new',confidence:0.99}]))});};
 try{const m=await f.message('Durable decision');await learnTeamMessage(f.team.id,m.id);assert.equal((await teamMemoryStatus(f.member))[0].status,'writer_unavailable');assert.equal(calls,1);assert.equal((await listTeamMemoryTopics(f.member)).length,0);
 config.operations.knowledge={harnessId:'pi',provider:'unavailable',modelId:'missing',thinkingLevel:'off'};save(settingsDatabase(),'systemAI',JSON.stringify(config));await learnTeamMessage(f.team.id,m.id);assert.equal((await teamMemoryStatus(f.member))[0].status,'memory_failed');assert.equal(calls,1);
 globalThis.fetch=async()=>{calls++;throw new Error('provider down');};await learnTeamMessage(f.team.id,(await f.message('Another decision')).id);assert.equal((await teamMemoryStatus(f.member))[0].status,'decision_unavailable');assert.equal((await listTeamMemoryTopics(f.member)).length,0);
 }finally{globalThis.fetch=original;save(settingsDatabase(),'systemAI',JSON.stringify(systemAiDefaults()));}
});

test('committed revision survives file-application failure; replay never accepts partial temp content',async()=>{
 const f=await fixture();const root=teamMemoryRoot(f.team.id);mkdirSync(path.join(root,'blocked.md'),{recursive:true});
 await assert.rejects(writeTeamMemory(f.member,{topic:'blocked',expectedRevision:0,description:'Journal first',body:'Authoritative committed body',sourceMessageIds:[]}),{status:503});
 assert.equal((await listTeamMemoryChanges(f.member))[0].revision,1);
 await assert.rejects(writeTeamMemory(f.member,{topic:'blocked',expectedRevision:0,description:'Stale',body:'Do not overwrite',sourceMessageIds:[]}),{status:409});
 rmSync(path.join(root,'blocked.md'),{recursive:true});writeFileSync(path.join(root,'.blocked.md.partial.tmp'),'incomplete');
 await replayTeamMemory();assert.match(readFileSync(path.join(root,'blocked.md'),'utf8'),/Authoritative committed body/);
 assert.match(readFileSync(path.join(root,'INDEX.md'),'utf8'),/blocked/);
});

test('quiet discussion uses the real isolated selected Pi writer, no specialist or Telegram output', {timeout:120000}, async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'team-memory-real-'));const requests:any[]=[];
 const provider=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;requests.push(JSON.parse(body));
  const answer=JSON.stringify({topic:'launch',expectedRevision:0,description:'Launch proposal',body:'Account proposes Friday. Proposal, not a decision; disagreement unresolved. [[testing]]'});
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const chunk=(delta:unknown,finish:string|null)=>`data: ${JSON.stringify({id:'memory',object:'chat.completion.chunk',created:0,model:'dev-model',choices:[{index:0,delta,finish_reason:finish}]})}\n\n`;
  res.end(chunk({role:'assistant',content:answer},null)+chunk({},'stop')+'data: [DONE]\n\n');
 });await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
 try{
  const env=await seedDevEnvironment(root,1),node=env.nodes[0],port=(provider.address() as any).port;
  await mkdir(path.join(env.home,'.pi','agent'),{recursive:true});
  await writeFile(path.join(env.home,'.pi','agent','models.json'),JSON.stringify({providers:{'dev-environment':{baseUrl:`http://127.0.0.1:${port}/v1`,api:'openai-completions',apiKey:'synthetic',models:[{id:'dev-model'}]}}}));
  await writeFile(path.join(env.home,'.pi','agent','AGENTS.md'),'PRIVATE_MEMORY_INSTRUCTIONS_SENTINEL');
  const result=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','--eval',`
   import assert from 'node:assert/strict';
   const {fixture}=await import('./test/assistant-team-fixture.ts');
   const {recoverTeamWork}=await import('./src/assistant-teams/assignments.ts');
   const {learnTeamMessage,readTeamMemory,teamMemoryStatus}=await import('./src/assistant-teams/memory.ts');
   const {systemAiDefaults}=await import('./src/system-ai-config.ts');
   const {save,settingsDatabase}=await import('./src/settings-store.ts');
   const {saveSecretAccount}=await import('./src/secrets.ts');
   const f=await fixture();
   const privateMemory=await import('./src/control-center/memory-store.ts');privateMemory.applyTopicText(privateMemory.memoryRoot(f.member.accountId),'private',privateMemory.topicText(privateMemory.cleanTopic('private',{description:'Private',body:'PRIVATE_PERSONAL_MEMORY_SENTINEL'})));
   const secret=await saveSecretAccount({label:'memory classifier',provider:'custom',variables:[{name:'TYPESAFE_AI_API_KEY',kind:'value',value:'synthetic-memory-key-123456'}]});
   const config=systemAiDefaults();config.decision.typesafeAccountId=secret.id;config.operations.knowledge={harnessId:'pi',provider:'dev-environment',modelId:'dev-model',thinkingLevel:'off'};save(settingsDatabase(),'systemAI',JSON.stringify(config));
   const original=fetch;let decisions=0;
   globalThis.fetch=async(url,init)=>{if(String(url).includes(':${port}/'))return original(url,init);decisions++;const body=JSON.parse(String(init.body));assert.ok(!JSON.stringify(body).includes('synthetic-memory-key-123456'));assert.ok(!JSON.stringify(body).includes('sk-provider-shaped-123456789'));return Response.json({answers:Object.fromEntries(Object.keys(body.questions).map(k=>[k,{type:'choice',choice:k==='memory'?(body.state.includes('casual hello')?'none':'learn'):k==='attention'?'none':'new',confidence:0.99}]))});};
   const m=await f.message('Proposal Friday; disagreement unresolved. synthetic-memory-key-123456 sk-provider-shaped-123456789 '+ 'full original '.repeat(12000));
   await recoverTeamWork(f.team.id);
   assert.equal((await teamMemoryStatus(f.member))[0].status,'learned',JSON.stringify(await teamMemoryStatus(f.member)));
   assert.match(await readTeamMemory(f.team.id,'launch'),/Proposal/);
   assert.equal(f.db.prepare('SELECT COUNT(*) n FROM assistant_team_assignments WHERE team_id=?').get(f.team.id).n,0);
   assert.equal(f.db.prepare('SELECT COUNT(*) n FROM assistant_team_outbox WHERE team_id=?').get(f.team.id).n,0);
   assert.ok(JSON.parse(f.db.prepare('SELECT record FROM assistant_team_messages WHERE id=?').get(m.id).record).text.length>140000);
   await learnTeamMessage(f.team.id,m.id);assert.equal(decisions,1);
   const casual=await f.message('casual hello');await recoverTeamWork(f.team.id);await learnTeamMessage(f.team.id,casual.id);assert.equal((await teamMemoryStatus(f.member))[0].status,'nothing');assert.equal(decisions,2);
   console.log('MEMORY_REAL_OK');
  `],{env:{...process.env,HOME:env.home,PI_CODING_AGENT_DIR:path.join(env.home,'.pi','agent'),NODE_ENV:'test',JOINT_BOB_DATA_DIR:path.join(root,'memory-node')},timeout:100000,maxBuffer:1024*1024});
  assert.match(result.stdout,/MEMORY_REAL_OK/);assert.equal(requests.length,1);
  const serialized=JSON.stringify(requests);assert.doesNotMatch(serialized,/PRIVATE_MEMORY_INSTRUCTIONS_SENTINEL|PRIVATE_PERSONAL_MEMORY_SENTINEL|synthetic-memory-key-123456|sk-provider-shaped-123456789/);
  assert.ok(!(requests[0].tools??[]).length,'writer has no tools');assert.ok(serialized.length<35000,'bounded learning material');
 }finally{await new Promise<void>(resolve=>provider.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});

test('real member HTTP paging/edit/revert and live specialist memory tools, without delegation', {timeout:120000},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'team-memory-http-'));const requests:any[]=[];
 const provider=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;const input=JSON.parse(body);requests.push(input);
  const count=input.messages.filter((m:any)=>m.role==='tool').length;
  const name=count===0?'team_memory_write':'team_memory_read';const args=count===0?{topic:'tool-note',expectedRevision:0,description:'Shared note',body:'Specialist proposal, not consensus',sourceMessageIds:[]}:{topic:'tool-note'};
  res.writeHead(200,{'Content-Type':'text/event-stream'});const chunk=(delta:unknown,finish:string|null)=>`data: ${JSON.stringify({id:'tools',object:'chat.completion.chunk',created:0,model:'dev-model',choices:[{index:0,delta,finish_reason:finish}]})}\n\n`;
  res.end(count<2?chunk({role:'assistant',tool_calls:[{index:0,id:`call-${count}`,type:'function',function:{name:`mcp__joint_bob__${name}`,arguments:JSON.stringify(args)}}]},null)+chunk({},'tool_calls')+'data: [DONE]\n\n':chunk({role:'assistant',content:'Memory tools completed'},null)+chunk({},'stop')+'data: [DONE]\n\n');
 });await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));let child:Awaited<ReturnType<typeof startDevNode>>|undefined;
 try{
  const env=await seedDevEnvironment(root,1),node=env.nodes[0],port=(provider.address() as any).port;
  await writeFile(path.join(env.home,'.pi','models.json'),JSON.stringify({providers:{'dev-environment':{baseUrl:`http://127.0.0.1:${port}/v1`,api:'openai-completions',apiKey:'synthetic',models:[{id:'dev-model'}]}}}));
  child=await startDevNode(env,node);const auth=await signIn(env,node);
  const cluster=await api<any>(node,auth,'POST','/clusters',{name:'Memory HTTP'});
  const created=await api<any>(node,auth,'POST','/assistant-teams',{clusterId:cluster.body.snapshot.body.clusterId});assert.equal(created.status,201);
  const team=created.body.team,base=`/assistant-teams/${team.id}`;
  assert.equal((await api(node,auth,'PUT','/guardian',{settings:{...DEFAULT_GUARDIAN_SETTINGS,enabled:true,rules:[PRODUCTION_RULE]}})).status,200);
  assert.equal((await api(node,auth,'PUT',`${base}/agents/qa`,{expectedRevision:1,name:'QA',instructions:'Use shared memory tools.',allowTerminal:false,executionSettings:{harnessId:'pi',provider:'dev-environment',modelId:'dev-model',reasoning:'off'}})).status,200);
  const turn=await api<any>(node,auth,'POST',`${base}/agents/qa/turn`,{subjectId:'memory-check',requestId:crypto.randomUUID(),message:'Store and read a shared proposal'});assert.equal(turn.status,200,JSON.stringify(turn.body));
  assert.equal(requests.length,3);assert.ok(requests[0].tools.some((t:any)=>t.function.name==='mcp__joint_bob__team_memory_write'));
  assert.ok(!requests[0].tools.some((t:any)=>t.function.name==='mcp__joint_bob__team_delegate'));
  assert.match(JSON.stringify(requests[2].messages.filter((m:any)=>m.role==='tool')),/Specialist proposal/);
  const topics=await api<any>(node,auth,'GET',`${base}/memory/topics?offset=0&limit=1`);assert.equal(topics.body.topics[0].revision,1);
  assert.equal((await api<any>(node,auth,'GET',`${base}/memory/topics?offset=1&limit=1`)).body.topics.length,0);
  assert.equal((await api(node,auth,'GET',`${base}/memory/topics?limit=101`)).status,400);
  const input={expectedRevision:1,description:'Edited',body:'Human correction',sourceMessageIds:[]};
  assert.equal((await api(node,auth,'PUT',`${base}/memory/topics/tool-note`,input)).status,200);
  assert.equal((await api(node,auth,'PUT',`${base}/memory/topics/tool-note`,input)).status,409);
  const changes=await api<any>(node,auth,'GET',`${base}/memory/changes`);
  assert.equal((await api(node,auth,'POST',`${base}/memory/changes/${changes.body.changes[1].id}/revert`,{expectedRevision:1})).status,409);
  assert.equal((await api(node,auth,'POST',`${base}/memory/changes/${changes.body.changes[0].id}/revert`,{expectedRevision:2})).status,200);
  assert.match((await api<any>(node,auth,'GET',`${base}/memory/topics`)).body.topics[0].body,/Specialist proposal/);
  const memoryDir=path.join(node.dataDir,'assistant-teams',team.id,'memory');
  await stopDevNode(child);child=undefined;
  rmSync(path.join(memoryDir,'tool-note.md'));rmSync(path.join(memoryDir,'INDEX.md'));
  writeFileSync(path.join(memoryDir,'.tool-note.md.crashed.tmp'),'partial corruption');
  child=await startDevNode(env,node);
  let restored='';const deadline=Date.now()+10000;
  while(Date.now()<deadline){try{restored=readFileSync(path.join(memoryDir,'tool-note.md'),'utf8');break;}catch{await new Promise(resolve=>setTimeout(resolve,25));}}
  assert.match(restored,/Specialist proposal/);assert.match(readFileSync(path.join(memoryDir,'INDEX.md'),'utf8'),/tool-note/);
  assert.equal(requests.length,3,'real startup replay regenerates files without inference');
 }finally{if(child)await stopDevNode(child);await new Promise<void>(resolve=>provider.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});

test('startup replay restores committed file and index, ignoring incomplete temporary file without inference',async()=>{
 const f=await fixture(); await writeTeamMemory(f.member,{topic:'recovery',expectedRevision:0,description:'Recovery',body:'Good committed text',sourceMessageIds:[]});
 const root=teamMemoryRoot(f.team.id); writeFileSync(path.join(root,'.recovery.md.incomplete.tmp'),'bad');
 rmSync(path.join(root,'recovery.md')); rmSync(path.join(root,'INDEX.md'));
 const original=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('Replay must not infer');};
 try {await replayTeamMemory();assert.match(await readTeamMemory(f.team.id,'recovery'),/Good committed text/);assert.match(readFileSync(path.join(root,'INDEX.md'),'utf8'),/recovery/);}
 finally{globalThis.fetch=original;}
});
