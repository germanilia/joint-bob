import assert from "node:assert/strict";
import test from "node:test";
import { recommendModels, reserveRecovery, evaluateHeldOut } from "../src/model-allocation.js";
import { evidenceSchema, evidenceFresh, modelKey } from "../src/model-evidence.js";

const identity = (id: string) => ({ provider: "fixture", modelId: id, release: "2026-01-01", harness: "pi", scaffold: "pi-1", reasoning: "high" });
const task = { taskId: "task", domain: "software-repair" as const, complexity: 4, risk: "low" as const, capabilities: ["terminal"], classifier: "fixture-v1", confidence: 0.95 };
const candidate = (id: string, cost: number | null) => ({ identity: identity(id), authorized: true, available: true, capabilities: ["terminal"], attemptCost: cost, handoffCost: 0.1, evaluationCost: 0.05, recoveryCost: 1 });
const evidence = (id: string) => ({ sourceUrl: "https://www.swebench.com/", retrievedAt: "2026-01-02T00:00:00Z", publishedAt: "2026-01-01T00:00:00Z", benchmark: "swe-bench-verified" as const, version: "500", domain: "software-repair" as const, identity: identity(id), score: 90, unit: "percent-resolved" as const, sampleSize: 500, limitations: ["Fixture, not a production score"] });
const outcomes = (id: string, count = 40) => Array.from({ length: count }, (_, index) => ({ taskId: `${id}-${index}`, projectId: "allowed", attemptId: `${id}-${index}`, identity: identity(id), domain: task.domain, complexity: 4, risk: task.risk, outcome: "verified" as const, cost: 1, latencyMs: 100, occurredAt: "2026-01-03T00:00:00Z" }));
const input = () => ({ assessment: task, baseline: identity("baseline"), pinned: false, candidates: [candidate("expensive", 4), candidate("cheap", 1)], evidence: [evidence("expensive"), evidence("cheap")], outcomes: [...outcomes("cheap"), ...outcomes("expensive")], authorizedProjectIds: ["allowed"], now: "2026-01-04T00:00:00Z" });

test("exact identities and provenance are mandatory; stale and future evidence are not usable", () => {
  assert.ok(evidenceSchema.safeParse(evidence("cheap")).success);
  assert.ok(!evidenceSchema.safeParse({ ...evidence("cheap"), unit: "accuracy" }).success);
  assert.ok(!evidenceSchema.safeParse({ ...evidence("cheap"), version: "unknown" }).success);
  assert.equal(evidenceFresh(evidence("cheap"), "2027-01-01T00:00:00Z"), false);
  assert.equal(evidenceFresh(evidence("cheap"), "2025-01-01T00:00:00Z"), false);
  assert.notEqual(modelKey(identity("cheap")), modelKey({ ...identity("cheap"), harness: "claude" }));
});

test("recommendation ranks qualified candidates by total expected cost, without switching", () => {
  const result = recommendModels(input());
  assert.equal(result.mode, "recommendation-only");
  assert.equal(result.recommended?.modelId, "cheap");
  assert.equal(result.ranked[0].samples, 40);
  assert.ok(result.ranked[0].expectedCost > 1.15);
});

test("manual pins, low confidence, unknown costs, access limits and sparse history retain baseline", () => {
  assert.equal(recommendModels({ ...input(), pinned: true }).recommended, null);
  assert.equal(recommendModels({ ...input(), assessment: { ...task, confidence: 0.2 } }).recommended, null);
  assert.equal(recommendModels({ ...input(), candidates: [candidate("cheap", null)] }).recommended, null);
  assert.equal(recommendModels({ ...input(), authorizedProjectIds: [] }).recommended, null);
  assert.equal(recommendModels({ ...input(), outcomes: outcomes("cheap", 1) }).recommended, null);
  assert.equal(recommendModels({ ...input(), candidates: [{ ...candidate("cheap", 1), authorized: false }] }).recommended, null);
});

test("authentication and unknown results never count as verified success", () => {
  const failed = outcomes("cheap").map(row => ({ ...row, outcome: "auth-error" as const }));
  assert.equal(recommendModels({ ...input(), candidates: [candidate("cheap", 1)], outcomes: failed }).recommended, null);
  const wrongRelease = outcomes("cheap").map(row => ({ ...row, identity: { ...row.identity, release: "other" } }));
  assert.equal(recommendModels({ ...input(), outcomes: wrongRelease }).recommended, null);
});

test("recovery reserves finite approved cost, stronger attempts only, never uncertain external work", () => {
  const state = { attempts: 0, spent: 0, reserved: 0, allowance: 3, pendingExternalOperation: false, writerActive: false, validated: true, enabled: true };
  assert.equal(reserveRecovery(state, 1, 0.9, 0.8).reserved, 1);
  for (const bad of [{ ...state, attempts: 2 }, { ...state, allowance: 0 }, { ...state, pendingExternalOperation: true }, { ...state, writerActive: true }, { ...state, validated: false }]) assert.throws(() => reserveRecovery(bad, 1, 0.9, 0.8));
  assert.throws(() => reserveRecovery(state, 1, 0.7, 0.8));
});

test("held-out evaluation excludes training tasks and reports unknown outcomes honestly", () => {
  const result = evaluateHeldOut(outcomes("cheap", 4), ["cheap-0"]);
  assert.equal(result.tasks, 3);
  assert.equal(result.verified, 3);
  assert.equal(result.observational, true);
});
