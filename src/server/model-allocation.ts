import { createHash } from "node:crypto";
import path from "node:path";
import { runAsAccount } from "../account-context.js";
import { ownerAsActor } from "../ownership.js";
import { AllocationStore } from "../model-allocation-store.js";
import { allocationTraining, allocationValidation } from "../model-allocation-policy.js";
import { recommendModels } from "../model-allocation.js";
import { modelKey } from "../model-evidence.js";
import { integrationCheckpoint } from "../worktree-integration.js";
import { routingPolicyDatabase } from "../routing-policy.js";
import { decisionModelTarget } from "../classifiers/conversation-routing.js";
import { systemAiSettings } from "../system-ai-config.js";
import { systemDecisionKey } from "../system-ai.js";
import { assessTask, type TaskAssessmentInput } from "../task-assessment.js";
import { withFreshUsage, ingestUsageSessions } from "../usage-ingest.js";
import { usageDatabase } from "../usage-ledger.js";
import { listHarnessSessions, getHarnessRuntime } from "../harnesses.js";
import { listProjects } from "../store.js";
import { harnessUpdateStatus } from "../harness-updater.js";
import { prepareAllocation } from "../model-allocation-runtime.js";
import type { ModelIdentity } from "../model-evidence.js";
import type { QueuedPrompt } from "../prompt-queue.js";
import type { HarnessChatConnection } from "./harness-chat.js";
import type { ProjectRecord, HarnessId } from "../types.js";
import type { AllocationAttempt } from "../model-allocation-policy.js";

const activeAttempts = new Map<string, { ownerId: string; attempt: AllocationAttempt }>();
export function activeAllocationAttempt(projectId: string, conversationId: string) { return activeAttempts.get(`${projectId}:${conversationId}`); }
export function releaseAllocationAttempt(attempt: AllocationAttempt) { activeAttempts.delete(`${attempt.projectId}:${attempt.conversationId}`); }
async function allocationProjects(ownerId: string) { return runAsAccount(ownerAsActor(ownerId), async () => (await listProjects()).map(project => project.id)); }

let store: AllocationStore | undefined;
export function modelAllocationStore(): AllocationStore { return store ??= new AllocationStore(routingPolicyDatabase()); }

export async function prepareConversationAllocation(connection: HarnessChatConnection, queued: QueuedPrompt, ownerId: string, pinned: boolean, apply: (identity: ModelIdentity) => Promise<void>) {
  const store = modelAllocationStore();
  if (store.policy(ownerId).mode === "off") return null;
  const versions = harnessUpdateStatus();
  const scaffold = connection.engine === "pi" ? versions.pi.version : versions.harnesses.find(item => item.id === connection.engine)?.version ?? null;
  const runtime = await getHarnessRuntime(connection.engine);
  const projectIds = await allocationProjects(ownerId);
  if (!projectIds.includes(connection.project.id)) return null;
  const prepared = await prepareAllocation(store, { ownerId, projectId: connection.project.id, conversationId: connection.conversationId, attemptId: `${queued.id}:${queued.revision}`,
    projectIds, harness: connection.engine, scaffold, current: connection.shared.session.settings(), pinned,
    capabilities: queued.images.length ? ["vision"] : [], text: (queued.messageText ?? queued.promptText).slice(0, 12000) }, {
    assess: async input => {
      const recovery = queued.requestId ? store.recovery(ownerId, queued.requestId) : null;
      return recovery?.execution ? recovery.execution.assessment : assessAllocationTask(input);
    },
    available: async identity => { try { await runtime.validateSettings({ provider: identity.provider, modelId: identity.modelId, reasoning: identity.reasoning }); return true; } catch { return false; } },
    apply,
  });
  if (prepared) activeAttempts.set(`${connection.project.id}:${connection.conversationId}`, { ownerId, attempt: prepared.attempt });
  return prepared;
}

export async function assessAllocationTask(input: TaskAssessmentInput) {
  const classifier = systemAiSettings().decision.model;
  const configured = await decisionModelTarget(classifier, systemDecisionKey(classifier));
  if (!configured) throw new Error("Task assessment unavailable; configure the decision model");
  return assessTask(input, configured.target, configured.apiKey);
}

export async function assertAllocationRecovery(connection: HarnessChatConnection, queued: QueuedPrompt, ownerId: string, manual: boolean, claim = false): Promise<void> {
  if (!queued.requestId) return;
  const store = modelAllocationStore();
  const recovery = store.recovery(ownerId, queued.requestId);
  if (!recovery?.execution) return;
  const policy = store.policy(ownerId);
  const projectIds = await allocationProjects(ownerId);
  if (!projectIds.includes(connection.project.id)) throw new Error("Recovery project access was revoked");
  if (manual || policy.mode !== "automatic" || !policy.acceptedValidation || policy.recoveryAllowance <= 0 || !allocationValidation(policy, store.outcomes(ownerId, projectIds)).passed) throw new Error("Automatic recovery permission or validation was revoked; ask the user");
  if (recovery.execution.projectId !== connection.project.id || recovery.execution.conversationId !== connection.conversationId || recovery.harness !== connection.engine || recovery.checkpoint.worktreeId !== path.basename(connection.cwd)) throw new Error("Recovery scope or harness changed");
  if (claim) {
    const current = connection.shared.session.settings();
    const versions = harnessUpdateStatus();
    const scaffold = connection.engine === "pi" ? versions.pi.version : versions.harnesses.find(item => item.id === connection.engine)?.version;
    if (scaffold !== recovery.execution.identity.scaffold || current.provider !== recovery.execution.identity.provider || current.modelId !== recovery.execution.identity.modelId || current.reasoning !== recovery.execution.identity.reasoning) throw new Error("Recovery model or harness version changed");
    if (!store.claimRecovery(ownerId, queued.requestId, recovery.execution, path.basename(connection.cwd))) throw new Error("Recovery execution is already claimed; reconcile rather than replaying it");
  }
}

export async function nextAllocationRecovery(ownerId: string, attempt: AllocationAttempt, safe: { writerActive: boolean; pendingExternalOperation: boolean }) {
  const store = modelAllocationStore();
  const policy = store.policy(ownerId);
  if (policy.mode !== "automatic" || policy.recoveryAllowance <= 0) return null;
  const check = store.attemptCheck(ownerId, attempt.projectId, attempt.attemptId);
  if (check.status !== "failed" || !check.id) return null;
  const checkpoint = integrationCheckpoint(attempt.projectId, check.id, attempt.conversationId);
  if (!checkpoint) return null;
  const projectIds = await allocationProjects(ownerId);
  const rows = store.outcomes(ownerId, projectIds);
  if (!rows.some(row => row.projectId === attempt.projectId && row.attemptId === attempt.attemptId && row.outcome === "failed")) throw new Error("Recovery requires an attributed failed check; unknown outcomes are not reasoning failures");
  const decision = recommendModels({ assessment: attempt.assessment, baseline: attempt.identity, pinned: false, candidates: policy.candidates.filter(candidate => candidate.identity.harness === attempt.identity.harness && candidate.identity.scaffold === attempt.identity.scaffold), evidence: policy.evidence, outcomes: allocationTraining(rows), authorizedProjectIds: projectIds, now: new Date().toISOString() });
  const previous = decision.ranked.find(row => modelKey(row.identity) === modelKey(attempt.identity));
  if (!previous) throw new Error("Recovery needs comparable quality evidence for the current model; ask the user");
  const next = decision.ranked.find(row => row.lowerBound > previous.lowerBound);
  if (!next) throw new Error("No stronger qualified model in this harness; ask the user");
  const runtime = await getHarnessRuntime(attempt.identity.harness as HarnessId);
  await runtime.validateSettings({ provider: next.identity.provider, modelId: next.identity.modelId, reasoning: next.identity.reasoning });
  if (JSON.stringify(store.policy(ownerId)) !== JSON.stringify(policy)) return null;
  const operationId = createHash("sha256").update(`${ownerId}\0${attempt.projectId}\0${attempt.attemptId}\0recovery`).digest("hex");
  const reservation = store.reserve(ownerId, { harness: attempt.identity.harness, taskId: `${attempt.projectId}:${attempt.assessment.taskId}`, operationId, cost: next.expectedCost,
    nextQuality: next.lowerBound, previousQuality: previous.lowerBound, checkpoint, execution: { projectId: attempt.projectId, conversationId: attempt.conversationId, originAttemptId: attempt.attemptId, identity: next.identity, assessment: attempt.assessment } },
    { harness: attempt.identity.harness, attempts: 0, spent: 0, reserved: 0, allowance: policy.recoveryAllowance, ...safe, validated: policy.acceptedValidation && allocationValidation(policy, rows).passed, enabled: policy.mode === "automatic" });
  if (!reservation.dispatch) return null;
  return { operationId, identity: next.identity, message: `Continue the existing task in worktree ${checkpoint.worktreeId}. Verification ${check.id} failed on candidate ${checkpoint.candidateCommit} against main ${checkpoint.baseCommit}. Inspect the current files and fix the failure, preserving all unrelated work. Stay in this harness. Do not replay completed or uncertain external actions. If anything is uncertain, stop and ask. Run real checks and finish with the verified merge command using a new operation ID. This is bounded recovery attempt ${reservation.state.attempts} of 2.` };
}

/** Refresh only this already-local session, through the existing usage importer. Never fetch a peer transcript. */
export async function completeAllocationAttempt(ownerId: string, project: ProjectRecord, cwd: string, engine: HarnessId, sessionId: string, turnId: string, attempt: AllocationAttempt, failed: boolean, attributed: boolean): Promise<number | null> {
  await withFreshUsage(async () => {
    const sessions = await listHarnessSessions({ ...project, additionalPaths: [cwd] }, [], [`${engine}:${sessionId}`]);
    await ingestUsageSessions(project, sessions.map(session => ({ ...session, conversationId: attempt.conversationId })), []);
  });
  const totals = usageDatabase().prepare("SELECT COUNT(*) AS requests, COUNT(json_extract(payload,'$.apiCostUsd')) AS priced, SUM(json_extract(payload,'$.apiCostUsd')) AS cost FROM model_usage_events WHERE project_id=? AND conversation_id=? AND json_extract(payload,'$.turnId')=?")
    .get(project.id, attempt.conversationId, turnId) as { requests: number; priced: number; cost: number | null };
  const cost = totals.requests > 0 && totals.requests === totals.priced ? totals.cost : null;
  modelAllocationStore().finishAttempt(ownerId, project.id, attempt.attemptId, { cost, latencyMs: Date.now() - Date.parse(attempt.startedAt), failed, attributed });
  return cost;
}
