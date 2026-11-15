import { readOncePerPass } from "./resource-pass.js";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { getSharingCluster, listSharingClusterMembers } from "./cluster-sharing-policy.js";
import { pinnedClusterPublicKey, verifyClusterMessage } from "./cluster-identity.js";
import { projectClusterIds } from "./provider-profiles/pool-sharing.js";
import { agentPolicyBodySchema, publishedRelayPolicy, signedRelaySkillPolicySchema, type SignedRelaySkillPolicy } from "./relay/resource-policy.js";
import { enqueueReplicationEvent, ensureReplicationSchema, type ReplicationEvent } from "./replication.js";

export { agentPolicyBodySchema };
export type AgentPolicyBody = z.infer<typeof agentPolicyBodySchema>;
const assignmentSchema = z.object({
  clusterId: z.string().uuid(), managerEpoch: z.number().int().positive(), revision: z.number().int().positive(),
  originNodeId: z.string().uuid(), sourceRelayNodeId: z.string().uuid().nullable(),
  // Read lazily: relay/resource-policy.ts imports this module back, so the schema may not exist yet at load.
  policy: z.lazy(() => agentPolicyBodySchema),
}).strict();
export type ClusterAgentPolicy = z.infer<typeof assignmentSchema>;
export function ensureClusterAgentPolicySchema(db: DatabaseSync): void {
  ensureReplicationSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS cluster_agent_policies(cluster_id TEXT PRIMARY KEY, assignment TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cluster_agent_policy_sources(node_id TEXT PRIMARY KEY, statement TEXT NOT NULL)`);
}
export function getClusterAgentPolicy(db: DatabaseSync, clusterId: string): ClusterAgentPolicy | undefined {
  ensureClusterAgentPolicySchema(db);
  const row = db.prepare("SELECT assignment FROM cluster_agent_policies WHERE cluster_id=?").get(clusterId) as { assignment: string } | undefined;
  return row ? assignmentSchema.parse(JSON.parse(row.assignment)) : undefined;
}
export function clusterPolicySource(db: DatabaseSync, nodeId: string): SignedRelaySkillPolicy | undefined {
  ensureClusterAgentPolicySchema(db);
  const row = db.prepare("SELECT statement FROM cluster_agent_policy_sources WHERE node_id=?").get(nodeId) as { statement: string } | undefined;
  return row ? signedRelaySkillPolicySchema.parse(JSON.parse(row.statement)) : undefined;
}
function sourcePublicKey(db: DatabaseSync, source: string): string | undefined {
  return pinnedClusterPublicKey(db, source) ?? (db.prepare("SELECT public_key FROM cluster_v2_identity WHERE node_id=?").get(source) as { public_key: string } | undefined)?.public_key;
}
function acceptSource(db: DatabaseSync, source: string, input: unknown): SignedRelaySkillPolicy {
  const statement = signedRelaySkillPolicySchema.parse(input), key = sourcePublicKey(db, source);
  if (!key || statement.body.relayNodeId !== source || !verifyClusterMessage(key, "relay-skill-policy", JSON.stringify(statement.body), statement.signature)) throw new Error("Cluster policy source signature is invalid");
  const held = clusterPolicySource(db, source);
  if (held && JSON.stringify(held) === JSON.stringify(statement)) return statement;
  if (held && statement.body.version < held.body.version) throw new Error("Stale cluster policy source");
  if (held && statement.body.version === held.body.version && JSON.stringify(held) !== JSON.stringify(statement)) throw new Error("Conflicting cluster policy source version");
  db.prepare("INSERT INTO cluster_agent_policy_sources VALUES(?,?) ON CONFLICT(node_id) DO UPDATE SET statement=excluded.statement").run(source, JSON.stringify(statement));
  return statement;
}
function persist(db: DatabaseSync, assignment: ClusterAgentPolicy): void {
  db.prepare("INSERT INTO cluster_agent_policies VALUES(?,?) ON CONFLICT(cluster_id) DO UPDATE SET assignment=excluded.assignment").run(assignment.clusterId, JSON.stringify(assignment));
}
export function setClusterAgentPolicy(db: DatabaseSync, managerNodeId: string, clusterId: string,
  input: { policy: AgentPolicyBody; sourceRelayNodeId: string | null; sourceStatement?: SignedRelaySkillPolicy }, expectedEpoch: number): ClusterAgentPolicy {
  const state = getSharingCluster(db, clusterId), held = getClusterAgentPolicy(db, clusterId);
  if (state.closed || state.managerNodeId !== managerNodeId || state.managerEpoch !== expectedEpoch) throw new Error("Cluster manager authority changed");
  const assignment = assignmentSchema.parse({ clusterId, managerEpoch: expectedEpoch, revision: (held?.revision ?? 0) + 1, originNodeId: managerNodeId, policy: input.policy, sourceRelayNodeId: input.sourceRelayNodeId });
  if (input.sourceRelayNodeId) {
    if (!listSharingClusterMembers(db, clusterId).some(({ nodeId }) => nodeId === input.sourceRelayNodeId)) throw new Error("Policy source must be a current cluster member");
    const statement = input.sourceStatement ?? clusterPolicySource(db, input.sourceRelayNodeId);
    if (!statement) throw new Error("Cluster policy source is unavailable");
    acceptSource(db, input.sourceRelayNodeId, statement);
  }
  persist(db, assignment);
  enqueueReplicationEvent(db, { originNodeId: managerNodeId, entityType: "cluster.agentPolicy", entityKey: clusterId, operation: "upsert", payload: { ...assignment, sourceStatement: assignment.sourceRelayNodeId ? clusterPolicySource(db, assignment.sourceRelayNodeId) : null } });
  return assignment;
}
export function applyClusterAgentPolicyEvent(db: DatabaseSync, event: ReplicationEvent): boolean {
  ensureClusterAgentPolicySchema(db);
  if (event.entityType !== "cluster.agentPolicy" || event.operation !== "upsert") return false;
  const parsed = assignmentSchema.extend({ sourceStatement: signedRelaySkillPolicySchema.nullable() }).safeParse(event.payload);
  if (!parsed.success || parsed.data.clusterId !== event.entityKey || parsed.data.originNodeId !== event.originNodeId) return false;
  const { sourceStatement, ...assignment } = parsed.data;
  if (!db.prepare("SELECT 1 FROM sharing_clusters WHERE id=?").get(assignment.clusterId)) return false;
  const state = getSharingCluster(db, assignment.clusterId);
  if (state.closed || state.managerNodeId !== event.originNodeId || state.managerEpoch !== assignment.managerEpoch) return false;
  const held = getClusterAgentPolicy(db, assignment.clusterId);
  if (held && held.managerEpoch === assignment.managerEpoch && held.revision >= assignment.revision) return JSON.stringify(held) === JSON.stringify(assignment) || held.revision > assignment.revision;
  if (assignment.sourceRelayNodeId) {
    if (!sourceStatement || !listSharingClusterMembers(db, assignment.clusterId).some(({ nodeId }) => nodeId === assignment.sourceRelayNodeId)) return false;
    try { acceptSource(db, assignment.sourceRelayNodeId, sourceStatement); } catch { return false; }
  }
  persist(db, assignment);
  const local = db.prepare("SELECT node_id FROM cluster_v2_identity WHERE singleton=1").get() as { node_id: string } | undefined;
  if (assignment.sourceRelayNodeId === local?.node_id) publishClusterPolicySource(db, publishedRelayPolicy(db, local.node_id));
  return true;
}
export function cacheClusterPolicySource(db: DatabaseSync, statement: SignedRelaySkillPolicy): void {
  ensureClusterAgentPolicySchema(db);
  const assignments = db.prepare("SELECT assignment FROM cluster_agent_policies").all() as Array<{ assignment: string }>;
  if (assignments.some(row => assignmentSchema.parse(JSON.parse(row.assignment)).sourceRelayNodeId === statement.body.relayNodeId)) acceptSource(db, statement.body.relayNodeId, statement);
}
/** Source publications are signed independently from the manager's source selection. */
export function applyClusterAgentPolicySourceEvent(db: DatabaseSync, event: ReplicationEvent): boolean {
  ensureClusterAgentPolicySchema(db);
  if (event.entityType !== "cluster.agentPolicySource") return false;
  const payload = z.object({ clusterId: z.string().uuid(), statement: signedRelaySkillPolicySchema }).strict().safeParse(event.payload);
  if (!payload.success || event.operation !== "upsert" || payload.data.clusterId !== event.entityKey) return false;
  const assignment = getClusterAgentPolicy(db, payload.data.clusterId);
  if (!assignment || assignment.sourceRelayNodeId !== event.originNodeId || !listSharingClusterMembers(db, assignment.clusterId).some(({ nodeId }) => nodeId === event.originNodeId)) return false;
  try { acceptSource(db, event.originNodeId, payload.data.statement); return true; } catch { return false; }
}
export function publishClusterPolicySource(db: DatabaseSync, statement: SignedRelaySkillPolicy): void {
  ensureClusterAgentPolicySchema(db);
  for (const row of db.prepare("SELECT assignment FROM cluster_agent_policies").all() as Array<{ assignment: string }>) {
    const assignment = assignmentSchema.parse(JSON.parse(row.assignment));
    if (assignment.sourceRelayNodeId !== statement.body.relayNodeId) continue;
    acceptSource(db, assignment.sourceRelayNodeId, statement);
    enqueueReplicationEvent(db, { originNodeId: statement.body.relayNodeId, entityType: "cluster.agentPolicySource", entityKey: assignment.clusterId, operation: "upsert", payload: { clusterId: assignment.clusterId, statement } });
  }
}
export type ProjectAgentPolicy = { clusterId: string; source: string; sourceNodeId: string; policy: AgentPolicyBody };
const databaseIds = new WeakMap<DatabaseSync, number>();
let lastDatabaseId = 0;
export function projectAgentPolicies(db: DatabaseSync, projectId: string | undefined): ProjectAgentPolicy[] {
  if (!projectId) return [];
  let id = databaseIds.get(db);
  if (id === undefined) databaseIds.set(db, id = ++lastDatabaseId);
  return readOncePerPass(`cluster-agent-policy:${id}:${projectId}`, () => readProjectAgentPolicies(db, projectId));
}
function readProjectAgentPolicies(db: DatabaseSync, projectId: string): ProjectAgentPolicy[] {
  ensureClusterAgentPolicySchema(db);
  if (!db.prepare("SELECT 1 FROM cluster_agent_policies LIMIT 1").get()) return [];
  const local = db.prepare("SELECT id FROM cluster_node WHERE singleton=1").get() as { id: string };
  return projectClusterIds(db, local.id, projectId).flatMap(clusterId => clusterAgentPolicyLayers(db, clusterId));
}
/** The policy layers of every cluster this machine has a policy for, one list per cluster, whatever project they apply to. */
export function allClusterAgentPolicies(db: DatabaseSync): ProjectAgentPolicy[][] {
  ensureClusterAgentPolicySchema(db);
  return (db.prepare("SELECT cluster_id FROM cluster_agent_policies").all() as Array<{ cluster_id: string }>).map(({ cluster_id }) => clusterAgentPolicyLayers(db, cluster_id));
}
function clusterAgentPolicyLayers(db: DatabaseSync, clusterId: string): ProjectAgentPolicy[] {
  const assignment = getClusterAgentPolicy(db, clusterId);
  if (!assignment) return [];
  const cluster = getSharingCluster(db, clusterId);
  if (cluster.closed || assignment.managerEpoch !== cluster.managerEpoch || assignment.originNodeId !== cluster.managerNodeId) throw new Error(`Cluster policy requires refresh: ${cluster.name}`);
  const layers = [{ clusterId, source: cluster.name, sourceNodeId: assignment.originNodeId, policy: assignment.policy }];
  if (assignment.sourceRelayNodeId) {
    if (!listSharingClusterMembers(db, clusterId).some(({ nodeId }) => nodeId === assignment.sourceRelayNodeId)) throw new Error(`Cluster policy source was removed: ${cluster.name}`);
    const statement = clusterPolicySource(db, assignment.sourceRelayNodeId);
    if (!statement) throw new Error(`Cluster policy source unavailable: ${cluster.name}`);
    const key = sourcePublicKey(db, assignment.sourceRelayNodeId);
    if (!key || !verifyClusterMessage(key, "relay-skill-policy", JSON.stringify(statement.body), statement.signature)) throw new Error(`Cluster policy source signature is invalid: ${cluster.name}`);
    const { relayNodeId, version, ...policy } = statement.body;
    layers.unshift({ clusterId, source: `${cluster.name} · source`, sourceNodeId: assignment.sourceRelayNodeId, policy });
  }
  return layers;
}
