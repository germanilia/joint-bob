import type { AllocationStore } from "./model-allocation-store.js";
import { allocationTraining, allocationValidation, type AllocationAttempt } from "./model-allocation-policy.js";
import { recommendModels } from "./model-allocation.js";
import { modelKey, type ModelIdentity, type TaskAssessment } from "./model-evidence.js";

export class AllocationEvidenceUnavailable extends Error {}

export interface AllocationTurn {
  ownerId: string; projectId: string; conversationId: string; attemptId: string; projectIds: string[];
  harness: string; scaffold: string | null; current: { provider: string; modelId: string; reasoning: string };
  pinned: boolean; capabilities: string[]; text: string;
}
export interface AllocationExecution {
  assess(input: { taskId: string; text: string; capabilities: string[] }): Promise<TaskAssessment>;
  available(identity: ModelIdentity): Promise<boolean>;
  apply(identity: ModelIdentity): Promise<void>;
}

/** Called in the existing queue's idle preparation gap, never while native tools are executing. */
export async function prepareAllocation(store: AllocationStore, input: AllocationTurn, execution: AllocationExecution): Promise<{ attempt: AllocationAttempt; notice: string } | null> {
  const policy = store.policy(input.ownerId);
  if (policy.mode === "off") return null;
  const sameRuntime = policy.candidates.filter(candidate => candidate.identity.harness === input.harness && candidate.identity.scaffold === input.scaffold);
  const baseline = sameRuntime.find(candidate => candidate.identity.provider === input.current.provider && candidate.identity.modelId === input.current.modelId && candidate.identity.reasoning === input.current.reasoning);
  if (!baseline) throw new AllocationEvidenceUnavailable("Allocation needs an approved exact model identity and current harness version; existing routing is unchanged");
  let assessment: TaskAssessment;
  try { assessment = await execution.assess({ taskId: input.conversationId, text: input.text, capabilities: input.capabilities }); }
  catch { throw new AllocationEvidenceUnavailable("Task assessment unavailable; existing routing is unchanged"); }
  const candidates = [];
  for (const candidate of sameRuntime) candidates.push({ ...candidate, available: candidate.available && await execution.available(candidate.identity) });
  const rows = store.outcomes(input.ownerId, input.projectIds);
  const validation = allocationValidation(policy, rows);
  const decision = recommendModels({ assessment, baseline: baseline.identity, pinned: input.pinned, candidates, evidence: policy.evidence,
    outcomes: allocationTraining(rows), authorizedProjectIds: input.projectIds, now: new Date().toISOString() });
  if (JSON.stringify(store.policy(input.ownerId)) !== JSON.stringify(policy)) return null;
  const identity = policy.mode === "automatic" && policy.acceptedValidation && validation.passed && decision.recommended && !input.pinned ? decision.recommended : baseline.identity;
  const attempt = { projectId: input.projectId, conversationId: input.conversationId, attemptId: input.attemptId, assessment, identity, startedAt: new Date().toISOString() };
  if (!store.beginAttempt(input.ownerId, attempt)) return null;
  if (modelKey(identity) !== modelKey(baseline.identity)) await execution.apply(identity);
  const notice = policy.mode === "automatic" && !validation.passed ? "Held-out evidence no longer passes; existing routing retained" : `${policy.mode}: ${decision.reason}`;
  return { attempt, notice };
}
