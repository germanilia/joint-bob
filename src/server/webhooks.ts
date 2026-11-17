// Delivers a webhook call: a new conversation in the target project, or one more message in
// the target conversation. Runs through this node's own chat socket, like a scheduled task.
import { randomUUID } from "node:crypto";
import { automationProfileContext, runWithAutomationProfile } from "./automation-profile.js";
import { createAutomationExecution, transitionAutomationExecution } from "../automation-executions.js";
import { automationWorkspaceIdentity, automationWorkspaceKey, snapshotAutomationTags } from "../automation-tags.js";
import path from "node:path";
import { getClusterNode } from "../cluster.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { getConversationOwnership } from "../conversation-ownership.js";
import { ensureConversationRecord, setWebhookConversationHistory } from "../conversation-records.js";
import { listDiscoveredHarnesses } from "../harnesses/registry.js";
import { backgroundAgent } from "../background-agent.js";
import { ensureSessionTitle } from "../names.js";
import { bindWebhookTitle, automationTitleInstruction } from "../webhook-title.js";
import { getProjectLock } from "../project-locks.js";
import { getProject } from "../store.js";
import { recordTurnFailure } from "../turn-failures.js";
import { isHarnessId } from "../types.js";
import {
  MAX_PAYLOAD_CHARS, PAYLOAD_FILE_NAME, disableAutomation, getWebhook, recordWebhookDelivery, WebhookError, webhookMessage, type Webhook, type WebhookAttachment, type WebhookCall,
} from "../webhooks.js";
import { persistTaskAttachments } from "./chat.js";
import { markSilentWebhookRequest } from "./scheduled-review.js";
import { bindWebhookConversation } from "../webhook-agent.js";
import { attachAutomationSecrets, automationResourceContext } from "./automation-context.js";
import { createWebhookWorkspace, setWebhookConversationWorkspace } from "../webhook-workspaces.js";
import { queueConversationPrompt, type PromptAttachment, type PromptQueueSettings } from "./conversation-prompt.js";
import { broadcastToProject } from "./realtime.js";
import { runPersonalAssistantAutomationTurn } from "./routes/personal-assistants.js";
import { telegramChatId, telegramText } from "../webhook-telegram.js";
import { announceWebhookCall } from "../control-center/triggers-observe.js";
import type { ProjectWorktree } from "../project-worktrees.js";
import { automationWorktreeInstruction, withAutomationWorktree } from "./automation-worktree.js";

/** What one chat-socket prompt may carry, as for a browser message (src/server/schemas.ts). */
const SOCKET_IMAGES = 4;
const SOCKET_FILES = 6;
const SOCKET_ATTACHMENT_BYTES = 4 * 1024 * 1024;

/** The harness a new conversation uses when the webhook names none: the first one this node can run. */
/** A webhook that names no agent runs on the background agent: one that is signed in here, not Pi by assumption. */
export function defaultAutomationEngine(): string {
  if (!listDiscoveredHarnesses().some((candidate) => candidate.runtime)) throw new WebhookError(503, "No harness is available on this machine");
  return backgroundAgent().harnessId;
}

/**
 * Splits a call's files between the prompt and the disk. Images and files that fit a chat
 * message travel with it, so the agent sees images as images and the transcript shows them.
 * The rest are saved to the project's attachments folder and listed by path in the message.
 */
async function placeAttachments(cwd: string, attachments: WebhookAttachment[]) {
  const images: PromptAttachment[] = [];
  const files: PromptAttachment[] = [];
  const spill: { images: PromptAttachment[]; files: PromptAttachment[] } = { images: [], files: [] };
  for (const attachment of attachments) {
    const encoded = { name: attachment.name, mimeType: attachment.mimeType, data: attachment.data.toString("base64") };
    const image = attachment.mimeType.startsWith("image/");
    const fits = attachment.data.byteLength > 0 && attachment.data.byteLength <= SOCKET_ATTACHMENT_BYTES;
    if (image && fits && images.length < SOCKET_IMAGES) images.push(encoded);
    else if (!image && fits && files.length < SOCKET_FILES) files.push(encoded);
    else (image ? spill.images : spill.files).push(encoded);
  }
  const saved = await persistTaskAttachments(cwd, spill.images, spill.files);
  const listed = saved.length
    ? `More files from this call, saved in the project:\n${saved.map((file) => `- ${file.name}: ${path.resolve(cwd, file.path)}`).join("\n")}\nOpen them from these paths when needed.`
    : "";
  return { images, files, listed };
}

/** Each chat or sender keeps its own conversations. The decision model reads their words, not this webhook's instructions. */
function assistantRouting(webhook: Webhook, call: WebhookCall): { scope: string | null; message: string } {
  if (call.telegram) return call.telegram.routing;
  const caller = telegramChatId(call.data) ?? call.sender?.value ?? "";
  const words = telegramText(call.data) ?? call.body.trim();
  return { scope: `webhook:${webhook.id}:${caller}`, message: (words || "(no text; the call carried only files)").slice(0, 8000) };
}

/** Checks the target and queues the message. Throws when the target cannot take it. */
async function deliver(webhook: Webhook, call: WebhookCall): Promise<string> {
  return runWithAutomationProfile(webhook, () => withAutomationWorktree({ ...webhook, projectId: webhook.target.projectId }, call.requestId!, worktree => deliverWithProfile(webhook, call, worktree)));
}

async function deliverWithProfile(webhook: Webhook, call: WebhookCall, worktree?: ProjectWorktree): Promise<string> {
  if ((worktree || !webhook.preserveFiles) && webhook.target.kind === "conversation") {
    return deliverWithProfile({ ...webhook, target: { kind: "project", projectId: webhook.target.projectId, engine: webhook.target.engine } }, call, worktree);
  }
  const local = await getClusterNode();
  const project = await getProject(webhook.target.projectId);
  if (!project) throw new WebhookError(404, "The webhook's project no longer exists");
  const lock = await getProjectLock(project.id);
  if (lock && lock.nodeId !== local.id) throw new WebhookError(409, `Project is locked by ${lock.nodeName}`);
  const db = await clusterV2Database();
  const resourceContext = await automationResourceContext(webhook.id, call.resourceSnapshot);
  const attachments = [...(call.attachments ?? [])];
  if (call.body.trim().length > MAX_PAYLOAD_CHARS) attachments.push({ name: PAYLOAD_FILE_NAME, mimeType: "text/plain", data: Buffer.from(call.body) });
  // Without isolation, assistant turns keep using the assistant's project.
  const workspacePath = worktree?.path ?? (webhook.target.kind === "assistant" || webhook.target.kind === "conversation" && webhook.preserveFiles ? project.path : await createWebhookWorkspace(webhook.id, webhook.preserveFiles));
  const placed = await placeAttachments(workspacePath, attachments);
  const titleTemplate = webhook.target.kind === "project" ? webhook.titleTemplate || webhook.name : "";
  const titleInstruction = automationTitleInstruction(titleTemplate);
  const message = [worktree ? automationWorktreeInstruction : "", ...(call.telegram ? [call.telegram.message, placed.listed] : [titleInstruction, webhookMessage(webhook, call), resourceContext, placed.listed])].filter(Boolean).join("\n\n");
  if (webhook.target.kind === "assistant") {
    if (!webhook.creatorAccountId) throw new WebhookError(409, "Assistant webhook has no creator account");
    const assistantId = webhook.target.assistantId;
    let activeSessionId: string | null = null;
    const turn = await runPersonalAssistantAutomationTurn(webhook.creatorAccountId, assistantId, call.requestId!, message, {
      bypassGuardian: webhook.bypassGuardian,
      worktreeId: worktree?.id, scheduledAutoRespond: webhook.autoRespond ?? undefined,
      label: "Webhook", origin: call.telegram && call.telegram.routing.scope === null ? "chat" : "webhook", automationProfile: automationProfileContext(webhook), images: placed.images, files: placed.files, routing: assistantRouting(webhook, call),
      prepare: async destination => {
        await attachAutomationSecrets(webhook, webhook.target.projectId, destination.engine, destination.sessionId);
        bindWebhookConversation(db, webhook.id, project.id, destination.sessionId, local.id, destination.isNew);
        if (destination.isNew) setWebhookConversationHistory(db, project.id, destination.sessionId, webhook.id, webhook.hideFromHistory, local.id);
      },
      onStarted: destination => {
        activeSessionId = destination.sessionId;
        call.started = true;
        const files = call.attachments?.length ? ` with ${call.attachments.length} file${call.attachments.length === 1 ? "" : "s"}` : "";
        void clusterV2Database().then(db => {
          transitionAutomationExecution(db, call.requestId!, "running", null, destination.sessionId, destination.engine);
          recordWebhookDelivery(db, webhook.id, "delivered", `Routed through assistant ${assistantId}${files}`);
        });
      },
    }).catch(async (error: unknown) => {
      await call.telegram?.failed();
      throw error;
    });
    const [engine, ...sessionParts] = turn.topicId.split(":");
    activeSessionId = sessionParts.join(":");
    if (!engine || !activeSessionId) throw new WebhookError(500, "Assistant webhook turn has no conversation target");
    await call.telegram?.answer(turn.response ?? "");
    return activeSessionId;
  }
  const engine = webhook.target.engine ?? defaultAutomationEngine();
  let activeSessionId = webhook.target.kind === "conversation" ? webhook.target.sessionId : null;
  const prompt = {
    bypassGuardian: webhook.bypassGuardian,
    automationProfile: automationProfileContext(webhook), worktreeId: worktree?.id, scheduledAutoRespond: webhook.autoRespond ?? undefined,
    message, images: placed.images, files: placed.files, requestId: call.requestId!, label: "Webhook", until: "completed" as const,
    onStarted: () => {
      call.started = true;
      const files = call.attachments?.length ? ` with ${call.attachments.length} file${call.attachments.length === 1 ? "" : "s"}` : "";
      const detail = webhook.target.kind === "project" ? `Started conversation ${activeSessionId}${files}` : `Added to the conversation${files}`;
      void clusterV2Database().then(db => {
        transitionAutomationExecution(db, call.requestId!, "running", null, activeSessionId);
        recordWebhookDelivery(db, webhook.id, "delivered", detail);
      });
    },
    // Apply settings when this turn starts, not while an existing conversation is busy.
    queueSettings: (status: { model: { provider: string; id: string }; thinkingLevel: string }): PromptQueueSettings | undefined => webhook.model || webhook.reasoning ? {
      harnessId: engine,
      provider: webhook.model?.provider ?? status.model.provider,
      modelId: webhook.model?.modelId ?? status.model.id,
      reasoning: webhook.reasoning ?? status.thinkingLevel,
    } : undefined,
  };
  if (!webhook.markForReview) markSilentWebhookRequest(prompt.requestId);
  if (webhook.target.kind === "conversation") {
    const { sessionId, engine } = webhook.target;
    if (!isHarnessId(engine)) throw new WebhookError(409, "The conversation's agent is not available");
    const ownership = await getConversationOwnership(engine, sessionId);
    if (ownership && ownership.ownerNodeId !== local.id) throw new WebhookError(409, "The conversation lives on another machine; create the webhook there");
    bindWebhookConversation(db, webhook.id, project.id, sessionId, local.id);
    await attachAutomationSecrets(webhook, webhook.target.projectId, engine, sessionId);
    await queueConversationPrompt({ projectId: project.id, engine, sessionId, ...prompt });
    return sessionId;
  }
  if (!isHarnessId(engine) || !listDiscoveredHarnesses().some((adapter) => adapter.id === engine && adapter.runtime)) throw new WebhookError(409, "The webhook's agent is not available on this machine");
  const sessionId = randomUUID();
  activeSessionId = sessionId;
  await ensureConversationRecord(project.id, engine, sessionId, local.id);
  if (!worktree) setWebhookConversationWorkspace(db, project.id, engine, sessionId, webhook.id, workspacePath);
  const current = getWebhook(db, webhook.id);
  if (!current) throw new WebhookError(404, "Webhook was deleted before this conversation started");
  bindWebhookConversation(db, webhook.id, project.id, sessionId, local.id, true);
  setWebhookConversationHistory(db, project.id, sessionId, webhook.id, current.hideFromHistory, local.id);
  if (titleInstruction) bindWebhookTitle(project.id, sessionId, titleTemplate);
  await ensureSessionTitle(sessionId, titleTemplate || webhook.name);
  broadcastToProject(project.id, { type: "sessionsChanged" });
  try {
    await attachAutomationSecrets(webhook, webhook.target.projectId, engine, sessionId);
    await queueConversationPrompt({ projectId: project.id, engine, sessionId, ...prompt });
  } catch (error) {
    // The conversation is already listed. It says why it is empty, instead of opening blank.
    recordTurnFailure(engine, sessionId, `Webhook "${webhook.name}" could not start this conversation: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  return sessionId;
}

const pendingWebhookDeliveries = new Map<string, number>();
export const webhookDeliveryPending = (id: string): boolean => pendingWebhookDeliveries.has(id);

/** Accepts a call for delivery; the outcome lands in the webhook's call history. */
export function acceptWebhookCall(webhook: Webhook, call: WebhookCall): void {
  const requestId = randomUUID();
  call = { ...call, requestId };
  // Announced with its request, so the control center can follow the run it starts.
  announceWebhookCall(webhook, call);
  pendingWebhookDeliveries.set(webhook.id, (pendingWebhookDeliveries.get(webhook.id) ?? 0) + 1);
  void (async () => {
    const db = await clusterV2Database();
    const project = await getProject(webhook.target.projectId);
    const local = await getClusterNode();
    const workspace = project ? automationWorkspaceIdentity(db, local.id, project.type ?? "personal") : null;
    const tags = workspace ? snapshotAutomationTags(db, workspace.workspaceId, webhook.tags, workspace.ownerNodeId) : [];
    const targetEngine = webhook.target.kind === "assistant" ? null : webhook.target.engine ?? null;
    createAutomationExecution(db, { id: requestId, sourceKind: "webhook", sourceId: webhook.id, sourceName: webhook.name, workspaceId: workspace ? automationWorkspaceKey(workspace) : null, projectId: webhook.target.projectId, ownerNodeId: local.id, engine: targetEngine, requestId, sessionId: webhook.target.kind === "conversation" ? webhook.target.sessionId : null, tags, status: "queued", error: null, acceptedAt: new Date().toISOString(), startedAt: null, finishedAt: null });
    try {
      const sessionId = await deliver(webhook, call);
      transitionAutomationExecution(db, requestId, "succeeded", null, sessionId);
      const files = call.attachments?.length ? ` with ${call.attachments.length} file${call.attachments.length === 1 ? "" : "s"}` : "";
      if (!call.started) recordWebhookDelivery(await clusterV2Database(), webhook.id, "delivered", webhook.target.kind === "project" ? `Started conversation ${sessionId}${files}` : `Added to the conversation${files}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`Webhook ${webhook.id} delivery failed: ${detail}`);
      try {
        const database = await clusterV2Database();
        transitionAutomationExecution(database, call.requestId!, "failed", detail);
        if (!call.started) recordWebhookDelivery(database, webhook.id, "failed", detail);
        // A used-up budget is not the automation's fault, so it stays on.
        if (webhook.pauseOnFailure && !/Budget reached:/.test(detail)) disableAutomation(database, webhook.id);
      } catch { /* history is best effort */ }
    }
  })().catch(error => console.error(`Webhook ${webhook.id} execution setup failed`, error)).finally(() => {
    const remaining = pendingWebhookDeliveries.get(webhook.id)! - 1;
    if (remaining) pendingWebhookDeliveries.set(webhook.id, remaining);
    else pendingWebhookDeliveries.delete(webhook.id);
  });
}
