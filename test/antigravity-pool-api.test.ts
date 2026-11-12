import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("editing a mixed pool accepts Antigravity when refreshing its manifest", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-pool-api-"));
  const environment = await seedDevEnvironment(root, 1), node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  try {
    const session = await signIn(environment, node);
    const claude = await api<{ profile: { id: string } }>(node, session, "POST", "/provider-profiles", { provider: "claude", label: "Work" });
    const google = await api<{ profile: { id: string } }>(node, session, "POST", "/provider-profiles", { provider: "antigravity", label: "Google" });
    assert.equal(claude.status, 201);
    assert.equal(google.status, 201);
    const created = await api<{ pool: { id: string } }>(node, session, "POST", "/provider-profiles/pools", { name: "Work pool", profileIds: [claude.body.profile.id] });
    assert.equal(created.status, 201);
    const profileIds = [claude.body.profile.id, google.body.profile.id];
    const updated = await api<{ pool: { members: { profileId: string }[] } }>(node, session, "PUT", `/provider-profiles/pools/${created.body.pool.id}`, { name: "Work pool", profileIds });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.deepEqual(updated.body.pool.members.map(({ profileId }) => profileId), profileIds);
  } finally {
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
