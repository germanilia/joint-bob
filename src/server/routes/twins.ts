import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import { resolveDataDirectory } from "../../data-directory.js";
import { z } from "zod";
import { getClusterNode } from "../../cluster.js";
import { getConversationOwnership } from "../../conversation-ownership.js";
import { signedPeerPost } from "../replication-v2.js";
import { applyTwinCertificate, listTwinRelationships, twinCertificateSchema, twinRevocationSchema } from "../../cluster-twins.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { ClusterV2HttpError } from "../../cluster-v2-errors.js";
import {
  acceptTwinHttpLink, applyRemoteTwinRevocation, bootstrapOwnedTwinPolicies,
  createTwinHttpInvitation, ensureTwinHttpSchema, mapTwinError, pendingTwinDeliveries,
  revokeTwinHttp, resyncAccountIds,
} from "../twins.js";
import { app } from "../state.js";
import type { HarnessId } from "../../types.js";
import { ConversationForkError } from "../conversation-fork.js";
import { declareTwinLost, receiveSuccession, successionNoticeSchema } from "../succession.js";
import { peerEndpoint, recordPeerEndpoint } from "../../cluster-peer-endpoints.js";
import { disconnectRevokedRuntimeSockets } from '../runtime-peers.js';
import { receiveScopedCredentials } from "../scoped-credentials.js";
import { acceptOwnerTranscript, forkConflictedTranscript, privateAttachmentName, sharedPrivateAttachment, sharedTranscriptFile, sharedTranscriptInventory, sharedTranscriptProject, sharedTranscriptsChanged, transcriptQuery } from "../shared-transcripts.js";
import { receiveFileEnrollment } from "../sharing-files.js";
import { isTrustedTwin } from "../../cluster-sharing-policy.js";
import { receiveSecretCredentialEvents, type SecretCredentialEvent } from "../../secret-replication.js";
import { secretCredentialBatchSchema } from "../schemas.js";
import { acceptTwinRequest, declineTwinRequest, listTwinRequests, receiveTwinRequest, receiveTwinRequestDecline, requestTwin } from "../twin-requests.js";
import { adoptionInventory, adoptionInventorySchema, adoptTwinProjects, completeTwinSharing, localRepairTwinSync, localTwinSharingStatus, repairTwinSync, scheduleTwinSharing, sharingTwin, twinSharingStatus } from "../twin-sharing.js";

const uuid = z.string().uuid().regex(/^[0-9a-f-]+$/);
function localOnly(response:Response):void { if(!response.locals.authSession) throw new ClusterV2HttpError(401,"Unauthorized"); }
function machineOnly(response:Response):string { if(response.locals.machineProtocol!==2||typeof response.locals.machineNodeId!=="string") throw new ClusterV2HttpError(401,"Unauthorized"); return response.locals.machineNodeId as string; }
function handler(action:(request:Request,response:Response)=>Promise<void>):(request:Request,response:Response,next:NextFunction)=>void {
  return (request,response,next)=>{void action(request,response).catch(error=>mapTwinError(error,response,next));};
}
function transaction(db:Awaited<ReturnType<typeof clusterV2Database>>,action:()=>void):void {
  db.exec("SAVEPOINT twin_route_write");
  try{action();db.exec("RELEASE twin_route_write");}
  catch(error){db.exec("ROLLBACK TO twin_route_write; RELEASE twin_route_write");throw error;}
}

app.post("/api/cluster/v2/twins/sharing-inventory",handler(async(request,response)=>{
  const payload=z.object({relationshipId:uuid}).strict().parse(request.body),sender=machineOnly(response),local=await getClusterNode(),db=await clusterV2Database();
  if(sharingTwin(db,local.id,payload.relationshipId)!==sender)throw new ClusterV2HttpError(403,'Forbidden');
  response.json({projects:adoptionInventory(db)});
}));

app.post("/api/cluster/v2/twins/sharing-status",handler(async(request,response)=>{
  const payload=z.object({relationshipId:uuid}).strict().parse(request.body),sender=machineOnly(response),local=await getClusterNode(),db=await clusterV2Database();
  if(sharingTwin(db,local.id,payload.relationshipId)!==sender)throw new ClusterV2HttpError(403,'Forbidden');
  response.json(await localTwinSharingStatus(db,local.id,payload.relationshipId));
}));

app.post("/api/cluster/v2/twins/repair",handler(async(request,response)=>{
  const payload=z.object({relationshipId:uuid}).strict().parse(request.body),sender=machineOnly(response),local=await getClusterNode(),db=await clusterV2Database();
  if(sharingTwin(db,local.id,payload.relationshipId)!==sender)throw new ClusterV2HttpError(403,'Forbidden');
  response.json({ok:true,...await localRepairTwinSync(db,local.id,payload.relationshipId)});
}));

app.post("/api/cluster/v2/credentials/scoped",handler(async(request,response)=>{
  await receiveScopedCredentials(machineOnly(response),request.body);response.json({ok:true});
}));

app.get("/api/cluster/v2/transcripts",handler(async(request,response)=>{
  const query=transcriptQuery.parse(request.query);
  const only=query.engine&&query.sessionId?{engine:query.engine,sessionId:query.sessionId}:undefined;
  response.json({entries:await sharedTranscriptInventory(machineOnly(response),query.projectId,only,request.get('X-Joint-Bob-Private-History')==='1')});
}));
app.post("/api/cluster/v2/transcripts/changed",handler(async(request,response)=>{
  await sharedTranscriptsChanged(machineOnly(response),request.body);response.json({ok:true});
}));
app.get("/api/cluster/v2/transcripts/file",handler(async(request,response)=>{
  const query=transcriptQuery.required().parse(request.query);
  response.sendFile(await sharedTranscriptFile(machineOnly(response),query.projectId,query.engine,query.sessionId,request.get('X-Joint-Bob-Private-History')==='1'));
}));

app.get("/api/cluster/v2/transcripts/private-attachment",handler(async(request,response)=>{
  const query=transcriptQuery.required().extend({name:privateAttachmentName}).parse(request.query);
  const file=path.resolve(await sharedPrivateAttachment(machineOnly(response),query.projectId,query.engine,query.sessionId,query.name));
  const dataRoot=path.resolve(resolveDataDirectory());
  if(!file.startsWith(`${dataRoot}${path.sep}`)) throw new ClusterV2HttpError(404,"Attachment not found");
  response.sendFile(file);
}));

app.post("/api/cluster/v2/twins/credentials",handler(async(request,response)=>{
  const sender=machineOnly(response),local=await getClusterNode(),db=await clusterV2Database();
  if(!isTrustedTwin(db,local.id,sender)) throw new ClusterV2HttpError(403,"Forbidden");
  const payload=secretCredentialBatchSchema.parse(request.body);
  if(payload.events.some(event=>event.originNodeId!==sender)) throw new ClusterV2HttpError(403,"Credential origin does not match authenticated peer");
  response.json({received:await receiveSecretCredentialEvents(payload.events as SecretCredentialEvent[])});
}));

app.post("/api/cluster/v2/files/enroll",handler(async(request,response)=>{
  response.json(await receiveFileEnrollment(machineOnly(response),request.body));
}));

app.get("/api/twins/:relationshipId/sharing",handler(async(request,response)=>{
  localOnly(response);
  response.json(await twinSharingStatus(await clusterV2Database(),(await getClusterNode()).id,uuid.parse(request.params.relationshipId)));
}));
app.post("/api/twins/:relationshipId/sharing",handler(async(request,response)=>{
  localOnly(response);
  const payload=z.object({ownerNodeId:uuid,confirmOwnedData:z.literal(true)}).strict().parse(request.body);
  response.json(await completeTwinSharing(uuid.parse(request.params.relationshipId),payload.ownerNodeId));
}));
app.post("/api/twins/:relationshipId/repair",handler(async(request,response)=>{
  localOnly(response);
  z.object({}).strict().parse(request.body);
  response.json(await repairTwinSync(uuid.parse(request.params.relationshipId)));
}));
app.post("/api/twins/:relationshipId/transcript-conflicts/fork",handler(async(request,response)=>{
  localOnly(response);
  const payload=z.object({projectId:z.string().min(1).max(300),engine:z.string().min(1).max(80),sessionId:z.string().min(1).max(300)}).strict().parse(request.body);
  const db=await clusterV2Database(),local=await getClusterNode(),peer=sharingTwin(db,local.id,uuid.parse(request.params.relationshipId));
  const auth=response.locals.authSession;
  const session=await forkConflictedTranscript(peer,payload.projectId,payload.engine,payload.sessionId,{userId:auth.userId,username:auth.accountId}).catch(error=>{
    if(error instanceof ConversationForkError)throw new ClusterV2HttpError(error.status,error.message);
    throw error;
  });
  response.status(201).json({session});
}));

const remoteTranscriptReview=transcriptQuery.required().extend({version:z.string().regex(/^[a-f0-9]{64}$/),confirmReplaceOnTwin:z.literal(true)});

app.post("/api/twins/:relationshipId/transcript-conflicts/accept-on-twin",handler(async(request,response)=>{
  localOnly(response);
  const payload=remoteTranscriptReview.parse(request.body),relationshipId=uuid.parse(request.params.relationshipId);
  const db=await clusterV2Database(),local=await getClusterNode(),peer=sharingTwin(db,local.id,relationshipId);
  await sharedTranscriptProject(peer,payload.projectId);
  const owner=await getConversationOwnership(payload.engine,payload.sessionId);
  if(owner?.ownerNodeId!==local.id||owner.status!=="owned")throw new ClusterV2HttpError(409,"This machine no longer owns the conversation or it is being transferred; check again");
  const result=await signedPeerPost(peerEndpoint(db,"twin",relationshipId,peer),"/api/cluster/v2/twins/transcript-conflicts/accept",{...payload,relationshipId,ownerEpoch:owner.epoch}).catch(error=>{
    if(error instanceof ClusterV2HttpError&&error.statusCode===409)throw new ClusterV2HttpError(409,"The history or owner changed, or the conversation is still running on the twin. Stop it there if needed, then check again.");
    if(error instanceof ClusterV2HttpError&&error.statusCode===404)throw new ClusterV2HttpError(404,"The twin no longer has this conflict or needs an update. Check again.");
    if(error instanceof ClusterV2HttpError&&error.statusCode===401)throw new ClusterV2HttpError(502,"The twin did not accept the repair request. Check the twin connection and try again.");
    throw error;
  });
  response.json(z.object({saved:z.string()}).parse(result));
}));

app.post("/api/cluster/v2/twins/transcript-conflicts/accept",handler(async(request,response)=>{
  const sender=machineOnly(response),db=await clusterV2Database(),local=await getClusterNode();
  const payload=remoteTranscriptReview.extend({relationshipId:uuid,ownerEpoch:z.number().int().positive()}).parse(request.body);
  if(sharingTwin(db,local.id,payload.relationshipId)!==sender)throw new ClusterV2HttpError(403,"Forbidden");
  response.json(await settleTranscriptHere(sender,payload,{version:payload.version,ownerEpoch:payload.ownerEpoch}));
}));

async function settleTranscriptHere(peer:string,payload:{projectId:string;engine:string;sessionId:string},review?:{version:string;ownerEpoch:number}){
  // A conversation open here still holds the history being replaced, and a running one is writing to it.
  const {disposeHarnessSession,findHarnessSession,harnessSessionBusy}=await import("../harness-sessions.js");
  const live=findHarnessSession(payload.projectId,payload.engine as HarnessId,payload.sessionId);
  if(live&&harnessSessionBusy(live))throw new ClusterV2HttpError(409,"This conversation is running on this machine; stop it first");
  const result=await acceptOwnerTranscript(peer,payload.projectId,payload.engine,payload.sessionId,undefined,review);
  if(live)disposeHarnessSession(live);
  return result;
}

/** Settles a conversation both twins continued by taking its owner's history. This machine's
    version is saved first; see acceptOwnerTranscript. */
app.post("/api/twins/:relationshipId/transcript-conflicts/accept",handler(async(request,response)=>{
  localOnly(response);
  const payload=z.object({projectId:z.string().min(1).max(300),engine:z.string().min(1).max(80),sessionId:z.string().min(1).max(300),confirmReplaceLocal:z.literal(true)}).strict().parse(request.body);
  const db=await clusterV2Database(),local=await getClusterNode(),peer=sharingTwin(db,local.id,uuid.parse(request.params.relationshipId));
  response.json(await settleTranscriptHere(peer,payload));
}));
app.post('/api/cluster/v2/twins/sharing-coordinate',handler(async(request,response)=>{
  const sender=machineOnly(response),local=await getClusterNode(),db=await clusterV2Database();
  const payload=z.object({relationshipId:uuid,ownerNodeId:uuid.optional()}).strict().parse(request.body);
  if(sharingTwin(db,local.id,payload.relationshipId)!==sender||local.id>sender)throw new ClusterV2HttpError(403,'Forbidden');
  response.json(await completeTwinSharing(payload.relationshipId,payload.ownerNodeId));
}));
app.post("/api/cluster/v2/twins/sharing",handler(async(request,response)=>{
  const sender=machineOnly(response),local=await getClusterNode(),db=await clusterV2Database();
  const payload=z.object({relationshipId:uuid,ownerNodeId:uuid,projects:adoptionInventorySchema}).strict().parse(request.body);
  if(sharingTwin(db,local.id,payload.relationshipId)!==sender||sender>local.id) throw new ClusterV2HttpError(403,"Forbidden");
  adoptTwinProjects(db,local.id,payload.relationshipId,payload.ownerNodeId,payload.projects);
  response.json({projects:adoptionInventory(db)});
}));

app.post("/api/twins/invitations",handler(async(request,response)=>{
  localOnly(response); z.object({confirmOwnedData:z.literal(true)}).strict().parse(request.body);
  response.status(201).json(await createTwinHttpInvitation());
}));
app.post("/api/twins/accept",handler(async(request,response)=>{
  localOnly(response); const payload=z.object({link:z.string().max(32768),confirmOwnedData:z.literal(true)}).strict().parse(request.body);
  response.status(201).json(await acceptTwinHttpLink(payload.link));
}));
app.get("/api/twins",handler(async(_request,response)=>{
  localOnly(response); const local=await getClusterNode(),db=await clusterV2Database();ensureTwinHttpSchema(db);
  response.json({relationships:listTwinRelationships(db,local.id).map(item=>({...item,endpoint:peerEndpoint(db,"twin",item.relationshipId,item.peer.nodeId),pendingDeliveries:pendingTwinDeliveries(db,item.relationshipId)}))});
}));
/** Twin requests inside a shared cluster; see src/server/twin-requests.ts. */
app.get("/api/twins/requests",handler(async(_request,response)=>{
  localOnly(response); response.json({requests:await listTwinRequests()});
}));
app.post("/api/clusters/:clusterId/members/:nodeId/twin-request",handler(async(request,response)=>{
  localOnly(response); z.object({confirmOwnedData:z.literal(true)}).strict().parse(request.body);
  response.status(201).json({request:await requestTwin(uuid.parse(request.params.clusterId),uuid.parse(request.params.nodeId))});
}));
app.post("/api/twins/requests/:relationshipId/accept",handler(async(request,response)=>{
  localOnly(response); z.object({confirmOwnedData:z.literal(true)}).strict().parse(request.body);
  response.status(201).json(await acceptTwinRequest(uuid.parse(request.params.relationshipId)));
}));
app.delete("/api/twins/requests/:relationshipId",handler(async(request,response)=>{
  localOnly(response); await declineTwinRequest(uuid.parse(request.params.relationshipId)); response.json({ok:true});
}));
app.post("/api/cluster/v2/twins/requests",handler(async(request,response)=>{
  await receiveTwinRequest(machineOnly(response),request.body); response.json({ok:true});
}));
app.post("/api/cluster/v2/twins/requests/decline",handler(async(request,response)=>{
  await receiveTwinRequestDecline(machineOnly(response),request.body); response.json({ok:true});
}));
/** The twin is gone for good: this node takes over what it owned (see src/cluster-succession.ts). */
app.post("/api/twins/:relationshipId/lost",handler(async(request,response)=>{
  localOnly(response); z.object({confirmLost:z.literal(true)}).strict().parse(request.body);
  response.json(await declareTwinLost(uuid.parse(request.params.relationshipId)));
}));
app.post("/api/cluster/v2/succession",handler(async(request,response)=>{
  const sender=machineOnly(response);
  await receiveSuccession(sender,successionNoticeSchema.parse(request.body));
  response.json({ok:true});
}));
app.delete("/api/twins/:relationshipId",handler(async(request,response)=>{
  localOnly(response); const local=await getClusterNode(),db=await clusterV2Database(),relationshipId=uuid.parse(request.params.relationshipId);
  const result=revokeTwinHttp(db,local.id,relationshipId);await resyncAccountIds();
  await disconnectRevokedRuntimeSockets();
  response.json({relationshipId,status:"revoked",pending:result.pending});
}));
/** A twin reports its new name and URL; this node reaches it at the new address. */
app.post("/api/cluster/v2/twins/descriptor",handler(async(request,response)=>{
  const sender=machineOnly(response),local=await getClusterNode(),db=await clusterV2Database();
  const payload=z.object({relationshipId:uuid,name:z.string(),url:z.string()}).strict().parse(request.body);
  if(sharingTwin(db,local.id,payload.relationshipId)!==sender)throw new ClusterV2HttpError(403,'Forbidden');
  recordPeerEndpoint(db,{kind:"twin",id:payload.relationshipId},{nodeId:sender,name:payload.name,url:payload.url});
  response.json({ok:true});
}));
app.post("/api/cluster/v2/twins/certificate",handler(async(request,response)=>{
  const sender=machineOnly(response),certificate=twinCertificateSchema.parse(z.object({certificate:twinCertificateSchema}).strict().parse(request.body).certificate);
  const local=await getClusterNode();
  const other=certificate.body.inviter.nodeId===local.id?certificate.body.acceptor.nodeId:certificate.body.inviter.nodeId;
  if(sender!==other) throw new ClusterV2HttpError(403,"Forbidden");
  const db=await clusterV2Database();ensureTwinHttpSchema(db);transaction(db,()=>{applyTwinCertificate(db,local.id,certificate);bootstrapOwnedTwinPolicies(db,local.id);scheduleTwinSharing(db,certificate.body.relationshipId);});
  await resyncAccountIds();
  response.json({ok:true});
}));
app.post("/api/cluster/v2/twins/revocation",handler(async(request,response)=>{
  const sender=machineOnly(response),revocation=twinRevocationSchema.parse(z.object({revocation:twinRevocationSchema}).strict().parse(request.body).revocation);
  if(sender!==revocation.signerNodeId) throw new ClusterV2HttpError(403,"Forbidden");
  const local=await getClusterNode(),db=await clusterV2Database();ensureTwinHttpSchema(db);
  applyRemoteTwinRevocation(db,local.id,revocation);await resyncAccountIds();await disconnectRevokedRuntimeSockets();response.json({ok:true});
}));
