import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AllocationStore } from "../src/model-allocation-store.js";

const row = { taskId: "task", attemptId: "attempt", projectId: "project", identity: { provider: "fixture", modelId: "model", release: "1", harness: "pi", scaffold: "1", reasoning: "high" }, domain: "software-repair" as const, complexity: 4, risk: "low" as const, outcome: "verified" as const, cost: 1, latencyMs: 10, occurredAt: "2026-01-01T00:00:00Z" };
test("derived outcomes stay account/project scoped and collection remains default-off", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new AllocationStore(db);
    store.recordOutcome("owner", row, false);
    assert.deepEqual(store.outcomes("owner", ["project"]), []);
    store.recordOutcome("owner", row, true);
    assert.deepEqual(store.outcomes("other", ["project"]), []);
    assert.deepEqual(store.outcomes("owner", ["other"]), []);
    assert.equal(store.outcomes("owner", ["project"]).length, 1);
    assert.throws(() => store.recordOutcome("owner", { ...row, transcript: "must not persist" }, true));
  } finally { db.close(); }
});
test("recovery reservations are durable, idempotent and scoped; interrupted attempts are not replayed", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new AllocationStore(db);
    const state = { attempts: 0, spent: 0, reserved: 0, allowance: 3, pendingExternalOperation: false, writerActive: false, validated: true, enabled: true };
    const input = { taskId: "task", operationId: "op", cost: 1, nextQuality: 0.9, previousQuality: 0.8, checkpoint: { worktreeId: "worktree", baseCommit: "a".repeat(40), candidateCommit: "b".repeat(40), checkIds: ["verified-check"] } };
    const first = store.reserve("owner", input, state);
    const retry = new AllocationStore(db).reserve("owner", input, state);
    assert.equal(first.dispatch, true);
    assert.equal(retry.dispatch, false);
    assert.equal(first.state.attempts, 1);
    assert.throws(() => store.reserve("other", input, state));
    assert.throws(() => store.reserve("owner", { ...input, cost: 2 }, state));
    assert.throws(() => store.reserve("owner", { ...input, operationId: "op2" }, state), /writer|uncertain/);
    assert.equal(first.state.writerActive, true);
    const finished = store.finish("owner", "op", 0.5);
    assert.equal(finished.spent, 0.5); assert.equal(finished.reserved, 0);
    assert.equal(store.reserve("owner", { ...input, operationId: "op2" }, state).dispatch, true);
    store.finish("owner", "op2", 1);
    assert.throws(() => store.reserve("owner", { ...input, operationId: "op3" }, state));
  } finally { db.close(); }
});
