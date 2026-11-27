import { randomUUID } from "node:crypto";
import { getAutoRespond } from "../conversation-auto-respond.js";
import { observeAutoResponder } from "./auto-respond-recovery.js";
import { automationProfileContext, runWithAutomationProfile } from "./automation-profile.js";
import { setTimeout as delay } from "node:timers/promises";
import { getClusterNode } from "../cluster.js";
import { getRuntimePeer } from "./runtime-peers.js";
import { signedAutomationFetch } from "./automation-peers.js";
import { queueConversationPrompt } from "./conversation-prompt.js";
import { getConversationOwnership } from "../conversation-ownership.js";
import { scheduledPromptText } from "../scheduled-prompt.js";
import { ensureConversationRecord, getConversationRecord, markCronConversation } from "../conversation-records.js";
import { cronStore, type CronTask, type CronRun } from "../cron.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { automationWorkspaceIdentity, automationWorkspaceKey, snapshotAutomationTags } from "../automation-tags.js";
import { transitionAutomationExecution } from "../automation-executions.js";
import { ensureSessionTitle } from "../names.js";
import { automationTitleInstruction, bindWebhookTitle } from "../webhook-title.js";
import { getProjectLock } from "../project-locks.js";
import { cancelQueuedPrompt, listQueuedPrompts } from "../prompt-queue.js";
import { getProject } from "../store.js";
import { takeLocalSessionOwnership } from "./routes/sessions.js";
import { listProjectSessionsWithReviewState } from "./sessions-helpers.js";
import { flags } from "./state.js";
import { recordTurnFailure } from "../turn-failures.js";
import { runPersonalAssistantAutomationTurn } from "./routes/personal-assistants.js";
import { automationCleanupInstruction, automationWorktreeInstruction, withAutomationWorktree } from "./automation-worktree.js";
import { attachAutomationSecrets, automationResourceContext, bindAutomationConversation } from "./automation-context.js";

export async function cronConversationReady(projectId: string, sessionId: string, engine: string): Promise<boolean> {
  const project = await getProject(projectId);
  if (!project) throw new Error("Scheduled project not found");
  const session = (await listProjectSessionsWithReviewState(project, "", "")).find(candidate => candidate.id === sessionId);
  if (!session) throw new Error("Scheduled conversation not found");
  if (session.harnessId !== engine) throw new Error("Conversation agent changed; update the scheduled task");
  if (session.readOnly) throw new Error("Scheduled conversation is read-only");
  return !session.running;
}

async function prepareConversation(task: CronTask): Promise<string> {
  const local = await getClusterNode();
  const project = await getProject(task.projectId);
  if (!project) throw new Error("Scheduled project not found");
  const lock = await getProjectLock(task.projectId);
  if (lock && lock.nodeId !== local.id) throw new Error(`Project is locked by ${lock.nodeName}`);
  if (!task.sessionId) {
    const id = randomUUID();
    await ensureConversationRecord(project.id, task.engine, id, local.id);
    return id;
  }
  for (;;) {
    const ownership = await getConversationOwnership(task.engine, task.sessionId);
    let ready = await cronConversationReady(project.id, task.sessionId, task.engine);
    if (ownership && ownership.ownerNodeId !== local.id) {
      const peer = await getRuntimePeer(ownership.ownerNodeId);
      if (!peer) throw new Error("Conversation owner is unavailable");
      const body = await signedAutomationFetch(peer, { action: "ready", projectId: project.id, sessionId: task.sessionId, engine: task.engine }, 5000) as { ready: boolean };
      ready = ready && body.ready;
    }
    if (ready) break;
    await delay(1000);
  }
  await takeLocalSessionOwnership(project, { projectId: project.id, sessionId: task.sessionId, sessionPath: `draft:${task.engine}:${task.sessionId}`, peerId: local.id });
  return task.sessionId;
}

export async function queuedCronPrompt(task: CronTask, run: CronRun, sessionId: string, worktreeId?: string): Promise<void> {
  const reasoning = task.reasoning ?? task.model?.reasoning;
  let titleInstruction = "";
  if (!task.sessionId) {
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: task.schedule.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(run.dueAt);
    const titleTemplate = (task.titleTemplate || task.name).replaceAll("[date]", date);
    await ensureSessionTitle(sessionId, titleTemplate);
    titleInstruction = automationTitleInstruction(titleTemplate);
    if (titleInstruction) bindWebhookTitle(task.projectId, sessionId, titleTemplate);
  }
  const resourceContext = await automationResourceContext(task.id);
  await queueConversationPrompt({
    bypassGuardian: task.bypassGuardian,
    automationProfile: automationProfileContext(task),
    scheduledAutoRespond: task.autoRespond ?? undefined,
    projectId: task.projectId, engine: task.engine, sessionId, worktreeId, message: [scheduledPromptText(task.prompt), resourceContext, worktreeId ? automationWorktreeInstruction : "", task.cleanupAfterRun ? automationCleanupInstruction : "", titleInstruction].filter(Boolean).join("\n\n"), requestId: run.id, label: "Scheduled", until: "completed",
    // Model and reasoning ride along with the queued prompt instead of
    // configuring the live session here: unrelated scheduled tasks share a
    // conversation, and configuring one mid-turn throws "session is busy".
    // The queue applies these when this prompt's own turn starts.
    queueSettings: (status) => task.model || reasoning ? {
      harnessId: task.engine,
      provider: task.model?.provider ?? status.model.provider,
      modelId: task.model?.modelId ?? status.model.id,
      reasoning: reasoning ?? status.thinkingLevel,
    } : undefined,
    onStarted: () => { cronStore().started(run.id, sessionId); void clusterV2Database().then(db => transitionAutomationExecution(db, run.id, "running", null, sessionId)); },
  });
}

export async function executeCronRun(task: CronTask, run: CronRun): Promise<void> {
  let destination = task.sessionId ? { sessionId: task.sessionId, engine: task.engine } : undefined;
  try {
    await runWithAutomationProfile(task, () => withAutomationWorktree(task, run.id, async worktree => {
      // Isolation never moves or reuses a pinned conversation in the shared project.
      if (worktree) {
        task = { ...task, sessionId: null };
        destination = undefined;
      }
      if (task.assistantId) {
        if (!task.creatorAccountId) throw new Error("Assistant scheduled task has no creator account");
        const resourceContext = await automationResourceContext(task.id);
        const turn = await runPersonalAssistantAutomationTurn(task.creatorAccountId, task.assistantId, run.id, [scheduledPromptText(task.prompt), resourceContext, worktree ? automationWorktreeInstruction : "", task.cleanupAfterRun ? automationCleanupInstruction : ""].filter(Boolean).join("\n\n"), {
          bypassGuardian: task.bypassGuardian,
          worktreeId: worktree?.id, label: "Scheduled", origin: "scheduled", automationProfile: automationProfileContext(task), scheduledAutoRespond: task.autoRespond ?? undefined,
          prepare: async target => {
            destination = target;
            cronStore().target(run.id, target.sessionId, target.engine);
            if (target.isNew) await markCronConversation(task.projectId, target.engine, target.sessionId, task.id, task.ownerNodeId);
            await attachAutomationSecrets(task, task.projectId, target.engine, target.sessionId);
            await bindAutomationConversation(task.id, task.projectId, target.sessionId, target.isNew);
          },
          onStarted: destination => {
            cronStore().started(run.id, destination.sessionId);
            void clusterV2Database().then(db => transitionAutomationExecution(db, run.id, "running", null, destination.sessionId, destination.engine));
          },
        });
        const [engine, ...sessionParts] = turn.topicId.split(":");
        const sessionId = sessionParts.join(":");
        if (!engine || !sessionId) throw new Error("Assistant scheduled turn has no conversation target");
        cronStore().target(run.id, sessionId, engine);
        return;
      }
      const sessionId = await prepareConversation(task);
      destination = { sessionId, engine: task.engine };
      await ensureConversationRecord(task.projectId, task.engine, sessionId, task.ownerNodeId);
      await markCronConversation(task.projectId, task.engine, sessionId, task.id, task.ownerNodeId);
      cronStore().target(run.id, sessionId, task.engine);
      await attachAutomationSecrets(task, task.projectId, task.engine, sessionId);
      await bindAutomationConversation(task.id, task.projectId, sessionId, !task.sessionId);
      await queuedCronPrompt(task, run, sessionId, worktree?.id);
    }));
    transitionAutomationExecution(await clusterV2Database(), run.id, "succeeded");
    cronStore().finish(run.id, "succeeded", null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (destination) recordTurnFailure(destination.engine, destination.sessionId, message);
    // A used-up budget is not the task's fault: the run is recorded, the task stays enabled.
    if (error instanceof Error && /Budget reached:/.test(error.message)) { transitionAutomationExecution(await clusterV2Database(), run.id, "failed", error.message); cronStore().finish(run.id, "failed", error.message); return; }
    if (task.pauseOnFailure) {
      const { id, nextRun, lastRun, ...input } = cronStore().get(task.id)!;
      cronStore().update(id, { ...input, enabled: false });
    }
    transitionAutomationExecution(await clusterV2Database(), run.id, "failed", message);
    cronStore().finish(run.id, "failed", message);
  }
}

export async function dispatchCronTasks(now = Date.now()): Promise<void> {
  if (!flags.startupReady || flags.updatePreparing) return;
  const local = await getClusterNode();
  for (const task of cronStore().list()) {
    // claim() takes the write lock; skip tasks that are not due so a busy database is only waited on when a run is due.
    if (task.ownerNodeId !== local.id || !task.enabled || task.nextRun > now) continue;
    const project = await getProject(task.projectId);
    const tagDatabase = await clusterV2Database();
    const workspace = automationWorkspaceIdentity(tagDatabase, local.id, project?.type ?? "personal");
    const tags = snapshotAutomationTags(tagDatabase, workspace.workspaceId, task.tags, workspace.ownerNodeId);
    const run = cronStore().claim(task.id, local.id, now, tags, automationWorkspaceKey(workspace));
    if (run) void executeCronRun(task, run).catch(error => console.error("Scheduled run persistence failed", error));
  }
}
export async function startCronScheduler(): Promise<void> {
  const continuing = new Set<string>();
  for (const task of cronStore().list()) {
    if (!cronStore().active(task.id) || !task.lastRun?.sessionId) continue;
    const record = await getConversationRecord(task.projectId, task.engine, task.lastRun.sessionId);
    const conversationId = record?.conversationId ?? task.lastRun.sessionId;
    const responder = await getAutoRespond(task.projectId, conversationId);
    if (task.autoRespond && responder?.sourceRequestId === task.lastRun.id) {
      continuing.add(task.id);
      const runId = task.lastRun.id;
      void observeAutoResponder(responder).then(async () => {
        cronStore().finish(runId, "succeeded", null);
        transitionAutomationExecution(await clusterV2Database(), runId, "succeeded", null, task.lastRun!.sessionId!);
      }).catch(error => console.error("Scheduled auto reply recovery failed", error));
      continue;
    }
    const key = `${task.projectId}:${conversationId}`;
    for (const prompt of listQueuedPrompts(key)) if (prompt.requestId === task.lastRun.id) cancelQueuedPrompt(key, prompt.id);
  }
  cronStore().recover(Date.now(), continuing);
  setInterval(() => { void dispatchCronTasks().catch(error => console.error("Scheduled dispatch failed", error)); }, 1000).unref();
}
