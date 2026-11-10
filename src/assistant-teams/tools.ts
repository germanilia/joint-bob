import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpAgentIdentity } from '../mcp/agent.js';
import { z } from 'zod';
import { teamConversation } from './runtime.js';
import { assignmentDatabase, delegateTeamAssignment, readTeamWork, requireLiveTeamBob, teamDispatchActive } from './assignments.js';
import { getTeam, getTeamAssignment, listTeamAgents, TeamError, type TeamAssignment } from './store.js';
import { requireTeamExecution } from './access.js';
import { runningPromptRequestId } from '../assistant-collaboration/bridge-tools.js';

export const TEAM_TOOLS:Tool[]=[
 {name:'team_list_agents',description:'List this team’s roles. Only Bob may delegate. Child answers are INTERNAL ONLY.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {name:'team_delegate',description:'Delegate one explicit request to a specialist. Returns a durable assignment ID, not a promise. Stop and wait if results are outstanding; you will resume with stored results. At most ten delegated turns per root.',inputSchema:{type:'object',properties:{role:{type:'string',enum:['product','designer','qa','pr_reviewer','support']},message:{type:'string'}},required:['role','message'],additionalProperties:false}},
 {name:'team_read_assignment',description:'Read the durable state/result of your own root or its children. Never publish before all children have completed.',inputSchema:{type:'object',properties:{assignmentId:{type:'string'}},required:['assignmentId'],additionalProperties:false}},
];
export const TEAM_MEMORY_TOOLS:Tool[]=[
 {name:'team_memory_read',description:'Read shared team topic text and revision. No private memory.',inputSchema:{type:'object',properties:{topic:{type:'string'}},required:['topic'],additionalProperties:false}},
 {name:'team_memory_list',description:'Page shared team subjects (offset, limit up to 100).',inputSchema:{type:'object',properties:{offset:{type:'integer'},limit:{type:'integer'}},additionalProperties:false}},
 {name:'team_memory_write',description:'Write shared team memory through the serialized revision writer. Preserve proposals and disagreements and cite authorized source message IDs. Stale revisions conflict.',inputSchema:{type:'object',properties:{topic:{type:'string'},expectedRevision:{type:'integer'},description:{type:'string'},body:{type:'string'},sourceMessageIds:{type:'array',items:{type:'string'}}},required:['topic','expectedRevision','description','body','sourceMessageIds'],additionalProperties:false}},
];
export const TEAM_AGENT_TOOL_NAMES=[...TEAM_TOOLS,...TEAM_MEMORY_TOOLS].map(t=>`mcp__joint_bob__${t.name}`);
async function context(identity:McpAgentIdentity,live:boolean):Promise<TeamAssignment> {
 const conversation=await teamConversation(identity.projectId,identity.conversationId);
 if(!conversation||identity.engine!=='pi')throw new TeamError('Live team Bob context required',403);
 const db=await assignmentDatabase(),team=await getTeam(conversation.teamId);
 // Listing happens while the runtime opens the session, before promptStarted. A running durable turn already exists then.
 const requestId=runningPromptRequestId(identity.projectId,identity.conversationId);
 const rows=db.prepare(`SELECT a.record FROM assistant_team_assignments a JOIN personal_assistant_turns t ON t.request_id=a.request_id
 JOIN assistant_team_agents g ON g.assistant_id=t.assistant_id AND g.team_id=a.team_id
 WHERE a.team_id=? AND g.role=? AND t.status='running' AND t.topic_id=?`).all(team.id,conversation.role,`pi:${identity.conversationId}`);
 const a=rows.map(r=>JSON.parse(r.record as string) as TeamAssignment).find(a=>requestId?a.requestId===requestId:!live&&teamDispatchActive(a.id));
 if(!a||(!requestId&&!teamDispatchActive(a.id))||!['queued','running'].includes(a.state)||![a.requestedBy,team.executorAccountId].includes(identity.account.accountId))throw new TeamError('Live team Bob context required',403);
 await requireTeamExecution(a.teamId,a.requestedBy);return a;
}
export async function listTeamTools(identity:McpAgentIdentity):Promise<Tool[]> {try{const a=await context(identity,false);return [...(a.role==='bob'?TEAM_TOOLS:[]),...TEAM_MEMORY_TOOLS];}catch{return [];}}
export async function callTeamTool(identity:McpAgentIdentity,name:string,args:unknown):Promise<CallToolResult> {
 try {
 const a=await context(identity,true);let result:unknown;
 if(!name.startsWith('team_memory_'))await requireLiveTeamBob(a.id);
 if(name.startsWith('team_memory_')){
  const memory=await import('./memory.js');const member=await requireTeamExecution(a.teamId,a.requestedBy);
  if(name==='team_memory_read'){const {topic}=z.object({topic:z.string()}).strict().parse(args);result=await memory.readTeamMemoryTopic(member,topic);}
  else if(name==='team_memory_list'){const p=z.object({offset:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(100).default(50)}).strict().parse(args);result=await memory.listTeamMemoryTopics(member,p.offset,p.limit);}
  else if(name==='team_memory_write')result=await memory.writeTeamMemory(member,memory.teamMemoryWriteSchema.parse(args));
  else throw new TeamError('Unknown team memory tool',400);
 }
 else if(name==='team_list_agents'){z.object({}).strict().parse(args);result=await listTeamAgents(a.teamId);}
 else if(name==='team_delegate'){const input=z.object({role:z.enum(['product','designer','qa','pr_reviewer','support']),message:z.string().trim().min(1).max(18000)}).strict().parse(args);result=await delegateTeamAssignment(a.id,input.role,input.message);}
 else if(name==='team_read_assignment'){
  const {assignmentId}=z.object({assignmentId:z.string()}).strict().parse(args),target=await getTeamAssignment(assignmentId);
  if(!target||target.teamId!==a.teamId||target.rootId!==a.rootId)throw new TeamError('Assignment outside running root',403);
  result={assignment:target,work:(await readTeamWork(a.teamId)).find(w=>w.assignmentId===assignmentId)};
 }else throw new TeamError('Unknown team tool',400);
 return {content:[{type:'text',text:JSON.stringify(result)}]};
 }catch(error){return {isError:true,content:[{type:'text',text:error instanceof TeamError||error instanceof z.ZodError?error.message:'Team tool refused'}]};}
}
