import { DatabaseSync } from "node:sqlite";
import { ownedByAdmin } from "./ownership.js";
import { notifyRelayPeersChanged } from "./relay/events.js";
import { untilNextWrite } from "./sqlite-generation.js";

export type SharedResourceKind = "project" | "ticket" | "secret";
export interface ResourceShare { clusterId: string; projectId: string | null; nodeIds?: string[] }
export interface SharingCluster { id: string; name: string }
export interface SharingClusterState extends SharingCluster { originalNodeId: string; managerNodeId: string | null; managerEpoch: number; closed: boolean }
export interface SharingMembership { clusterId: string; nodeId: string; autoShareProjects: boolean; joinSequence: number }
export interface SharingManagerTransfer {
  clusterId: string; transferId: string; fromNodeId: string; toNodeId: string; expectedEpoch: number;
  status: "prepared" | "accepted" | "committed";
}
export type OwnedResource =
  | { kind: "project" | "secret"; id: string; ownerNodeId: string }
  | { kind: "ticket"; id: string; ownerNodeId: string; projectId: string };

interface MembershipRow { cluster_id: string; node_id: string; auto_share_projects: number; join_sequence: number }
interface ClusterRow { id: string; name: string; original_node_id: string; manager_node_id: string | null; manager_epoch: number; next_join_sequence: number; closed: number }
interface TransferRow { cluster_id: string; transfer_id: string; from_node_id: string; to_node_id: string; expected_epoch: number; status: "prepared" | "accepted" | "committed" }
interface CountRow { count: number }
interface ShareRow { cluster_id: string; project_id: string; node_ids: string | null }
interface OwnerRow { owner_node_id: string; project_id: string | null }
interface IdRow { cluster_id: string }
const kinds = new Set<SharedResourceKind>(["project", "ticket", "secret"]);
const relayLeaseEpoch = `${process.pid}:${process.hrtime.bigint()}`;
const RELAY_SHARING_LEASE_MS = 90_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateUuid(value: string, label: string): void {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw new Error(`${label} must be a valid UUID`);
}
function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
}
function validateKind(kind: SharedResourceKind): void {
  if (!kinds.has(kind)) throw new Error("Invalid resource kind");
}
function validateResourceId(id: string): void {
  if (typeof id !== "string" || id.trim().length === 0 || id.length > 300 || id !== id.trim() || /[\x00-\x1f\x7f]/.test(id)) {
    throw new Error("Resource ID must be nonblank, already trimmed, contain no ASCII control characters, and be at most 300 characters");
  }
}
function validateResource(kind: SharedResourceKind, id: string): void { validateKind(kind); validateResourceId(id); }
function validateName(name: string): void {
  if (typeof name !== "string" || name.trim().length === 0 || name.trim().length > 80) throw new Error("Cluster name must contain 1 to 80 characters");
}
function inSavepoint<T>(db: DatabaseSync, action: () => T): T {
  db.exec("SAVEPOINT sharing_policy_write");
  try { const result = action(); db.exec("RELEASE sharing_policy_write"); return result; }
  catch (error) { db.exec("ROLLBACK TO sharing_policy_write; RELEASE sharing_policy_write"); throw error; }
}
function membershipExists(db: DatabaseSync, clusterId: string, nodeId: string): boolean {
  return db.prepare("SELECT 1 FROM sharing_memberships WHERE cluster_id = ? AND node_id = ?").get(clusterId, nodeId) !== undefined;
}
function requireCluster(db: DatabaseSync, clusterId: string): void { getSharingCluster(db, clusterId); }
function clusterRow(db: DatabaseSync, clusterId: string): ClusterRow {
  const row = db.prepare("SELECT id,name,original_node_id,manager_node_id,manager_epoch,next_join_sequence,closed FROM sharing_clusters WHERE id=?").get(clusterId) as ClusterRow | undefined;
  if (!row) throw new Error(`Unknown cluster: ${clusterId}`);
  return row;
}
function membershipRow(db: DatabaseSync, clusterId: string, nodeId: string): MembershipRow {
  const row = db.prepare("SELECT cluster_id,node_id,auto_share_projects,join_sequence FROM sharing_memberships WHERE cluster_id=? AND node_id=?").get(clusterId, nodeId) as MembershipRow | undefined;
  if (!row) throw new Error(`Node ${nodeId} is not a member of cluster ${clusterId}`);
  return row;
}
function transferRow(db: DatabaseSync, clusterId: string, transferId: string): TransferRow | undefined {
  return db.prepare("SELECT cluster_id,transfer_id,from_node_id,to_node_id,expected_epoch,status FROM sharing_manager_transfers WHERE cluster_id=? AND transfer_id=?").get(clusterId, transferId) as TransferRow | undefined;
}
function requireMembership(db: DatabaseSync, clusterId: string, nodeId: string): void {
  if (!membershipExists(db, clusterId, nodeId)) throw new Error(`Node ${nodeId} is not a member of cluster ${clusterId}`);
}
function ownerOrThrow(db: DatabaseSync, kind: SharedResourceKind, id: string): string {
  const row = db.prepare("SELECT owner_node_id FROM sharing_resource_owners WHERE kind = ? AND resource_id = ?").get(kind, id) as OwnerRow | undefined;
  if (!row) throw new Error(`Unknown ${kind} resource: ${id}`);
  return row.owner_node_id;
}
function policyResource(db: DatabaseSync, kind: SharedResourceKind, id: string): { kind: "project" | "secret"; id: string } {
  if (kind !== "ticket") { ownerOrThrow(db, kind, id); return { kind, id }; }
  const ticket = db.prepare("SELECT project_id FROM sharing_resource_owners WHERE kind='ticket' AND resource_id=?").get(id) as OwnerRow | undefined;
  if (!ticket) throw new Error(`Unknown ticket resource: ${id}`);
  ownerOrThrow(db, "project", ticket.project_id!);
  return { kind: "project", id: ticket.project_id! };
}
function pair(left: string, right: string): [string, string] { return left < right ? [left, right] : [right, left]; }

/* The sharing lookups are asked thousands of times a second with the same arguments, and each runs
   several queries. Their answers are kept until the next write to the database.

   sqlite-generation.ts says when that is: it reads SQLite's own counters and keeps an object until
   one of them moves. The object kept here is one table of answers per connection. A lookup that is
   asked from outside reads the counters once and gets the table. The lookups it asks while it is
   computed use the same table without reading the counters again: a peer's shared projects ask
   about every project twice, and reading the counters for each of those cost more than it saved
   whenever the answers were needed only once before the next write. So every answer a lookup
   gives is true of the database as it was when that lookup began, or later. An answer that was
   put into the table while the counters moved goes with the table: the next lookup from outside
   reads the counters, sees them moved and starts an empty table. Nothing is put into the table
   inside a transaction, whose changes may be rolled back.

   A kept answer must rest on the database alone, and two things these lookups read do not:

   - A relay's lease on a sharing group runs out by the clock, with no write.
   - A visitor's clusters and a team's members are read from the sign-in tables through another
     module's connection, whose open transaction this connection cannot see.

   So a lookup that is being computed carries the span of time its answer holds for. Reading a
   lease narrows the span to the moment the lease was read and the moment it ends. Reading through
   another connection empties it. A kept answer is served only inside its span; outside it the lookup
   is computed again. A lookup that asks another takes over the other's span, so the outer answer
   never outlives the inner one. */
interface Kept { value: unknown; from: number; until: number }
/** A lookup being computed: its connection, that connection's table of answers, and the span its own answer holds for. */
interface Lookup { db: DatabaseSync; answers: Map<string, Kept>; from: number; until: number }
let computing: Lookup | undefined;
/** No real key comes near this: ids are at most 300 characters. A longer one is computed and not kept, so made-up ids cannot fill the memory. */
const MAX_KEY_LENGTH = 1024;
/** Answers held for one connection before the table is emptied: bounds memory on a node with many projects and peers. */
const MAX_ANSWERS = 20_000;
const ANSWERS = "cluster-sharing-policy:answers";
const newAnswers = (): Map<string, Kept> => new Map();

/** The table a lookup on `db` reads and fills: the outer lookup's when that is on the same connection. */
function answersFor(db: DatabaseSync, outer: Lookup | undefined): Map<string, Kept> {
  if (outer?.db === db) return outer.answers;
  // An outer lookup on another connection would rest on this one, which its own counters say nothing about.
  if (outer) outer.until = -Infinity;
  return untilNextWrite(db, ANSWERS, newAnswers);
}
function narrow(lookup: Lookup, from: number, until: number): void {
  if (from > lookup.from) lookup.from = from;
  if (until < lookup.until) lookup.until = until;
}

/**
 * `compute()`'s answer, kept until the next write to the database or until a relay lease it read runs
 * out. `name` is the function's own; `ids` are all the arguments the answer depends on. What is
 * returned is the very object that was kept, so callers must not change it. `compute` only reads.
 */
export function untilWriteOrLeaseEnd<T>(db: DatabaseSync, name: string, ids: readonly unknown[], compute: () => T): T {
  let key = name;
  for (const id of ids) {
    // Kept for text only, which every real id is. Anything else is answered as it always was.
    if (typeof id !== "string") return compute();
    // The length keeps the ids apart whatever characters they hold.
    key += `\0${id.length}\0${id}`;
  }
  if (key.length > MAX_KEY_LENGTH) return compute();
  const outer = computing;
  const answers = answersFor(db, outer);
  const kept = answers.get(key);
  if (kept !== undefined) {
    const timed = kept.from !== -Infinity || kept.until !== Infinity;
    const now = timed ? Date.now() : 0;
    // No write was made since it was kept, so the rows are the same. Only the clock can have moved past a lease, or back.
    if (!timed || (now >= kept.from && now < kept.until)) {
      if (outer?.db === db) narrow(outer, kept.from, kept.until);
      return kept.value as T;
    }
  }
  const mine: Lookup = { db, answers, from: -Infinity, until: Infinity };
  computing = mine;
  let value: T;
  try { value = compute(); }
  // Also when it throws: a caller that turns the failure into an answer rests on what was read before it.
  finally { computing = outer; if (outer?.db === db) narrow(outer, mine.from, mine.until); }
  if (mine.until === -Infinity || db.isTransaction !== false) answers.delete(key);
  else {
    if (answers.size >= MAX_ANSWERS) answers.clear();
    answers.set(key, { value, from: mine.from, until: mine.until });
  }
  return value;
}

/**
 * Runs `read` as one lookup on `db`, keeping nothing of its own: the lookups it asks share one table
 * and one reading of the counters. For a function that asks several in a row. `read` only reads.
 */
export function asOneLookup<T>(db: DatabaseSync, read: () => T): T {
  const outer = computing;
  if (outer?.db === db) return read();
  computing = { db, answers: answersFor(db, outer), from: -Infinity, until: Infinity };
  try { return read(); }
  finally { computing = outer; }
}

/** For a lookup that reads what no write to this database announces: its answer, and any answer built on it, is computed every time. */
export function answerIsNotKept(): void {
  if (computing) computing.until = -Infinity;
}

/* Tables are made when a feature is first used and are not dropped while the node runs, so a table that
   was found stays found for the connection. A missing one is looked for again every time. Nothing is
   remembered inside a transaction: a rollback takes a table made in it away again. */
const tablesFound = new WeakMap<DatabaseSync, Set<string>>();
function tableFound(db: DatabaseSync, name: string): boolean {
  const found = tablesFound.get(db);
  if (found?.has(name)) return true;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) return false;
  if (db.isTransaction === false) { if (found) found.add(name); else tablesFound.set(db, new Set([name])); }
  return true;
}

/* Called at the top of most sharing functions. The script changes nothing once the tables are there,
   and they are not dropped while the node runs, so it is run once per connection. Not remembered
   inside a transaction: a rollback takes the new tables away again. */
const policySchemaEnsured = new WeakSet<DatabaseSync>();

export function ensureClusterSharingPolicySchema(db: DatabaseSync): void {
  if (policySchemaEnsured.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS sharing_clusters(id TEXT PRIMARY KEY, name TEXT NOT NULL, original_node_id TEXT NOT NULL, manager_node_id TEXT, manager_epoch INTEGER NOT NULL CHECK(manager_epoch>0), next_join_sequence INTEGER NOT NULL CHECK(next_join_sequence>0), closed INTEGER NOT NULL CHECK(closed IN (0,1)), CHECK((closed=0 AND manager_node_id IS NOT NULL) OR (closed=1 AND manager_node_id IS NULL)));
CREATE TABLE IF NOT EXISTS sharing_memberships(cluster_id TEXT NOT NULL REFERENCES sharing_clusters(id), node_id TEXT NOT NULL, auto_share_projects INTEGER NOT NULL DEFAULT 0 CHECK(auto_share_projects IN (0,1)), join_sequence INTEGER NOT NULL CHECK(join_sequence>0), PRIMARY KEY(cluster_id,node_id), UNIQUE(cluster_id,join_sequence));
CREATE TABLE IF NOT EXISTS sharing_manager_transfers(cluster_id TEXT NOT NULL REFERENCES sharing_clusters(id), transfer_id TEXT NOT NULL, from_node_id TEXT NOT NULL, to_node_id TEXT NOT NULL, expected_epoch INTEGER NOT NULL CHECK(expected_epoch>0), status TEXT NOT NULL CHECK(status IN ('prepared','accepted','committed')), PRIMARY KEY(cluster_id,transfer_id), UNIQUE(cluster_id,expected_epoch));
CREATE TABLE IF NOT EXISTS sharing_explicit_project_selections(cluster_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS sharing_resource_owners(kind TEXT NOT NULL CHECK(kind IN ('project','ticket','secret')), resource_id TEXT NOT NULL, owner_node_id TEXT NOT NULL, project_id TEXT, PRIMARY KEY(kind,resource_id), CHECK((kind='ticket' AND project_id IS NOT NULL AND length(project_id)>0) OR (kind<>'ticket' AND project_id IS NULL)));
CREATE TABLE IF NOT EXISTS sharing_resource_shares(kind TEXT NOT NULL, resource_id TEXT NOT NULL, cluster_id TEXT NOT NULL REFERENCES sharing_clusters(id), project_id TEXT NOT NULL DEFAULT '', PRIMARY KEY(kind,resource_id,cluster_id,project_id), FOREIGN KEY(kind,resource_id) REFERENCES sharing_resource_owners(kind,resource_id));
CREATE TABLE IF NOT EXISTS sharing_twins(left_node_id TEXT NOT NULL, right_node_id TEXT NOT NULL, PRIMARY KEY(left_node_id,right_node_id), CHECK(left_node_id < right_node_id));
CREATE TABLE IF NOT EXISTS relay_sharing_groups(relay_node_id TEXT PRIMARY KEY,cluster_id TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS relay_sharing_live(relay_node_id TEXT PRIMARY KEY,epoch TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sharing_memberships_node_id ON sharing_memberships(node_id);
CREATE INDEX IF NOT EXISTS sharing_resource_shares_cluster_id ON sharing_resource_shares(cluster_id);
CREATE INDEX IF NOT EXISTS sharing_resource_owners_owner_node_id ON sharing_resource_owners(owner_node_id);`);
  if (!(db.prepare("PRAGMA table_info(sharing_resource_shares)").all() as Array<{name: string}>).some(column => column.name === "node_ids")) {
    db.exec("ALTER TABLE sharing_resource_shares ADD COLUMN node_ids TEXT");
  }
  if (db.isTransaction === false) policySchemaEnsured.add(db);
}

/** INTERNAL topology API. Network callers must first verify a membership invitation or snapshot. */
export function createSharingCluster(db: DatabaseSync, cluster: SharingCluster, nodeId: string): void {
  validateUuid(cluster.id, "Cluster ID"); validateUuid(nodeId, "Node ID"); validateName(cluster.name);
  inSavepoint(db, () => {
    db.prepare("INSERT INTO sharing_clusters(id,name,original_node_id,manager_node_id,manager_epoch,next_join_sequence,closed) VALUES (?,?,?,?,1,2,0)").run(cluster.id, cluster.name.trim(), nodeId, nodeId);
    db.prepare("INSERT INTO sharing_memberships(cluster_id,node_id,join_sequence) VALUES (?,?,1)").run(cluster.id, nodeId);
  });
}

/** A restart or a lost authenticated relay connection cannot keep stale admission grants alive. */
export function recordRelaySharingHeartbeat(db: DatabaseSync, relayNodeId: string, connected: boolean, now = Date.now()): void {
  db.exec("CREATE TABLE IF NOT EXISTS relay_sharing_live(relay_node_id TEXT PRIMARY KEY,epoch TEXT NOT NULL,expires_at INTEGER NOT NULL)");
  if (!connected) { db.prepare("DELETE FROM relay_sharing_live WHERE relay_node_id=?").run(relayNodeId); return; }
  db.prepare("INSERT INTO relay_sharing_live VALUES(?,?,?) ON CONFLICT(relay_node_id) DO UPDATE SET epoch=excluded.epoch,expires_at=excluded.expires_at")
    .run(relayNodeId, relayLeaseEpoch, now + RELAY_SHARING_LEASE_MS);
}

export function relaySharingGroupActive(db: DatabaseSync, clusterId: string, now?: number): boolean {
  const group = db.prepare("SELECT relay_node_id FROM relay_sharing_groups WHERE cluster_id=?").get(clusterId) as {relay_node_id: string}|undefined;
  if (!group) return true;
  const has = (table: string) => tableFound(db, table);
  const local = has("cluster_v2_identity") ? (db.prepare("SELECT node_id FROM cluster_v2_identity WHERE singleton=1").get() as {node_id: string}|undefined)?.node_id : undefined;
  if (local === group.relay_node_id) return has("relay_serving") && Boolean(db.prepare("SELECT 1 FROM relay_serving WHERE enabled=1 AND origin<>''").get());
  return has("relay_memberships") && has("relay_sharing_live")
    && Boolean(db.prepare("SELECT 1 FROM relay_memberships WHERE relay_node_id=? AND status='admitted'").get(group.relay_node_id))
    && relayLeaseLive(db, group.relay_node_id, now);
}
/** Whether this process holds a lease from the relay that has not run out. The one answer here that the clock changes. */
function relayLeaseLive(db: DatabaseSync, relayNodeId: string, at?: number): boolean {
  const now = at ?? Date.now();
  const live = Boolean(db.prepare("SELECT 1 FROM relay_sharing_live WHERE relay_node_id=? AND epoch=? AND expires_at>?").get(relayNodeId, relayLeaseEpoch, now));
  if (!computing) return live;
  // A caller that names its own time is answered for that time only.
  if (at !== undefined) { computing.until = -Infinity; return live; }
  // A live lease holds until it ends. One that is not live stays so, unless the clock is set back.
  const end = live ? (db.prepare("SELECT expires_at FROM relay_sharing_live WHERE relay_node_id=? AND epoch=?").get(relayNodeId, relayLeaseEpoch) as { expires_at: unknown } | undefined)?.expires_at : Infinity;
  narrow(computing, now, typeof end === "number" ? end : -Infinity);
  return live;
}

export function getSharingCluster(db: DatabaseSync, clusterId: string): SharingClusterState {
  validateUuid(clusterId, "Cluster ID"); const row = clusterRow(db, clusterId);
  return { id: row.id, name: row.name, originalNodeId: row.original_node_id, managerNodeId: row.manager_node_id, managerEpoch: row.manager_epoch, closed: row.closed === 1 || !relaySharingGroupActive(db, clusterId) };
}
export function listSharingClusterMembers(db: DatabaseSync, clusterId: string): SharingMembership[] {
  validateUuid(clusterId, "Cluster ID"); requireCluster(db, clusterId);
  const rows = db.prepare("SELECT cluster_id,node_id,auto_share_projects,join_sequence FROM sharing_memberships WHERE cluster_id=? ORDER BY join_sequence").all(clusterId) as unknown as MembershipRow[];
  return rows.map(toMembership);
}

/** INTERNAL topology API. The actor must be authenticated by orchestration. */
export function addSharingMember(db: DatabaseSync, clusterId: string, managerNodeId: string, nodeId: string, expectedManagerEpoch: number): void {
  validateUuid(clusterId, "Cluster ID"); validateUuid(managerNodeId, "Manager node ID"); validateUuid(nodeId, "Node ID"); validatePositiveInteger(expectedManagerEpoch, "Expected manager epoch");
  inSavepoint(db, () => {
    const state = clusterRow(db, clusterId);
    if (state.closed) throw new Error("Cluster is closed");
    if (state.manager_node_id !== managerNodeId || state.manager_epoch !== expectedManagerEpoch) throw new Error("Cluster manager authority changed");
    if (membershipExists(db, clusterId, nodeId)) return;
    if (db.prepare("SELECT 1 FROM sharing_manager_transfers WHERE cluster_id=? AND expected_epoch=? AND status<>'committed'").get(clusterId, state.manager_epoch)) throw new Error("Cluster has a pending transfer");
    validatePositiveInteger(state.next_join_sequence, "Next join sequence");
    if (state.next_join_sequence === Number.MAX_SAFE_INTEGER) throw new Error("Join sequence exhausted");
    db.prepare("INSERT INTO sharing_memberships(cluster_id,node_id,join_sequence) VALUES (?,?,?)").run(clusterId, nodeId, state.next_join_sequence);
    db.prepare("UPDATE sharing_clusters SET next_join_sequence=next_join_sequence+1 WHERE id=?").run(clusterId);
  });
}

function clearInvalidSecretScopes(db: DatabaseSync, projectId?: string): void {
  const suffix = projectId === undefined ? "" : " AND s.project_id = ?";
  db.prepare(`DELETE FROM sharing_resource_shares AS s WHERE s.kind = 'secret' AND s.project_id <> ''${suffix}
    AND NOT EXISTS (SELECT 1 FROM sharing_resource_shares p JOIN sharing_resource_owners po ON po.kind='project' AND po.resource_id=p.resource_id JOIN sharing_memberships pm ON pm.cluster_id=p.cluster_id AND pm.node_id=po.owner_node_id WHERE p.kind='project' AND p.resource_id=s.project_id AND p.cluster_id=s.cluster_id)`).run(...(projectId === undefined ? [] : [projectId]));
}

export function removeSharingMember(db: DatabaseSync, clusterId: string, actorNodeId: string, nodeId: string): void {
  validateUuid(clusterId, "Cluster ID"); validateUuid(actorNodeId, "Actor node ID"); validateUuid(nodeId, "Node ID");
  inSavepoint(db, () => removeMember(db, clusterId, actorNodeId, nodeId));
}
function removeMember(db: DatabaseSync, clusterId: string, actorNodeId: string, nodeId: string): void {
  const state = clusterRow(db, clusterId); if (state.closed) throw new Error("Cluster is closed");
  const actor = membershipRow(db, clusterId, actorNodeId); const target = membershipRow(db, clusterId, nodeId);
  if (db.prepare("SELECT 1 FROM sharing_manager_transfers WHERE cluster_id=? AND expected_epoch=? AND status<>'committed'").get(clusterId, state.manager_epoch)) throw new Error("Cluster has a pending transfer");
  if (actorNodeId !== nodeId && actor.join_sequence >= target.join_sequence) throw new Error("Only an older member can remove a younger member");
  const count = (db.prepare("SELECT count(*) AS count FROM sharing_memberships WHERE cluster_id=?").get(clusterId) as unknown as CountRow).count;
  if (state.manager_node_id === nodeId && count > 1) throw new Error("Transfer cluster membership management before departure");
  if (count === 1) db.prepare("UPDATE sharing_clusters SET manager_node_id=NULL,closed=1 WHERE id=?").run(clusterId);
  db.prepare(`DELETE FROM sharing_resource_shares WHERE cluster_id=? AND EXISTS
    (SELECT 1 FROM sharing_resource_owners o WHERE o.kind=sharing_resource_shares.kind AND o.resource_id=sharing_resource_shares.resource_id AND o.owner_node_id=?)`).run(clusterId, nodeId);
  db.prepare("DELETE FROM sharing_memberships WHERE cluster_id=? AND node_id=?").run(clusterId, nodeId); clearInvalidSecretScopes(db);
}
/** Removes a member its twin proved lost (cluster-succession.ts), whatever its seniority.
    A lost manager is first replaced by the most senior remaining member. */
export function removeLostSharingMember(db: DatabaseSync, clusterId: string, nodeId: string, successorManager?: string): void {
  inSavepoint(db, () => {
    const state = clusterRow(db, clusterId); if (state.closed) throw new Error("Cluster is closed");
    membershipRow(db, clusterId, nodeId);
    if (state.manager_node_id === nodeId) {
      const remaining = listSharingClusterMembers(db, clusterId).filter((member) => member.nodeId !== nodeId);
      if (!successorManager || remaining[0]?.nodeId !== successorManager) throw new Error("Only the most senior remaining member replaces a lost manager");
      db.prepare("UPDATE sharing_clusters SET manager_node_id=?,manager_epoch=manager_epoch+1 WHERE id=?").run(successorManager, clusterId);
    }
    db.prepare(`DELETE FROM sharing_resource_shares WHERE cluster_id=? AND EXISTS
      (SELECT 1 FROM sharing_resource_owners o WHERE o.kind=sharing_resource_shares.kind AND o.resource_id=sharing_resource_shares.resource_id AND o.owner_node_id=?)`).run(clusterId, nodeId);
    db.prepare("DELETE FROM sharing_memberships WHERE cluster_id=? AND node_id=?").run(clusterId, nodeId); clearInvalidSecretScopes(db);
  });
}
function toMembership(row: MembershipRow): SharingMembership {
  return { clusterId: row.cluster_id, nodeId: row.node_id, autoShareProjects: row.auto_share_projects === 1, joinSequence: row.join_sequence };
}
/** Relay resource groups are not login/account/configuration sharing clusters. Opt in only for workspace grants. */
export function listSharingMemberships(db: DatabaseSync, nodeId: string, includeRelayGroups = false): SharingMembership[] {
  validateUuid(nodeId, "Node ID");
  const rows = db.prepare(`SELECT cluster_id,node_id,auto_share_projects,join_sequence FROM sharing_memberships m WHERE node_id=?
    ${includeRelayGroups ? "" : "AND NOT EXISTS (SELECT 1 FROM relay_sharing_groups r WHERE r.cluster_id=m.cluster_id)"} ORDER BY cluster_id`).all(nodeId) as unknown as MembershipRow[];
  return rows.map(toMembership);
}

function toTransfer(row: TransferRow): SharingManagerTransfer {
  return { clusterId: row.cluster_id, transferId: row.transfer_id, fromNodeId: row.from_node_id, toNodeId: row.to_node_id, expectedEpoch: row.expected_epoch, status: row.status };
}
function validateTransferIds(clusterId: string, actorNodeId: string, transferId: string): void {
  validateUuid(clusterId, "Cluster ID"); validateUuid(actorNodeId, "Actor node ID"); validateUuid(transferId, "Transfer ID");
}
export function prepareSharingManagerTransfer(db: DatabaseSync, clusterId: string, actorNodeId: string, successorNodeId: string, expectedEpoch: number, transferId: string): SharingManagerTransfer {
  validateTransferIds(clusterId, actorNodeId, transferId); validateUuid(successorNodeId, "Successor node ID"); validatePositiveInteger(expectedEpoch, "Expected manager epoch");
  return inSavepoint(db, () => {
    const existing = transferRow(db, clusterId, transferId);
    if (existing) {
      if (existing.from_node_id !== actorNodeId || existing.to_node_id !== successorNodeId || existing.expected_epoch !== expectedEpoch) throw new Error("Transfer ID reuse with different fields");
      return toTransfer(existing);
    }
    const state = clusterRow(db, clusterId);
    if (state.closed || state.manager_node_id !== actorNodeId || state.manager_epoch !== expectedEpoch) throw new Error("Cluster manager authority changed");
    if (actorNodeId === successorNodeId) throw new Error("Successor must be a distinct current member"); requireMembership(db, clusterId, successorNodeId);
    db.prepare("INSERT INTO sharing_manager_transfers(cluster_id,transfer_id,from_node_id,to_node_id,expected_epoch,status) VALUES (?,?,?,?,?,'prepared')").run(clusterId, transferId, actorNodeId, successorNodeId, expectedEpoch);
    return toTransfer(transferRow(db, clusterId, transferId)!);
  });
}
export function acceptSharingManagerTransfer(db: DatabaseSync, clusterId: string, actorNodeId: string, transferId: string): SharingManagerTransfer {
  validateTransferIds(clusterId, actorNodeId, transferId);
  return inSavepoint(db, () => {
    const row = transferRow(db, clusterId, transferId); if (!row) throw new Error("Unknown manager transfer");
    if (row.to_node_id !== actorNodeId) throw new Error("Only the named successor can accept the transfer");
    if (row.status !== "prepared") return toTransfer(row);
    const state = clusterRow(db, clusterId);
    if (state.closed || state.manager_node_id !== row.from_node_id || state.manager_epoch !== row.expected_epoch) throw new Error("Cluster manager authority changed");
    requireMembership(db, clusterId, row.to_node_id);
    db.prepare("UPDATE sharing_manager_transfers SET status='accepted' WHERE cluster_id=? AND transfer_id=?").run(clusterId, transferId);
    return toTransfer(transferRow(db, clusterId, transferId)!);
  });
}
export function commitSharingManagerTransfer(db: DatabaseSync, clusterId: string, actorNodeId: string, transferId: string): SharingManagerTransfer {
  validateTransferIds(clusterId, actorNodeId, transferId);
  return inSavepoint(db, () => commitTransfer(db, clusterId, actorNodeId, transferId));
}
function commitTransfer(db: DatabaseSync, clusterId: string, actorNodeId: string, transferId: string): SharingManagerTransfer {
  const row = transferRow(db, clusterId, transferId); if (!row) throw new Error("Unknown manager transfer");
  if (row.from_node_id !== actorNodeId) throw new Error("Only the current manager can commit the transfer");
  if (row.status === "committed") return toTransfer(row);
  if (row.status !== "accepted") throw new Error("Manager transfer must be accepted before commit");
  const result = db.prepare("UPDATE sharing_clusters SET manager_node_id=?,manager_epoch=? WHERE id=? AND manager_node_id=? AND manager_epoch=? AND closed=0").run(row.to_node_id, row.expected_epoch + 1, clusterId, row.from_node_id, row.expected_epoch);
  if (result.changes !== 1) throw new Error("Cluster manager authority changed");
  db.prepare("UPDATE sharing_manager_transfers SET status='committed' WHERE cluster_id=? AND transfer_id=?").run(clusterId, transferId);
  return toTransfer(transferRow(db, clusterId, transferId)!);
}

export function setAutoShareProjects(db: DatabaseSync, clusterId: string, nodeId: string, enabled: boolean): void {
  validateUuid(clusterId, "Cluster ID"); validateUuid(nodeId, "Node ID");
  const result = db.prepare("UPDATE sharing_memberships SET auto_share_projects=? WHERE cluster_id=? AND node_id=?").run(enabled ? 1 : 0, clusterId, nodeId);
  if (result.changes === 0) throw new Error(`Missing membership for node ${nodeId} in cluster ${clusterId}`);
}

export function registerOwnedResource(db: DatabaseSync, resource: OwnedResource, localNodeId: string): void {
  validateResource(resource.kind, resource.id); validateUuid(resource.ownerNodeId, "Owner node ID"); validateUuid(localNodeId, "Local node ID");
  if (resource.kind === "ticket") validateResourceId(resource.projectId);
  inSavepoint(db, () => {
    const projectId = resource.kind === "ticket" ? resource.projectId : null;
    if (resource.kind === "ticket" && ownerOrThrow(db, "project", resource.projectId) !== resource.ownerNodeId) throw new Error("Ticket owner must match its project owner");
    const existing = db.prepare("SELECT owner_node_id,project_id FROM sharing_resource_owners WHERE kind=? AND resource_id=?").get(resource.kind, resource.id) as OwnerRow | undefined;
    if (existing) {
      if (existing.owner_node_id !== resource.ownerNodeId) throw new Error("Resource original owner cannot be changed");
      if (existing.project_id !== projectId) throw new Error("Ticket parent project cannot be changed");
      return;
    }
    db.prepare("INSERT INTO sharing_resource_owners(kind,resource_id,owner_node_id,project_id) VALUES (?,?,?,?)").run(resource.kind, resource.id, resource.ownerNodeId, projectId);
    if (resource.kind === "project" && resource.ownerNodeId === localNodeId) db.prepare(`INSERT INTO sharing_resource_shares(kind,resource_id,cluster_id,project_id)
      SELECT 'project', ?, cluster_id, '' FROM sharing_memberships WHERE node_id=? AND auto_share_projects=1
      AND cluster_id NOT IN (SELECT cluster_id FROM sharing_explicit_project_selections)`).run(resource.id, resource.ownerNodeId);
  });
}

/** INTERNAL API. Enabling trust requires an explicitly accepted twin handshake, never a membership snapshot. */
export function setTrustedTwin(db: DatabaseSync, localNodeId: string, peerNodeId: string, trusted: boolean): void {
  validateUuid(localNodeId, "Local node ID"); validateUuid(peerNodeId, "Peer node ID");
  if (localNodeId === peerNodeId) throw new Error("A node cannot have a self twin relationship");
  const [left, right] = pair(localNodeId, peerNodeId);
  if (trusted) db.prepare("INSERT OR IGNORE INTO sharing_twins(left_node_id,right_node_id) VALUES (?,?)").run(left, right);
  else db.prepare("DELETE FROM sharing_twins WHERE left_node_id=? AND right_node_id=?").run(left, right);
  notifyRelayPeersChanged();
}

export function isTrustedTwin(db: DatabaseSync, leftNodeId: string, rightNodeId: string): boolean {
  validateUuid(leftNodeId, "Left node ID"); validateUuid(rightNodeId, "Right node ID");
  if (leftNodeId === rightNodeId) return false;
  const [left, right] = pair(leftNodeId, rightNodeId);
  return db.prepare("SELECT 1 FROM sharing_twins WHERE left_node_id=? AND right_node_id=?").get(left, right) !== undefined;
}

export function resourceOwner(db: DatabaseSync, kind: SharedResourceKind, resourceId: string): string {
  validateResource(kind, resourceId); const policy = policyResource(db, kind, resourceId); return ownerOrThrow(db, policy.kind, policy.id);
}
export function listResourceShares(db: DatabaseSync, kind: SharedResourceKind, resourceId: string): ResourceShare[] {
  validateResource(kind, resourceId); const policy = policyResource(db, kind, resourceId);
  const rows = db.prepare("SELECT cluster_id,project_id,node_ids FROM sharing_resource_shares WHERE kind=? AND resource_id=? ORDER BY cluster_id,project_id").all(policy.kind, policy.id) as unknown as ShareRow[];
  return rows.map((row) => ({ clusterId: row.cluster_id, projectId: row.project_id || null, ...(row.node_ids === null ? {} : { nodeIds: JSON.parse(row.node_ids) as string[] }) }));
}

function validateShareSelection(db: DatabaseSync, actor: string, owner: string, kind: SharedResourceKind, shares: ResourceShare[]): void {
  const selected = new Set<string>(); const modes = new Map<string, boolean>();
  for (const share of shares) {
    validateUuid(share.clusterId, "Cluster ID"); requireCluster(db, share.clusterId);
    if (share.projectId !== null) validateResourceId(share.projectId);
    if (kind !== "secret" && share.projectId !== null) throw new Error("Only secrets may have a project scope");
    const key = `${share.clusterId}\0${share.projectId ?? ""}`;
    if (selected.has(key)) throw new Error("Duplicate resource share selection"); selected.add(key);
    const scoped = share.projectId !== null;
    if (modes.has(share.clusterId) && modes.get(share.clusterId) !== scoped) throw new Error("Redundant ambiguous secret scopes for one cluster");
    modes.set(share.clusterId, scoped); requireMembership(db, share.clusterId, actor); requireMembership(db, share.clusterId, owner);
    if (share.nodeIds !== undefined) {
      if (kind !== "project" || !share.nodeIds.length || new Set(share.nodeIds).size !== share.nodeIds.length) throw new Error("Invalid node selection");
      for (const nodeId of share.nodeIds) { validateUuid(nodeId, "Node ID"); requireMembership(db, share.clusterId, nodeId); }
    }
    if (scoped && !activeProjectShare(db, actor, share.clusterId, share.projectId!)) throw new Error("Scoped secret project is not actively shared to actor in this cluster");
  }
}
function activeProjectShare(db: DatabaseSync, nodeId: string, clusterId: string, projectId: string): boolean {
  return db.prepare(`SELECT 1 FROM sharing_resource_shares p JOIN sharing_resource_owners o ON o.kind='project' AND o.resource_id=p.resource_id
    JOIN sharing_memberships om ON om.cluster_id=p.cluster_id AND om.node_id=o.owner_node_id JOIN sharing_memberships rm ON rm.cluster_id=p.cluster_id AND rm.node_id=?
    WHERE p.kind='project' AND p.resource_id=? AND p.cluster_id=? AND (p.node_ids IS NULL OR EXISTS (SELECT 1 FROM json_each(p.node_ids) WHERE value=rm.node_id))`).get(nodeId, projectId, clusterId) !== undefined;
}

export function setResourceShares(db: DatabaseSync, actorNodeId: string, kind: SharedResourceKind, resourceId: string, shares: ResourceShare[]): void {
  validateUuid(actorNodeId, "Actor node ID"); validateResource(kind, resourceId);
  if (kind === "ticket") throw new Error("Ticket sharing is inherited from its project");
  for (const share of shares) {
    validateUuid(share.clusterId, "Cluster ID");
    if (share.projectId !== null) validateResourceId(share.projectId);
    if (kind !== "secret" && share.projectId !== null) throw new Error("Only secrets may have a project scope");
  }
  inSavepoint(db, () => {
    const owner = ownerOrThrow(db, kind, resourceId);
    if (actorNodeId !== owner) throw new Error("Actor is not authorized to change this resource's shares");
    validateShareSelection(db, actorNodeId, owner, kind, shares);
    db.prepare("DELETE FROM sharing_resource_shares WHERE kind=? AND resource_id=?").run(kind, resourceId);
    const insert = db.prepare("INSERT INTO sharing_resource_shares(kind,resource_id,cluster_id,project_id,node_ids) VALUES (?,?,?,?,?)");
    for (const share of shares) insert.run(kind, resourceId, share.clusterId, share.projectId ?? "", share.nodeIds === undefined ? null : JSON.stringify([...share.nodeIds].sort()));
    if (kind === "project") clearInvalidSecretScopes(db, resourceId);
  });
}

export function shareAllOwnedProjects(db: DatabaseSync, clusterId: string, actorNodeId: string): number {
  validateUuid(clusterId, "Cluster ID"); validateUuid(actorNodeId, "Actor node ID");
  return inSavepoint(db, () => {
    requireMembership(db, clusterId, actorNodeId);
    return Number(db.prepare(`INSERT OR IGNORE INTO sharing_resource_shares(kind,resource_id,cluster_id,project_id)
      SELECT 'project',o.resource_id,?,'' FROM sharing_resource_owners o
      WHERE o.kind='project' AND o.owner_node_id=?`).run(clusterId, actorNodeId).changes);
  });
}

export function mayReceiveResource(db: DatabaseSync, recipientNodeId: string, kind: SharedResourceKind, resourceId: string, projectId?: string): boolean {
  validateUuid(recipientNodeId, "Recipient node ID"); validateResource(kind, resourceId); if (projectId !== undefined) validateResourceId(projectId);
  // An unknown resource throws and is not kept. A valid project id is never empty, so "" stands for none.
  return untilWriteOrLeaseEnd(db, "mayReceiveResource", [recipientNodeId, kind, resourceId, projectId ?? ""], () => {
    const policy = policyResource(db, kind, resourceId); const owner = ownerOrThrow(db, policy.kind, policy.id);
    if (recipientNodeId === owner) return true;
    // Twins are the admin's own machines: they get the admin's things, never a member's.
    if (isTrustedTwin(db, recipientNodeId, owner)) return twinMayReceive(db, owner, policy.kind, policy.id, projectId);
    const rows = db.prepare(`SELECT s.cluster_id,s.project_id,s.node_ids FROM sharing_resource_shares s JOIN sharing_memberships om ON om.cluster_id=s.cluster_id AND om.node_id=?
    JOIN sharing_memberships rm ON rm.cluster_id=s.cluster_id AND rm.node_id=? WHERE s.kind=? AND s.resource_id=?`).all(owner, recipientNodeId, policy.kind, policy.id) as unknown as ShareRow[];
    return rows.some((row) => relaySharingGroupActive(db, row.cluster_id) && (row.node_ids === null || (JSON.parse(row.node_ids) as string[]).includes(recipientNodeId))
      && (policy.kind !== "secret" || row.project_id === "" || (projectId === row.project_id && activeProjectShare(db, recipientNodeId, row.cluster_id, row.project_id))));
  });
}

export function resourceClusterIds(db: DatabaseSync, nodeId: string, kind: SharedResourceKind, resourceId: string): string[] {
  validateUuid(nodeId, "Node ID"); validateResource(kind, resourceId); const policy = policyResource(db, kind, resourceId); const owner = ownerOrThrow(db, policy.kind, policy.id);
  const rows = db.prepare(`SELECT DISTINCT s.cluster_id FROM sharing_resource_shares s JOIN sharing_memberships om ON om.cluster_id=s.cluster_id AND om.node_id=?
    JOIN sharing_memberships rm ON rm.cluster_id=s.cluster_id AND rm.node_id=? WHERE s.kind=? AND s.resource_id=? AND (rm.node_id=om.node_id OR s.node_ids IS NULL OR EXISTS (SELECT 1 FROM json_each(s.node_ids) WHERE value=rm.node_id)) AND
    (s.project_id='' OR EXISTS (SELECT 1 FROM sharing_resource_shares p JOIN sharing_resource_owners po ON po.kind='project' AND po.resource_id=p.resource_id
      JOIN sharing_memberships pom ON pom.cluster_id=p.cluster_id AND pom.node_id=po.owner_node_id WHERE p.kind='project' AND p.resource_id=s.project_id AND p.cluster_id=s.cluster_id)) ORDER BY s.cluster_id`).all(owner, nodeId, policy.kind, policy.id) as unknown as IdRow[];
  return rows.filter((row) => relaySharingGroupActive(db, row.cluster_id)).map((row) => row.cluster_id);
}

function twinMayReceive(db: DatabaseSync, owner: string, kind: SharedResourceKind, resourceId: string, projectId?: string): boolean {
  if (!tableFound(db, "cluster_node")) return true;
  const local = (db.prepare("SELECT id FROM cluster_node WHERE singleton = 1").get() as { id: string } | undefined)?.id;
  if (owner !== local || !tableFound(db, "resource_account_owners")) return true;
  if (kind === "project") return ownedByAdmin("project", resourceId, db);
  if (kind === "secret") {
    const row = db.prepare("SELECT project_id FROM secret_accounts WHERE id = ?").get(resourceId) as { project_id: string | null } | undefined;
    return row?.project_id ? ownedByAdmin("project", row.project_id, db) : ownedByAdmin("secret", resourceId, db);
  }
  return projectId === undefined || ownedByAdmin("project", projectId, db);
}
