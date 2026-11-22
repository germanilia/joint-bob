import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getClusterNode } from "../src/cluster.js";
import { ensureMembershipSchema } from "../src/cluster-membership.js";
import { agentPolicyBodySchema, setClusterAgentPolicy } from "../src/cluster-agent-policy.js";
import { addSharingMember, createSharingCluster, recordRelaySharingHeartbeat, registerOwnedResource, setResourceShares } from "../src/cluster-sharing-policy.js";
import { getOrCreateClusterIdentity, pinClusterPublicKey } from "../src/cluster-identity.js";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { checkGuardian, guardianStartProblem } from "../src/guardian/check.js";
import { PRODUCTION_RULE } from "../src/guardian/production-rule.js";
import { answerRelayGuardian, RelayGuardianRefused } from "../src/guardian/relay-model.js";
import { DEFAULT_GUARDIAN_SETTINGS, guardianRelayPolicySchema } from "../src/guardian/rules.js";
import { guardianGroups, productionGuard, productionGuardCoverage, updateGuardianSettings } from "../src/guardian/settings.js";
import { publishRelayPolicy, receiveRelayPolicy } from "../src/relay/resource-policy.js";
import { createMembership, ensureRelaySchema, updateMembership } from "../src/relay/store.js";
import { addProject } from "../src/store.js";

const jevPolicy = guardianRelayPolicySchema.parse({ model: "jev", layaUrl: "", rules: [PRODUCTION_RULE] });

test("a relay's Jev rules reach a cluster's projects, are asked through the relay, and count as protection", async (t) => {
  const relay = new DatabaseSync(":memory:");
  const relayId = randomUUID();
  const identity = getOrCreateClusterIdentity(relay, relayId);
  const local = await clusterV2Database();
  const member = createMembership(local, "https://guardian-key.example", identity.fingerprint);
  updateMembership(local, member.id, { status: "admitted", relayNodeId: relayId, fingerprint: identity.fingerprint });
  const admitted = { ...member, status: "admitted" as const, relayNodeId: relayId, fingerprint: identity.fingerprint };
  t.after(() => { local.prepare("DELETE FROM relay_skill_subscriptions WHERE membership_id=?").run(member.id); local.prepare("DELETE FROM relay_memberships WHERE id=?").run(member.id); relay.close(); });

  ensureMembershipSchema(local);
  updateGuardianSettings({ ...DEFAULT_GUARDIAN_SETTINGS, enabled: false });
  const legacy = { ...PRODUCTION_RULE, name: 'Production or destructive steps', question: 'Could this command change a production system or cannot be undone: deploy or restart a live service, change cloud or production infrastructure, push or merge to the main branch, force a push, delete data, files, branches, conversations or automations, or spend real money?', check: 'commands', ifYes: 'ask', care: 'cautious' } as const;
  const custom = { ...legacy, care: 'balanced' } as const;
  const statement = publishRelayPolicy(relay, relayId, [], undefined, undefined, { ...jevPolicy, rules: [legacy] });
  receiveRelayPolicy(local, admitted, identity.publicKey, statement);
  const project = await addProject("Guardian key", mkdtempSync(path.join(os.tmpdir(), "guardian-key-")), { writeInstructions: false });
  const manager = (await getClusterNode()).id, clusterId = randomUUID();
  createSharingCluster(local, { id: clusterId, name: "Key cluster" }, manager);
  addSharingMember(local, clusterId, manager, relayId, 1);
  pinClusterPublicKey(local, relayId, identity.publicKey);
  registerOwnedResource(local, { kind: "project", id: project.id, ownerNodeId: manager }, manager);
  setResourceShares(local, manager, "project", project.id, [{ clusterId, projectId: null }]);
  assert.equal(await productionGuard(project.id), "on", "shared projects inherit production checks before a manager customizes policy");
  setClusterAgentPolicy(local, manager, clusterId, { policy: agentPolicyBodySchema.parse({}), sourceRelayNodeId: relayId, sourceStatement: statement }, 1);

  assert.equal(await productionGuard(project.id), "on", "no warning below a relay that imposes the production rule");
  assert.equal(await productionGuard(), "on", "every cluster policy of this machine imposes it");
  const covered = await productionGuardCoverage([{ id: project.id, name: project.name }]);
  assert.deepEqual([covered.status, covered.uncovered], ["on", []], "a relay's rule covers its cluster's project");
  const [group] = await guardianGroups(project.id);
  assert.equal(group.relayNodeId, relayId);
  assert.deepEqual(group.rules, [PRODUCTION_RULE], 'migrate the signed legacy default only at runtime');
  assert.deepEqual(statement.body.guardian?.rules, [legacy], 'do not rewrite the signed policy');
  assert.equal(await guardianStartProblem('claude', project.id), null, 'the shared severe rule checks tools, not outgoing content');
  const verdict = await checkGuardian({ projectId: project.id, conversationId: "c", harness: "pi", cwd: process.cwd(), canReplaceTool: true },
    { kind: "tool", tool: "bash", category: "commands", input: { command: "make release" } });
  assert.equal(verdict.action, "block", "the relay cannot be reached here, so the check fails closed");
  assert.match((verdict as { reason: string }).reason, /Jev did not answer/, "the check went to the relay, which cannot be reached here");
  assert.doesNotMatch((verdict as { reason: string }).reason, /System AI|TypeSafe key/, "the member never looks for a key of its own");

  // A second cluster that imposes nothing leaves the machine as a whole uncovered.
  const bare = randomUUID();
  createSharingCluster(local, { id: bare, name: "Bare" }, manager);
  setClusterAgentPolicy(local, manager, bare, { policy: agentPolicyBodySchema.parse({ guardian: null }), sourceRelayNodeId: null }, 1);
  assert.equal(await productionGuard(), "guardian-off");
  assert.equal(await productionGuard(project.id), "on", "the project's own cluster still imposes it");

  // fix: a project that no relay or cluster covers is named, instead of the whole machine being called unprotected.
  const loose = await addProject("Unshared notes", mkdtempSync(path.join(os.tmpdir(), "guardian-loose-")), { writeInstructions: false });
  const coverage = await productionGuardCoverage([{ id: project.id, name: project.name }, { id: loose.id, name: loose.name }]);
  assert.deepEqual([coverage.status, coverage.uncovered, coverage.coveredBy.length], ["guardian-off", ["Unshared notes"], 1]);
  assert.match(coverage.coveredBy[0], /Key cluster/);
  setClusterAgentPolicy(local, manager, clusterId, { policy: agentPolicyBodySchema.parse({ guardian: { ...jevPolicy, rules: [custom] } }), sourceRelayNodeId: relayId }, 1);
  assert.deepEqual((await guardianGroups(project.id)).flatMap(group => group.rules), [PRODUCTION_RULE, custom], 'leave the manager’s customized thresholds alone');
});

test("a relay answers only its admitted machines, only while it imposes Jev rules, and with its own key", async () => {
  const db = new DatabaseSync(":memory:");
  ensureRelaySchema(db);
  const self = (await getClusterNode()).id, admittedMachine = randomUUID();
  getOrCreateClusterIdentity(db, self);
  const signal = new AbortController().signal;
  const seen: Array<{ authorization: string | null; body: string }> = [];
  const fetchImpl = (async (_url: unknown, init: RequestInit) => { seen.push({ authorization: new Headers(init.headers).get("authorization"), body: String(init.body) }); return new Response('{"answers":{}}', { status: 200 }); }) as typeof fetch;
  const dependencies = { key: () => "relay-key", fetchImpl };
  const refused = (status: number) => (error: unknown) => error instanceof RelayGuardianRefused && error.statusCode === status;

  await assert.rejects(answerRelayGuardian(db, admittedMachine, "{}", signal, dependencies), refused(403), "a machine that does not serve a relay refuses");
  const now = new Date().toISOString();
  db.prepare("INSERT INTO relay_serving(singleton,enabled,origin,updated_at) VALUES(1,1,'https://relay.example',?)").run(now);
  await assert.rejects(answerRelayGuardian(db, randomUUID(), "{}", signal, dependencies), refused(403), "a machine not admitted is refused");
  db.prepare("INSERT INTO relay_machines(node_id,public_key,name,status,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(admittedMachine, "key", "member", "admitted", now, now);
  assert.equal((await answerRelayGuardian(db, admittedMachine, '{}', signal, dependencies)).status, 200, 'a fresh relay publishes the production rule by default');
  seen.length = 0;
  publishRelayPolicy(db, self, [], undefined, undefined, null);
  await assert.rejects(answerRelayGuardian(db, admittedMachine, "{}", signal, dependencies), refused(403), "an explicitly disabled relay refuses");
  publishRelayPolicy(db, self, [], undefined, undefined, jevPolicy);
  await assert.rejects(answerRelayGuardian(db, admittedMachine, "{}", signal, { ...dependencies, key: () => { throw new Error("no key"); } }), refused(409), "a relay without a key says so");
  const answer = await answerRelayGuardian(db, admittedMachine, '{"state":"x"}', signal, dependencies);
  assert.equal(answer.status, 200);
  assert.deepEqual(seen, [{ authorization: "Bearer relay-key", body: '{"state":"x"}' }], "Jev is asked with the relay's key, not the member's");
});

test("default cluster Jev rules borrow an admitted relay's decision model when this machine has no TypeSafe key", async (t) => {
  const relay = new DatabaseSync(":memory:");
  const relayId = randomUUID();
  const identity = getOrCreateClusterIdentity(relay, relayId);
  const local = await clusterV2Database();
  const member = createMembership(local, "https://guardian-borrow.example", identity.fingerprint);
  updateMembership(local, member.id, { status: "admitted", relayNodeId: relayId, fingerprint: identity.fingerprint });
  t.after(() => {
    local.prepare("DELETE FROM relay_skill_subscriptions WHERE membership_id=?").run(member.id);
    local.prepare("DELETE FROM relay_memberships WHERE id=?").run(member.id);
    relay.close();
  });

  ensureMembershipSchema(local);
  updateGuardianSettings({ ...DEFAULT_GUARDIAN_SETTINGS, enabled: false });
  const project = await addProject("Cluster default guardian", mkdtempSync(path.join(os.tmpdir(), "guardian-borrow-")), { writeInstructions: false });
  const manager = (await getClusterNode()).id, clusterId = randomUUID();
  createSharingCluster(local, { id: clusterId, name: "contigos" }, manager);
  addSharingMember(local, clusterId, manager, relayId, 1);
  pinClusterPublicKey(local, relayId, identity.publicKey);
  registerOwnedResource(local, { kind: "project", id: project.id, ownerNodeId: manager }, manager);
  setResourceShares(local, manager, "project", project.id, [{ clusterId, projectId: null }]);

  const groups = await guardianGroups(project.id);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].source, "contigos");
  assert.equal(groups[0].relayNodeId, undefined, "a regular cluster's default rule has no relay policy source");

  const verdict = await checkGuardian(
    { projectId: project.id, conversationId: "c-borrow", harness: "claude", cwd: process.cwd(), canReplaceTool: true },
    { kind: "outgoing", source: "the user's message", text: "hello" },
  );
  assert.equal(verdict.action, "block", "the relay cannot be reached in this unit test, so the check fails closed");
  assert.match((verdict as { reason: string }).reason, /Jev did not answer/, "the check routed through the decision relay instead of failing on a missing local key");
  assert.doesNotMatch((verdict as { reason: string }).reason, /No system TypeSafe key/, "the member borrows the relay's decision model");

  // A relay sharing group that has not received a signed policy statement yet still points to its relay.
  const relayGroupId = randomUUID();
  createSharingCluster(local, { id: relayGroupId, name: "Relay: unsynced" }, relayId);
  addSharingMember(local, relayGroupId, relayId, manager, 1);
  local.prepare("INSERT INTO relay_sharing_groups(relay_node_id,cluster_id) VALUES(?,?)").run(relayId, relayGroupId);
  recordRelaySharingHeartbeat(local, relayId, true);
  t.after(() => { recordRelaySharingHeartbeat(local, relayId, false); local.prepare("DELETE FROM relay_sharing_groups WHERE cluster_id=?").run(relayGroupId); });
  const relayProject = await addProject("Unsynced relay group", mkdtempSync(path.join(os.tmpdir(), "guardian-unsynced-")), { writeInstructions: false });
  registerOwnedResource(local, { kind: "project", id: relayProject.id, ownerNodeId: manager }, manager);
  setResourceShares(local, manager, "project", relayProject.id, [{ clusterId: relayGroupId, projectId: null }]);
  const unsyncedGroups = await guardianGroups(relayProject.id);
  assert.equal(unsyncedGroups.length, 1);
  assert.equal(unsyncedGroups[0].relayNodeId, relayId, "unsynced relay group keeps its relay as the Jev source");
});
