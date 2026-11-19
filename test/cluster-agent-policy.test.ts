import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { agentPolicyBodySchema, applyClusterAgentPolicyEvent, applyClusterAgentPolicySourceEvent, projectAgentPolicies, setClusterAgentPolicy } from "../src/cluster-agent-policy.js";
import { addSharingMember, createSharingCluster, ensureClusterSharingPolicySchema, registerOwnedResource, setResourceShares } from "../src/cluster-sharing-policy.js";
import { getOrCreateClusterIdentity, pinClusterPublicKey } from "../src/cluster-identity.js";
import { publishRelayPolicy } from "../src/relay/resource-policy.js";

function setup() {
  const db = new DatabaseSync(":memory:");
  const manager = randomUUID(), source = randomUUID(), clusterId = randomUUID();
  getOrCreateClusterIdentity(db, manager);
  ensureClusterSharingPolicySchema(db);
  db.exec("CREATE TABLE cluster_node(singleton INTEGER PRIMARY KEY,id TEXT); ");
  db.prepare("INSERT INTO cluster_node VALUES(1,?)").run(manager);
  createSharingCluster(db, { id: clusterId, name: "Policy" }, manager);
  addSharingMember(db, clusterId, manager, source, 1);
  registerOwnedResource(db, { kind: "project", id: "shared", ownerNodeId: manager }, manager);
  setResourceShares(db, manager, "project", "shared", [{ clusterId, projectId: null }]);
  return { db, manager, source, clusterId };
}

test('a second member inherits the shared project default and the manager opt-out without a node switch', () => {
  const { db, manager, source: twin, clusterId } = setup();
  try {
    db.prepare('UPDATE cluster_node SET id=?').run(twin);
    assert.equal(projectAgentPolicies(db, 'shared', true)[0].policy.guardian?.rules[0].id, 'production-or-destructive');
    assert.deepEqual(projectAgentPolicies(db, 'private', true), []);
    setClusterAgentPolicy(db, manager, clusterId, { sourceRelayNodeId: null, policy: agentPolicyBodySchema.parse({ guardian: null }) }, 1);
    assert.equal(projectAgentPolicies(db, 'shared', true)[0].policy.guardian, null);
  } finally { db.close(); }
});

test("cluster policy is project scoped, manager authorized and epoch checked", () => {
  const { db, manager, source, clusterId } = setup();
  try {
    const input = { sourceRelayNodeId: null, policy: agentPolicyBodySchema.parse({ rules: [{ name: "blocked", action: "block", harness: "all" }] }) };
    assert.throws(() => setClusterAgentPolicy(db, source, clusterId, input, 1), /manager|authority/i);
    assert.throws(() => setClusterAgentPolicy(db, manager, clusterId, input, 2), /manager|authority/i);
    setClusterAgentPolicy(db, manager, clusterId, input, 1);
    assert.equal(projectAgentPolicies(db, "shared")[0].policy.rules[0].name, "blocked");
    assert.deepEqual(projectAgentPolicies(db, "private"), []);
    assert.deepEqual(projectAgentPolicies(db, undefined), []);
    const row = db.prepare("SELECT * FROM replication_outbox WHERE entity_type='cluster.agentPolicy'").get() as { payload: string; event_id: string; created_at: string };
    const event = { id: row.event_id, originNodeId: source, entityType: "cluster.agentPolicy", entityKey: clusterId, operation: "upsert", payload: JSON.parse(row.payload), createdAt: row.created_at };
    assert.equal(applyClusterAgentPolicyEvent(db, event), false);
    assert.equal(applyClusterAgentPolicyEvent(db, { ...event, originNodeId: manager }), true);
  } finally { db.close(); }
});

test("source policy must be signed, stays cached offline and cannot be weakened by local rules", () => {
  const { db, manager, source, clusterId } = setup();
  const publisher = new DatabaseSync(":memory:");
  try {
    const identity = getOrCreateClusterIdentity(publisher, source);
    pinClusterPublicKey(db, source, identity.publicKey);
    const statement = publishRelayPolicy(publisher, source, [{ name: "blocked", action: "block", harness: "all" }]);
    const input = { sourceRelayNodeId: source, policy: agentPolicyBodySchema.parse({ rules: [{ name: "blocked", action: "enable", harness: "all" }] }) };
    assert.throws(() => setClusterAgentPolicy(db, manager, clusterId, input, 1), /source|policy/i);
    // A configured source is accepted only with the source's signed publication.
    const policy = setClusterAgentPolicy(db, manager, clusterId, { ...input, sourceStatement: statement }, 1);
    assert.equal(policy.sourceRelayNodeId, source);
    const layers = projectAgentPolicies(db, "shared");
    assert.equal(layers.length, 2);
    assert.ok(layers.some(layer => layer.policy.rules[0]?.action === "block"));
    assert.throws(() => setClusterAgentPolicy(db, manager, clusterId, { ...input, sourceStatement: { ...statement, signature: "invalid" } }, 1), /signature/i);
    assert.equal(projectAgentPolicies(db, "shared").length, 2);
    const secondCluster = randomUUID();
    createSharingCluster(db, { id: secondCluster, name: "Second policy" }, manager);
    addSharingMember(db, secondCluster, manager, source, 1);
    setResourceShares(db, manager, "project", "shared", [{ clusterId, projectId: null }, { clusterId: secondCluster, projectId: null }]);
    setClusterAgentPolicy(db, manager, secondCluster, { ...input, sourceStatement: statement }, 1);
    const updated = publishRelayPolicy(publisher, source, [{ name: "new-block", action: "block", harness: "all" }]);
    const update = { id: randomUUID(), entityType: "cluster.agentPolicySource", entityKey: clusterId, originNodeId: source, operation: "upsert", createdAt: new Date().toISOString(), payload: { clusterId, statement: updated } };
    assert.equal(applyClusterAgentPolicySourceEvent(db, { ...update, originNodeId: manager }), false);
    assert.equal(applyClusterAgentPolicySourceEvent(db, { ...update, payload: { clusterId, statement: { ...updated, signature: "invalid" } } }), false);
    assert.equal(applyClusterAgentPolicySourceEvent(db, update), true);
    assert.equal(projectAgentPolicies(db, "shared").filter(layer => layer.sourceNodeId === source && layer.policy.rules[0].name === "new-block").length, 2, "one signed publication supplies two clusters");
    assert.equal(applyClusterAgentPolicySourceEvent(db, { ...update, payload: { clusterId, statement } }), false, "stale source cannot replace a newer verified publication");
    setResourceShares(db, manager, "project", "shared", [{ clusterId, projectId: null }]);
    setClusterAgentPolicy(db, manager, clusterId, { policy: agentPolicyBodySchema.parse({}), sourceRelayNodeId: null }, 1);
    assert.equal(projectAgentPolicies(db, "shared").length, 1);
  } finally { db.close(); publisher.close(); }
});
