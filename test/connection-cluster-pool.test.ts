import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";

test("Connections cluster pool assignments publish a shared rule, not a personal exception", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-connection-cluster-pool-"));
  const environment = await seedDevEnvironment(root, 2);
  const [manager, member] = environment.nodes;
  const servers = await Promise.all(environment.nodes.map(node => startDevNode(environment, node)));
  try {
    const [managerSession, memberSession] = await Promise.all(environment.nodes.map(node => signIn(environment, node)));
    const created = await api<{ snapshot: { body: { clusterId: string } } }>(manager, managerSession, "POST", "/clusters", { name: "Contigos fixture" });
    assert.equal(created.status, 201);
    const clusterId = created.body.snapshot.body.clusterId;
    const invitation = await api<{ link: string }>(manager, managerSession, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
    assert.equal(invitation.status, 201);
    assert.equal((await api(member, memberSession, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() })).status, 201);
    const profile = await api<{ profile: { id: string } }>(manager, managerSession, "POST", "/provider-profiles", { provider: "openai-codex", label: "Hosted Codex" });
    assert.equal(profile.status, 201);
    const pool = await api<{ pool: { id: string } }>(manager, managerSession, "POST", "/provider-profiles/pools", { name: "Contigos shared", profileIds: [profile.body.profile.id], fallbackModels: {} });
    assert.equal(pool.status, 201);
    const choice = { scope: "cluster", scopeId: clusterId, poolId: pool.body.pool.id };
    const saved = await api(manager, managerSession, "PUT", "/provider-profiles/pool-selection", choice);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const rule = await api<{ assignment: { poolId: string; poolOwnerNodeId: string } | null }>(manager, managerSession, "GET", `/clusters/${clusterId}/subscription-pool`);
    assert.equal(rule.body.assignment?.poolId, pool.body.pool.id, "the Connections save must publish the mandatory pool for the actual cluster");
    assert.equal(rule.body.assignment?.poolOwnerNodeId, manager.nodeId);
    const grants = await api<{ pools: Array<{ poolId: string; enabled: boolean }> }>(manager, managerSession, "GET", `/clusters/${clusterId}/pool-grants`);
    assert.ok(grants.body.pools.some(item => item.poolId === pool.body.pool.id && item.enabled));
    const inherited = await api<{ rules: Array<{ clusterId: string; poolId: string; providers: string[] }> }>(member, memberSession, "GET", "/provider-profiles/relay-rules");
    assert.ok(inherited.body.rules.some(item => item.clusterId === clusterId && item.poolId === pool.body.pool.id && item.providers.includes("openai-codex")), JSON.stringify(inherited.body));
    const memberProfiles = await api<{ profiles: Array<{ id: string }> }>(member, memberSession, "GET", "/provider-profiles");
    assert.equal(memberProfiles.body.profiles.some(item => item.id === profile.body.profile.id), false, "cluster access must not copy the owner's profiles or credentials");
    assert.equal((await api(manager, managerSession, "PUT", `/provider-profiles/${profile.body.profile.id}/sharing`, { shared: true })).status, 200);
    const probe = await signedNodeRequest(environment, member, manager, "POST", "/api/cluster/v2/subscription-pools/proxy", { clusterId, poolId: pool.body.pool.id, profileId: profile.body.profile.id });
    assert.equal(probe.status, 409, "a granted pool authorizes even a shared profile; the synthetic profile has no login, not a permission denial");
    await probe.arrayBuffer();
    assert.equal((await api(member, memberSession, "PUT", "/provider-profiles/pool-selection", { ...choice, poolId: null })).status, 403, "a member cannot clear the shared cluster assignment");
    const removed = await api(manager, managerSession, "PUT", "/provider-profiles/pool-selection", { ...choice, poolId: null });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    const cleared = await api<{ assignment: unknown }>(manager, managerSession, "GET", `/clusters/${clusterId}/subscription-pool`);
    assert.equal(cleared.body.assignment, null);
  } finally {
    await Promise.all(servers.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
