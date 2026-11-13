import { getClusterNode } from "../cluster.js";
import { getConversationRecord } from "../conversation-records.js";
import { getHarnessRuntime } from "../harnesses.js";
import type { HarnessPrompt } from "../harnesses/runtime.js";
import { runAsAccount } from "../account-context.js";
import { ownerAsActor, resourceOwner } from "../ownership.js";
import { resolvePoolModelSettings } from "../provider-profiles/pool-execution.js";
import { getProject } from "../store.js";
import { completeUpdateRecovery, failUpdateRecovery, listPendingUpdateRecoveries, type UpdateRecoveryRecord } from "../update-recovery.js";
import { announceRecoveryConnection, announceSharedConnection, drainHarnessPromptQueue, harnessChatConnections, promptOnSubscriptionPool, resolveRecoverySubscriptionPool } from "./harness-chat.js";
import { openHarnessSession, sendHarnessStatus, type SharedHarnessSession } from "./harness-sessions.js";
import { broadcastToProject } from "./realtime.js";
import { claimConversationLocally, requireLocalConversationOwner } from "./sessions-helpers.js";
import { flags, updateContinuationPrompt } from "./state.js";

async function recoverChat(record: UpdateRecoveryRecord): Promise<void> {
  const local = await getClusterNode();
  await claimConversationLocally(record.engine, record.sessionId, local.id);
  const conversation = await getConversationRecord(record.projectId, record.engine, record.sessionId);
  const conversationId = conversation?.conversationId ?? record.sessionId;
  const project = await getProject(record.projectId);
  if (!project) throw new Error("Recovery project not found");
  // Opening a saved Pi model already needs the turn's app subscription context, not just prompting it.
  // Legacy records without an account resume as the project's owner.
  const actor = ownerAsActor(record.accountId ?? resourceOwner("project", record.projectId));
  const shared = await runAsAccount(actor, () => openHarnessSession(record.engine, {
    projectId: record.projectId, cwd: record.cwd, sessionId: record.sessionId, sessionPath: record.sessionPath, conversationId,
  }));
  shared.turnInFlight += 1;
  shared.turnAccountId = actor?.accountId ?? null;
  broadcastToProject(record.projectId, { type: "sessionsChanged" });
  try {
    await runAsAccount(actor, () => resumeChat(record, shared, project.type!));
    await completeUpdateRecovery(record.id);
  } finally {
    shared.turnInFlight -= 1;
    if (!shared.turnInFlight) { shared.turnConnection = null; shared.turnAccountId = null; }
    sendHarnessStatus(shared);
    broadcastToProject(record.projectId, { type: "sessionsChanged" });
    const connection = [...harnessChatConnections].find((candidate) => candidate.shared === shared);
    if (connection) void drainHarnessPromptQueue(connection).catch((error) => console.warn("Post-recovery queue failed", error));
  }
}

async function resumeChat(record: UpdateRecoveryRecord, shared: SharedHarnessSession, workspaceId: string): Promise<void> {
  const legacySettings = !record.settings && (record.model !== null || record.effort !== null)
    ? { ...shared.session.settings(), ...(record.model !== null ? { modelId: record.model } : {}), ...(record.effort !== null ? { reasoning: record.effort } : {}) }
    : undefined;
  const settings = record.settings ?? legacySettings;
  if (settings) {
    const runtime = await getHarnessRuntime(record.engine);
    await runtime.validateSettings(settings);
    await shared.session.configure(settings);
  }
  const pool = await resolveRecoverySubscriptionPool(shared, workspaceId);
  if (!pool) {
    await shared.session.preflight();
    await announceRecoveryConnection(shared);
  }
  const initial = shared.session.settings();
  for (const prompt of [updateContinuationPrompt, ...record.queuedPrompts]) {
    const input: HarnessPrompt = { text: prompt, beforeStart: async () => {
      if (flags.updatePreparing) throw new Error("An update is being prepared");
      await requireLocalConversationOwner(shared.engine, record.sessionId);
      if (flags.updatePreparing) throw new Error("An update is being prepared");
    } };
    if (!pool) await shared.session.prompt(input);
    else await promptOnSubscriptionPool(shared.session, pool, initial,
      (candidate) => resolvePoolModelSettings(shared.engine, candidate.provider, initial, undefined, pool.fallbackModels[candidate.provider]), input,
      (candidate) => announceSharedConnection(shared, { pool: { name: pool.name }, profile: { label: candidate.label } }));
  }
}

/** Resumes the conversation turns an update interrupted. A "task" row comes from the removed project board and is only failed. */
export async function recoverPendingUpdateRuns(): Promise<void> {
  await Promise.all((await listPendingUpdateRecoveries()).map(async (record) => {
    try {
      if (record.kind !== "chat") throw new Error("Board tasks were removed");
      await recoverChat(record);
    } catch (error) {
      console.warn("Update recovery failed", error);
      await failUpdateRecovery(record.id, error instanceof Error ? error.message : "Update recovery failed");
    }
  }));
}
