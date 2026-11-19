import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import { openNodeDatabase } from "../src/node-database.js";

test("automation saves reject unavailable profiles, ignore forged creators, and preserve assignments", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "automation-profile-api-"));
  let server;
  try {
    const environment = await seedDevEnvironment(root, 1), node = environment.nodes[0];
    server = await startDevNode(environment, node);
    const auth = await signIn(environment, node);
    const profile = await api<{ profile: { id: string; owner: string } }>(node, auth, "POST", "/provider-profiles", { label: "Synthetic", provider: "claude" });
    assert.equal(profile.status, 201);
    const providerProfileId = profile.body.profile.id;
    const base = { trigger: "webhook", creatorAccountId: "forged-account", providerProfileId, name: "Test", target: { kind: "project", projectId: node.projects[0].id }, enabled: false };
    const invalid = await api(node, auth, "POST", "/automations", { ...base, providerProfileId: randomUUID() });
    assert.ok(invalid.status >= 400, "unknown node-local profile must not save");
    const hook = await api<{ automation: { id: string; creatorAccountId: string; providerProfileId: string | null } }>(node, auth, "POST", "/automations", base);
    assert.equal(hook.status, 201, JSON.stringify(hook.body));
    assert.equal(hook.body.automation.creatorAccountId, profile.body.profile.owner);
    assert.equal(hook.body.automation.providerProfileId, providerProfileId);
    const profiles = await api<{ profiles: Array<{ id: string }> }>(node, auth, "GET", "/automations/profiles");
    assert.ok(profiles.body.profiles.some(p => p.id === providerProfileId));
    const input = { trigger: "schedule", creatorAccountId: "forged-account", providerProfileId, target: { kind: "project", projectId: node.projects[0].id, engine: "claude" }, name: "Profile schedule", context: "Never run", enabled: false, schedule: { frequency: "daily", hour: 9, minute: 0, weekday: 1, timezone: "UTC" } };
    assert.ok((await api(node, auth, "POST", "/automations", { ...input, providerProfileId: randomUUID() })).status >= 400);
    const task = await api<{ automation: { id: string; creatorAccountId: string; providerProfileId: string } }>(node, auth, "POST", "/automations", input);
    assert.equal(task.status, 201, JSON.stringify(task.body));
    assert.equal(task.body.automation.creatorAccountId, profile.body.profile.owner);
    assert.equal(task.body.automation.providerProfileId, providerProfileId);
    const cleared = await api<{ automation: { creatorAccountId: string; providerProfileId: null } }>(node, auth, "PUT", `/automations/${hook.body.automation.id}`, { ...base, providerProfileId: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.automation.creatorAccountId, profile.body.profile.owner);
    assert.equal(cleared.body.automation.providerProfileId, null);
    // The same project remains visible, but its automations belong to a different user.
    const db = openNodeDatabase(path.join(node.dataDir, "node.db"));
    try {
      db.prepare("UPDATE webhooks SET creator_account_id=? WHERE id=?").run("different-creator", hook.body.automation.id);
      db.prepare("UPDATE webhooks SET creator_account_id=? WHERE id=?").run("different-creator", task.body.automation.id);
    } finally { db.close(); }
    // Anyone may edit an automation (cluster members, 7387f55a), but an edit never moves it to the editor: the creator stays,
    // and clearing the profile leaves it on the node's defaults rather than on the creator's current profile.
    type Saved = { automation: { creatorAccountId: string; providerProfileId: string | null; context: string } };
    const rewrittenHook = await api<Saved>(node, auth, "PUT", `/automations/${hook.body.automation.id}`, { ...base, context: "Edited by another person", providerProfileId: null });
    assert.equal(rewrittenHook.status, 200, JSON.stringify(rewrittenHook.body));
    assert.equal(rewrittenHook.body.automation.creatorAccountId, "different-creator", "an editor does not become the creator");
    assert.equal(rewrittenHook.body.automation.providerProfileId, null, "an editor does not run the work under the creator's profile");
    const rewrittenTask = await api<Saved>(node, auth, "PUT", `/automations/${task.body.automation.id}`, { ...input, context: "Edited by another person", providerProfileId: null });
    assert.equal(rewrittenTask.status, 200, JSON.stringify(rewrittenTask.body));
    assert.equal(rewrittenTask.body.automation.creatorAccountId, "different-creator");
    assert.equal(rewrittenTask.body.automation.providerProfileId, null);
  } finally { if (server) await stopDevNode(server); await rm(root, { recursive: true, force: true }); }
});
