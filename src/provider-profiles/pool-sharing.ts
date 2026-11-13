import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { ensureClusterSharingPolicySchema, getSharingCluster, listSharingClusterMembers } from "../cluster-sharing-policy.js";
import { enqueueReplicationEvent, ensureReplicationSchema, type ReplicationEvent } from "../replication.js";
import type { ProfileProvider } from "./store.js";

const uuid = z.string().uuid();
export const poolProfileProviderSchema = z.enum(["claude", "openai-codex", "pi", "antigravity"]);
const fallbackModelsSchema = z.object({
  claude: z.string().trim().min(1).max(200).optional(),
  "openai-codex": z.string().trim().min(1).max(200).optional(),
  pi: z.string().trim().min(1).max(500).optional(),
}).strict();
const manifestMemberSchema = z.object({
  profileId: uuid,
  provider: poolProfileProviderSchema,
  label: z.string().trim().min(1).max(80),
  position: z.number().int().nonnegative(),
}).strict();
const manifestSchema = z.object({
  poolId: uuid,
  name: z.string().trim().min(1).max(80),
  fallbackModels: fallbackModelsSchema,
  members: z.array(manifestMemberSchema).min(1),
}).strict().superRefine((manifest, context) => {
  const positions = manifest.members.map(({ position }) => position);
  if (new Set(positions).size !== positions.length || positions.some((position) => position >= positions.length)) {
    context.addIssue({ code: "custom", message: "Pool member positions must be unique and consecutive" });
  }
  if (new Set(manifest.members.map(({ profileId }) => profileId)).size !== manifest.members.length) {
    context.addIssue({ code: "custom", message: "Pool profiles must be unique" });
  }
});
const assignmentEventSchema = z.object({
  clusterId: uuid,
  poolOwnerNodeId: uuid,
  poolId: uuid,
  manifest: manifestSchema.nullable(),
  managerEpoch: z.number().int().positive(),
  revision: z.number().int().positive(),
  updatedAt: z.string().datetime(),
  deleted: z.boolean(),
  originNodeId: uuid,
}).strict().superRefine((assignment, context) => {
  if (assignment.deleted === (assignment.manifest !== null)) {
    context.addIssue({ code: "custom", message: "Pool assignment deletion state is inconsistent" });
  }
  if (assignment.manifest && assignment.manifest.poolId !== assignment.poolId) {
    context.addIssue({ code: "custom", message: "Pool manifest ID does not match assignment" });
  }
});

type PoolAssignmentPayload = z.infer<typeof assignmentEventSchema>;
export type ClusterSubscriptionPoolManifest = z.infer<typeof manifestSchema>;
export type ClusterSubscriptionPoolAssignment = PoolAssignmentPayload;
export function parseClusterSubscriptionPoolAssignment(input: unknown): ClusterSubscriptionPoolAssignment {
  return assignmentEventSchema.parse(input);
}
interface AssignmentRow {
  cluster_id: string;
  pool_owner_node_id: string;
  pool_id: string;
  manifest: string | null;
  manager_epoch: number;
  revision: number;
  updated_at: string;
  deleted: number;
  origin_node_id: string;
}

export function ensureClusterSubscriptionPoolSchema(db: DatabaseSync): void {
  ensureClusterSharingPolicySchema(db);
  ensureReplicationSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS cluster_subscription_pool_assignments (
    cluster_id TEXT PRIMARY KEY,
    pool_owner_node_id TEXT NOT NULL,
    pool_id TEXT NOT NULL,
    manifest TEXT,
    manager_epoch INTEGER NOT NULL CHECK(manager_epoch > 0),
    revision INTEGER NOT NULL CHECK(revision > 0),
    updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),
    origin_node_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cluster_subscription_pool_grants (
    cluster_id TEXT NOT NULL, pool_id TEXT NOT NULL, account_id TEXT NOT NULL,
    PRIMARY KEY(cluster_id,pool_id)
  );`);
}

/** Host-local consent. This table never replicates and managers cannot write remote grants. */
export function setClusterPoolGrant(db: DatabaseSync, accountId: string, clusterId: string, poolId: string, enabled: boolean): void {
  ensureClusterSubscriptionPoolSchema(db);
  uuid.parse(clusterId); uuid.parse(poolId);
  if (enabled) db.prepare("INSERT INTO cluster_subscription_pool_grants VALUES(?,?,?) ON CONFLICT(cluster_id,pool_id) DO UPDATE SET account_id=excluded.account_id").run(clusterId, poolId, accountId);
  else db.prepare("DELETE FROM cluster_subscription_pool_grants WHERE cluster_id=? AND pool_id=? AND account_id=?").run(clusterId, poolId, accountId);
}
export function clusterPoolGranted(db: DatabaseSync, accountId: string, clusterId: string, poolId: string): boolean {
  ensureClusterSubscriptionPoolSchema(db);
  return Boolean(db.prepare("SELECT 1 FROM cluster_subscription_pool_grants WHERE cluster_id=? AND pool_id=? AND account_id=?").get(clusterId, poolId, accountId));
}

function rowAssignment(row: AssignmentRow): ClusterSubscriptionPoolAssignment {
  return assignmentEventSchema.parse({
    clusterId: row.cluster_id,
    poolOwnerNodeId: row.pool_owner_node_id,
    poolId: row.pool_id,
    manifest: row.manifest === null ? null : JSON.parse(row.manifest),
    managerEpoch: row.manager_epoch,
    revision: row.revision,
    updatedAt: row.updated_at,
    deleted: row.deleted === 1,
    originNodeId: row.origin_node_id,
  });
}

function heldAssignment(db: DatabaseSync, clusterId: string): AssignmentRow | undefined {
  return db.prepare(`SELECT cluster_id,pool_owner_node_id,pool_id,manifest,manager_epoch,revision,updated_at,deleted,origin_node_id
    FROM cluster_subscription_pool_assignments WHERE cluster_id=?`).get(clusterId) as AssignmentRow | undefined;
}

/** The relay that serves a relay group; undefined for an ordinary cluster. */
export function relayOfGroup(db: DatabaseSync, clusterId: string): string | undefined {
  ensureClusterSharingPolicySchema(db);
  return (db.prepare("SELECT relay_node_id FROM relay_sharing_groups WHERE cluster_id=?").get(clusterId) as { relay_node_id: string } | undefined)?.relay_node_id;
}
function validateManager(db: DatabaseSync, actorNodeId: string, clusterId: string, expectedEpoch: number): void {
  const state = getSharingCluster(db, clusterId);
  if (state.closed || state.managerNodeId !== actorNodeId || state.managerEpoch !== expectedEpoch) {
    throw new Error("Cluster manager authority changed");
  }
}

function persistAssignment(db: DatabaseSync, value: PoolAssignmentPayload): ClusterSubscriptionPoolAssignment {
  db.prepare(`INSERT INTO cluster_subscription_pool_assignments
    (cluster_id,pool_owner_node_id,pool_id,manifest,manager_epoch,revision,updated_at,deleted,origin_node_id)
    VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(cluster_id) DO UPDATE SET pool_owner_node_id=excluded.pool_owner_node_id,pool_id=excluded.pool_id,
    manifest=excluded.manifest,manager_epoch=excluded.manager_epoch,revision=excluded.revision,updated_at=excluded.updated_at,
    deleted=excluded.deleted,origin_node_id=excluded.origin_node_id`)
    .run(value.clusterId, value.poolOwnerNodeId, value.poolId, value.manifest ? JSON.stringify(value.manifest) : null,
      value.managerEpoch, value.revision, value.updatedAt, value.deleted ? 1 : 0, value.originNodeId);
  return value;
}

function publishAssignment(db: DatabaseSync, input: Omit<PoolAssignmentPayload, "revision" | "updatedAt" | "deleted" | "originNodeId">, actorNodeId: string, deleted: boolean): ClusterSubscriptionPoolAssignment {
  const held = heldAssignment(db, input.clusterId);
  const value = assignmentEventSchema.parse({
    ...input,
    revision: (held?.revision ?? 0) + 1,
    updatedAt: new Date().toISOString(),
    deleted,
    originNodeId: actorNodeId,
  });
  persistAssignment(db, value);
  enqueueReplicationEvent(db, {
    originNodeId: actorNodeId,
    entityType: "provider.poolAssignment",
    entityKey: value.clusterId,
    operation: "upsert",
    payload: value,
  });
  return value;
}

export function setClusterSubscriptionPool(
  db: DatabaseSync,
  managerNodeId: string,
  clusterId: string,
  poolOwnerNodeId: string,
  manifestInput: ClusterSubscriptionPoolManifest,
  expectedEpoch: number,
): ClusterSubscriptionPoolAssignment {
  ensureClusterSubscriptionPoolSchema(db);
  validateManager(db, managerNodeId, clusterId, expectedEpoch);
  const manifest = manifestSchema.parse(manifestInput);
  if (!listSharingClusterMembers(db, clusterId).some(({ nodeId }) => nodeId === poolOwnerNodeId)) {
    throw new Error("Pool owner must be a current cluster member");
  }
  const held = heldAssignment(db, clusterId);
  if (held && held.deleted === 0 && (held.pool_owner_node_id !== poolOwnerNodeId || held.pool_id !== manifest.poolId)) {
    throw new Error("A different pool is already assigned to this cluster");
  }
  return publishAssignment(db, {
    clusterId: uuid.parse(clusterId), poolOwnerNodeId: uuid.parse(poolOwnerNodeId), poolId: manifest.poolId, manifest,
    managerEpoch: expectedEpoch,
  }, managerNodeId, false);
}

export function clearClusterSubscriptionPool(
  db: DatabaseSync,
  managerNodeId: string,
  clusterId: string,
  poolOwnerNodeId: string,
  poolId: string,
  expectedEpoch: number,
): ClusterSubscriptionPoolAssignment {
  ensureClusterSubscriptionPoolSchema(db);
  validateManager(db, managerNodeId, clusterId, expectedEpoch);
  const held = heldAssignment(db, clusterId);
  if (!held || held.deleted || held.pool_owner_node_id !== poolOwnerNodeId || held.pool_id !== poolId) {
    throw new Error("Pool owner does not match the active assignment");
  }
  return publishAssignment(db, {
    clusterId: uuid.parse(clusterId), poolOwnerNodeId: uuid.parse(poolOwnerNodeId), poolId: uuid.parse(poolId),
    manifest: null, managerEpoch: expectedEpoch,
  }, managerNodeId, true);
}

export function getClusterSubscriptionPool(db: DatabaseSync, clusterId: string): ClusterSubscriptionPoolAssignment | undefined {
  ensureClusterSubscriptionPoolSchema(db);
  const row = heldAssignment(db, clusterId);
  const assignment = row && row.deleted === 0 ? rowAssignment(row) : undefined;
  return assignment;
}

export function assignedClusterPoolsForOwner(db: DatabaseSync, poolOwnerNodeId: string, poolId: string): ClusterSubscriptionPoolAssignment[] {
  ensureClusterSubscriptionPoolSchema(db);
  return (db.prepare(`SELECT cluster_id,pool_owner_node_id,pool_id,manifest,manager_epoch,revision,updated_at,deleted,origin_node_id
    FROM cluster_subscription_pool_assignments WHERE pool_owner_node_id=? AND pool_id=? AND deleted=0 ORDER BY cluster_id`)
    .all(poolOwnerNodeId, poolId) as unknown as AssignmentRow[]).map(rowAssignment)
    .filter((assignment) => listSharingClusterMembers(db, assignment.clusterId).some(({ nodeId }) => nodeId === poolOwnerNodeId));
}

/** Policy follows saved project shares, not a relay's current connection or lease. */
export function projectClusterIds(db: DatabaseSync, localNodeId: string, projectId: string): string[] {
  ensureClusterSharingPolicySchema(db);
  return (db.prepare(`SELECT DISTINCT s.cluster_id FROM sharing_resource_shares s
    JOIN sharing_resource_owners o ON o.kind=s.kind AND o.resource_id=s.resource_id
    JOIN sharing_memberships owner ON owner.cluster_id=s.cluster_id AND owner.node_id=o.owner_node_id
    JOIN sharing_memberships member ON member.cluster_id=s.cluster_id AND member.node_id=?
    JOIN sharing_clusters c ON c.id=s.cluster_id AND c.closed=0
    WHERE s.kind='project' AND s.resource_id=? AND
      (member.node_id=owner.node_id OR s.node_ids IS NULL OR EXISTS (SELECT 1 FROM json_each(s.node_ids) WHERE value=member.node_id))
    ORDER BY s.cluster_id`).all(localNodeId, projectId) as Array<{ cluster_id: string }>).map((row) => row.cluster_id);
}

export function resolveClusterSubscriptionPools(db: DatabaseSync, localNodeId: string, projectId: string): ClusterSubscriptionPoolAssignment[] {
  ensureClusterSubscriptionPoolSchema(db);
  const clusterIds = projectClusterIds(db, localNodeId, projectId).sort();
  return clusterIds.map((clusterId) => getClusterSubscriptionPool(db, clusterId))
    .filter((assignment): assignment is ClusterSubscriptionPoolAssignment => Boolean(assignment))
    .map(assignment => {
      const state = getSharingCluster(db, assignment.clusterId);
      if (state.managerEpoch !== assignment.managerEpoch || state.managerNodeId !== assignment.originNodeId) throw new Error("Cluster pool assignment requires a manager refresh");
      if (!listSharingClusterMembers(db, assignment.clusterId).some(({ nodeId }) => nodeId === assignment.poolOwnerNodeId)) throw new Error("Mandatory cluster pool host is no longer a cluster member");
      return assignment;
    });
}

export function applyClusterSubscriptionPoolEvent(db: DatabaseSync, event: ReplicationEvent): boolean {
  ensureClusterSubscriptionPoolSchema(db);
  const parsed = assignmentEventSchema.safeParse(event.payload);
  if (!parsed.success || event.entityType !== "provider.poolAssignment" || event.operation !== "upsert"
    || parsed.data.originNodeId !== event.originNodeId || event.entityKey !== parsed.data.clusterId) return false;
  const value = parsed.data;
  const state = db.prepare("SELECT manager_node_id,manager_epoch,closed FROM sharing_clusters WHERE id=?").get(value.clusterId) as { manager_node_id: string | null; manager_epoch: number; closed: number } | undefined;
  if (!state || state.closed || state.manager_node_id !== event.originNodeId || state.manager_epoch !== value.managerEpoch) return false;
  const members = new Set((db.prepare("SELECT node_id FROM sharing_memberships WHERE cluster_id=?").all(value.clusterId) as unknown as Array<{ node_id: string }>).map(({ node_id }) => node_id));
  if (!members.has(event.originNodeId) || !value.deleted && !members.has(value.poolOwnerNodeId)) return false;
  const held = heldAssignment(db, value.clusterId);
  if (held && (held.manager_epoch > value.managerEpoch || held.manager_epoch === value.managerEpoch && held.revision > value.revision)) return true;
  if (held && held.manager_epoch === value.managerEpoch && held.revision === value.revision) return JSON.stringify(rowAssignment(held)) === JSON.stringify(value);
  persistAssignment(db, value);
  return true;
}

export function clusterPoolProfileAuthorized(db: DatabaseSync, clusterId: string, poolOwnerNodeId: string, requesterNodeId: string, poolId: string, profileId: string): boolean {
  ensureClusterSubscriptionPoolSchema(db);
  const assignment = getClusterSubscriptionPool(db, clusterId);
  if (!assignment || assignment.poolOwnerNodeId !== poolOwnerNodeId || assignment.poolId !== poolId) return false;
  const state = getSharingCluster(db, clusterId);
  if (state.closed || state.managerEpoch !== assignment.managerEpoch || state.managerNodeId !== assignment.originNodeId) return false;
  const members = new Set(listSharingClusterMembers(db, clusterId).map(({ nodeId }) => nodeId));
  return members.has(poolOwnerNodeId) && members.has(requesterNodeId)
    && Boolean(assignment.manifest?.members.some((member) => member.profileId === profileId));
}

export function poolManifestProfiles(manifest: ClusterSubscriptionPoolManifest): Array<{ profileId: string; provider: ProfileProvider; label: string; position: number }> {
  return manifestSchema.parse(manifest).members.map((member) => ({ ...member }));
}
