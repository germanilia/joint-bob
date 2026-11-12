import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import "../src/sqlite-statements.js";
import { getOrCreateClusterIdentity, pinClusterPublicKey } from "../src/cluster-identity.js";
import { recordPeerEndpoint } from "../src/cluster-peer-endpoints.js";
import { projectMetadataVisible, recordProjectMetadataReceipt, type ProjectMetadataEnvelope } from "../src/cluster-project-metadata.js";
import { addSharingMember, createSharingCluster, setTrustedTwin } from "../src/cluster-sharing-policy.js";
import {
  applyResourcePolicy, deleteSharedResource, ensureResourceSharingSchema, getResourcePolicyState,
  listResourcePolicyDeliveries, registerLocalSharingResource, updateResourceSharing,
} from "../src/cluster-sharing.js";
import { setNodeBlock } from "../src/node-blocks.js";
import type { ReplicationEvent } from "../src/replication.js";
import { mayReplicateEvent, replicationPeers } from "../src/server/replication-v2.js";
import { mayShareProject, sharedProjectIds } from "../src/server/sharing-files.js";
import { openNodeDatabase } from "../src/node-database.js";

/* What one node may share with another is asked for every peer, project and event. The answers
   are kept until the next write. These tests hold them to that: an answer follows every change at
   once, whichever connection made it; nothing is asked of the database in between; and nothing
   a rolled back transaction showed is served afterwards. */

const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002", C = "00000000-0000-4000-8000-000000000003";
const X = "10000000-0000-4000-8000-000000000001";
const ACCOUNT = "a".repeat(32);

/** One node's database, opened twice, with the cluster X of A and B in it. */
function node(t: TestContext, local: string): { db: DatabaseSync; other: DatabaseSync } {
  const directory = mkdtempSync(path.join(os.tmpdir(), "jb-perf-access-sharing-"));
  const file = path.join(directory, "node.db");
  const open = (): DatabaseSync => { const db = new DatabaseSync(file); db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON"); return db; };
  const db = open();
  ensureResourceSharingSchema(db);
  getOrCreateClusterIdentity(db, local);
  createSharingCluster(db, { id: X, name: "X" }, A);
  addSharingMember(db, X, A, B, 1);
  const other = open();
  t.after(() => { db.close(); other.close(); rmSync(directory, { recursive: true, force: true }); });
  return { db, other };
}

/** The owner's database with project "p" registered; `shared` puts it into the cluster. */
function owner(t: TestContext, shared = true): { db: DatabaseSync; other: DatabaseSync } {
  const made = node(t, A);
  registerLocalSharingResource(made.db, A, { kind: "project", id: "p" });
  if (shared) share(made.db, true);
  return made;
}
function share(db: DatabaseSync, shared: boolean, id = "p"): void {
  updateResourceSharing(db, A, "project", id, getResourcePolicyState(db, "project", id).generation, shared ? [{ clusterId: X, projectId: null }] : []);
}

/** Counts the queries code runs: every query here is prepared where it runs. */
function queries(t: TestContext): { count: () => number; reset: () => void } {
  const prepare = DatabaseSync.prototype.prepare;
  let count = 0;
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) { count++; return prepare.call(this, sql); });
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) { count++; exec.call(this, sql); });
  return { count: () => count, reset: () => { count = 0; } };
}

test("mayShareProject and sharedProjectIds are answered once between writes and follow every change", (t) => {
  const { db, other } = owner(t, false);
  registerLocalSharingResource(db, A, { kind: "project", id: "q" });
  assert.equal(mayShareProject(db, A, B, "p"), false);
  assert.deepEqual(sharedProjectIds(db, A, B), []);
  const asked = queries(t);
  for (let i = 0; i < 30; i++) { assert.equal(mayShareProject(db, A, B, "p"), false); assert.deepEqual(sharedProjectIds(db, A, B), []); }
  assert.equal(asked.count(), 0, "kept answers run no query");

  share(db, true);
  assert.equal(mayShareProject(db, A, B, "p"), true, "shared through this connection");
  assert.deepEqual(sharedProjectIds(db, A, B), ["p"]);
  assert.equal(mayShareProject(db, A, C, "p"), false, "each peer has its own answer: this one is not in the cluster");
  assert.deepEqual(sharedProjectIds(db, A, C), []);
  assert.equal(mayShareProject(db, C, B, "p"), false, "and so has each node asking");
  assert.deepEqual(sharedProjectIds(db, C, B), []);
  assert.equal(mayShareProject(db, A, B, "p"), true);
  share(other, true, "q");
  assert.deepEqual(sharedProjectIds(db, A, B).sort(), ["p", "q"], "another project shared through another connection");
  share(other, false);
  assert.equal(mayShareProject(db, A, B, "p"), false, "unshared through another connection");
  assert.deepEqual(sharedProjectIds(db, A, B), ["q"]);
  deleteSharedResource(other, A, "project", "q", getResourcePolicyState(other, "project", "q").generation);
  assert.deepEqual(sharedProjectIds(db, A, B), [], "a deleted project is shared with nobody");
  assert.equal(mayShareProject(db, A, B, "q"), false);
  assert.equal(mayShareProject(db, A, B, "never-heard-of"), false);

  // The list belongs to its caller.
  share(db, true);
  const mine = sharedProjectIds(db, A, B);
  mine.push("added by the caller");
  assert.deepEqual(sharedProjectIds(db, A, B), ["p"]);
});

test("mayShareProject fails as before for a node id that is no id, and keeps no failure", (t) => {
  const { db } = owner(t);
  assert.throws(() => mayShareProject(db, A, "not-a-node", "p"), /Recipient node ID must be a valid UUID/);
  assert.throws(() => mayShareProject(db, A, "not-a-node", "p"), /Recipient node ID must be a valid UUID/);
  assert.equal(mayShareProject(db, A, "not-a-node", "unknown"), false, "an unknown project is refused before the node is looked at");
  assert.throws(() => sharedProjectIds(db, A, "not-a-node"), /Recipient node ID must be a valid UUID/);
  db.prepare("DELETE FROM sharing_resource_shares").run();
  db.prepare("DELETE FROM sharing_resource_owners").run();
  assert.throws(() => mayShareProject(db, A, B, "p"), /Unknown project resource: p/, "a policy without an owner is a failure, not a no");
});

test("a share that a transaction made and rolled back is not served afterwards", (t) => {
  const { db } = owner(t, false);
  assert.equal(mayShareProject(db, A, B, "p"), false);
  assert.deepEqual(sharedProjectIds(db, A, B), []);
  db.exec("BEGIN");
  share(db, true);
  assert.equal(mayShareProject(db, A, B, "p"), true, "a transaction reads its own writes");
  assert.deepEqual(sharedProjectIds(db, A, B), ["p"]);
  assert.equal(mayReplicateEvent(db, A, B, task("p")), true);
  db.exec("ROLLBACK");
  assert.equal(mayShareProject(db, A, B, "p"), false);
  assert.deepEqual(sharedProjectIds(db, A, B), []);
  assert.equal(mayReplicateEvent(db, A, B, task("p")), false);
});

/** The receiver's database holding the owner's project "p" as the owner shared it, with its metadata received. */
function receiver(t: TestContext): { db: DatabaseSync; other: DatabaseSync } {
  const from = owner(t), to = node(t, B);
  pinClusterPublicKey(to.db, A, getOrCreateClusterIdentity(from.db, A).publicKey);
  const statement = listResourcePolicyDeliveries(from.db).find((delivery) => delivery.peerId === B && delivery.statement.body.operation === "upsert")!.statement;
  applyResourcePolicy(to.db, B, A, statement);
  const envelope: ProjectMetadataEnvelope = { statement, revision: 1, metadata: { name: "Project", color: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" } };
  recordProjectMetadataReceipt(to.db, envelope);
  return to;
}

test("projectMetadataVisible is answered once between writes and follows every change", (t) => {
  const { db, other } = receiver(t);
  assert.equal(projectMetadataVisible(db, B, "p"), true, "received, with a current context");
  assert.equal(projectMetadataVisible(db, B, "no-owner"), true, "a project nobody registered for sharing is this node's own");
  const asked = queries(t);
  for (let i = 0; i < 30; i++) assert.equal(projectMetadataVisible(db, B, "p"), true);
  assert.equal(asked.count(), 0, "a kept answer runs no query and no schema script");

  other.prepare("UPDATE cluster_v2_resource_contexts SET active=0").run();
  assert.equal(projectMetadataVisible(db, B, "p"), false, "the context ended, through another connection");
  assert.equal(projectMetadataVisible(db, A, "p"), true, "each node asking has its own answer: the owner needs no context");
  assert.equal(projectMetadataVisible(db, B, "p"), false);
  db.prepare("UPDATE cluster_v2_resource_contexts SET active=1").run();
  assert.equal(projectMetadataVisible(db, B, "p"), true, "and came back, through this one");
  other.prepare("DELETE FROM cluster_v2_project_metadata_receipts").run();
  assert.equal(projectMetadataVisible(db, B, "p"), false, "no receipt, no project");
});

test("projectMetadataVisible for an owned project follows its policy, and a rollback leaves nothing behind", (t) => {
  const { db, other } = owner(t);
  assert.equal(projectMetadataVisible(db, A, "p"), true);
  db.exec("BEGIN");
  db.prepare("UPDATE cluster_v2_resource_policy SET deleted=1 WHERE resource_id='p'").run();
  assert.equal(projectMetadataVisible(db, A, "p"), false, "a transaction reads its own writes");
  db.exec("ROLLBACK");
  assert.equal(projectMetadataVisible(db, A, "p"), true, "the rolled back deletion is not served");
  deleteSharedResource(other, A, "project", "p", getResourcePolicyState(other, "project", "p").generation);
  assert.equal(projectMetadataVisible(db, A, "p"), false, "deleted for good, through another connection");
});

test("replicationPeers is answered once between writes, follows every change, and hands out rows of the caller's own", (t) => {
  const { db, other } = owner(t);
  assert.deepEqual(replicationPeers(db, A), [], "no endpoint known yet");
  recordPeerEndpoint(other, { kind: "cluster", id: X }, { nodeId: B, name: "Bee", url: "https://b.example" });
  const first = replicationPeers(db, A);
  assert.deepEqual(first.map((peer) => ({ ...peer })), [{ nodeId: B, name: "Bee", url: "https://b.example" }]);
  // The first call that met a peer made the block tables, which is a write: the answer is kept from the next call on.
  assert.equal(replicationPeers(db, A).length, 1);
  const asked = queries(t);
  for (let i = 0; i < 30; i++) assert.equal(replicationPeers(db, A).length, 1);
  assert.equal(asked.count(), 0, "a kept answer runs no query and no schema script");
  assert.deepEqual(replicationPeers(db, B), [], "each node asking has its own answer");
  assert.equal(replicationPeers(db, A).length, 1);

  first[0].name = "changed by the caller";
  first.length = 0;
  const second = replicationPeers(db, A);
  assert.equal(second[0].name, "Bee");
  assert.notEqual(second[0], replicationPeers(db, A)[0], "every call gets rows of its own");
  assert.equal(Object.getPrototypeOf(second[0]), Object.getPrototypeOf(other.prepare("SELECT 1 one").get()), "shaped as a row from the database is");

  setNodeBlock(other, B, "Bee", true, []);
  assert.deepEqual(replicationPeers(db, A), [], "blocked through another connection");
  setNodeBlock(db, B, "Bee", false, []);
  assert.equal(replicationPeers(db, A).length, 1, "and unblocked through this one");
  addSharingMember(other, X, A, C, 1);
  recordPeerEndpoint(other, { kind: "cluster", id: X }, { nodeId: C, name: "Sea", url: "https://c.example" });
  assert.deepEqual(replicationPeers(db, A).map((peer) => peer.nodeId).sort(), [B, C]);

  db.exec("BEGIN");
  setNodeBlock(db, C, "Sea", true, []);
  assert.deepEqual(replicationPeers(db, A).map((peer) => peer.nodeId), [B]);
  db.exec("ROLLBACK");
  assert.deepEqual(replicationPeers(db, A).map((peer) => peer.nodeId).sort(), [B, C], "the rolled back block is not served");
});

function task(projectId: string, originNodeId = A): ReplicationEvent {
  return { id: "e", originNodeId, entityType: "project.lock", entityKey: "k", operation: "upsert", payload: { projectId }, createdAt: "2026-01-01T00:00:00.000Z" };
}

test("mayReplicateEvent asks nothing for a second event of the same project and follows sharing and blocks", (t) => {
  const { db, other } = owner(t);
  assert.equal(mayReplicateEvent(db, A, B, task("p")), true, "the first check makes the block tables, which is a write");
  assert.equal(mayReplicateEvent(db, A, B, task("p")), true);
  const asked = queries(t);
  for (let i = 0; i < 30; i++) assert.equal(mayReplicateEvent(db, A, B, task("p")), true);
  assert.equal(asked.count(), 0, "kept answers run no query");
  assert.equal(mayReplicateEvent(db, A, C, task("p")), false, "each peer has its own answer: this one is not in the cluster");
  assert.equal(mayReplicateEvent(db, C, B, task("p")), false, "and so has each node asking");
  assert.equal(mayReplicateEvent(db, A, B, task("p")), true);

  setNodeBlock(other, B, "Bee", true, []);
  assert.equal(mayReplicateEvent(db, A, B, task("p")), false, "blocked through another connection");
  setNodeBlock(db, B, "Bee", false, []);
  assert.equal(mayReplicateEvent(db, A, B, task("p")), true);
  // A block between the event's origin and the peer stops it too.
  other.prepare("INSERT INTO node_block_notices VALUES(?, ?, 1, 'now')").run(C, B);
  assert.equal(mayReplicateEvent(db, A, B, task("p", C)), false);
  assert.equal(mayReplicateEvent(db, A, B, task("p")), true);
  db.exec("BEGIN");
  setNodeBlock(db, B, "Bee", true, []);
  assert.equal(mayReplicateEvent(db, A, B, task("p")), false, "a transaction reads its own block");
  db.exec("ROLLBACK");
  assert.equal(mayReplicateEvent(db, A, B, task("p")), true, "the rolled back block is not served");
  share(other, false);
  assert.equal(mayReplicateEvent(db, A, B, task("p")), false, "unshared through another connection");
  assert.equal(mayReplicateEvent(db, A, B, task("unknown")), false);
});

test("mayReplicateEvent finds the tables that later features bring, and never sends a newer event type too early", (t) => {
  const { db, other } = owner(t);
  const author = { ...task("p"), entityType: "conversation.author" };
  assert.equal(mayReplicateEvent(db, A, B, author), false, "no account snapshot was ever delivered: the peer may be on an older release");
  other.exec("CREATE TABLE account_replication_deliveries(peer_id TEXT PRIMARY KEY)");
  assert.equal(mayReplicateEvent(db, A, B, author), false, "the table alone says nothing about this peer");
  other.prepare("INSERT INTO account_replication_deliveries VALUES(?)").run(B);
  assert.equal(mayReplicateEvent(db, A, B, author), true);
  other.prepare("DELETE FROM account_replication_deliveries").run();
  assert.equal(mayReplicateEvent(db, A, B, author), false);

  // An account's own events go to the node that account is at home on, once this node knows the account.
  const pin: ReplicationEvent = { ...task("p"), entityType: "user.pin", payload: { username: ACCOUNT, projectId: "p" } };
  assert.equal(mayReplicateEvent(db, A, B, pin), false, "no users table yet");
  other.exec("CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT NOT NULL, home_node_id TEXT, account_id TEXT, role TEXT)");
  assert.equal(mayReplicateEvent(db, A, B, pin), false);
  other.prepare("INSERT INTO users VALUES('u1', 'visitor', ?, ?, NULL)").run(B, ACCOUNT);
  assert.equal(mayReplicateEvent(db, A, B, pin), true, "a visitor here whose home is the peer");
  other.exec("CREATE TABLE account_roaming_nodes(account_id TEXT NOT NULL, node_id TEXT NOT NULL)");
  other.prepare("UPDATE users SET home_node_id=? WHERE id='u1'").run(C);
  assert.equal(mayReplicateEvent(db, A, B, pin), false, "at home elsewhere, and not signed in on the peer");
  other.prepare("INSERT INTO account_roaming_nodes VALUES(?, ?)").run(ACCOUNT, B);
  assert.equal(mayReplicateEvent(db, A, B, pin), true, "signed in on the peer, about a project the peer has");

  // A twin holds the admin's data only: never an account this node knows as somebody else's.
  setTrustedTwin(other, A, B, true);
  assert.equal(mayReplicateEvent(db, A, B, pin), false, "a visitor's pin does not go to the admin's twin");
  const unknownAccount: ReplicationEvent = { ...pin, payload: { username: "b".repeat(32), projectId: "p" } };
  assert.equal(mayReplicateEvent(db, A, B, unknownAccount), true, "each account has its own answer: nobody here answers to this one, so it is the admin's");
  assert.equal(mayReplicateEvent(db, A, B, pin), false);
  other.prepare("DELETE FROM users").run();
  assert.equal(mayReplicateEvent(db, A, B, pin), true, "an account nobody here answers to is the admin's");
  db.prepare("INSERT INTO users VALUES('u2', 'member', NULL, ?, 'member')").run(ACCOUNT);
  assert.equal(mayReplicateEvent(db, A, B, pin), false, "a member of this node, added through this connection");
  db.prepare("DELETE FROM users").run();
  assert.equal(mayReplicateEvent(db, A, B, pin), true);
  db.exec("BEGIN");
  db.prepare("INSERT INTO users VALUES('u3', 'member', NULL, ?, 'member')").run(ACCOUNT);
  assert.equal(mayReplicateEvent(db, A, B, pin), false, "a transaction reads its own member");
  db.exec("ROLLBACK");
  assert.equal(mayReplicateEvent(db, A, B, pin), true, "the rolled back member is not served");
  const asked = queries(t);
  for (let i = 0; i < 30; i++) assert.equal(mayReplicateEvent(db, A, B, pin), true);
  assert.ok(asked.count() <= 30, `one twin lookup per event at most, got ${asked.count()} queries for 30 events`);
});

test("the sharing schema is made sure of once per connection, and again after a rollback took it away", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "jb-perf-access-schema-"));
  const db = openNodeDatabase(path.join(directory, "node.db"));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const has = (table: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  db.exec("BEGIN");
  ensureResourceSharingSchema(db);
  assert.equal(has("cluster_v2_resource_policy"), true);
  db.exec("ROLLBACK");
  assert.equal(has("cluster_v2_resource_policy"), false, "the rollback took the tables away");
  ensureResourceSharingSchema(db);
  for (const table of ["cluster_v2_resource_policy", "cluster_v2_resource_contexts", "cluster_v2_resource_deliveries", "cluster_v2_resource_deletions", "cluster_v2_twin_relationships", "cluster_v2_identity", "sharing_resource_shares"]) {
    assert.equal(has(table), true, `${table} is made again: a call inside a transaction is not remembered`);
  }
  const asked = queries(t);
  for (let i = 0; i < 20; i++) ensureResourceSharingSchema(db);
  assert.equal(asked.count(), 0, "once made sure of, the connection is not asked again");
});
