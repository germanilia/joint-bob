import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getClusterNode } from "../src/cluster.js";
import { getOrCreateClusterIdentity } from "../src/cluster-identity.js";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { checkGuardian } from "../src/guardian/check.js";
import { PRODUCTION_RULE } from "../src/guardian/production-rule.js";
import { answerRelayGuardian, RelayGuardianRefused } from "../src/guardian/relay-model.js";
import { DEFAULT_GUARDIAN_SETTINGS, guardianRelayPolicySchema } from "../src/guardian/rules.js";
import { guardianGroups, productionGuard, updateGuardianSettings } from "../src/guardian/settings.js";
import { publishRelayPolicy, receiveRelayPolicy } from "../src/relay/resource-policy.js";
import { createMembership, ensureRelaySchema, updateMembership } from "../src/relay/store.js";
import { addProject } from "../src/store.js";

const jevPolicy = guardianRelayPolicySchema.parse({ model: "jev", layaUrl: "", rules: [PRODUCTION_RULE] });

test("a relay's Jev rules apply to every member, are asked through the relay, and count as protection", async (t) => {
  const relay = new DatabaseSync(":memory:");
  const relayId = randomUUID();
  const identity = getOrCreateClusterIdentity(relay, relayId);
  const local = await clusterV2Database();
  const member = createMembership(local, "https://guardian-key.example", identity.fingerprint);
  updateMembership(local, member.id, { status: "admitted", relayNodeId: relayId, fingerprint: identity.fingerprint });
  const admitted = { ...member, status: "admitted" as const, relayNodeId: relayId, fingerprint: identity.fingerprint };
  t.after(() => { local.prepare("DELETE FROM relay_skill_subscriptions WHERE membership_id=?").run(member.id); local.prepare("DELETE FROM relay_memberships WHERE id=?").run(member.id); relay.close(); });

  updateGuardianSettings({ ...DEFAULT_GUARDIAN_SETTINGS, enabled: false });
  assert.equal(await productionGuard(), "guardian-off", "nothing is imposed yet");
  receiveRelayPolicy(local, admitted, identity.publicKey, publishRelayPolicy(relay, relayId, [], undefined, undefined, jevPolicy));
  assert.equal(await productionGuard(), "on", "no warning below a relay that imposes the production rule");
  assert.equal((await guardianGroups())[0].relayNodeId, relayId);

  const project = await addProject("Guardian key", mkdtempSync(path.join(os.tmpdir(), "guardian-key-")), { writeInstructions: false });
  const verdict = await checkGuardian({ projectId: project.id, conversationId: "c", harness: "pi", cwd: process.cwd(), canReplaceTool: true },
    { kind: "tool", tool: "bash", category: "commands", input: { command: "ls" } });
  assert.equal(verdict.action, "block", "the relay cannot be reached here, so the check fails closed");
  assert.match((verdict as { reason: string }).reason, /No route to the relay/);
  assert.doesNotMatch((verdict as { reason: string }).reason, /System AI|TypeSafe key/, "the member never looks for a key of its own");
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
  await assert.rejects(answerRelayGuardian(db, admittedMachine, "{}", signal, dependencies), refused(403), "a relay that imposes no Jev rules refuses");
  publishRelayPolicy(db, self, [], undefined, undefined, jevPolicy);
  await assert.rejects(answerRelayGuardian(db, admittedMachine, "{}", signal, { ...dependencies, key: () => { throw new Error("no key"); } }), refused(409), "a relay without a key says so");
  const answer = await answerRelayGuardian(db, admittedMachine, '{"state":"x"}', signal, dependencies);
  assert.equal(answer.status, 200);
  assert.deepEqual(seen, [{ authorization: "Bearer relay-key", body: '{"state":"x"}' }], "Jev is asked with the relay's key, not the member's");
});
