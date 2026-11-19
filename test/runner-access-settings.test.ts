import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import { openNodeDatabase } from "../src/node-database.js";

test("other machines may start conversations and run automations here until this node opts out; the choice persists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-runner-access-settings-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    server = await startDevNode(environment, node);
    const auth = await signIn(environment, node);
    const initial = await api<Record<string, unknown>>(node, auth, "GET", "/settings");
    assert.deepEqual(initial.body.runnerAccess, { conversations: true, automations: true });

    const changed = await api<Record<string, unknown>>(node, auth, "PUT", "/settings", { ...initial.body, runnerAccess: { conversations: true, automations: false } });
    assert.equal(changed.status, 200);
    assert.deepEqual((await api<Record<string, unknown>>(node, auth, "GET", "/settings")).body.runnerAccess, { conversations: true, automations: false });

    const { runnerAccess: _stored, ...withoutFlag } = changed.body;
    const untouched = await api<Record<string, unknown>>(node, auth, "PUT", "/settings", { ...withoutFlag, conversationHistoryDays: 31 });
    assert.deepEqual(untouched.body.runnerAccess, { conversations: true, automations: false }, "a save that omits the setting keeps the stored value");

    assert.equal((await api(node, auth, "PUT", "/settings", { ...initial.body, runnerAccess: { conversations: "yes", automations: true } })).status, 400);
    assert.equal((await api(node, auth, "PUT", "/settings", { ...initial.body, runnerAccess: { otherNodes: true } })).status, 400, "the old single switch is not accepted");
  } finally {
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});

// fix: the settings page saved the old opt-in "Allow other nodes to pick this node in Runs on" on every change, so its "false" was nobody's choice.
test("the old opt-in switch no longer keeps other machines out", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-runner-access-legacy-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    await stopDevNode(await startDevNode(environment, node));
    const db = openNodeDatabase(path.join(node.dataDir, "node.db"));
    db.prepare("INSERT INTO node_settings (key, value, is_secret, updated_at) VALUES ('runnerAccess.otherNodes', 'false', 0, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(new Date().toISOString());
    db.close();
    server = await startDevNode(environment, node);
    const auth = await signIn(environment, node);
    assert.deepEqual((await api<Record<string, unknown>>(node, auth, "GET", "/settings")).body.runnerAccess, { conversations: true, automations: true });
  } finally {
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
