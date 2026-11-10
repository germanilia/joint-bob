import { randomUUID } from 'node:crypto';
import { createAdministrator, localAccountIdForUsername, type AuthSession } from '../src/auth.js';
import { getClusterNode } from '../src/cluster.js';
import { createMembershipCluster } from '../src/cluster-membership.js';
import { addClusterLocalMember } from '../src/cluster-accounts.js';
import { requireClusterMember, requireTeamMember } from '../src/assistant-teams/access.js';
import { createTeam, prepareTeamProject, teamDatabase } from '../src/assistant-teams/store.js';
import { telegramDatabase, saveTeamTelegramConnection } from '../src/assistant-teams/telegram-store.js';
import { ingestTeamTelegramUpdate } from '../src/assistant-teams/telegram.js';
import { saveSecretAccount } from '../src/secrets.js';
import { initializeTeamAgents } from '../src/assistant-teams/runtime.js';

export async function fixture() {
 const db = await teamDatabase(), host = await getClusterNode(), username = 'assignment';
 if (!localAccountIdForUsername(username)) createAdministrator(username, 'Synthetic-password-123!', false);
 const accountId = localAccountIdForUsername(username)!;
 const session: AuthSession = { id:randomUUID(),userId:randomUUID(),accountId,username,homeNodeId:null,isRemoteLogin:false,email:null,role:'admin',csrfToken:'fixture',mustChangePassword:false };
 const clusterId=randomUUID(); createMembershipCluster(db,{nodeId:host.id,name:'host',url:'http://127.0.0.1:19001'},{id:clusterId,name:'assignments'}); addClusterLocalMember(db,clusterId,accountId);
 const actor=await requireClusterMember(session,clusterId), team=await createTeam(actor,{projectId:await prepareTeamProject(actor),executorAccountId:accountId});
 const member=await requireTeamMember(session,team.id);
 await telegramDatabase(); const secret=await saveSecretAccount({label:'fake telegram',provider:'custom',variables:[{name:'TELEGRAM_BOT_TOKEN',kind:'value',value:'synthetic-token'}]});
 saveTeamTelegramConnection(db,{teamId:team.id,botId:randomUUID(),botUsername:'fixture_bot',tokenAccountId:secret.id,headerSecret:'secret',readsAllGroupMessages:true});
 db.prepare('INSERT INTO assistant_team_telegram_members VALUES(?,?,?,?)').run(team.id,accountId,'7','human'); db.prepare('INSERT INTO assistant_team_telegram_groups VALUES(?,?)').run(team.id,'-1');
 let id=0; const message=async(text:string,extra:object={})=>(await ingestTeamTelegramUpdate(team.id,{update_id:++id,message:{message_id:id,chat:{id:-1,type:'supergroup'},from:{id:7},date:1,text,...extra}}))!.message;
 await initializeTeamAgents(team);
 return {db,team,member,session,message};
}
