import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './assistant-team-fixture.js';
import { createServer } from 'node:http';
import { createLocalUser, authenticate, changePassword, sessionCookieName, type AuthSession } from '../src/auth.js';
import { addClusterLocalMember, removeClusterLocalMember } from '../src/cluster-accounts.js';
import { requireTeamMember } from '../src/assistant-teams/access.js';
import { acceptTeamAssignment, routeTeamAssignment, resolveTeamApproval, assignmentDatabase } from '../src/assistant-teams/assignments.js';
import { getTeamAssignment } from '../src/assistant-teams/store.js';
import { teamAssignmentDestination, teamAgentReadiness } from '../src/assistant-teams/runtime.js';
import { beginPersonalAssistantTurn } from '../src/personal-assistants.js';
import { promptStarted, promptEnded } from '../src/assistant-collaboration/bridge-tools.js';
import { requestGuardianReview, pendingGuardianReviews, decideGuardianReview, cancelGuardianReviews } from '../src/guardian/reviews.js';
import { getGuardianSettings, updateGuardianSettings } from '../src/guardian/settings.js';
import { withProductionGuard, productionGuardStatus } from '../src/guardian/production-rule.js';
import { enableAutoRespond, DEFAULT_AUTO_RESPOND_INSTRUCTIONS, DEFAULT_AUTO_RESPOND_STOP_INSTRUCTIONS } from '../src/conversation-auto-respond.js';
import { autoRespondHeldBack } from '../src/server/control-center-watch.js';
import { personalContinuationAllowed } from '../src/control-center/auto-respond.js';
import { checkGuardian } from '../src/guardian/check.js';

test('all team roles refuse personal auto-response and review continuations; production readiness fails closed',async()=>{
 const f=await fixture();
 for(const role of ['bob','product','designer','qa','pr_reviewer','support'] as const){
  const [initial]=await acceptTeamAssignment(f.member,await f.message(`/${role} test`),[role],null);await routeTeamAssignment(initial.id,{kind:'new'});
  const a=(await getTeamAssignment(initial.id))!,resolved=await teamAssignmentDestination(a);
  assert.equal(await personalContinuationAllowed(f.team.projectId,resolved.destination.sessionId),false);
  const config={harnessId:'pi',provider:'synthetic',modelId:'synthetic',thinkingLevel:'off' as const,instructions:DEFAULT_AUTO_RESPOND_INSTRUCTIONS,stopInstructions:DEFAULT_AUTO_RESPOND_STOP_INSTRUCTIONS,maxResponses:10};
  await assert.rejects(enableAutoRespond(f.team.projectId,resolved.destination.sessionId,config,null),/team/i);
  assert.equal(await autoRespondHeldBack({projectId:f.team.projectId,conversationId:resolved.destination.sessionId,enabledBy:null,creatorAccountId:f.member.accountId} as any),true);
  const settings=getGuardianSettings();
  try{updateGuardianSettings({...settings,enabled:false});assert.match((await teamAgentReadiness({...resolved.profile,allowTerminal:true})).join(' '),/production.*guard/i);assert.match((await teamAgentReadiness({...resolved.profile,allowTerminal:false})).join(' '),/production.*guard/i);
   assert.equal((await checkGuardian({projectId:f.team.projectId,conversationId:resolved.destination.sessionId,harness:'pi',cwd:process.cwd(),canReplaceTool:true},{kind:'tool',tool:'write',category:'file-changes',input:{path:'/synthetic-production/file',content:'synthetic'}})).action,'block');
  }finally{updateGuardianSettings(settings);}
 }
 assert.equal(await personalContinuationAllowed('private','ordinary'),true);
 const guarded=withProductionGuard(getGuardianSettings());assert.equal(productionGuardStatus(guarded),'on');
 assert.notEqual(productionGuardStatus({...guarded,rules:guarded.rules.map(r=>({...r,check:'outgoing'}))}),'on','an outgoing-only rule is not a production command guard');
});

test('Guardian approval is exact-operation, real-member, live-request and single-use; confidence is not approval',async()=>{
 const f=await fixture();const [initial]=await acceptTeamAssignment(f.member,await f.message('/qa production review'),['qa'],null);await routeTeamAssignment(initial.id,{kind:'new'});
 const a=(await getTeamAssignment(initial.id))!,resolved=await teamAssignmentDestination(a);
 await beginPersonalAssistantTurn(f.team.executorAccountId,resolved.profile.id,a.requestId,`pi:${resolved.destination.sessionId}`,'review fixture','assistant');
 promptStarted(f.team.projectId,resolved.destination.sessionId,a.requestId);
 const other=createLocalUser({username:`approver${randomUUID().slice(0,6)}`,email:'approver@example.test'}).user;addClusterLocalMember(f.db,f.team.clusterId,other.accountId);
 const session:AuthSession={...f.session,accountId:other.accountId,username:other.username,userId:other.id};
 const member=await requireTeamMember(session,f.team.id);
 let settled=false;
 const pending=requestGuardianReview({projectId:f.team.projectId,conversationId:resolved.destination.sessionId,title:'Deploy exact operation',subject:'deploy production --revision abc',detail:'Agent confidence 0.99'},undefined,5000).then(answer=>{settled=true;return answer;});
 try{
  // Team binding may resolve asynchronously, but the open-review event is the authoritative state machine.
  for(let i=0;i<100&&!pendingGuardianReviews(f.team.projectId,resolved.destination.sessionId).length;i++)await new Promise(r=>setTimeout(r,1));
  const review=pendingGuardianReviews(f.team.projectId,resolved.destination.sessionId)[0];assert.ok(review);
  assert.equal(settled,false);
  assert.equal(decideGuardianReview(f.team.projectId,resolved.destination.sessionId,review.id,'allow'),false,'generic owner endpoint cannot approve a team operation');
  await assert.rejects(resolveTeamApproval({...member},a.id,review.id,true),/Unverified/);
  await assert.rejects(resolveTeamApproval(member,'wrong-assignment',review.id,true));
  removeClusterLocalMember(f.db,f.team.clusterId,member.accountId);
  await assert.rejects(resolveTeamApproval(member,a.id,review.id,true),/member/i);
  addClusterLocalMember(f.db,f.team.clusterId,member.accountId);
  await resolveTeamApproval(member,a.id,review.id,true);assert.equal(await pending,'allow');
  await assert.rejects(resolveTeamApproval(member,a.id,review.id,true),/open|answered/i);
  assert.equal(await requestGuardianReview({projectId:f.team.projectId,conversationId:resolved.destination.sessionId,title:'Deploy exact operation',subject:'deploy production --revision abc',detail:'Agent confidence 0.99'},undefined,100),'block','same operation in the same request cannot retry its approval');
  const audit=(await assignmentDatabase()).prepare('SELECT record FROM assistant_team_approvals WHERE review_id=?').get(review.id)!;
  assert.equal(JSON.parse(audit.record as string).approvedBy,member.accountId);
  assert.notEqual(member.accountId,f.team.executorAccountId);
 }finally{cancelGuardianReviews(f.team.projectId,resolved.destination.sessionId);promptEnded(f.team.projectId,resolved.destination.sessionId,a.requestId);await pending;}
});

test('real session/CSRF team approval endpoint carries a second human, never confidence or owner impersonation',async()=>{
 const f=await fixture();const server=createServer((await import('../src/app.js')).createApp());
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const created=createLocalUser({username:'httpapprover',email:'httpapprover@example.test'});
 const login=authenticate(created.user.username,created.oneTimePassword) as AuthSession;
 changePassword(login,created.oneTimePassword,'Synthetic-new-password-123!');
 const authenticated=authenticate(created.user.username,'Synthetic-new-password-123!') as AuthSession;
 const headers={'Content-Type':'application/json',Cookie:`${sessionCookieName}=${authenticated.id}`,'X-CSRF-Token':authenticated.csrfToken};
 const [initial]=await acceptTeamAssignment(f.member,await f.message('/qa real guarded operation'),['qa'],null);await routeTeamAssignment(initial.id,{kind:'new'});
 const a=(await getTeamAssignment(initial.id))!,resolved=await teamAssignmentDestination(a);
 await beginPersonalAssistantTurn(f.team.executorAccountId,resolved.profile.id,a.requestId,`pi:${resolved.destination.sessionId}`,'guarded fixture','assistant');promptStarted(f.team.projectId,resolved.destination.sessionId,a.requestId);
 const settings=getGuardianSettings(),original=globalThis.fetch;let modelCalls=0;
 updateGuardianSettings({...withProductionGuard(settings),enabled:true,model:'laya-remote',layaUrl:'http://127.0.0.1:19009',rules:withProductionGuard(settings).rules.filter(r=>r.id==='production-or-destructive')});
 globalThis.fetch=async(input,init)=>{
  if(String(input).startsWith('http://127.0.0.1:19009')){modelCalls++;const body=JSON.parse(String(init?.body));return Response.json({answers:Object.fromEntries(Object.keys(body.questions).map(id=>[id,{type:'noul',noul:.99}]))});}
  return original(input,init);
 };
 const pending=checkGuardian({projectId:f.team.projectId,conversationId:resolved.destination.sessionId,harness:'pi',cwd:process.cwd(),canReplaceTool:true},{kind:'tool',tool:'bash',category:'commands',input:{command:'synthetic deployment operation --revision exact'}});
 try{
  for(let i=0;i<200&&!pendingGuardianReviews(f.team.projectId,resolved.destination.sessionId).length;i++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(modelCalls,1);const review=pendingGuardianReviews(f.team.projectId,resolved.destination.sessionId)[0];assert.ok(review,'0.99 confidence asks, never approves');
  const endpoint=`${url}/api/assistant-teams/${f.team.id}/assignments/${a.id}/reviews/${review.id}`;
  const post=(body:unknown,custom=headers)=>fetch(endpoint,{method:'POST',headers:custom,body:JSON.stringify(body)});
  assert.equal((await post({allow:true})).status,403,'authenticated outsider cannot approve');
  addClusterLocalMember(f.db,f.team.clusterId,created.user.accountId);
  assert.equal((await post({allow:true},{...headers,'X-CSRF-Token':'forged'})).status,403);
  assert.equal((await post({allow:true,confidence:.99})).status,400,'agent confidence not a human decision schema');
  const listed=await fetch(`${url}/api/assistant-teams/${f.team.id}/reviews`,{headers});assert.equal(listed.status,200);assert.equal((await listed.json() as any).reviews[0].id,review.id);
  assert.equal((await post({allow:true})).status,200);assert.deepEqual(await pending,{action:'continue'});
  assert.equal((await post({allow:true})).status,409);
  const audit=JSON.parse((f.db.prepare('SELECT record FROM assistant_team_approvals WHERE review_id=?').get(review.id)!.record) as string);assert.equal(audit.approvedBy,created.user.accountId);
  const [waiting]=await acceptTeamAssignment(f.member,await f.message('/qa choose subject'),['qa'],null);
  const routeUrl=`${url}/api/assistant-teams/${f.team.id}/assignments/${waiting.id}/route`;
  assert.equal((await fetch(routeUrl,{method:'POST',headers,body:JSON.stringify({kind:'continue',subjectId:'foreign'})})).status,403);
  assert.equal((await fetch(routeUrl,{method:'POST',headers,body:JSON.stringify({kind:'new'})})).status,200);
  assert.ok((await getTeamAssignment(waiting.id))!.subjectId);
  assert.equal((await fetch(routeUrl,{method:'POST',headers,body:JSON.stringify({kind:'new'})})).status,409);
 }finally{cancelGuardianReviews(f.team.projectId,resolved.destination.sessionId);await pending;promptEnded(f.team.projectId,resolved.destination.sessionId,a.requestId);globalThis.fetch=original;updateGuardianSettings(settings);await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
