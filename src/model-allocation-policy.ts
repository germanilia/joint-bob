import { createHash } from "node:crypto";
import { z } from "zod";
import { candidateSchema, recommendModels, ALLOCATION_POLICY_VERSION } from "./model-allocation.js";
import { assessmentSchema, evidenceSchema, modelIdentitySchema, modelKey, type ModelOutcome } from "./model-evidence.js";

export const allocationPolicySchema = z.object({
  mode: z.enum(["off", "recommendation", "automatic"]), candidates: z.array(candidateSchema).max(200),
  evidence: z.array(evidenceSchema).max(2000), recoveryAllowance: z.number().finite().nonnegative(), acceptedValidation: z.boolean(),
}).strict();
export type AllocationPolicy = z.infer<typeof allocationPolicySchema>;
export const allocationAttemptSchema = z.object({
  projectId: z.string().min(1).max(200), conversationId: z.string().min(1).max(200), attemptId: z.string().min(1).max(200),
  assessment: assessmentSchema, identity: modelIdentitySchema, startedAt: z.string().datetime(),
}).strict();
export type AllocationAttempt = z.infer<typeof allocationAttemptSchema>;

/** Stable task-level split keeps retries in one partition. No transcript is read. */
export function allocationTraining(rows: ModelOutcome[]): ModelOutcome[] {
  return rows.filter(row => createHash("sha256").update(`${row.projectId}\0${row.taskId}`).digest()[0] % 5 !== 0);
}

/** Observational acceptance only: never substitute another model's outcome for a recommendation. */
export function allocationValidation(policy: AllocationPolicy, rows: ModelOutcome[], now = new Date().toISOString()) {
  const training = allocationTraining(rows);
  const trainingTasks = new Set(training.map(row => `${row.projectId}\0${row.taskId}`));
  const heldOut = new Map<string, ModelOutcome>();
  for (const row of [...rows].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))) {
    const key = `${row.projectId}\0${row.taskId}`;
    if (!trainingTasks.has(key) && Date.parse(row.occurredAt) <= Date.parse(now)) heldOut.set(key, row);
  }
  const recommendations = new Map<string, string | null>();
  const matched: ModelOutcome[] = [];
  for (const row of heldOut.values()) {
    const group = JSON.stringify([row.identity.harness, row.domain, row.complexity, row.risk]);
    if (!recommendations.has(group)) {
      const result = recommendModels({ assessment: { taskId: row.taskId, domain: row.domain, complexity: row.complexity, risk: row.risk, capabilities: [], classifier: "held-out", confidence: 1 }, baseline: row.identity, pinned: false,
        candidates: policy.candidates, evidence: policy.evidence, outcomes: training, authorizedProjectIds: [...new Set(rows.map(item => item.projectId))], now });
      recommendations.set(group, result.recommended ? modelKey(result.recommended) : null);
    }
    if (recommendations.get(group) === modelKey(row.identity)) matched.push(row);
  }
  const verified = matched.filter(row => row.outcome === "verified").length;
  const coverage = heldOut.size ? matched.length / heldOut.size : 0;
  const priced = matched.length > 0 && matched.every(row => row.cost !== null);
  return { version: ALLOCATION_POLICY_VERSION, observational: true, trainingTasks: trainingTasks.size, heldOutTasks: heldOut.size, matchedTasks: matched.length, verified, coverage,
    totalCost: priced ? matched.reduce((sum, row) => sum + row.cost!, 0) : null,
    passed: matched.length >= 20 && coverage >= 0.5 && verified / matched.length >= 0.9 && priced,
    limitation: "Only matching historical decisions are observable. This is not a randomized quality or cost comparison; explicit acceptance is still required." };
}
