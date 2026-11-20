import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createAdministrator, listReplicatedUsers } from "../src/auth.js";
import { ensureClusterSharingPolicySchema, setTrustedTwin } from "../src/cluster-sharing-policy.js";
import { settingsDatabase } from "../src/settings-store.js";
import { applyAccountSnapshot } from "../src/user-replication.js";

const account = (username: string, email: string) => ({
  accountId: randomUUID().replaceAll("-", ""), username, email, passwordHash: "ab".repeat(64), passwordSalt: "cd".repeat(16),
  mfaRequired: false, updatedAt: new Date().toISOString(), clusterIds: [],
});

test("a twin's administrator is kept when both machines' administrators use one email", async () => {
  const db = await settingsDatabase(), local = randomUUID(), twin = randomUUID();
  createAdministrator("iliagerman", "a-long-enough-password-1", false, "owner@example.test");
  ensureClusterSharingPolicySchema(db);
  setTrustedTwin(db, local, twin, true);
  const result = applyAccountSnapshot(db, local, twin, { version: 2, accounts: [account("ilia", "owner@example.test")] });
  assert.deepEqual(result, { applied: ["ilia"], rejected: [] });
  const kept = listReplicatedUsers().find((user) => user.username === "ilia");
  assert.equal(kept?.homeNodeId, twin);
  assert.equal(kept?.email ?? null, null, "the address stays with this machine's own account");
});
