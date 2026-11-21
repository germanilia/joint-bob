import assert from "node:assert/strict";
import { randomUUID, scryptSync } from "node:crypto";
import test from "node:test";
import { adoptTwinAdministrator, authenticate, createAdministrator, listLocalUsers, listReplicatedUsers } from "../src/auth.js";
import { ensurePeerEndpointSchema } from "../src/cluster-peer-endpoints.js";
import { ensureClusterSharingPolicySchema, setTrustedTwin } from "../src/cluster-sharing-policy.js";
import { ensureTwinSchema } from "../src/cluster-twins.js";
import type { ReplicationEvent } from "../src/replication.js";
import { acceptableReplicationEvents } from "../src/server/replication-v2.js";
import { settingsDatabase } from "../src/settings-store.js";
import { applyAccountSnapshot } from "../src/user-replication.js";

const LOCAL = randomUUID(), TWIN = randomUUID(), VISITOR_ACCOUNT = "ab".repeat(16);
const salt = Buffer.from("cd".repeat(16), "hex"), twinPassword = "the-twin-password-123";
const twinHash = scryptSync(twinPassword, salt, 64);

const event = (id: string, username?: string): ReplicationEvent => ({
  id, originNodeId: TWIN, entityType: "provider.profile", entityKey: id, operation: "upsert", payload: username ? { username } : {}, createdAt: new Date().toISOString(),
});

test("a machine that became a twin takes the twin's administrator, and keeps its sign-in", async () => {
  const db = await settingsDatabase();
  createAdministrator("iliagerman", "a-long-enough-password-1", false, "owner@example.test");
  ensureClusterSharingPolicySchema(db);
  setTrustedTwin(db, LOCAL, TWIN, true);
  // The twin's administrator first arrives as a visitor, which is what made it a stranger here.
  applyAccountSnapshot(db, LOCAL, TWIN, { version: 2, accounts: [{
    accountId: VISITOR_ACCOUNT, username: "ilia", email: "owner@example.test", passwordHash: twinHash.toString("hex"), passwordSalt: salt.toString("hex"),
    mfaRequired: false, updatedAt: new Date().toISOString(), clusterIds: [],
  }] });
  assert.equal(listReplicatedUsers().some((user) => user.username === "ilia"), true);
  const session = authenticate("iliagerman", "a-long-enough-password-1");
  assert.ok("id" in session, "signed in before the change");

  const change = adoptTwinAdministrator({ username: "ilia", email: "owner@example.test", passwordHash: twinHash, passwordSalt: salt, twinNodeIds: [TWIN] });
  assert.deepEqual(change, { from: "iliagerman", to: "ilia" });
  assert.deepEqual(listLocalUsers().map((user) => [user.username, user.role]), [["ilia", "admin"]]);
  assert.equal(listReplicatedUsers().some((user) => user.username === "ilia"), false, "the visitor copy gave way");
  assert.ok("id" in authenticate("ilia", twinPassword), "the twin's password signs in here");
  assert.equal(db.prepare("SELECT 1 FROM login_sessions WHERE id = ?").get((session as { id: string }).id) !== undefined, true, "the open sign-in stays");
  assert.equal(adoptTwinAdministrator({ username: "ilia", email: null, passwordHash: twinHash, passwordSalt: salt, twinNodeIds: [TWIN] }), undefined, "nothing to do when the names match");
});

test("a batch with an event this node may not take still delivers the rest", async () => {
  const db = await settingsDatabase();
  ensureTwinSchema(db);
  ensurePeerEndpointSchema(db);
  const relationshipId = randomUUID();
  db.prepare("INSERT INTO cluster_v2_twin_relationships (relationship_id, local_node_id, peer_node_id, body, acceptor_signature, status) VALUES (?,?,?,?,?,'active')").run(relationshipId, LOCAL, TWIN, "{}", "s");
  db.prepare("INSERT INTO cluster_v2_peer_endpoints VALUES ('twin', ?, ?, 'Twin', 'https://twin.example.test')").run(relationshipId, TWIN);
  // Someone else's account: a visitor from a third machine.
  db.prepare("INSERT INTO users (id, username, password_hash, password_salt, must_change_password, home_node_id, account_id, created_at, updated_at) VALUES ('v1','guest',x'00',x'00',0,?,?,'','')").run(randomUUID(), VISITOR_ACCOUNT);

  const mine = event("mine"), theirs = event("theirs", VISITOR_ACCOUNT);
  assert.deepEqual(acceptableReplicationEvents(db, LOCAL, TWIN, [theirs, mine])?.map((item) => item.id), ["mine"]);
  assert.equal(acceptableReplicationEvents(db, LOCAL, TWIN, [theirs]), undefined, "nothing in scope is still refused");
  assert.equal(acceptableReplicationEvents(db, LOCAL, TWIN, [mine, { ...mine, id: "forged", originNodeId: randomUUID() }]), undefined, "another node's events are never taken");
  assert.equal(acceptableReplicationEvents(db, LOCAL, randomUUID(), [mine]), undefined, "a node that is not a peer is refused");
});
