import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { api, seedDevEnvironment, startDevNode, stopDevNode, signIn } from './dev-nodes.js';
import { teamDatabase, createTeam, prepareTeamProject } from '../src/assistant-teams/store.js';
import { requireClusterMember } from '../src/assistant-teams/access.js';
import { getClusterNode } from '../src/cluster.js';
import { createAdministrator, createLocalUser, localAccountIdForUsername, type AuthSession } from '../src/auth.js';
import { createMembershipCluster } from '../src/cluster-membership.js';
import { addClusterLocalMember } from '../src/cluster-accounts.js';
import { telegramDatabase, saveTeamTelegramConnection } from '../src/assistant-teams/telegram-store.js';
import { ingestTeamTelegramUpdate } from '../src/assistant-teams/telegram.js';
import { directTeamTargets, listPendingTeamEvents, teamMessageHistory, listTeamHistory, recordTeamOutput, saveTeamSubject, teamSubjectCandidates, onTeamInbox, bindTeamMessageSubject, bindTeamConversation } from '../src/assistant-teams/conversations.js';

test('durable full history, edit versions, pending dedup, scoped reply routing and entity-safe aliases',async()=>{
 const db=await teamDatabase(),host=await getClusterNode();createAdministrator('context','Synthetic-password-123!',false);
 const accountId=localAccountIdForUsername('context')!;
 const session:AuthSession={id:randomUUID(),userId:randomUUID(),accountId,username:'context',homeNodeId:null,isRemoteLogin:false,email:null,role:'admin',csrfToken:'fixture',mustChangePassword:false};
 const clusterId=randomUUID();createMembershipCluster(db,{nodeId:host.id,name:'host',url:'http://127.0.0.1:19001'},{id:clusterId,name:'context'});addClusterLocalMember(db,clusterId,accountId);
 const actor=await requireClusterMember(session,clusterId),team=await createTeam(actor,{projectId:await prepareTeamProject(actor),executorAccountId:accountId});
 await telegramDatabase();saveTeamTelegramConnection(db,{teamId:team.id,botId:'1',botUsername:'fixture_bot',tokenAccountId:'fixture',headerSecret:'secret',readsAllGroupMessages:true});
 db.prepare('INSERT INTO assistant_team_telegram_members VALUES(?,?,?,?)').run(team.id,accountId,'7','human');db.prepare('INSERT INTO assistant_team_telegram_groups VALUES(?,?)').run(team.id,'-1');
 let notifications=0;const stop=onTeamInbox(()=>{notifications++;});
 const update=(id:number,text:string,extra:object={})=>({update_id:id,message:{message_id:id,chat:{id:-1,type:'supergroup'},from:{id:7,is_bot:false},date:1,message_thread_id:10,text,...extra}});
 const first=await ingestTeamTelegramUpdate(team.id,update(1,'x'.repeat(4000)));assert.equal(first!.message.text.length,4000);
 assert.equal((await ingestTeamTelegramUpdate(team.id,update(1,'changed')))!.duplicate,true);
 for(let i=2;i<=205;i++)await ingestTeamTelegramUpdate(team.id,update(i,'history'));
 assert.equal((await listPendingTeamEvents(team.id,300)).length,205);assert.equal(notifications,205);
 const edit=update(500,'edited');const edited=await ingestTeamTelegramUpdate(team.id,{update_id:500,edited_message:{...edit.message,message_id:1,edit_date:2}});
 assert.equal(edited!.message.revision,2);assert.equal((await teamMessageHistory(first!.message.id)).length,2);assert.equal((await listPendingTeamEvents(team.id,300)).length,205);
 assert.equal((await listTeamHistory(team.id,'-1',10,300)).length,205);
 assert.equal(await ingestTeamTelegramUpdate(team.id,update(600,'/qa',{from:{id:8}})),null);
 assert.equal(await ingestTeamTelegramUpdate(team.id,update(601,'/qa',{from:{id:7,is_bot:true}})),null);
 for(const [text,entities,targets] of [
 ['/qa check',[],['qa']],['@product @designer work',[],['product','designer']],['@fixture_bot help',[],['bob']],['/unknown help',[],[]],['quoted /qa',[],[]],['`@qa`',[],[]],['@qa', [{type:'code',offset:0,length:3}],[]],['@qa',[{type:'blockquote',offset:0,length:3}],[]]
 ] as const){const m=await ingestTeamTelegramUpdate(team.id,update(700+notifications,text,{entities}));assert.deepEqual(await directTeamTargets(m!.message),targets);}
 await saveTeamSubject({id:'qa-subject',teamId:team.id,title:'QA',summary:'testing'},'-1',10);
 await saveTeamSubject({id:'other-topic',teamId:team.id,title:'Other',summary:''},'-1',11);
 await bindTeamMessageSubject(team.id,first!.message.id,'qa-subject');
 createLocalUser({username:'secondhuman',email:'second@example.invalid'});const second=localAccountIdForUsername('secondhuman')!;addClusterLocalMember(db,clusterId,second);db.prepare('INSERT INTO assistant_team_telegram_members VALUES(?,?,?,?)').run(team.id,second,'8','second');
 await saveTeamSubject({id:'product-subject',teamId:team.id,title:'Product',summary:'unrelated'},'-1',10);
 const interleaved=await ingestTeamTelegramUpdate(team.id,update(849,'unrelated product',{from:{id:8}}));await bindTeamMessageSubject(team.id,interleaved!.message.id,'product-subject');
 const humanReply=await ingestTeamTelegramUpdate(team.id,update(850,'follow up',{from:{id:8},reply_to_message:{message_id:1}}));assert.deepEqual((await teamSubjectCandidates(team.id,humanReply!.message)).map(s=>s.id),['qa-subject']);
 const {initializeTeamAgents}=await import('../src/assistant-teams/runtime.js');const agents=await initializeTeamAgents(team);const conversationId=randomUUID();
 await bindTeamConversation(team.id,'qa-subject',agents[0].assistantId,conversationId);await bindTeamConversation(team.id,'qa-subject',agents[0].assistantId,conversationId);
 await assert.rejects(bindTeamConversation(team.id,'qa-subject',agents[0].assistantId,randomUUID()));
 assert.equal((db.prepare('SELECT conversation_id FROM assistant_team_conversations WHERE team_id=?').get(team.id) as any).conversation_id,conversationId);
 await recordTeamOutput({teamId:team.id,chatId:'-1',threadId:10,telegramMessageId:900,role:'qa',subjectId:'qa-subject',assignmentId:'assignment',text:'QA result'});
 const reply=await ingestTeamTelegramUpdate(team.id,update(901,'continue',{reply_to_message:{message_id:900}}));
 assert.equal(reply!.message.replyToMessageId,900);assert.deepEqual(await directTeamTargets(reply!.message),['qa']);assert.deepEqual((await teamSubjectCandidates(team.id,reply!.message)).map(s=>s.id),['qa-subject']);
 const other=await ingestTeamTelegramUpdate(team.id,update(902,'continue',{message_thread_id:11,reply_to_message:{message_id:900}}));assert.deepEqual(await directTeamTargets(other!.message),[]);
 const media=await ingestTeamTelegramUpdate(team.id,update(950,'caption',{media_group_id:'album',document:{file_id:'large',file_unique_id:'unique',file_name:'large.txt',mime_type:'text/plain',file_size:21*1024*1024}}));
 assert.equal(media!.message.albumId,'album');assert.equal(media!.message.attachments[0].fileId,'large');assert.match(media!.message.attachments[0].problem!,/20 MB/);
 const unsupported=await ingestTeamTelegramUpdate(team.id,update(951,'',{poll:{question:'vote'}}));assert.deepEqual(unsupported!.message.unsupported,['poll']);
 const {saveSecretAccount}=await import('../src/secrets.js');const {TELEGRAM_TOKEN_VARIABLE}=await import('../src/webhook-telegram.js');
 const secret=await saveSecretAccount({label:'fixture',provider:'custom',replicate:false,variables:[{name:TELEGRAM_TOKEN_VARIABLE,kind:'value',value:'synthetic-token'}]});db.prepare('UPDATE assistant_team_telegram SET token_account_id=? WHERE team_id=?').run(secret.id,team.id);
 const fetchBefore=globalThis.fetch;let downloads=0;
 globalThis.fetch=async(input)=>{downloads++;const url=String(input);if(url.includes('/getFile'))return Response.json({ok:true,result:{file_path:'fixture.txt',file_size:5}});if(url.includes('/file/'))return new Response('hello');throw new Error('Unexpected network call');};
 try{
 const fileUpdate=update(952,'file',{document:{file_id:'small',file_unique_id:'small',file_name:'small.txt',mime_type:'text/plain',file_size:5}});
 const file=await ingestTeamTelegramUpdate(team.id,fileUpdate);assert.equal(file!.message.attachments[0].extractedText,'hello');assert.ok(file!.message.attachments[0].path);assert.equal(downloads,2);
 await ingestTeamTelegramUpdate(team.id,fileUpdate);assert.equal(downloads,2,'duplicate does not download again');
 const before=downloads;assert.equal(await ingestTeamTelegramUpdate(team.id,update(953,'/qa',{from:{id:99},document:{file_id:'no',file_unique_id:'no'}})),null);assert.equal(downloads,before,'unauthorized input causes no external call');
 }finally{globalThis.fetch=fetchBefore;}
 stop();
});

test('real HTTP enrollment and webhook persist before acknowledgment; pending survives server restart', {timeout:120000}, async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'team-telegram-http-'));let server:Awaited<ReturnType<typeof startDevNode>>|undefined;let db:DatabaseSync|undefined;
 try{
 const env=await seedDevEnvironment(root,1),node=env.nodes[0];server=await startDevNode(env,node);const login=await signIn(env,node);
 const cluster=await api<any>(node,login,'POST','/clusters',{name:'Telegram fixture'});assert.equal(cluster.status,201);
 const created=await api<any>(node,login,'POST','/assistant-teams',{clusterId:cluster.body.snapshot.body.clusterId});assert.equal(created.status,201);const teamId=created.body.team.id,base=`/assistant-teams/${teamId}/telegram`;
 assert.equal((await api(node,login,'GET',base)).status,200);
 db=new DatabaseSync(path.join(node.dataDir,'node.db'));saveTeamTelegramConnection(db,{teamId,botId:'http-fixture',botUsername:'http_fixture_bot',tokenAccountId:'synthetic',headerSecret:'http-secret',readsAllGroupMessages:true});
 const hook=async(update:unknown,secret='http-secret')=>fetch(`${node.url}/hooks/teamtelegram-${teamId}`,{method:'POST',headers:{'Content-Type':'application/json','x-telegram-bot-api-secret-token':secret},body:JSON.stringify(update)});
 assert.equal((await hook({},'forged')).status,401);
 assert.equal((await fetch(`${node.url}/api${base}/enrollment`,{method:'POST',headers:{Cookie:login.cookie,'Content-Type':'application/json'},body:'{}'})).status,403);
 const enrollment=await api<any>(node,login,'POST',`${base}/enrollment`,{});assert.equal(enrollment.status,200);
 const msg=(id:number,text:string,type='supergroup')=>({update_id:id,message:{message_id:id,chat:{id:type==='private'?7:-1,type},from:{id:7,first_name:'Human'},date:1,text}});
 assert.equal((await hook(msg(1,`/start ${new URL(enrollment.body.link).searchParams.get('start')}`,'private'))).status,200);
 assert.equal((await api(node,login,'POST',`${base}/enrollment/${enrollment.body.id}/confirm`,{})).status,200);
 const challenge=await api<any>(node,login,'POST',`${base}/group`,{});assert.equal((await hook(msg(2,`/bind ${challenge.body.code}`))).status,200);
 assert.equal((await api(node,login,'POST',`${base}/group/${challenge.body.id}/confirm`,{})).status,200);
 assert.equal((await hook(msg(3,'/qa check'))).status,200);
 const count=()=>Number((db!.prepare("SELECT COUNT(*) n FROM assistant_team_inbox WHERE team_id=? AND state='pending'").get(teamId) as {n:number}).n);
 assert.equal(count(),1,'durable before HTTP success');
 await stopDevNode(server);server=undefined;server=await startDevNode(env,node);
 assert.equal((await hook(msg(3,'/qa check'))).status,200);assert.equal(count(),1,'deduplicated delivery must not consume pending work after restart');
 const unauthorized=msg(4,'/qa outsider');unauthorized.message.from.id=88;assert.equal((await hook(unauthorized)).status,200);assert.equal(count(),1);
 }finally{if(server)await stopDevNode(server);db?.close();await rm(root,{recursive:true,force:true});}
});
