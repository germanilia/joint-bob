import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpAgentIdentity } from '../mcp/agent.js';
import { z } from 'zod';
import { teamConversation } from './runtime.js';
import { assignmentDatabase, delegateTeamAssignment, readTeamWork, requireLiveTeamBob, teamDispatchActive } from './assignments.js';
import { getTeam, getTeamAssignment, listTeamAgents, teamCoordinator, TEAM_ROLE_PATTERN, TeamError, type TeamAssignment } from './store.js';
import { getPersonalAssistantById } from '../personal-assistants.js';
/** The account a member runs as: the owner of the picked assistant. */
async function memberOwner(teamId:string,role:string):Promise<string|undefined>{const member=(await listTeamAgents(teamId)).find(item=>item.role===role);return member&&(await getPersonalAssistantById(member.assistantId))?.accountId;}
import { createTeamProposal, inspectTeamAgent, listTeamAgentSummaries, listTeamProposals, readAssignmentTrace, readTeamNodeCatalog } from './proposals.js';
import { requireTeamExecution } from './access.js';
import { runningPromptRequestId } from '../assistant-collaboration/bridge-tools.js';

export const TEAM_TOOLS:Tool[]=[
 {name:'team_list_agents',description:'List this team’s members: role names, assistants, readiness, harness/model, tools (terminal/browser/MCP), attached secrets (metadata only, including whether each is usable in this team project), skills, instructions preview, and usage stats. Only the coordinator may use this. Child answers are INTERNAL ONLY.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {name:'team_inspect_agent',description:'Inspect one member of THIS team in detail: full standing instructions, own skills (including SKILL.md), disabled skills/plugins, MCP servers, attached secrets metadata, browser logins, files, memory excerpt, model/harness, and usage stats.',inputSchema:{type:'object',properties:{role:{type:'string'}},required:['role'],additionalProperties:false}},
 {name:'team_node_catalog',description:'List what is available on this host node to equip or create team assistants: attachable secrets usable in this team project (metadata only: id, label, provider, variable names — NEVER values), unusableSecrets (secrets present on this host but not granted/scoped for this team project), MCP servers, node skills/plugins, ready harnesses/models/thinking levels, saved browser profiles, and host assistants not yet in this team.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {name:'team_list_proposals',description:'List pending and recent team change proposals (IDs, states, summaries, full proposed changes, previews, and results). Check this before proposing or revising changes when a user comments on or modifies a pending proposal.',inputSchema:{type:'object',properties:{state:{type:'string',enum:['pending','all']},limit:{type:'integer',minimum:1,maximum:50}},additionalProperties:false}},
 {name:'team_delegate',description:'Delegate one explicit request to another team member by role name (see team_list_agents). Also use this to prompt an assistant back with feedback if its work was incomplete or not good enough. Returns a durable assignment ID, not a promise. Stop and wait if results are outstanding; you will resume with stored results. At most ten delegated turns per root.',inputSchema:{type:'object',properties:{role:{type:'string'},message:{type:'string'}},required:['role','message'],additionalProperties:false}},
 {name:'team_read_assignment',description:'Read the durable state, result, and execution trace (tool calls, errors, model used) of your own root or its children/reviewed work. Never publish before all children have completed.',inputSchema:{type:'object',properties:{assignmentId:{type:'string'},includeTrace:{type:'boolean'}},required:['assignmentId'],additionalProperties:false}},
 {name:'team_propose_changes',description:'Propose one or more permanent live changes to assistants or roster in THIS team (can bundle multiple changes into one approval card). Pass supersedeProposalId to cancel and replace an existing pending proposal when the user asks to modify it. Field names per kind: update_assistant (role + optional name, instructions, allowTerminal, allowBrowser, mcpServerNames, executionSettings, disabledSkills, disabledPlugins), attach_secret/detach_secret (role, secretAccountId), upsert_skill (role, files: [{relativePath, content}] including SKILL.md), delete_skill (role, skillName), attach_login/detach_login (role, profileId), create_member (role, name, instructions + optional allowTerminal, allowBrowser, mcpServerNames, executionSettings, secretAccountIds, skills), add_member (role, assistantId), rename_role (role, newRole), remove_member (role). A human team member must approve in Telegram or UI; once approved, changes apply live immediately and your turn automatically resumes.',inputSchema:{type:'object',properties:{summary:{type:'string',description:'Short human-readable title of the bundled change'},rationale:{type:'string',description:'Why these changes are needed based on the task or assistant review'},supersedeProposalId:{type:'string',description:'Optional UUID of an existing pending proposal to cancel and replace with this revised proposal'},changes:{type:'array',minItems:1,maxItems:20,items:{type:'object',properties:{kind:{type:'string',enum:['update_assistant','attach_secret','detach_secret','upsert_skill','delete_skill','attach_login','detach_login','create_member','add_member','rename_role','remove_member']},role:{type:'string',description:'Target role name (lowercase letters, digits, underscores)'},name:{type:'string'},instructions:{type:'string'},allowTerminal:{type:'boolean'},allowBrowser:{type:'boolean'},mcpServerNames:{type:['array','null'],items:{type:'string'}},executionSettings:{type:'object',properties:{harnessId:{type:'string'},provider:{type:'string'},modelId:{type:'string'},reasoning:{type:'string'}},required:['harnessId','provider','modelId','reasoning'],additionalProperties:false},disabledSkills:{type:'array',items:{type:'string'}},disabledPlugins:{type:'array',items:{type:'string'}},secretAccountId:{type:'string',description:'Secret account UUID for attach_secret / detach_secret (from team_node_catalog.secrets)'},secretAccountIds:{type:'array',items:{type:'string'},description:'Secret account UUIDs for create_member (from team_node_catalog.secrets)'},files:{type:'array',items:{type:'object',properties:{relativePath:{type:'string'},content:{type:'string'}},required:['relativePath','content'],additionalProperties:false}},skillName:{type:'string'},profileId:{type:'string'},skills:{type:'array',items:{type:'object',properties:{files:{type:'array',items:{type:'object',properties:{relativePath:{type:'string'},content:{type:'string'}},required:['relativePath','content'],additionalProperties:false}}},required:['files'],additionalProperties:false}},assistantId:{type:'string'},newRole:{type:'string'}},required:['kind','role']}}},required:['summary','rationale','changes'],additionalProperties:false}},
];
export const TEAM_MEMORY_TOOLS:Tool[]=[
 {name:'team_memory_read',description:'Read a memory topic and its revision. Scope "team" (default) is shared by every member; scope "member" is your own notes.',inputSchema:{type:'object',properties:{topic:{type:'string'},scope:{type:'string',enum:['team','member']}},required:['topic'],additionalProperties:false}},
 {name:'team_memory_list',description:'Page memory topics: the team\u2019s and your own notes, each marked with its scope (offset, limit up to 100).',inputSchema:{type:'object',properties:{offset:{type:'integer'},limit:{type:'integer'}},additionalProperties:false}},
 {name:'team_memory_write',description:'Write memory through the serialized revision writer. Scope "team" (default) is read by every member, so use it only for what all of them need; scope "member" is your own notes, read only by you. Preserve proposals and disagreements and cite authorized source message IDs. Stale revisions conflict.',inputSchema:{type:'object',properties:{topic:{type:'string'},expectedRevision:{type:'integer'},description:{type:'string'},body:{type:'string'},sourceMessageIds:{type:'array',items:{type:'string'}},scope:{type:'string',enum:['team','member']}},required:['topic','expectedRevision','description','body','sourceMessageIds'],additionalProperties:false}},
 {name:'team_memory_delete',description:'Delete an obsolete memory topic through the serialized revision writer (logged in change history and reversible). Pass expectedRevision from team_memory_read.',inputSchema:{type:'object',properties:{topic:{type:'string'},expectedRevision:{type:'integer'},scope:{type:'string',enum:['team','member']}},required:['topic','expectedRevision'],additionalProperties:false}},
];
export const TEAM_AGENT_TOOL_NAMES=[...TEAM_TOOLS,...TEAM_MEMORY_TOOLS].map(t=>`mcp__joint_bob__${t.name}`);
async function context(identity:McpAgentIdentity,live:boolean):Promise<TeamAssignment> {
 const conversation=await teamConversation(identity.projectId,identity.conversationId);
 if(!conversation)throw new TeamError('Live team member context required',403);
 const db=await assignmentDatabase(),team=await getTeam(conversation.teamId);
 // Listing happens while the runtime opens the session, before promptStarted. A running durable turn already exists then.
 const requestId=runningPromptRequestId(identity.projectId,identity.conversationId);
 const rows=db.prepare(`SELECT a.record FROM assistant_team_assignments a JOIN personal_assistant_turns t ON t.request_id=a.request_id
 JOIN assistant_team_agents g ON g.assistant_id=t.assistant_id AND g.team_id=a.team_id
 WHERE a.team_id=? AND g.role=? AND t.status='running' AND t.topic_id=?`).all(team.id,conversation.role,`${identity.engine}:${identity.conversationId}`);
 const a=rows.map(r=>JSON.parse(r.record as string) as TeamAssignment).find(a=>requestId?a.requestId===requestId:!live&&teamDispatchActive(a.id));
 if(!a||(!requestId&&!teamDispatchActive(a.id))||!['queued','running'].includes(a.state)||![a.requestedBy,await memberOwner(team.id,a.role)].includes(identity.account.accountId))throw new TeamError('Live team member context required',403);
 await requireTeamExecution(a.teamId,a.requestedBy);return a;
}
export async function listTeamTools(identity:McpAgentIdentity):Promise<Tool[]> {try{const a=await context(identity,false);return [...(a.role===await teamCoordinator(await getTeam(a.teamId))?TEAM_TOOLS:[]),...TEAM_MEMORY_TOOLS];}catch{return [];}}
export async function callTeamTool(identity:McpAgentIdentity,name:string,args:unknown):Promise<CallToolResult> {
 try {
 const a=await context(identity,true);let result:unknown;
 if(!name.startsWith('team_memory_'))await requireLiveTeamBob(a.id);
 if(name.startsWith('team_memory_')){
  const memory=await import('./memory.js');const member=await requireTeamExecution(a.teamId,a.requestedBy);
  if(name==='team_memory_read'){const {topic,scope}=z.object({topic:z.string(),scope:z.enum(['team','member']).default('team')}).strict().parse(args);result=await memory.readTeamMemoryTopic(member,topic,scope==='member'?a.role:null);}
  else if(name==='team_memory_list'){const p=z.object({offset:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(100).default(50)}).strict().parse(args);result=await memory.listTeamMemoryTopics(member,p.offset,p.limit,a.role);}
  else if(name==='team_memory_write')result=await memory.writeTeamMemory(member,memory.teamMemoryWriteSchema.parse(args),a.role);
  else if(name==='team_memory_delete'){const p=memory.teamMemoryDeleteSchema.parse(args);result=await memory.deleteTeamMemory(member,p.topic,p.expectedRevision,p.scope==='member'?a.role:null);}
  else throw new TeamError('Unknown team memory tool',400);
 }
 else if(name==='team_list_agents'){z.object({}).strict().parse(args);result=await listTeamAgentSummaries(a.teamId);}
 else if(name==='team_inspect_agent'){const {role}=z.object({role:z.string().regex(TEAM_ROLE_PATTERN)}).strict().parse(args);result=await inspectTeamAgent(a.teamId,role);}
 else if(name==='team_node_catalog'){z.object({}).strict().parse(args);result=await readTeamNodeCatalog(a.teamId);}
 else if(name==='team_list_proposals'){
  const {state,limit}=z.object({state:z.enum(['pending','all']).default('all'),limit:z.number().int().min(1).max(50).default(20)}).strict().parse(args);
  const all=await listTeamProposals(a.teamId,limit);
  result=state==='pending'?all.filter(p=>p.state==='pending'):all;
 }
 else if(name==='team_delegate'){const input=z.object({role:z.string().regex(TEAM_ROLE_PATTERN),message:z.string().trim().min(1).max(18000)}).strict().parse(args);result=await delegateTeamAssignment(a.id,input.role,input.message);}
 else if(name==='team_read_assignment'){
  const {assignmentId,includeTrace}=z.object({assignmentId:z.string(),includeTrace:z.boolean().default(true)}).strict().parse(args),target=await getTeamAssignment(assignmentId);
  if(!target||target.teamId!==a.teamId||target.rootId!==a.rootId)throw new TeamError('Assignment outside running root',403);
  const w=(await readTeamWork(a.teamId)).find(item=>item.assignmentId===assignmentId);
  const trace=includeTrace&&w?.conversationId?await readAssignmentTrace(a.teamId,target,w.conversationId):null;
  result={assignment:target,work:w,trace};
 }
 else if(name==='team_propose_changes'){
  const proposal=await createTeamProposal(a.id,args);
  result={proposalId:proposal.id,status:proposal.state,previews:proposal.previews,message:'Proposal sent for team approval. Stop your turn now; once a team member approves or rejects, changes will apply immediately (if approved) and you will automatically resume to continue the task.'};
 }else throw new TeamError('Unknown team tool',400);
 return {content:[{type:'text',text:JSON.stringify(result)}]};
 }catch(error){return {isError:true,content:[{type:'text',text:error instanceof TeamError||error instanceof z.ZodError?error.message:'Team tool refused'}]};}
}
