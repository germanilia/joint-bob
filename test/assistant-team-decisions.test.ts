import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { proactiveDisposition, decideTeamMessage, listTeamDecisions } from '../src/assistant-teams/decisions.js';
import { teamDatabase, createTeam, prepareTeamProject } from '../src/assistant-teams/store.js';
import { requireClusterMember } from '../src/assistant-teams/access.js';
import { getClusterNode } from '../src/cluster.js';
import { createAdministrator, localAccountIdForUsername, type AuthSession } from '../src/auth.js';
import { createMembershipCluster } from '../src/cluster-membership.js';
import { addClusterLocalMember } from '../src/cluster-accounts.js';
import { telegramDatabase, saveTeamTelegramConnection } from '../src/assistant-teams/telegram-store.js';
import { ingestTeamTelegramUpdate } from '../src/assistant-teams/telegram.js';
import { saveTeamSubject, recordTeamOutput, getTeamMessage, bindTeamMessageSubject, persistTeamMessage } from '../src/assistant-teams/conversations.js';
import { saveSecretAccount } from '../src/secrets.js';
import { systemAiDefaults } from '../src/system-ai-config.js';
import { save, settingsDatabase } from '../src/settings-store.js';
import { bobDatabase, writeBobSettings, readBobSettings } from '../src/control-center/bob-store.js';
import { getGuardianSettings, updateGuardianSettings } from '../src/guardian/settings.js';

const defaults = { askThreshold: .8, actThreshold: .95 };
test('strict affirmative thresholds; invalid confidence/settings fail closed', () => {
 for (const [confidence, expected] of [[.96,'act'],[.95,'ask'],[.81,'ask'],[.8,'silent']] as const) assert.equal(proactiveDisposition('act',confidence,defaults),expected);
 for(const confidence of [0,.8,.99,1]) assert.equal(proactiveDisposition('none',confidence,defaults),'silent');
 assert.equal(proactiveDisposition('act',.91,{askThreshold:.7,actThreshold:.9}),'act');
 for(const confidence of [NaN,Infinity,-.1,1.01]) assert.equal(proactiveDisposition('act',confidence,defaults),'silent');
 for(const settings of [{askThreshold:NaN,actThreshold:1},{askThreshold:0,actThreshold:Infinity},{askThreshold:-.1,actThreshold:.9},{askThreshold:.9,actThreshold:.9},{askThreshold:1,actThreshold:.9},{askThreshold:0,actThreshold:1.1}]) assert.equal(proactiveDisposition('act',1,settings),'silent');
});

test('central batched decisions, deterministic replies, scoped evidence and durable failclosed diagnostics',async()=>{
 const db=await teamDatabase(),host=await getClusterNode();createAdministrator('decision','Synthetic-password-123!',false);
 const accountId=localAccountIdForUsername('decision')!;
 const session:AuthSession={id:randomUUID(),userId:randomUUID(),accountId,username:'decision',homeNodeId:null,isRemoteLogin:false,email:null,role:'admin',csrfToken:'fixture',mustChangePassword:false};
 const clusterId=randomUUID();createMembershipCluster(db,{nodeId:host.id,name:'host',url:'http://127.0.0.1:19001'},{id:clusterId,name:'decision'});addClusterLocalMember(db,clusterId,accountId);
 const actor=await requireClusterMember(session,clusterId),team=await createTeam(actor,{projectId:await prepareTeamProject(actor),executorAccountId:accountId});
 await (await import('./team-members-fixture.js')).seedTeamMembers(team);
 await telegramDatabase();saveTeamTelegramConnection(db,{teamId:team.id,botId:'1',botUsername:'fixture_bot',tokenAccountId:'fixture',headerSecret:'secret',readsAllGroupMessages:true});
 db.prepare('INSERT INTO assistant_team_telegram_members VALUES(?,?,?,?)').run(team.id,accountId,'7','human');db.prepare('INSERT INTO assistant_team_telegram_groups VALUES(?,?)').run(team.id,'-1');
 const secret=await saveSecretAccount({label:'central',provider:'typesafe',variables:[{name:'TYPESAFE_AI_API_KEY',kind:'value',value:'synthetic-central-key'}]});
 const config=systemAiDefaults();config.decision.typesafeAccountId=secret.id;save(settingsDatabase(),'systemAI',JSON.stringify(config));
 // An unrelated personal classifier preference must never select the team classifier.
 writeBobSettings(await bobDatabase(),accountId,{classifier:'laya',modelId:'personal-executing-model'});
 assert.equal(readBobSettings(db,accountId).classifier,'laya');
 let id=0;const message=async(text:string,extra:object={})=>(await ingestTeamTelegramUpdate(team.id,{update_id:++id,message:{message_id:id,chat:{id:-1,type:'supergroup'},from:{id:7},date:1,text,...extra}}))!.message;
 await saveTeamSubject({id:'ours',teamId:team.id,title:'Our subject',summary:'Team testing'},'-1',null);
 await saveTeamSubject({id:'foreign',teamId:'another-team',title:'FOREIGN_SECRET',summary:'private'},'-1',null);
 await saveTeamSubject({id:'thread',teamId:team.id,title:'THREAD_SECRET',summary:'private'},'-1',10);
 const outside=await message('placeholder');const outsider=await persistTeamMessage({...outside,id:randomUUID(),telegramMessageId:999,telegramUserId:'outsider',accountId:'outsider',text:'OUTSIDER_SECRET'},999,false);
 const originalFetch=globalThis.fetch;let calls=0;let subject='new';let attention='act';let confidence=.96;let malformed:unknown=undefined;let last:any;
 globalThis.fetch=async(_input,init)=>{calls++;last=JSON.parse(String(init?.body));assert.equal(last.model,'jev-latest');assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer synthetic-central-key');assert.ok(!JSON.stringify(last).includes('FOREIGN_SECRET'));assert.ok(!JSON.stringify(last).includes('THREAD_SECRET'));assert.ok(!JSON.stringify(last).includes('OUTSIDER_SECRET'));
 const answers=Object.fromEntries(Object.keys(last.questions).map(key=>[key,{type:'choice',choice:key==='attention'?attention:key==='subject'?subject:'learn',confidence:key==='attention'?confidence:.01}]));
 return Response.json({answers:malformed===undefined?answers:malformed});};
 try {
 assert.equal(await decideTeamMessage(team,outsider.message),null);assert.equal(calls,0);assert.equal((await listTeamDecisions(team.id))[0].failure?.code,'access_denied');
 const m=await message('Please investigate');assert.deepEqual(await decideTeamMessage(team,m),{attention:'act',targets:['bob'],route:{kind:'new'},learn:true});assert.equal(calls,1);assert.deepEqual(Object.keys(last.questions).sort(),['attention','memory','subject']);
 for(const [value,expected] of [[.95,'ask'],[.81,'ask'],[.80,'silent']] as const){confidence=value;assert.equal((await decideTeamMessage(team,await message('monitor boundary')))!.attention,expected);}
 attention='none';confidence=.99;assert.equal((await decideTeamMessage(team,await message('durable fact')))!.attention,'silent');
 attention='act';confidence=.01;const direct=await message('/qa check this');assert.deepEqual(await decideTeamMessage(team,direct),{attention:'direct',targets:['qa'],route:{kind:'new'},learn:true});assert.ok(!last.questions.attention);
 subject='clarify';assert.equal((await decideTeamMessage(team,await message('/qa which one?')))!.route.kind,'clarify');assert.equal((await listTeamDecisions(team.id))[0].waitingReason,'subject_clarification');
 await recordTeamOutput({teamId:team.id,chatId:'-1',threadId:null,telegramMessageId:900,role:'qa',subjectId:'ours',assignmentId:'a',text:'result'});
 const reply=await message('continue',{reply_to_message:{message_id:900}});assert.deepEqual((await decideTeamMessage(team,reply))!.route,{kind:'continue',subjectId:'ours'});assert.ok(!last.questions.subject);
 await bindTeamMessageSubject(team.id,m.id,'ours');assert.deepEqual((await decideTeamMessage(team,await message('human reply',{reply_to_message:{message_id:m.telegramMessageId}})))!.route,{kind:'continue',subjectId:'ours'});assert.ok(!last.questions.subject);
 await recordTeamOutput({teamId:team.id,chatId:'-1',threadId:null,telegramMessageId:901,role:'qa',subjectId:'missing-subject',assignmentId:'dangling',text:'old result'});
 assert.deepEqual((await decideTeamMessage(team,await message('follow up',{reply_to_message:{message_id:901}})))!.route,{kind:'clarify'});assert.ok(!last.questions.subject);
 subject='new';const long=await message('a'.repeat(140000));await decideTeamMessage(team,long);assert.ok(last.state.length<=120000);assert.equal((await getTeamMessage(team.id,long.id))!.text.length,140000);
 const audit=(await listTeamDecisions(team.id))[0];assert.equal(audit.model,'typesafe');assert.equal(audit.settingsRevision,(await (await import('../src/assistant-teams/store.js')).getTeam(team.id)).revision);assert.ok(audit.evidenceMessageIds.includes(long.id));assert.equal(audit.answers!.attention.confidence,.01);assert.ok(!JSON.stringify(audit).includes('synthetic-central-key'));
 for(const answer of [null,{}, {attention:{type:'choice',choice:'act',confidence:2}}, {attention:{type:'choice',choice:'act',confidence:NaN}}, {attention:{type:'choice',choice:'unknown',confidence:.99}}]) {malformed=answer;assert.equal(await decideTeamMessage(team,await message('bad answer')),null);assert.equal((await listTeamDecisions(team.id))[0].failure?.code,'decision_unavailable_or_invalid');}
 // Complete but invalid answers isolate confidence/catalog validation from missing-question validation.
 for(const bad of [{choice:'act',confidence:null},{choice:'act',confidence:-.1},{choice:'act',confidence:1.01},{choice:'unexpected',confidence:.99}]){
 malformed={attention:{type:'choice',...bad},subject:{type:'choice',choice:'new',confidence:1},memory:{type:'choice',choice:'none',confidence:1}};
 assert.equal(await decideTeamMessage(team,await message('invalid complete answer')),null);
 }
 malformed=undefined;globalThis.fetch=async()=>{throw new Error('synthetic-central-key');};assert.equal(await decideTeamMessage(team,await message('/qa outage')),null);const failed=(await listTeamDecisions(team.id))[0];assert.equal(failed.status,'failed');assert.equal(failed.waitingReason,'decision_failed');assert.ok(!JSON.stringify(failed).includes('synthetic-central-key'));
 const before=calls;assert.equal(await decideTeamMessage(team,{...m,teamId:'another-team'}),null);assert.equal(calls,before);
 const guardian=getGuardianSettings();
 try {
 updateGuardianSettings({...guardian,layaUrl:'http://127.0.0.1:19876'});config.decision.model='laya';save(settingsDatabase(),'systemAI',JSON.stringify(config));
 writeBobSettings(db,accountId,{classifier:'typesafe'});
 globalThis.fetch=async(url,init)=>{assert.equal(String(url),'http://127.0.0.1:19876/v1/systemone');const request=JSON.parse(String(init?.body));assert.equal(request.model,'multilingual');assert.ok(request.state.length<=3500);assert.equal(new Headers(init?.headers).get('Authorization'),null);return Response.json({answers:Object.fromEntries(Object.keys(request.questions).map(key=>[key,{type:'choice',choice:key==='subject'?'new':'none',confidence:.99}]))});};
 assert.equal((await decideTeamMessage(team,await message('x'.repeat(10000))))!.attention,'silent');assert.equal((await listTeamDecisions(team.id))[0].model,'laya');
 }finally{updateGuardianSettings(guardian);}
 config.decision.model='typesafe';config.decision.typesafeAccountId=randomUUID();save(settingsDatabase(),'systemAI',JSON.stringify(config));
 globalThis.fetch=async()=>{assert.fail('missing system key must not call any provider');};
 assert.equal(await decideTeamMessage(team,await message('/qa missing credential')),null);assert.equal((await listTeamDecisions(team.id))[0].failure?.code,'credentials_unavailable');
 }finally{globalThis.fetch=originalFetch;save(settingsDatabase(),'systemAI',JSON.stringify(systemAiDefaults()));}
});
