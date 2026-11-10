import { mkdir } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { signClusterRequest } from "../cluster-protocol.js";
import { mayReceiveResource } from "../cluster-sharing-policy.js";
import { ClusterV2HttpError } from "../cluster-v2-errors.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { clearHarnessSessionCache } from "../harnesses.js";
import { replicationPeers } from "./replication-v2.js";
import { peerAway } from "../peer-presence.js";
import { peerFetch } from "../relay/transport.js";
import { listPhases } from "../file-sync/control.js";

/* What two machines that share projects tell each other besides the files themselves (those are moved by
   built-in sync, src/file-sync): where each project lies on the other machine. The request keeps the name
   "enroll" from the time it also set up the folders of an external sync tool; `deviceId` is what such a
   machine still sends, and is ignored. */
export const fileEnrollmentSchema=z.object({deviceId:z.string().max(200).optional(),projects:z.array(z.string().min(1).max(300)).max(10000),
 locations:z.array(z.object({projectId:z.string().min(1).max(300),path:z.string().min(1).max(4096)}).strict()).max(10000)}).strict();
function projectLocations(db:DatabaseSync,ids:string[]):Array<{projectId:string;path:string}>{
 const lookup=db.prepare("SELECT id projectId,path FROM projects WHERE id=?");
 return ids.flatMap(id=>{const row=lookup.get(id) as {projectId:string;path:string}|undefined;return row?[row]:[];});
}
function receiveLocations(db:DatabaseSync,local:string,peer:string,locations:Array<{projectId:string;path:string}>):void{
 const save=db.prepare("INSERT INTO project_locations VALUES(?,?,?) ON CONFLICT(project_id,node_id) DO UPDATE SET path=excluded.path");
 for(const location of locations){
  if(!mayShareProject(db,local,peer,location.projectId))throw new ClusterV2HttpError(403,"Project is not shared with this node");
  if(!db.prepare("SELECT 1 FROM projects WHERE id=?").get(location.projectId))continue;
  save.run(location.projectId,peer,location.path);clearHarnessSessionCache(location.projectId);
 }
}
/* A project just shared with this machine has no folder here yet, and file sync does not take over a project whose
   folder is missing. It is made once, before the take-over: a folder that goes missing later (a disk not mounted) is
   never made again, since an empty one would read as every file deleted. */
async function makeNewFolders(db:DatabaseSync,ids:string[]):Promise<void>{
 const phases=listPhases(db);
 for(const location of projectLocations(db,ids)){
  if(phases.get(location.projectId)?.phase==="builtin")continue;
  await mkdir(location.path,{recursive:true}).catch(error=>console.warn(`The folder of a shared project could not be made at ${location.path}: ${error instanceof Error?error.message:String(error)}`));
 }
}
function ensureSchema(db:DatabaseSync):void {
 db.exec("CREATE TABLE IF NOT EXISTS cluster_v2_file_errors(peer_id TEXT PRIMARY KEY,error TEXT NOT NULL)");
}
export function mayShareProject(db:DatabaseSync,local:string,peer:string,id:string):boolean {
 const policy=db.prepare("SELECT deleted FROM cluster_v2_resource_policy WHERE kind='project' AND resource_id=?").get(id) as {deleted:number}|undefined;
 return Boolean(policy&&!policy.deleted&&mayReceiveResource(db,local,"project",id)&&mayReceiveResource(db,peer,"project",id));
}
export function sharedProjectIds(db:DatabaseSync,local:string,peer:string):string[]{
 const rows=db.prepare("SELECT resource_id id FROM cluster_v2_resource_policy WHERE kind='project' AND deleted=0").all() as unknown as Array<{id:string}>;
 return rows.filter(p=>mayShareProject(db,local,peer,p.id)).map(p=>p.id);
}
export async function receiveFileEnrollment(peer:string,input:unknown){
 const payload=fileEnrollmentSchema.parse(input),db=await clusterV2Database(),local=await getClusterNode();
 if(!replicationPeers(db,local.id).some(p=>p.nodeId===peer))throw new ClusterV2HttpError(403,"Forbidden");
 if(payload.projects.some(id=>!mayShareProject(db,local.id,peer,id)))throw new ClusterV2HttpError(403,"Project is not shared with this node");
 ensureSchema(db);
 receiveLocations(db,local.id,peer,payload.locations);
 await makeNewFolders(db,payload.projects);
 db.prepare("DELETE FROM cluster_v2_file_errors WHERE peer_id=?").run(peer);
 // The peer answers again, so this node's own failed exchange with it need not wait out its retry.
 retries.delete(peer);
 const known=db.prepare("SELECT 1 FROM projects WHERE id=?");
 return {projects:payload.projects.filter(id=>known.get(id)),locations:projectLocations(db,payload.projects)};
}
/** Whether this node holds what `peer` has of the projects they share: the engine's cursors say so, from memory. */
export async function sharingFilesStatus(db:DatabaseSync,local:string,peer:string):Promise<{ready:boolean;error?:string}>{
 ensureSchema(db);
 const error=db.prepare("SELECT error FROM cluster_v2_file_errors WHERE peer_id=?").get(peer) as {error:string}|undefined;
 if(error)return {ready:false,error:error.error};
 const shared=sharedProjectIds(db,local,peer);
 if(!shared.length)return {ready:true};
 try{return {ready:(await (await import("../file-sync/facade.js")).peerFilesReady(peer,shared)).ready};}
 catch(error){return {ready:false,error:error instanceof Error?error.message:"File sync status unavailable"};}
}

// The administration flush runs every few seconds. Each peer is told again only when what would be
// sent differs from what it last accepted, or a failed attempt is due a retry.
const RETRY_MS=15_000,MAX_RETRY_MS=5*60_000;
const exchanged=new Map<string,string>();
const retries=new Map<string,{count:number;state:string;at:number}>();
function exchangeState(db:DatabaseSync,projects:string[]):string{
 const lookup=db.prepare("SELECT id,path FROM projects WHERE id=?");
 return JSON.stringify(projects.map(id=>lookup.get(id)));
}

export async function flushSharingFiles():Promise<void>{
 const db=await clusterV2Database(),local=await getClusterNode();ensureSchema(db);
 const peers=replicationPeers(db,local.id),now=Date.now();
 for(const known of [exchanged,retries])for(const peerId of known.keys())if(!peers.some(peer=>peer.nodeId===peerId))known.delete(peerId);
 const due=peers.filter(peer=>!peerAway(peer.nodeId)).flatMap(peer=>{
  const projects=sharedProjectIds(db,local.id,peer.nodeId),state=exchangeState(db,projects),retry=retries.get(peer.nodeId);
  return exchanged.get(peer.nodeId)===state||(retry?.state===state&&retry.at>now)?[]:[{peer,projects,state}];
 });
 for(const {peer,projects,state} of due)try{
  // Before asking: a peer that does not answer (away, or on an older release) must not keep the folder from being made.
  await makeNewFolders(db,projects);
  const target="/api/cluster/v2/files/enroll",body=Buffer.from(JSON.stringify({projects,locations:projectLocations(db,projects)}));
  const response=await peerFetch(new URL(target,peer.url),{method:"POST",redirect:"error",signal:AbortSignal.timeout(10000),body,
   headers:{"Content-Type":"application/json",Authorization:signClusterRequest(db,local.id,peer.nodeId,"POST",target,body)}}, peer.nodeId);
  if(!response.ok)throw new Error(`Project locations were not accepted (${response.status})`);
  const payload=fileEnrollmentSchema.parse(await response.json());
  receiveLocations(db,local.id,peer.nodeId,payload.locations);
  db.prepare("DELETE FROM cluster_v2_file_errors WHERE peer_id=?").run(peer.nodeId);
  exchanged.set(peer.nodeId,state);retries.delete(peer.nodeId);
 }catch(error){
  exchanged.delete(peer.nodeId);
  const count=(retries.get(peer.nodeId)?.count??0)+1;
  retries.set(peer.nodeId,{count,state,at:Date.now()+Math.min(MAX_RETRY_MS,RETRY_MS*2**(count-1))});
  db.prepare("INSERT OR REPLACE INTO cluster_v2_file_errors VALUES(?,?)").run(peer.nodeId,error instanceof Error?error.message:"Project locations could not be exchanged");
 }
}
