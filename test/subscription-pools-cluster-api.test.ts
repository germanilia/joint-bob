import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";
let root: string, environment: DevEnvironment, nodeA: SeededNode, nodeB: SeededNode;
let servers: Awaited<ReturnType<typeof startDevNode>>[] = [];
let sessionA: SignedIn, sessionB: SignedIn;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "jb-cluster-pools-")); environment = await seedDevEnvironment(root, 2); [nodeA, nodeB] = environment.nodes;
  servers = await Promise.all(environment.nodes.map(node => startDevNode(environment, node)));
  [sessionA, sessionB] = await Promise.all([signIn(environment, nodeA), signIn(environment, nodeB)]);
}, { timeout: 120_000 });
after(async () => { await Promise.all(servers.map(stopDevNode)); if (root) await rm(root, { recursive: true, force: true }); });

test("ordinary clusters require host consent and manager selection; revocation refuses cached proxy use", { timeout: 120_000 }, async () => {
  const created = await api<{ snapshot: { body: { clusterId: string } } }>(nodeA, sessionA, "POST", "/clusters", { name: "Pool access" });
  assert.equal(created.status, 201, JSON.stringify(created.body)); const clusterId = created.body.snapshot.body.clusterId;
  const invitation = await api<{ link: string }>(nodeA, sessionA, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
  assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
  const joined = await api(nodeB, sessionB, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() }); assert.equal(joined.status, 201, JSON.stringify(joined.body));
  const profile = await api<{ profile: { id: string } }>(nodeB, sessionB, "POST", "/provider-profiles", { label: "Hosted fixture", provider: "claude" }); assert.equal(profile.status, 201);
  const pool = await api<{ pool: { id: string } }>(nodeB, sessionB, "POST", "/provider-profiles/pools", { name: "Hosted pool", profileIds: [profile.body.profile.id], fallbackModels: {} }); assert.equal(pool.status, 201);
  const selection = { poolId: pool.body.pool.id, poolOwnerNodeId: nodeB.nodeId, expectedEpoch: 1 };
  assert.equal((await api(nodeA, sessionA, "POST", `/clusters/${clusterId}/subscription-pool`, selection)).status, 403, "naming a remote pool grants no access");
  assert.equal((await api(nodeB, sessionB, "POST", `/clusters/${clusterId}/subscription-pool`, selection)).status, 403, "host cannot select the cluster pool");
  const grantPath = `/provider-profiles/pools/${pool.body.pool.id}/cluster-grants/${clusterId}`;
  assert.equal((await api(nodeB, sessionB, "PUT", grantPath, { enabled: true })).status, 200);
  const offered = await api<{ pools: Array<{ poolId: string }> }>(nodeA, sessionA, "GET", `/clusters/${clusterId}/available-pools`); assert.equal(offered.status, 200, JSON.stringify(offered.body)); assert.ok(offered.body.pools.some(item => item.poolId === pool.body.pool.id));
  const assigned = await api(nodeA, sessionA, "POST", `/clusters/${clusterId}/subscription-pool`, selection); assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  const manifest = { poolId: pool.body.pool.id, name: "Hosted pool", fallbackModels: {}, members: [{ profileId: profile.body.profile.id, provider: "claude", label: "Hosted fixture", position: 0 }] };
  const forged = await signedNodeRequest(environment, nodeB, nodeA, "POST", "/api/cluster/v2/subscription-pools/assign", { clusterId, expectedEpoch: 1, poolOwnerNodeId: nodeB.nodeId, manifest: { ...manifest, poolId: randomUUID() } }); assert.equal(forged.status, 403); await forged.arrayBuffer();
  assert.equal((await api(nodeB, sessionB, "PUT", grantPath, { enabled: false })).status, 200);
  const proxy = await signedNodeRequest(environment, nodeA, nodeB, "POST", "/api/cluster/v2/subscription-pools/proxy", { clusterId, poolId: pool.body.pool.id, profileId: profile.body.profile.id }); assert.equal(proxy.status, 403); await proxy.arrayBuffer();
  const retained = await api<{ assignment: { poolId: string } }>(nodeA, sessionA, "GET", `/clusters/${clusterId}/subscription-pool`); assert.equal(retained.body.assignment.poolId, pool.body.pool.id, "revocation never silently restores personal credentials");
});
