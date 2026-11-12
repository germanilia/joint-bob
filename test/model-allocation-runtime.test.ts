import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AllocationStore } from "../src/model-allocation-store.js";
import { prepareAllocation } from "../src/model-allocation-runtime.js";

const identity = { provider: "fixture", modelId: "model-v1", release: "1", harness: "pi", scaffold: "1", reasoning: "high" };
const assessment = { taskId: "task", domain: "software-repair" as const, complexity: 4, risk: "low" as const, capabilities: [], classifier: "fixture", confidence: 0.95 };
const attempt = { projectId: "project", conversationId: "conversation", attemptId: "turn", assessment, identity, startedAt: "2026-01-01T00:00:00Z" };

test("runtime evidence is opt-in, scoped, and requires an explicit verified check", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new AllocationStore(db);
    assert.equal(store.policy("owner").mode, "off");
    assert.equal(store.beginAttempt("owner", attempt), false);
    store.savePolicy("owner", { mode: "recommendation", candidates: [], evidence: [], recoveryAllowance: 0, acceptedValidation: false });
    assert.equal(store.beginAttempt("owner", attempt), true);
    store.finishAttempt("owner", "project", "turn", { cost: null, latencyMs: 100, failed: false, attributed: true });
    assert.equal(store.outcomes("owner", ["project"])[0].outcome, "unknown", "a completed turn is not a verified task");
    assert.equal(store.verifyAttempt("other", "project", "conversation", "check", "committed", "turn"), false);
    assert.equal(store.verifyAttempt("owner", "project", "conversation", "check", "committed", "turn"), true);
    assert.equal(store.outcomes("owner", ["project"])[0].outcome, "verified");
    assert.equal(store.outcomes("owner", ["project"])[0].cost, null);
    assert.deepEqual(store.outcomes("other", ["project"]), []);
    store.beginAttempt("owner", { ...attempt, attemptId: "unattributed" });
    store.finishAttempt("owner", "project", "unattributed", { cost: 0.1, latencyMs: 100, failed: false, attributed: false });
    store.verifyAttempt("owner", "project", "conversation", "late-check", "committed", "unattributed");
    assert.equal(store.outcomes("owner", ["project"])[0].outcome, "unknown", "late checks cannot invent exact model attribution");
    assert.throws(() => store.beginAttempt("owner", { ...attempt, prompt: "must not persist" }));
  } finally { db.close(); }
});

test("automatic dispatch uses held-out evidence once and respects policy revocation during classification", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new AllocationStore(db);
    const cheap = { ...identity, modelId: "cheap" };
    const candidate = (model: typeof identity, cost: number) => ({ identity: model, authorized: true, available: true, capabilities: [], attemptCost: cost, handoffCost: 0, evaluationCost: 0, recoveryCost: 1 });
    for (let i = 0; i < 500; i++) store.recordOutcome("owner", { taskId: `task-${i}`, projectId: "project", attemptId: `past-${i}`, identity: cheap, domain: assessment.domain, complexity: 4, risk: "low", outcome: "verified", cost: 0.1, latencyMs: 10, occurredAt: "2026-01-01T00:00:00Z" }, true);
    const policy = { mode: "automatic", candidates: [candidate(identity, 4), candidate(cheap, 1)], evidence: [], recoveryAllowance: 0, acceptedValidation: true };
    store.savePolicy("owner", policy, ["project"]);
    const input = { ownerId: "owner", projectId: "project", conversationId: "conversation", attemptId: "turn", projectIds: ["project"], harness: "pi", scaffold: "1", current: identity, pinned: false, capabilities: [], text: "Fix parser" };
    let actualModel = identity.modelId;
    let configurations = 0;
    const execution = { assess: async () => assessment, available: async () => true, apply: async (model: typeof identity) => { actualModel = model.modelId; configurations++; } };
    await prepareAllocation(store, input, execution);
    assert.equal(actualModel, "cheap");
    await assert.rejects(prepareAllocation(store, input, execution), /already exists/);
    assert.equal(configurations, 1, "replayed operation must not reconfigure a live harness");
    actualModel = identity.modelId;
    const revoked = await prepareAllocation(store, { ...input, attemptId: "next" }, { ...execution, assess: async () => { store.savePolicy("owner", { ...policy, mode: "off" }); return assessment; } });
    assert.equal(actualModel, identity.modelId, "revoked policy must not change the model");
    assert.equal(revoked, null);
  } finally { db.close(); }
});

test("recovery dispatch claim survives restart and refuses a different scope or model", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new AllocationStore(db);
    const execution = { projectId: "project", conversationId: "conversation", originAttemptId: "turn", identity, assessment };
    store.reserve("owner", { harness: "pi", taskId: "task", operationId: "operation", cost: 1, nextQuality: 0.95, previousQuality: 0.8,
      checkpoint: { worktreeId: "worktree", baseCommit: "a".repeat(40), candidateCommit: "b".repeat(40), checkIds: ["check"] }, execution },
      { harness: "pi", attempts: 0, spent: 0, reserved: 0, allowance: 2, writerActive: false, pendingExternalOperation: false, enabled: true, validated: true });
    assert.equal(store.recovery("other", "operation"), null);
    assert.throws(() => store.claimRecovery("owner", "operation", { ...execution, identity: { ...identity, harness: "claude" } }, "worktree"), /scope|model|harness/);
    assert.equal(store.claimRecovery("owner", "operation", execution, "worktree"), true);
    assert.equal(new AllocationStore(db).claimRecovery("owner", "operation", execution, "worktree"), false);
    store.finish("owner", "operation", 0.5);
    assert.ok(store.recovery("owner", "operation"), "completed operations remain visible to dispatch replay fences");
    assert.equal(store.claimRecovery("owner", "operation", execution, "worktree"), false);
  } finally { db.close(); }
});

test("automatic policy requires accepted held-out evidence and cannot be enabled on an empty store", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new AllocationStore(db);
    assert.throws(() => store.savePolicy("owner", { mode: "automatic", candidates: [], evidence: [], recoveryAllowance: 2, acceptedValidation: true }), /held-out/i);
    assert.equal(store.policy("owner").mode, "off");
  } finally { db.close(); }
});
