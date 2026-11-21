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
import { addSharingMember, createSharingCluster, registerOwnedResource, setResourceShares } from "../src/cluster-sharing-policy.js";
import { getOrCreateClusterIdentity, pinClusterPublicKey } from "../src/cluster-identity.js";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { checkGuardian } from "../src/guardian/check.js";
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
  const statement = publishRelayPolicy(relay, relayId, [], undefined, undefined, jevPolicy);
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
  assert.equal((await guardianGroups(project.id))[0].relayNodeId, relayId);
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
