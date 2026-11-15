import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { actingAccount } from "../../account-context.js";
import { accountInCluster } from "../../cluster-accounts.js";
import { getClusterNode } from "../../cluster.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { getSharingCluster, listSharingClusterMembers } from "../../cluster-sharing-policy.js";
import { agentPolicyBodySchema, clusterPolicySource, getClusterAgentPolicy, setClusterAgentPolicy } from "../../cluster-agent-policy.js";
import path from "node:path";
import { buildSkillBundle } from "../../skill-sharing.js";
import { agentResourcePaths } from "../../agent-resources.js";
import { publishedRelayPolicy } from "../../relay/resource-policy.js";
import { pinnedClusterPublicKey, signClusterMessage, verifyClusterMessage } from "../../cluster-identity.js";
import { ClusterV2HttpError } from "../../cluster-v2-errors.js";
import { clusterManager, mapV2Error, signedPost } from "../cluster-v2.js";
import { flushHubDeliveries } from "../cluster-hubs.js";
import { app } from "../state.js";
const clusterBody = z.object({ clusterId: z.string().uuid() }).strict();
function handler(work: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => { void work(request, response).catch(error => mapV2Error(error, response, next)); };
}
function person(response: Response) {
  const account = actingAccount();
  if (!response.locals.authSession || !account || account.isRemoteLogin) throw new ClusterV2HttpError(401, "Unauthorized");
  return account;
}
app.get("/api/clusters/:clusterId/agent-policy", handler(async (request, response) => {
  const account = person(response), clusterId = z.string().uuid().parse(request.params.clusterId), db = await clusterV2Database();
  if (!accountInCluster(db, account.accountId, clusterId)) throw new ClusterV2HttpError(404, "Not found");
  const policy = getClusterAgentPolicy(db, clusterId);
  response.json({ policy: policy ?? null, sources: listSharingClusterMembers(db, clusterId).map(member => ({ nodeId: member.nodeId, name: member.nodeId })), effective: { local: policy?.policy ?? agentPolicyBodySchema.parse({}), source: policy?.sourceRelayNodeId ? clusterPolicySource(db, policy.sourceRelayNodeId)?.body ?? null : null } });
}));
app.put("/api/clusters/:clusterId/agent-policy", handler(async (request, response) => {
  const account = person(response), clusterId = z.string().uuid().parse(request.params.clusterId), db = await clusterV2Database(), local = await getClusterNode();
  if (!accountInCluster(db, account.accountId, clusterId)) throw new ClusterV2HttpError(404, "Not found");
  if (clusterManager(db, clusterId) !== local.id) throw new ClusterV2HttpError(403, "Only the cluster manager edits policy");
  const input = z.object({ expectedEpoch: z.number().int().positive(), sourceRelayNodeId: z.string().uuid().nullable(), policy: agentPolicyBodySchema }).strict().parse(request.body);
  if (getSharingCluster(db, clusterId).managerEpoch !== input.expectedEpoch) throw new ClusterV2HttpError(409, "Cluster manager authority changed");
  for (const member of listSharingClusterMembers(db, clusterId)) {
    if (member.nodeId === local.id) continue;
    const capability = z.object({ features: z.array(z.string()) }).parse(await signedPost(db, local.id, member.nodeId, clusterId, "/api/cluster/v2/subscription-pools/capability", { clusterId }));
    if (!capability.features.includes("cluster-agent-policy-v1")) throw new ClusterV2HttpError(409, "Update every cluster member before assigning project policy");
  }
  if (input.policy.settings.skills.enforce) {
    const names = [...new Set(Object.values(input.policy.enabled.skills).flat())];
    const digests: Record<string, string> = {};
    for (const name of names) digests[name] = (await buildSkillBundle(path.join(agentResourcePaths().sharedSkills, name), name)).digest;
    input.policy.skillDigests = digests;
  }
  let sourceStatement;
  if (input.sourceRelayNodeId) {
    if (!listSharingClusterMembers(db, clusterId).some(member => member.nodeId === input.sourceRelayNodeId)) throw new ClusterV2HttpError(403, "Policy source must be a cluster member");
    sourceStatement = input.sourceRelayNodeId === local.id ? publishedRelayPolicy(db, local.id) : await signedPost(db, local.id, input.sourceRelayNodeId, clusterId, "/api/cluster/v2/agent-policy/publication", { clusterId });
  }
  // Validate all source material before storing the assignment.
  const policy = setClusterAgentPolicy(db, local.id, clusterId, { ...input, ...(sourceStatement ? { sourceStatement: sourceStatement as ReturnType<typeof publishedRelayPolicy> } : {}) }, input.expectedEpoch);
  await flushHubDeliveries();
  response.json({ policy });
}));
app.post("/api/cluster/v2/agent-policy/skill", handler(async (request, response) => {
  const input = clusterBody.extend({ name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/), digest: z.string().regex(/^[a-f0-9]{64}$/) }).parse(request.body);
  const db = await clusterV2Database(), local = await getClusterNode();
  if (response.locals.machineProtocol !== 2 || !listSharingClusterMembers(db, input.clusterId).some(member => member.nodeId === response.locals.machineNodeId)) throw new ClusterV2HttpError(403, "Forbidden");
  const assignment = getClusterAgentPolicy(db, input.clusterId);
  const policy = assignment?.sourceRelayNodeId === local.id ? publishedRelayPolicy(db, local.id).body : assignment?.originNodeId === local.id ? assignment.policy : undefined;
  if (!policy || !policy.settings.skills.enforce || policy.skillDigests?.[input.name] !== input.digest) throw new ClusterV2HttpError(403, "This source does not enforce the requested skill");
  const built = await buildSkillBundle(path.join(agentResourcePaths().sharedSkills, input.name), input.name);
  if (built.digest !== input.digest) throw new ClusterV2HttpError(409, "The skill changed after its policy was published");
  response.json({ bundle: built.bundle });
}));
app.post("/api/cluster/v2/agent-policy/publication", handler(async (request, response) => {
  const { clusterId } = clusterBody.parse(request.body), db = await clusterV2Database(), local = await getClusterNode();
  if (response.locals.machineProtocol !== 2 || clusterManager(db, clusterId) !== response.locals.machineNodeId) throw new ClusterV2HttpError(403, "Forbidden");
  if (!listSharingClusterMembers(db, clusterId).some(member => member.nodeId === local.id)) throw new ClusterV2HttpError(403, "Forbidden");
  response.json(publishedRelayPolicy(db, local.id));
}));
app.post("/api/cluster/v2/agent-policy/snapshot", handler(async (request, response) => {
  const { clusterId } = clusterBody.parse(request.body), db = await clusterV2Database(), local = await getClusterNode();
  if (response.locals.machineProtocol !== 2 || getSharingCluster(db, clusterId).managerNodeId !== local.id || !listSharingClusterMembers(db, clusterId).some(member => member.nodeId === response.locals.machineNodeId)) throw new ClusterV2HttpError(403, "Forbidden");
  const assignment = getClusterAgentPolicy(db, clusterId);
  const snapshot = assignment ? { ...assignment, sourceStatement: assignment.sourceRelayNodeId ? clusterPolicySource(db, assignment.sourceRelayNodeId) : null } : null;
  response.json({ snapshot, signerNodeId: local.id, signature: signClusterMessage(db, local.id, "cluster-agent-policy-snapshot", JSON.stringify(snapshot)) });
}));

export async function pullClusterAgentPolicy(db: Awaited<ReturnType<typeof clusterV2Database>>, local: string, clusterId: string): Promise<void> {
  const manager = clusterManager(db, clusterId);
  if (manager === local) return;
  const reply = z.object({ snapshot: z.unknown(), signerNodeId: z.string().uuid(), signature: z.string() }).strict().parse(await signedPost(db, local, manager, clusterId, "/api/cluster/v2/agent-policy/snapshot", { clusterId }));
  const key = pinnedClusterPublicKey(db, manager);
  if (!key || reply.signerNodeId !== manager || !verifyClusterMessage(key, "cluster-agent-policy-snapshot", JSON.stringify(reply.snapshot), reply.signature)) throw new Error("Invalid cluster policy snapshot signature");
  if (reply.snapshot === null) return;
  const { applyClusterAgentPolicyEvent } = await import("../../cluster-agent-policy.js");
  if (!applyClusterAgentPolicyEvent(db, { id: randomUUID(), entityType: "cluster.agentPolicy", entityKey: clusterId, originNodeId: manager, operation: "upsert", payload: reply.snapshot, createdAt: new Date().toISOString() })) throw new Error("Invalid cluster policy snapshot");
}
