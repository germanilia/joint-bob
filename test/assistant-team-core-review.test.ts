import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './assistant-team-fixture.js';
import { accountIdFor } from '../src/accounts.js';
import { createMembershipInvitation, prepareMembershipJoin, redeemMembershipInvitation } from '../src/cluster-membership.js';
import { clusterPublicKeyFingerprint } from '../src/cluster-identity.js';
import { getClusterNode } from '../src/cluster.js';
import { applyAccountSnapshot } from '../src/user-replication.js';
import { requirePeerClusterMember, requireTeamExecution } from '../src/assistant-teams/access.js';
import { onTeamChange } from '../src/assistant-teams/store.js';
import { listResourceShares } from '../src/cluster-sharing-policy.js';
import { createLocalUser } from '../src/auth.js';
import { addClusterLocalMember, removeClusterLocalMember } from '../src/cluster-accounts.js';
import { projectVisible, addProject } from '../src/store.js';
import { asNode } from '../src/account-context.js';
import { resolveDataDirectory } from '../src/data-directory.js';
import { getResourcePolicyState, updateResourceSharing } from '../src/cluster-sharing.js';
import { getTeamAssignment } from '../src/assistant-teams/store.js';
import { teamAssignmentDestination } from '../src/assistant-teams/runtime.js';
import { beginPersonalAssistantTurn, finishPersonalAssistantTurn } from '../src/personal-assistants.js';
import { createTeamInquiry, openTeamRequests, acceptTeamAssignment, routeTeamAssignment, readTeamWork, recoverTeamWork, teamWorkStatus, confirmTeamInquiry, attachTeamRequestEvidence } from '../src/assistant-teams/assignments.js';
import { decideTeamMessage } from '../src/assistant-teams/decisions.js';
import { saveSecretAccount } from '../src/secrets.js';
import { systemAiDefaults } from '../src/system-ai-config.js';
import { save, settingsDatabase } from '../src/settings-store.js';
import { teamSubjectCandidates, saveTeamSubject, bindTeamMessageSubject, listPendingTeamEvents, finishTeamEvent, teamExecutionEvidence, getTeamMessage } from '../src/assistant-teams/conversations.js';

 test('received empty account snapshot supersedes claim-only identity permanently and invalidates idle readers',async()=>{
 const f=await fixture(),host=await getClusterNode(),home=randomUUID(),remote=new DatabaseSync(':memory:');
 try {
 const invite=createMembershipInvitation(f.db,host.id,host.id,f.team.clusterId,1);
 redeemMembershipInvitation(f.db,host.id,prepareMembershipJoin(remote,{nodeId:home,name:'home',url:'http://127.0.0.1:19002'},invite,clusterPublicKeyFingerprint(invite.body.manager.publicKey),randomUUID()),invite.secret);
 const claim={clusterId:f.team.clusterId,homeNodeId:home,username:'claimonly',accountId:accountIdFor(home,'claimonly')};
 await requirePeerClusterMember(home,claim);await requireTeamExecution(f.team.id,claim.accountId);
 const changes:string[]=[];const stop=onTeamChange(id=>changes.push(id));
 try {
 applyAccountSnapshot(f.db,host.id,home,{version:2,accounts:[]});
 await assert.rejects(requireTeamExecution(f.team.id,claim.accountId),/claim|snapshot|member/i);
 await assert.rejects(requirePeerClusterMember(home,claim),/claim|snapshot|member/i,'new facade claim cannot undo received revocation');
 await new Promise<void>(resolve=>queueMicrotask(resolve));
 assert.ok(changes.includes(f.team.id),'received account changes invalidate idle team readers');
 }finally{stop();}
 }finally{remote.close();}
 });
 test('semantic routing coalesces distinct messages, not distinct work in the same topic',async()=>{
 const f=await fixture(),original=globalThis.fetch;let selection='request_0',sends=0,requestQuestions=0;
 const secret=await saveSecretAccount({label:'central',provider:'typesafe',variables:[{name:'TYPESAFE_AI_API_KEY',kind:'value',value:'synthetic'}]});
 const config=systemAiDefaults();config.decision.typesafeAccountId=secret.id;save(settingsDatabase(),'systemAI',JSON.stringify(config));
 globalThis.fetch=async(_url,init)=>{
  const body=JSON.parse(String(init?.body));if(!body.questions)return Response.json({ok:true,result:{message_id:1000+ ++sends}});
  if(body.questions.request)requestQuestions++;
  return Response.json({answers:Object.fromEntries(Object.keys(body.questions).map(k=>[k,{type:'choice',choice:k==='attention'?'act':k==='memory'?'none':k==='request'?selection:body.questions.subject.criteria.subject_0?'subject_0':'new',confidence:.9}]))});
 };
 try{
 const first=await f.message('Checkout crashes on save');await recoverTeamWork(f.team.id);
 const secondHuman=createLocalUser({username:'secondevidence',email:'second-evidence@example.test'}).user;addClusterLocalMember(f.db,f.team.clusterId,secondHuman.accountId);
 f.db.prepare('INSERT INTO assistant_team_telegram_members VALUES(?,?,?,?)').run(f.team.id,secondHuman.accountId,'9','second');
 const second=await f.message('Same failure also loses the basket',{from:{id:9}});await recoverTeamWork(f.team.id);
 let status=await teamWorkStatus(f.member);assert.equal(status.inquiries.length,1);assert.equal(sends,1,'same pending request has only one question');assert.equal(requestQuestions,1);
 assert.deepEqual(f.db.prepare('SELECT message_id FROM assistant_team_request_evidence WHERE team_id=? ORDER BY rowid').all(f.team.id).map(r=>r.message_id),[first.id,second.id]);
 assert.equal(f.db.prepare('SELECT account_id FROM assistant_team_request_evidence WHERE message_id=?').get(second.id)!.account_id,secondHuman.accountId,'coalescing preserves the distinct human identity');
 selection='separate';await f.message('Also redesign checkout typography');await recoverTeamWork(f.team.id);
 status=await teamWorkStatus(f.member);assert.equal(status.inquiries.length,2,'same broad subject can contain distinct work');
 const inquiry=status.inquiries[0];await confirmTeamInquiry(f.member,inquiry.id,'confirm');
 selection='request_1'; // pending second request precedes the active first request in candidate order.
 const later=await f.message('Another reproduction for the original failure');
 const decision=await decideTeamMessage(f.team,later);assert.ok(decision?.requestId);
 assert.equal(await attachTeamRequestEvidence(f.member,later,decision.requestId),true);
 assert.equal((await readTeamWork(f.team.id)).length,1,'active request receives evidence without independent work');
 const otherThread=await f.message('Same words in another forum',{message_thread_id:99});
 assert.equal(await attachTeamRequestEvidence(f.member,otherThread,decision.requestId),false,'thread isolation is checked transactionally');
 for(const event of await listPendingTeamEvents(f.team.id))await finishTeamEvent(f.team.id,event.id,'decided');
 const active=(await getTeamAssignment((await readTeamWork(f.team.id))[0].assignmentId))!,destination=await teamAssignmentDestination(active);
 await beginPersonalAssistantTurn(f.team.executorAccountId,destination.profile.id,active.requestId,`pi:${destination.destination.sessionId}`,'fixture','assistant');
 await finishPersonalAssistantTurn(f.team.executorAccountId,destination.profile.id,active.requestId,'Confirmed completion');
 f.db.prepare("UPDATE assistant_team_work SET phase='dispatched' WHERE assignment_id=?").run(active.id);
 await recoverTeamWork(f.team.id);
 assert.equal((await getTeamAssignment(active.id))!.state,'completed');
 const fresh=await f.message('New work after completion');
 assert.ok(!(await openTeamRequests(fresh)).some(r=>r.id===active.rootId),'completed work is not an open routing candidate');
 assert.equal(await attachTeamRequestEvidence(f.member,fresh,active.rootId),false);
 selection='separate';const freshDecision=await decideTeamMessage(f.team,fresh);assert.equal(freshDecision?.requestId,undefined);
 await createTeamInquiry(f.member,fresh,['bob'],freshDecision!.route);
 assert.equal((await teamWorkStatus(f.member)).inquiries.length,3);
 }finally{globalThis.fetch=original;save(settingsDatabase(),'systemAI',JSON.stringify(systemAiDefaults()));}
 });
 test('assignment material includes preceding subject evidence with identity, not other topics',async()=>{
 const f=await fixture();
 await saveTeamSubject({id:'checkout',teamId:f.team.id,title:'Checkout',summary:''},'-1',null);
 const prior=await f.message('QUIET_FAILURE: saving basket returns 503');await bindTeamMessageSubject(f.team.id,prior.id,'checkout');
 await f.message('UNRELATED_PRIVATE_TOPIC');
 const call=await f.message('/qa investigate that',{reply_to_message:{message_id:prior.telegramMessageId}});
 const [a]=await acceptTeamAssignment(f.member,call,['qa'],null);await routeTeamAssignment(a.id,{kind:'continue',subjectId:'checkout'});
 const material=(await readTeamWork(f.team.id)).find(w=>w.assignmentId===a.id)!.message;
 assert.match(material,/QUIET_FAILURE/,'execution must receive prior evidence, not just the direct call');
 assert.match(material,new RegExp(prior.accountId));assert.doesNotMatch(material,/UNRELATED_PRIVATE_TOPIC/);
 const long=await f.message('FULL_SOURCE_MARKER '+ 'long evidence '.repeat(2000));await bindTeamMessageSubject(f.team.id,long.id,'checkout');
 const departed=createLocalUser({username:'departedevidence',email:'departed@example.test'}).user;
 addClusterLocalMember(f.db,f.team.clusterId,departed.accountId);
 f.db.prepare('INSERT INTO assistant_team_telegram_members VALUES(?,?,?,?)').run(f.team.id,departed.accountId,'9','departing');
 const removed=await f.message('REVOKED_SOURCE_MUST_NOT_LEAK',{from:{id:9}});await bindTeamMessageSubject(f.team.id,removed.id,'checkout');
 removeClusterLocalMember(f.db,f.team.clusterId,departed.accountId);
 const projection=await teamExecutionEvidence((await getTeamAssignment(a.id))!,call.text);
 assert.match(projection,/FULL_SOURCE_MARKER/);assert.doesNotMatch(projection,/REVOKED_SOURCE_MUST_NOT_LEAK|UNRELATED_PRIVATE_TOPIC/);
 assert.ok(projection.length<13000,'supplementary discussion is bounded independently of retained source size');
 assert.equal((await getTeamMessage(f.team.id,long.id))!.text,long.text,'projection never truncates retained sources');
 });
 test('pending new inquiry is a routable candidate before confirmation',async()=>{
 const f=await fixture(),source=await f.message('Checkout crashes when saving');
 await createTeamInquiry(f.member,source,['bob'],{kind:'new'});
 const next=await f.message('The same checkout crash also loses the basket');
 const candidates=await teamSubjectCandidates(f.team.id,next);
 assert.equal(candidates.length,1,'pending new request must be offered to semantic routing');
 });
 test('dedicated team project is shared only with selected cluster and visible to nonexecutor members',async()=>{
 const f=await fixture();
 assert.deepEqual(listResourceShares(f.db,'project',f.team.projectId).map(s=>s.clusterId),[f.team.clusterId]);
 const user=createLocalUser({username:'nonexecutor',email:'nonexecutor@example.test'}).user;
 const actor={accountId:user.accountId,username:user.username,role:null,homeNodeId:null,isRemoteLogin:false};
 assert.equal(await projectVisible(f.team.projectId,actor),false);
 addClusterLocalMember(f.db,f.team.clusterId,user.accountId);
 assert.equal(await projectVisible(f.team.projectId,actor),true,'ordinary project access must include current local team member');
 const privateProject=await asNode(()=>addProject('private',`${resolveDataDirectory()}/private-${randomUUID()}`));
 assert.equal(await projectVisible(privateProject.id,actor),false,'ordinary private ownership wall is unchanged');
 assert.throws(()=>updateResourceSharing(f.db,f.team.hostNodeId,'project',f.team.projectId,getResourcePolicyState(f.db,'project',f.team.projectId).generation,[{clusterId:randomUUID(),projectId:null}]),/selected cluster/);
 });
