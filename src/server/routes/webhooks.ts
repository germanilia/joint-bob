// Inbound webhooks (src/webhooks.ts). `POST /hooks/<secret>` is the public entry: it needs no
// sign-in, because the secret in the URL is the credential. Relayed calls arrive on a channel
// marked webhook-only, which can reach nothing else on this machine. The Automations tab
// manages them through `/api/automations` (routes/automations.ts).
import type { IncomingMessage, ServerResponse } from "node:http";
import { lstat, readFile } from "node:fs/promises";
import type { Duplex } from "node:stream";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { actingAccount } from "../../account-context.js";
import { listSubscriptionPools, poolCandidates, getSubscriptionPool } from "../../provider-profiles/pools.js";
import { assertAutomationCreator, validateAutomationAssignment } from "../automation-profile.js";
import { accessibleProviderProfile, listAccessibleProviderProfiles } from "../../provider-profiles/store.js";
import { getClusterNode } from "../../cluster.js";
import { signClusterRequest } from "../../cluster-protocol.js";
import { isTrustedTwin } from "../../cluster-sharing-policy.js";
import { getConversationOwnership } from "../../conversation-ownership.js";
import { latestConversationSegment } from "../../conversation-records.js";
import type { AgentCapabilityIdentity } from "../../agent-capabilities.js";
import { fillWebhookTitle, titlePlaceholders, webhookConversationTitle } from "../../webhook-title.js";
import { setSessionTitle } from "../../names.js";
import { broadcastToProject } from "../realtime.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { automationWorkspaceIdentity, validateAutomationTagAssignments } from "../../automation-tags.js";
import { relayRuntimeInstance, relayServerInstance } from "../../relay/index.js";
import { phoneAddress } from "../../relay/protocol.js";
import { relayMachine } from "../../relay/store.js";
import { isWebhookOnlyChannel } from "../../relay/stream.js";
import { peerFetch } from "../../relay/transport.js";
import { getProject, listProjects } from "../../store.js";
import { listHarnesses, listHarnessModels } from "../../harnesses.js";
import { getScopeSecretAccounts, listSecretAccounts, validateProjectSecretAccounts } from "../../secrets.js";
import { sharedProjectIds } from "../sharing-files.js";
import { peerMayRunHere } from "../cluster-helpers.js";
import { listRuntimePeers } from "../runtime-peers.js";
import {
  createWebhook, deleteWebhook, getWebhook, listWebhooks, readWebhookPayload, recordWebhookDelivery, regenerateWebhookSecret, updateWebhook,
  TELEGRAM_SENDER_FIELDS, WEBHOOK_MAX_BODY_BYTES, webhookDeliveries, webhookForSecret, webhookInputSchema, WebhookError, webhookSender, type WebhookInput,
} from "../../webhooks.js";
import { Feature, isClusterOriginUrl, requireFeature, sendError } from "../http-auth.js";
import { listProjectSessionsWithReviewState } from "../sessions-helpers.js";
import { app, flags, requestInterceptors, upgradeHandlers } from "../state.js";
import { acceptWebhookCall, webhookDeliveryPending } from "../webhooks.js";
import { exportWebhookTransfer, installWebhookTransfer, removeTransferredWebhook, webhookTransferSchema } from "../../webhook-transfer.js";
import { ensureAutomationExecutionSchema } from "../../automation-executions.js";
import { updateWebhookHistory } from "../webhook-history.js";
import { getPersonalAssistant } from "../../personal-assistants.js";
import { handleTelegramCallHeader, handleTelegramUpdate } from "../telegram.js";
import { snapshotWebhookResources, listWebhookResources, saveWebhookResource, removeWebhookResource, revertWebhookResource, WebhookResourceError } from "../../webhook-resources.js";
import { ensureWebhookAgentSchema, runWebhookMemoryAgentCommand, type WebhookMemoryAgentIdentity } from "../../webhook-agent.js";
import { readWebhookMemory, writeWebhookMemory, setWebhookMemoryEnabled } from "../../webhook-memory.js";
import { webhookMemoryEnabled } from "../../webhook-resources.js";
import { listWebhookSkills, listSelectableWebhookSkills, uploadWebhookSkill, importExistingWebhookSkill, discoverWebhookGitSkills, importWebhookGitSkill, removeWebhookSkill } from "../../webhook-skills.js";

const HOOK_PATH = /^\/hooks\/([A-Za-z0-9_-]{20,128})$/;

function reply(response: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Connection: "close", ...headers }).end(text);
}

/** Reads the body, giving up past the cap. Resolves undefined when the sender sent too much. */
function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > WEBHOOK_MAX_BODY_BYTES) { chunks.length = 0; request.removeAllListeners("data"); request.resume(); resolve(undefined); return; }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function flatHeaders(request: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) if (typeof value === "string") out[name] = value;
  return out;
}

async function handleHook(request: IncomingMessage, response: ServerResponse, secret: string): Promise<void> {
  if (request.method !== "POST") { request.resume(); reply(response, 405, "Webhooks accept POST only", { Allow: "POST" }); return; }
  if (!flags.startupReady) { request.resume(); reply(response, 503, "Starting up; try again shortly", { "Retry-After": "10" }); return; }
  const database = await clusterV2Database();
  const webhook = webhookForSecret(database, secret);
  if (!webhook) { request.resume(); reply(response, 404, "Not found"); return; }
  if (!webhook.enabled) { request.resume(); reply(response, 403, "This webhook is turned off"); return; }
  // A connected bot's calls must prove they come from Telegram before anything is read.
  if (webhook.reply === "telegram" && !handleTelegramCallHeader(database, webhook.id, request.headers["x-telegram-bot-api-secret-token"])) {
    request.resume();
    recordWebhookDelivery(database, webhook.id, "refused", "Refused: the call didn't prove it came from Telegram");
    reply(response, 401, "Unauthorized");
    return;
  }
  const body = await readBody(request);
  if (body === undefined) { reply(response, 413, "Payload too large"); return; }
  let payload: Awaited<ReturnType<typeof readWebhookPayload>>;
  try { payload = await readWebhookPayload(String(request.headers["content-type"] ?? ""), body, webhook.attachments); }
  catch (error) { reply(response, error instanceof WebhookError ? error.statusCode : 400, error instanceof Error ? error.message : "The body could not be read"); return; }
  if (!getWebhook(database, webhook.id)?.enabled) { reply(response, 409, "Webhook changed while reading the call; try its current address"); return; }
  if (webhook.reply === "telegram") {
    // Answered at once, so Telegram doesn't retry while the assistant works.
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", Connection: "close" }).end("{}");
    void handleTelegramUpdate(webhook, payload.data).catch((error: unknown) => console.warn("Telegram update failed", error instanceof Error ? error.message : error));
    return;
  }
  // A sender off the list never reaches the conversation. The answer is still 2xx, so a sender
  // such as Telegram does not retry the call and hold up the ones behind it.
  const sender = webhookSender(webhook.senders, payload.data);
  if (!sender.allowed) {
    recordWebhookDelivery(await clusterV2Database(), webhook.id, "refused", sender.value ? `Refused sender ${sender.value}: not on the list` : "Refused: the call names no sender", sender.value);
    response.writeHead(202, { "Content-Type": "application/json", "Cache-Control": "no-store", Connection: "close" }).end('{"accepted":false}');
    return;
  }
  const query = (request.url ?? "").split("?", 2)[1] ?? "";
  const local = await getClusterNode();
  if (!getWebhook(database, webhook.id)?.enabled) { reply(response, 409, "Webhook changed while reading the call; try its current address"); return; }
  acceptWebhookCall(webhook, {
    method: request.method ?? "POST", headers: flatHeaders(request), query: query.slice(0, 1000), body: payload.text, attachments: payload.attachments,
    resourceSnapshot: snapshotWebhookResources(database, webhook.id, local.id),
    ...(sender.value ? { sender: { value: sender.value, label: sender.label } } : {}),
    data: payload.data,
  });
  response.writeHead(202, { "Content-Type": "application/json", "Cache-Control": "no-store", Connection: "close" }).end(JSON.stringify({ accepted: true, attachments: payload.attachments.length }));
}

requestInterceptors.push((request, response) => {
  const path = (request.url ?? "").split("?", 1)[0];
  const match = HOOK_PATH.exec(path);
  // A webhook-only relay channel carries no other request, whatever the relay sent.
  if (!match && !isWebhookOnlyChannel(request.socket)) return false;
  if (!match) { request.resume(); reply(response, 404, "Not found"); return true; }
  handleHook(request, response, match[1]).catch((error: unknown) => {
    console.warn("Webhook request failed", error instanceof Error ? error.message : error);
    if (!response.headersSent) reply(response, 500, "Webhook failed");
    else response.destroy();
  });
  return true;
});

upgradeHandlers.push((request: IncomingMessage, socket: Duplex) => {
  if (!isWebhookOnlyChannel(request.socket ?? socket)) return false;
  socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  return true;
});

// ------------------------------------------------------------ agent endpoints

function handle(work: (request: Request, response: Response) => Promise<void>) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try { await work(request, response); } catch (error) {
      if (error instanceof z.ZodError) { sendError(response, 400, error.issues.map((issue) => issue.message).join(", ")); return; }
      if (error instanceof WebhookError || error instanceof WebhookResourceError) { sendError(response, error.statusCode, error.message); return; }
      next(error);
    }
  };
}

const webhookMemoryAgentCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("read") }).strict(),
  z.object({ action: z.literal("write"), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), content: z.string().max(200_000) }).strict(),
]);

app.post("/api/webhook-agent/memory", handle(async (request, response) => {
  const identity = response.locals.webhookMemoryAgent as WebhookMemoryAgentIdentity | undefined;
  if (!identity) throw new WebhookError(403, "Webhook memory capability required");
  const db = await clusterV2Database();
  const command = webhookMemoryAgentCommandSchema.parse(request.body);
  response.json(await runWebhookMemoryAgentCommand(db, identity, command));
}));

const titleCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("fill"), replacements: z.record(z.string(), z.string().max(200)) }).strict(),
]);

// No caller-supplied conversation ID or template: the capability selects both.
app.post("/api/webhook-title/agent", handle(async (request, response) => {
  const identity = response.locals.webhookTitleAgent as AgentCapabilityIdentity | undefined;
  if (!identity) throw new WebhookError(403, "Webhook title capability required");
  const command = titleCommandSchema.parse(request.body);
  const template = webhookConversationTitle(identity.projectId, identity.conversationId);
  const segment = await latestConversationSegment(identity.conversationId);
  if (template === undefined || !segment || segment.projectId !== identity.projectId) throw new WebhookError(404, "This conversation has no webhook title template");
  const ownership = await getConversationOwnership(segment.engine, segment.sessionId);
  if (ownership && ownership.ownerNodeId !== (await getClusterNode()).id) throw new WebhookError(409, "This conversation now runs on another machine");
  if (command.action === "status") {
    response.json({ template, placeholders: titlePlaceholders(template) });
    return;
  }
  let title: string;
  try { title = fillWebhookTitle(template, command.replacements); }
  catch (error) { throw new WebhookError(400, (error as Error).message); }
  await setSessionTitle(identity.conversationId, title);
  broadcastToProject(identity.projectId, { type: "sessionsChanged" });
  response.json({ title });
}));

/** Where a webhook's secret goes to make a URL: each relay this machine is on, and its own address when it has one. */
export async function urlBases(): Promise<Array<{ id: string; label: string; base: string }>> {
  const bases: Array<{ id: string; label: string; base: string }> = [];
  const node = await getClusterNode();
  const db = await clusterV2Database();
  const server = relayServerInstance();
  const self = server?.enabled ? relayMachine(db, node.id) : undefined;
  if (server?.enabled && self) bases.push({ id: "local-relay", label: `This machine's relay (${server.environment || new URL(server.origin).host})`, base: `${new URL(server.origin).origin}/hooks/${self.name}` });
  for (const item of relayRuntimeInstance()?.status() ?? []) {
    if (item.status !== "admitted" || !item.name) continue;
    bases.push({ id: item.id, label: item.environment ? `Relay ${item.environment}` : `Relay ${new URL(item.origin).host}`, base: `${new URL(item.origin).origin}/hooks/${item.name}` });
  }
  if (node.url && isClusterOriginUrl(node.url)) bases.push({ id: "direct", label: "This machine's own address", base: `${new URL(node.url).origin}/hooks` });
  return bases;
}
