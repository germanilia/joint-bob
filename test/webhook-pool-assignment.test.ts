import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createWebhook, updateWebhook, webhookInputSchema, webhookForSecret } from "../src/webhooks.js";
import { queuedAutomationProfileSchema } from "../src/prompt-queue.js";

test("webhook pool and Guardian bypass survive persistence, edits and queue serialization", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const providerPoolId = randomUUID();
    const input = webhookInputSchema.parse({ name: "Pool hook", target: { kind: "project", projectId: "p" }, creatorAccountId: "alice", providerPoolId, bypassGuardian: true });
    const { webhook, secret } = createWebhook(db, input);
    assert.equal(webhookForSecret(db, secret)?.providerPoolId, providerPoolId);
    assert.equal(webhookForSecret(db, secret)?.bypassGuardian, true);
    updateWebhook(db, webhook.id, { ...input, providerPoolId: null });
    assert.equal(webhookForSecret(db, secret)?.providerPoolId, null);
    assert.equal(webhookForSecret(db, secret)?.bypassGuardian, true);
    assert.equal(queuedAutomationProfileSchema.parse({ accountId: "alice", profileId: null, poolId: providerPoolId, nodeId: randomUUID() }).poolId, providerPoolId);
  } finally { db.close(); }
});
