// Managing automations. An automation is instructions for an agent and what starts it: a call to a secret
// address (src/webhooks.ts, received by routes/webhooks.ts) or a schedule (src/cron.ts, run by server/cron.ts).
// Both live in one table, so one set of commands lists, creates, changes, moves and deletes either. A person
// reaches them at `/api/automations`; another machine reaches the same commands, signed, at
// `/api/cluster/v2/automations`.
import { lstat, readFile } from "node:fs/promises";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { actingAccount } from "../../account-context.js";
import type { AuthSession } from "../../auth.js";
import { DEFAULT_AUTO_RESPOND_INSTRUCTIONS, DEFAULT_AUTO_RESPOND_STOP_INSTRUCTIONS, validateAutoRespondProfile } from "../../conversation-auto-respond.js";
import { listSubscriptionPools, poolCandidates, getSubscriptionPool } from "../../provider-profiles/pools.js";
import { validateAutomationAssignment } from "../automation-profile.js";
import { accessibleProviderProfile, listAccessibleProviderProfiles } from "../../provider-profiles/store.js";
import { getClusterNode } from "../../cluster.js";
import { isTrustedTwin } from "../../cluster-sharing-policy.js";
import { getConversationOwnership } from "../../conversation-ownership.js";
import { ensureConversationRecord, markCronConversation } from "../../conversation-records.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { automationWorkspaceIdentity, validateAutomationTagAssignments } from "../../automation-tags.js";
import { getProject, listProjects } from "../../store.js";
import { getHarnessRuntime, listHarnesses, listHarnessModels } from "../../harnesses.js";
import type { HarnessId } from "../../types.js";
import { getScopeSecretAccounts, listSecretAccounts, validateProjectSecretAccounts } from "../../secrets.js";
import { sharedProjectIds } from "../sharing-files.js";
import { peerMayRunHere } from "../cluster-helpers.js";
import { listRuntimePeers } from "../runtime-peers.js";
import { listProjectAutomations, signedAutomationFetch } from "../automation-peers.js";
import { cronInputOf, cronInputSchema, cronStore, type CronRun } from "../../cron.js";
import {
  createAutomation, deleteWebhook, getWebhook, listWebhooks, regenerateWebhookSecret, TELEGRAM_SENDER_FIELDS, updateAutomation, webhookDeliveries, webhookInputSchema, WebhookError,
  type Webhook, type WebhookDelivery, type WebhookInput,
} from "../../webhooks.js";
import { Feature, requireFeature, sendError } from "../http-auth.js";
import { hasFeature } from "../../features.js";
import { listProjectSessionsWithReviewState } from "../sessions-helpers.js";
import { app, flags } from "../state.js";
import { acceptWebhookCall, defaultAutomationEngine, webhookDeliveryPending } from "../webhooks.js";
import { cronConversationReady } from "../cron.js";
import { broadcastToProject } from "../realtime.js";
import { exportWebhookTransfer, installWebhookTransfer, removeTransferredWebhook, webhookTransferSchema } from "../../webhook-transfer.js";
import { ensureAutomationExecutionSchema } from "../../automation-executions.js";
import { updateWebhookHistory } from "../webhook-history.js";
import { getPersonalAssistant } from "../../personal-assistants.js";
import { snapshotWebhookResources, listWebhookResources, saveWebhookResource, removeWebhookResource, revertWebhookResource, WebhookResourceError } from "../../webhook-resources.js";
import { ensureWebhookAgentSchema } from "../../webhook-agent.js";
import { readWebhookMemory, writeWebhookMemory, setWebhookMemoryEnabled } from "../../webhook-memory.js";
import { webhookMemoryEnabled } from "../../webhook-resources.js";
import { listWebhookSkills, listSelectableWebhookSkills, uploadWebhookSkill, importExistingWebhookSkill, discoverWebhookGitSkills, importWebhookGitSkill, removeWebhookSkill } from "../../webhook-skills.js";
import { urlBases } from "./webhooks.js";
import { harnessProblems } from "../harness-readiness.js";

function handle(work: (request: Request, response: Response) => Promise<void>) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try { await work(request, response); } catch (error) {
      if (error instanceof z.ZodError) { sendError(response, 400, error.issues.map((issue) => issue.message).join(", ")); return; }
      if (error instanceof WebhookError || error instanceof WebhookResourceError) { sendError(response, error.statusCode, error.message); return; }
      next(error);
    }
  };
}

/** A webhook may point only at what exists on this machine, because it is delivered here. */
async function checkTarget(input: WebhookInput): Promise<void> {
  const project = await getProject(input.target.projectId);
  if (!project) throw new WebhookError(404, "Project not found on this machine");
  if (input.secretAccountIds.length) {
    try { validateProjectSecretAccounts(project.id, input.secretAccountIds); }
    catch { throw new WebhookError(400, "Selected secret accounts are unavailable for this project or conflict"); }
  }
  if (input.reply) throw new WebhookError(400, "Connect Telegram from the assistant's Resources");
  let selectedEngine = input.target.kind === "assistant" ? defaultAutomationEngine() : input.target.engine ?? defaultAutomationEngine();
  if (input.target.kind === "assistant") {
    const assistant = input.creatorAccountId ? await getPersonalAssistant(input.creatorAccountId, input.target.assistantId) : undefined;
    if (!assistant || assistant.projectId !== project.id || assistant.nodeId && assistant.nodeId !== (await getClusterNode()).id) throw new WebhookError(404, "Assistant not found on this machine");
    selectedEngine = assistant.executionSettings?.harnessId ?? defaultAutomationEngine();
  }
  const problems = await harnessProblems(selectedEngine as HarnessId, project.path);
  if (problems.length) throw new WebhookError(400, problems.join("\n"));
  const selectedModel = input.model;
  if (selectedModel) {
    const models = await listHarnessModels(selectedEngine as HarnessId);
    if (!models.some(model => model.provider === selectedModel.provider && model.id === selectedModel.modelId)) throw new WebhookError(400, "Selected model is unavailable on this machine");
  }
  if (input.target.kind !== "conversation") return;
  const { sessionId, engine } = input.target;
  const found = (await listProjectSessionsWithReviewState(project, "", "")).find((session) => session.id === sessionId && session.harnessId === engine);
  if (!found || found.readOnly || found.doneAt) throw new WebhookError(404, "Conversation not found on this machine");
  const ownership = await getConversationOwnership(engine, sessionId);
  // A scheduled run waits for the conversation to be free and takes it over; a webhook call is delivered where the conversation lives.
  if (input.trigger === "webhook" && ownership && ownership.ownerNodeId !== (await getClusterNode()).id) throw new WebhookError(409, "Choose the machine that owns this conversation");
}

const webhookResourceCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("resource-list"), id: z.string().uuid(), creatorAccountId: z.string().nullable().optional() }).strict(),
  z.object({ action: z.literal("resource-download"), id: z.string().uuid(), resourceId: z.string().uuid(), creatorAccountId: z.string().nullable().optional() }).strict(),
  z.object({ action: z.literal("resource-save"), id: z.string().uuid(), resource: z.object({ kind: z.enum(["file", "tool"]), resourceId: z.string().uuid().optional(), name: z.string().min(1).max(240), description: z.string().min(1).max(2000), usage: z.string().max(2000).nullable().optional(), expectedVersionId: z.string().uuid().optional(), mimeType: z.string().max(120).optional(), data: z.string().max(5_592_408) }).strict(), creatorAccountId: z.string().nullable().optional() }).strict(),
  z.object({ action: z.literal("resource-remove"), id: z.string().uuid(), resourceId: z.string().uuid(), creatorAccountId: z.string().nullable().optional() }).strict(),
  z.object({ action: z.literal("resource-revert"), id: z.string().uuid(), resourceId: z.string().uuid(), expectedVersionId: z.string().uuid(), creatorAccountId: z.string().nullable().optional() }).strict(),
  z.object({ action: z.literal("skill-list"), id: z.string().uuid(), creatorAccountId: z.string().nullable().optional() }).strict(),
  z.object({ action: z.literal("skill-inventory"), id: z.string().uuid(), harness: z.enum(["pi", "claude", "kiro"]).optional(), creatorAccountId: z.string().nullable().optional() }).strict(),
  z.object({ action: z.literal("skill-upload"), id: z.string().uuid(), files: z.array(z.object({ relativePath: z.string().min(1).max(1000), data: z.string().max(5_592_408) }).strict()).max(200), creatorAccountId: z.string().nullable().optional() }).strict(),
  z.object({ action: z.literal("skill-import-existing"), id: z.string().uuid(), inventoryId: z.string().min(1).max(4096), creatorAccountId: z.string().nullable().optional() }).strict(),
  z.object({ action: z.literal("skill-discover-git"), id: z.string().uuid(), url: z.string().min(1).max(2048), ref: z.string().max(200).nullable().optional(), creatorAccountId: z.string().nullable().optional() }).strict(),
  z.object({ action: z.literal("skill-import-git"), id: z.string().uuid(), url: z.string().min(1).max(2048), ref: z.string().max(200).nullable().optional(), commit: z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/), key: z.string().min(1).max(4096), skillId: z.string().uuid().optional(), creatorAccountId: z.string().nullable().optional() }).strict(),
  z.object({ action: z.literal("skill-remove"), id: z.string().uuid(), skillId: z.string().uuid(), creatorAccountId: z.string().nullable().optional() }).strict(),
  z.object({ action: z.literal("memory-read"), id: z.string().uuid(), creatorAccountId: z.string().nullable().optional() }).strict(),
  z.object({ action: z.literal("memory-write"), id: z.string().uuid(), content: z.string().max(200_000), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), creatorAccountId: z.string().nullable().optional() }).strict(),
  z.object({ action: z.literal("memory-enable"), id: z.string().uuid(), enabled: z.boolean(), creatorAccountId: z.string().nullable().optional() }).strict(),
]);

type WebhookResourceCommand = z.infer<typeof webhookResourceCommandSchema>;
const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("profiles"), accountId: z.string().nullable().optional() }).strict(),
  z.object({ action: z.literal("list"), projectId: z.string().min(1).max(240).optional() }).strict(),
  z.object({ action: z.literal("projects") }).strict(),
  z.object({ action: z.literal("options") }).strict(),
  z.object({ action: z.literal("sessions"), projectId: z.string().min(1).max(240) }).strict(),
  z.object({ action: z.literal("create"), input: webhookInputSchema }).strict(),
  z.object({ action: z.literal("update"), id: z.string().uuid(), input: webhookInputSchema }).strict(),
  z.object({ action: z.literal("transfer"), id: z.string().uuid(), nodeId: z.string().uuid(), creatorAccountId: z.string().nullable().optional() }).strict(),
  z.object({ action: z.literal("install-transfer"), bundle: webhookTransferSchema }).strict(),
  z.object({ action: z.literal("regenerate"), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("history"), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("run"), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("ready"), projectId: z.string().min(1), sessionId: z.string().min(1), engine: z.string().min(1).max(80) }).strict(),
  z.object({ action: z.literal("delete"), id: z.string().uuid() }).strict(),
  ...webhookResourceCommandSchema.options,
]);
export type AutomationCommand = z.infer<typeof commandSchema>;
type Command = AutomationCommand;

/** Always executes locally. Remote management never stores another copy. */
function isWebhookResourceCommand(command: Command): command is WebhookResourceCommand {
  return webhookResourceCommandSchema.safeParse(command).success;
}

function publicWebhookSkill(skill: Awaited<ReturnType<typeof uploadWebhookSkill>>) {
  const { path: _path, ...metadata } = skill;
  return metadata;
}

function stripTrailingEquals(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 61) end -= 1;
  return value.slice(0, end);
}

function decodeResourceData(data: string): Buffer {
  const decoded = Buffer.from(data, "base64");
  if (stripTrailingEquals(decoded.toString("base64")) !== stripTrailingEquals(data)) throw new WebhookError(400, "Resource data is not valid base64");
  return decoded;
}

interface AutomationPeerScope { projects: Set<string>; secrets: Set<string> }

async function automationPeerScope(peerId: string): Promise<AutomationPeerScope | undefined> {
  const db = await clusterV2Database(), local = await getClusterNode();
  if (isTrustedTwin(db, local.id, peerId)) return undefined;
  const projects = new Set(sharedProjectIds(db, local.id, peerId));
  if (!projects.size) throw new WebhookError(403, "No webhook projects are shared with this machine");
  const secrets = new Set<string>();
  for (const id of projects) {
    const project = await getProject(id);
    if (!project) continue;
    for (const scope of [["project", id], ["workspace", project.type ?? "personal"]] as const) {
      for (const accountId of (await getScopeSecretAccounts(scope[0], scope[1])).accountIds) secrets.add(accountId);
    }
  }
  for (const account of await listSecretAccounts()) if (account.projectId && projects.has(account.projectId)) secrets.add(account.id);
  return { projects, secrets };
}

function assertAutomationPeerScope(db: Awaited<ReturnType<typeof clusterV2Database>>, command: Command, scope: AutomationPeerScope): void {
  const input = "input" in command ? command.input : command.action === "install-transfer" ? command.bundle.input : undefined;
  const projects = [...("projectId" in command && command.projectId ? [command.projectId] : []), ...(input ? [input.target.projectId] : [])];
  // An edit keeps the automation's creator (manage), so its profile or pool is checked as the creator's, not the editor's.
  let creatorAccountId = input?.creatorAccountId;
  if ("id" in command) {
    const hook = getWebhook(db, command.id);
    if (!hook) throw new WebhookError(404, "Webhook not found");
    projects.push(hook.target.projectId);
    creatorAccountId = hook.creatorAccountId ?? creatorAccountId;
  }
  if (projects.some(id => !scope.projects.has(id))) throw new WebhookError(403, "Webhook project is not shared with this machine");
  if (input?.target.kind === "assistant") throw new WebhookError(403, "Assistant webhooks stay on their assistant's machine");
  if (input?.secretAccountIds.some(id => !scope.secrets.has(id))) throw new WebhookError(403, "Selected secrets are not attached to a shared project");
  if (input?.providerProfileId && (!creatorAccountId || !listAccessibleProviderProfiles(creatorAccountId, "automation").some(profile => profile.id === input.providerProfileId && profile.shared))) throw new WebhookError(403, "Select a shared automation profile on this machine");
  for (const assignment of [input, input?.autoRespond]) {
    if (!assignment?.providerPoolId) continue;
    validateAutomationAssignment({ ...assignment, creatorAccountId });
    const pool = getSubscriptionPool(creatorAccountId!, assignment.providerPoolId);
    if (!poolCandidates(pool, "claude").every(profile => profile.shared)) throw new WebhookError(403, "Select a pool of shared automation profiles on this machine");
  }
  if (command.action === "skill-inventory" || command.action === "skill-import-existing") throw new WebhookError(403, "Machine-local skill imports require a trusted twin; upload a skill or import it from Git instead");
}

/** What a list shows for one automation: its settings and the last thing that happened to it. */
export type AutomationItem = Webhook & { lastDelivery: WebhookDelivery | null; lastRun: CronRun | null };
export const automationItem = (db: Awaited<ReturnType<typeof clusterV2Database>>, hook: Webhook): AutomationItem =>
  ({ ...hook, lastDelivery: webhookDeliveries(db, hook.id)[0] ?? null, lastRun: hook.trigger === "schedule" ? cronStore().history(hook.id, 1)[0] ?? null : null });

/** A scheduled automation runs the way a scheduled task always did, so it is held to the same checks before it is saved. */
async function checkSchedule(input: WebhookInput, ownerNodeId: string): Promise<{ engine: string }> {
  const assistant = input.target.kind === "assistant" && input.creatorAccountId ? await getPersonalAssistant(input.creatorAccountId, input.target.assistantId) : undefined;
  const engine = assistant?.executionSettings?.harnessId ?? (input.target.kind === "assistant" ? undefined : input.target.engine) ?? defaultAutomationEngine();
  cronInputSchema.parse(cronInputOf(input, ownerNodeId, engine));
  if (input.autoRespond) {
    if (!input.creatorAccountId) throw new WebhookError(400, "Sign in to configure auto reply");
    const runtime = await getHarnessRuntime(input.autoRespond.harnessId as HarnessId);
    await runtime.validateSettings({ provider: input.autoRespond.provider, modelId: input.autoRespond.modelId, reasoning: input.autoRespond.thinkingLevel });
  }
  if (input.target.kind === "conversation") await cronConversationReady(input.target.projectId, input.target.sessionId, input.target.engine);
  return { engine };
}

/** What follows a save: a pinned conversation learns it belongs to a schedule, and every open window refreshes. */
async function savedAutomation(db: Awaited<ReturnType<typeof clusterV2Database>>, hook: Webhook): Promise<void> {
  const projectId = hook.target.projectId;
  if (hook.trigger === "schedule" && hook.target.kind === "conversation") {
    const local = await getClusterNode();
    await ensureConversationRecord(projectId, hook.target.engine, hook.target.sessionId, local.id);
    await markCronConversation(projectId, hook.target.engine, hook.target.sessionId, hook.id, local.id);
    broadcastToProject(projectId, { type: "sessionsChanged" });
  }
  broadcastToProject(projectId, { type: "automationsChanged" });
}

async function manage(command: Command, scope?: AutomationPeerScope): Promise<unknown> {
  const db = await clusterV2Database();
  if (scope) assertAutomationPeerScope(db, command, scope);
  if (command.action === "profiles") return {
    profiles: command.accountId ? listAccessibleProviderProfiles(command.accountId, "automation").filter(profile => !scope || profile.shared) : [],
    pools: command.accountId ? listSubscriptionPools(command.accountId).filter(pool => !scope || poolCandidates(pool, "claude").every(profile => profile.shared)) : [],
  };
  if ("id" in command && transferring.has(command.id)) throw new WebhookError(409, "Webhook transfer is in progress; wait before changing it");
  // The webhook behind a connected Telegram bot is managed from the assistant, not here.
  if ("id" in command && typeof command.id === "string" && command.action !== "history" && getWebhook(db, command.id)?.reply) throw new WebhookError(409, "Manage this webhook from the assistant's Telegram settings");
  if (command.action === "list") {
    const shown = listWebhooks(db).filter(hook => !hook.reply && (!command.projectId || hook.target.projectId === command.projectId) && (!scope || scope.projects.has(hook.target.projectId)));
    return { automations: shown.map(hook => automationItem(db, hook)), bases: await urlBases(), startupReady: flags.startupReady, telegramSenderFields: TELEGRAM_SENDER_FIELDS };
  }
  if (command.action === "ready") {
    if (!await getProject(command.projectId)) throw new WebhookError(404, "Project not found");
    return { ready: await cronConversationReady(command.projectId, command.sessionId, command.engine) };
  }
  if (command.action === "options") {
    const installed = listHarnesses().filter(({ runtime }) => runtime);
    const available = await Promise.all(installed.map(async adapter => ({ adapter, problems: await harnessProblems(adapter.id) })));
    const adapters = available.filter(({ problems }) => !problems.length).map(({ adapter }) => adapter);
    return {
      secretAccounts: (await listSecretAccounts()).filter(account => !scope || scope.secrets.has(account.id)).map(({ id, label, provider, projectId }) => ({ id, label, provider, projectId })),
      harnesses: adapters.map(({ id, label, configuration }) => ({ id, label, thinkingLevels: configuration?.thinkingLevels ?? [] })),
      models: (await Promise.all(adapters.map(async ({ id }) => (await listHarnessModels(id)).map(model => ({ ...model, harnessId: id }))))).flat(),
    };
  }
  if (command.action === "projects") return { projects: (await listProjects()).filter(project => !scope || scope.projects.has(project.id)).map(({ id, name }) => ({ id, name })) };
  if (command.action === "sessions") {
    const project = await getProject(command.projectId);
    if (!project) throw new WebhookError(404, "Project not found on this machine");
    const local = await getClusterNode();
    const sessions = await listProjectSessionsWithReviewState(project, "", "");
    return { sessions: sessions.filter(session => !session.readOnly && !session.doneAt && (!session.executionNodeId || session.executionNodeId === local.id))
      .map(({ id, title, firstMessage, harnessId }) => ({ id, title, firstMessage, harnessId })) };
  }
  if (isWebhookResourceCommand(command)) {
    const webhook = getWebhook(db, command.id);
    if (!webhook) throw new WebhookError(404, "Webhook not found");
    if (command.action === "resource-list") return { resources: listWebhookResources(db, webhook.id).map(({ path: _path, ...item }) => item) };
    if (command.action === "resource-download") {
      const resource = listWebhookResources(db, webhook.id).find(item => item.id === command.resourceId);
      if (!resource) throw new WebhookError(404, "Webhook resource not found");
      const info = await lstat(resource.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== resource.bytes) throw new WebhookResourceError("Webhook resource version is unavailable", 409);
      return { name: resource.name, mimeType: resource.mimeType, data: (await readFile(resource.path)).toString("base64") };
    }
    if (command.action === "resource-save") {
      const resource = await saveWebhookResource(db, webhook.id, { kind: command.resource.kind, id: command.resource.resourceId, name: command.resource.name, description: command.resource.description, usage: command.resource.usage, expectedVersionId: command.resource.expectedVersionId, mimeType: command.resource.mimeType, bytes: decodeResourceData(command.resource.data) });
      const { path: _path, ...publicResource } = resource;
      return { resource: publicResource };
    }
    if (command.action === "resource-revert") return await revertWebhookResource(db, webhook.id, command.resourceId, command.expectedVersionId).then(({ path: _path, ...resource }) => resource);
    if (command.action === "resource-remove") { await removeWebhookResource(db, webhook.id, command.resourceId); return { ok: true }; }
    if (command.action === "skill-list") return { skills: listWebhookSkills(db, webhook.id).map(({ path: _path, ...item }) => item) };
    if (command.action === "skill-inventory") {
      const project = await getProject(webhook.target.projectId);
      if (!project) throw new WebhookError(404, "Webhook project not found");
      return { skills: await listSelectableWebhookSkills(project.path, command.harness) };
    }
    if (command.action === "skill-upload") return { skill: publicWebhookSkill(await uploadWebhookSkill(db, webhook.id, command.files.map(file => ({ relativePath: file.relativePath, data: decodeResourceData(file.data) })))) };
    if (command.action === "skill-import-existing") {
      const project = await getProject(webhook.target.projectId);
      if (!project) throw new WebhookError(404, "Webhook project not found");
      return { skill: publicWebhookSkill(await importExistingWebhookSkill(db, webhook.id, project.path, command.inventoryId)) };
    }
    if (command.action === "skill-discover-git") return await discoverWebhookGitSkills(command.url, command.ref ?? null);
    if (command.action === "skill-import-git") return { skill: publicWebhookSkill(await importWebhookGitSkill(db, webhook.id, command.url, command.ref ?? null, command.commit, command.key, {}, command.skillId)) };
    if (command.action === "skill-remove") { await removeWebhookSkill(db, webhook.id, command.skillId); return { ok: true }; }
    if (command.action === "memory-read") {
      const { path: _path, ...memory } = await readWebhookMemory(webhook.id);
      return { ...memory, enabled: webhookMemoryEnabled(db, webhook.id) };
    }
    if (command.action === "memory-write") {
      const { path: _path, ...memory } = await writeWebhookMemory(db, webhook.id, command.expectedRevision, command.content);
      return memory;
    }
    setWebhookMemoryEnabled(db, webhook.id, command.enabled);
    return { enabled: command.enabled };
  }
  if (command.action === "transfer") return transferAutomation(command);
  if (command.action === "install-transfer") {
    const input = command.bundle.input;
    validateAutomationAssignment(input);
    if (input.autoRespond) validateAutoRespondProfile(input.creatorAccountId ?? null, input.autoRespond);
    await checkTarget(input);
    if (input.providerProfileId) {
      if (!input.creatorAccountId) throw new WebhookError(400, "Sign in to select a profile");
      accessibleProviderProfile(input.creatorAccountId, input.providerProfileId, "automation");
    }
    const project = (await getProject(input.target.projectId))!;
    const local = await getClusterNode();
    const workspace = automationWorkspaceIdentity(db, local.id, project.type ?? "personal");
    validateAutomationTagAssignments(db, workspace.workspaceId, input.tags, workspace.ownerNodeId);
    const installed = await installWebhookTransfer(db, command.bundle, local.id);
    return { automation: automationItem(db, installed.webhook), secret: installed.secret, bases: installed.secret ? await urlBases() : [] };
  }
  if (command.action === "create" || command.action === "update") {
    const existing = command.action === "update" ? getWebhook(db, command.id) : undefined;
    // Anyone who can open an automation may change it; it keeps running as its creator, on the creator's profile or pool.
    if (existing) {
      if (existing.target.kind === "assistant" && (command.input.target.kind !== "assistant" || command.input.target.assistantId !== existing.target.assistantId)) throw new WebhookError(409, "Assistant webhook target cannot be changed in place");
    }
    command.input.creatorAccountId = existing?.creatorAccountId ?? command.input.creatorAccountId ?? null;
    if (command.input.providerProfileId && !command.input.creatorAccountId) throw new WebhookError(400, "Sign in to select a profile");
    validateAutomationAssignment(command.input);
    if (command.input.autoRespond) validateAutoRespondProfile(command.input.creatorAccountId, command.input.autoRespond);
    command.input.providerProfileId ??= null;
    if (command.input.providerProfileId) accessibleProviderProfile(command.input.creatorAccountId!, command.input.providerProfileId, "automation");
    await checkTarget(command.input);
    const tagProject = await getProject(command.input.target.projectId);
    if (!tagProject) throw new WebhookError(404, "Project not found on this machine");
    const local = await getClusterNode();
    const workspace = automationWorkspaceIdentity(db, local.id, tagProject.type ?? "personal");
    validateAutomationTagAssignments(db, workspace.workspaceId, command.input.tags, workspace.ownerNodeId);
    const scheduled = command.input.trigger === "schedule" ? await checkSchedule(command.input, local.id) : undefined;
    const options = { ownerNodeId: local.id, engine: scheduled?.engine };
    ensureWebhookAgentSchema(db);
    const saved = command.action === "create" ? createAutomation(db, command.input, options) : updateAutomation(db, command.id, command.input, options);
    if (command.action === "update") await updateWebhookHistory(saved.webhook);
    await savedAutomation(db, saved.webhook);
    return { automation: automationItem(db, saved.webhook), secret: saved.secret, bases: saved.secret ? await urlBases() : [] };
  }
  if (!getWebhook(db, command.id)) throw new WebhookError(404, "Webhook not found");
  if (command.action === "regenerate") {
    if (getWebhook(db, command.id)!.trigger !== "webhook") throw new WebhookError(409, "Only an automation started by a webhook has an address");
    const { webhook, secret } = regenerateWebhookSecret(db, command.id);
    return { automation: automationItem(db, webhook), secret, bases: await urlBases() };
  }
  if (command.action === "history") return { calls: webhookDeliveries(db, command.id), runs: cronStore().history(command.id) };
  if (command.action === "run") {
    const hook = getWebhook(db, command.id)!;
    if (hook.trigger === "schedule") cronStore().runNow(hook.id);
    else acceptWebhookCall(hook, { method: "POST", headers: {}, query: "", body: "", manual: true, resourceSnapshot: snapshotWebhookResources(db, hook.id, (await getClusterNode()).id) });
    return { automation: automationItem(db, getWebhook(db, hook.id)!) };
  }
  const doomed = getWebhook(db, command.id)!;
  if (cronStore().active(command.id)) throw new WebhookError(409, "Wait for the scheduled run to finish before deleting");
  deleteWebhook(db, command.id);
  cronStore().purge(command.id);
  broadcastToProject(doomed.target.projectId, { type: "automationsChanged" });
  return { ok: true };
}

const transferring = new Set<string>();
async function transferAutomation(command: Extract<Command, { action: "transfer" }>) {
  const db = await clusterV2Database(), local = await getClusterNode();
  if (command.nodeId === local.id) throw new WebhookError(400, "Choose a different machine");
  const hook = getWebhook(db, command.id);
  if (!hook) throw new WebhookError(404, "Webhook not found");
  if (!(await listRuntimePeers(hook.target.projectId)).some(peer => peer.id === command.nodeId)) throw new WebhookError(403, "Choose a machine sharing this webhook's project");
  ensureAutomationExecutionSchema(db);
  const sourceKind = hook.trigger === "schedule" ? "scheduled" : "webhook";
  if (transferring.has(hook.id) || webhookDeliveryPending(hook.id) || cronStore().active(hook.id) || db.prepare("SELECT 1 FROM automation_executions WHERE source_kind=? AND source_id=? AND status IN ('queued','running') LIMIT 1").get(sourceKind, hook.id)) throw new WebhookError(409, "Wait for active runs to finish before transferring");
  transferring.add(hook.id);
  // Fail closed on any uncertain remote result. Never restore the source automatically.
  db.prepare("UPDATE webhooks SET enabled=0 WHERE id=?").run(hook.id);
  try {
    const bundle = await exportWebhookTransfer(db, hook.id);
    const result = await dispatchAutomationCommand(command.nodeId, { action: "install-transfer", bundle }) as { automation: AutomationItem; secret: string | null; bases: Array<{ id: string; label: string; base: string }> };
    await removeTransferredWebhook(db, hook.id);
    const input = { ...bundle.input, enabled: hook.enabled };
    const updated = await dispatchAutomationCommand(command.nodeId, { action: "update", id: hook.id, input }) as { automation: AutomationItem };
    return { ...result, automation: updated.automation };
  } catch (error) {
    throw new WebhookError(error instanceof WebhookError ? error.statusCode : 409, `Transfer did not finish: ${error instanceof Error ? error.message : String(error)}. Check both machines; the source is paused or already moved. Do not retry blindly.`);
  } finally { transferring.delete(hook.id); }
}

/** Owners visible through the project's cluster, workspace or direct sharing grants. */
export async function automationOwners(projectId?: string): Promise<Array<{ id: string; name: string; local: boolean; twin: boolean }>> {
  const local = await getClusterNode(), db = await clusterV2Database();
  if (projectId && !await getProject(projectId)) throw new WebhookError(404, "Project not found");
  return [{ id: local.id, name: local.name, local: true, twin: false }, ...(await listRuntimePeers(projectId)).map(({ id, name }) => ({ id, name, local: false, twin: isTrustedTwin(db, local.id, id) }))];
}

/**
 * A person signed in from another machine manages scheduled automations but never webhooks, whose addresses are
 * secrets. They see no webhook, and a command naming one is refused.
 */
async function assertScheduleOnly(nodeId: string | undefined, command: Command): Promise<void> {
  const refusal = new WebhookError(403, "Webhooks are managed on the machine you sign in at home");
  if (command.action === "install-transfer" || "input" in command && command.input.trigger === "webhook") throw refusal;
  if (!("id" in command)) return;
  const { automations } = await dispatchAutomationCommand(nodeId, { action: "list" }) as { automations: Webhook[] };
  if (automations.find(item => item.id === command.id)?.trigger !== "schedule") throw refusal;
}

async function route(request: Request, response: Response, command: Command): Promise<unknown> {
  const nodeId = z.string().uuid().optional().parse(request.query.nodeId);
  const session = response.locals.authSession as AuthSession | undefined;
  const remote = !response.locals.machineAuth && session?.isRemoteLogin === true;
  if (remote) await assertScheduleOnly(nodeId, command);
  const result = await runAutomationCommand(nodeId, command);
  if (remote && command.action === "list") {
    const listed = result as { automations: Webhook[]; bases: unknown[] };
    return { ...listed, automations: listed.automations.filter(item => item.trigger === "schedule"), bases: [] };
  }
  return result;
}

/** An automation command for the person it runs as, on this machine or the twin that owns the automation. */
export async function runAutomationCommand(nodeId: string | undefined, command: Command): Promise<unknown> {
  if (command.action === "profiles") command.accountId = actingAccount()?.accountId ?? null;
  if (command.action === "create" || command.action === "update") command.input.creatorAccountId = actingAccount()?.accountId ?? null;
  if (isWebhookResourceCommand(command) || command.action === "transfer") command.creatorAccountId = actingAccount()?.accountId ?? null;
  return dispatchAutomationCommand(nodeId, command);
}

export async function dispatchAutomationCommand(nodeId: string | undefined, command: Command, timeoutMs?: number): Promise<unknown> {
  const local = await getClusterNode();
  if (!nodeId || nodeId === local.id) return manage(command);
  const projectId = "input" in command ? command.input.target.projectId : command.action === "install-transfer" ? command.bundle.input.target.projectId : "projectId" in command ? command.projectId : undefined;
  const peer = (await listRuntimePeers()).find(peer => peer.id === nodeId);
  if (!peer) throw new WebhookError(403, "Webhook owner is unavailable or does not share this project");
  if (projectId && !isTrustedTwin(await clusterV2Database(), local.id, nodeId) && !(await listRuntimePeers(projectId)).some(candidate => candidate.id === nodeId)) throw new WebhookError(403, "Webhook project is not shared with this machine");
  const timeout = timeoutMs ?? (isWebhookResourceCommand(command) || command.action === "transfer" || command.action === "install-transfer" ? 210_000 : 10_000);
  return signedAutomationFetch(peer, command, timeout);
}

app.post("/api/cluster/v2/automations", handle(async (request, response) => {
  const peerId = response.locals.machineNodeId;
  if (response.locals.machineProtocol !== 2 || !(await listRuntimePeers()).some(peer => peer.id === peerId)) throw new WebhookError(403, "Only machines sharing a project may manage webhooks");
  const command = commandSchema.parse(request.body);
  if (["create", "update", "install-transfer", "run"].includes(command.action) && !await peerMayRunHere(peerId, "automations")) throw new WebhookError(403, "This node does not accept automations from other nodes");
  response.json(await manage(command, await automationPeerScope(peerId)));
}));

app.get("/api/auto-respond/defaults", (_request, response) => {
  response.json({ instructions: DEFAULT_AUTO_RESPOND_INSTRUCTIONS, stopInstructions: DEFAULT_AUTO_RESPOND_STOP_INSTRUCTIONS, maxResponses: 10 });
});

app.get("/api/automations/owners", handle(async (_request, response) => {
  response.json({ owners: await automationOwners(z.string().min(1).optional().parse(_request.query.projectId)) });
}));
app.get("/api/automations/profiles", handle(async (request, response) => {
  response.json(await route(request, response, { action: "profiles" }));
}));
app.get("/api/automations/options", handle(async (request, response) => {
  response.json(await route(request, response, { action: "options" }));
}));
app.get("/api/automations/projects", handle(async (request, response) => {
  response.json(await route(request, response, { action: "projects" }));
}));
app.get("/api/automations/projects/:projectId/sessions", handle(async (request, response) => {
  response.json(await route(request, response, commandSchema.parse({ action: "sessions", projectId: request.params.projectId })));
}));
app.get("/api/automations", handle(async (request, response) => {
  response.json(await route(request, response, { action: "list" }));
}));
app.post("/api/automations", handle(async (request, response) => {
  response.status(201).json(await route(request, response, { action: "create", input: webhookInputSchema.parse(request.body) }));
}));
const webhookIdParam = (request: Request) => z.string().uuid().parse(request.params.id);
app.get("/api/automations/:id/resources", handle(async (request, response) => {
  response.json(await route(request, response, { action: "resource-list", id: webhookIdParam(request) }));
}));
app.post("/api/automations/:id/resources", handle(async (request, response) => {
  const body = z.object({ kind: z.enum(["file", "tool"]), resourceId: z.string().uuid().optional(), name: z.string().min(1).max(240), description: z.string().min(1).max(2000), usage: z.string().max(2000).nullable().optional(), expectedVersionId: z.string().uuid().optional(), mimeType: z.string().max(120).optional(), data: z.string().max(5_592_408) }).strict().parse(request.body);
  response.status(body.resourceId ? 200 : 201).json(await route(request, response, { action: "resource-save", id: webhookIdParam(request), resource: { ...body, resourceId: body.resourceId } }));
}));
app.get("/api/automations/:id/resources/:resourceId/download", handle(async (request, response) => {
  response.json(await route(request, response, { action: "resource-download", id: webhookIdParam(request), resourceId: z.string().uuid().parse(request.params.resourceId) }));
}));
app.post("/api/automations/:id/resources/:resourceId/revert", handle(async (request, response) => {
  const body = z.object({ expectedVersionId: z.string().uuid() }).strict().parse(request.body);
  response.json(await route(request, response, { action: "resource-revert", id: webhookIdParam(request), resourceId: z.string().uuid().parse(request.params.resourceId), expectedVersionId: body.expectedVersionId }));
}));
app.delete("/api/automations/:id/resources/:resourceId", handle(async (request, response) => {
  await route(request, response, { action: "resource-remove", id: webhookIdParam(request), resourceId: z.string().uuid().parse(request.params.resourceId) });
  response.status(204).end();
}));
app.get("/api/automations/:id/skills", handle(async (request, response) => {
  const inventory = z.enum(["0", "1"]).default("0").parse(request.query.inventory);
  const harness = z.enum(["pi", "claude", "kiro"]).optional().parse(request.query.harness);
  response.json(await route(request, response, inventory === "1" ? { action: "skill-inventory", id: webhookIdParam(request), harness } : { action: "skill-list", id: webhookIdParam(request) }));
}));
app.post("/api/automations/:id/skills", handle(async (request, response) => {
  const body = z.discriminatedUnion("action", [
    z.object({ action: z.literal("upload"), files: z.array(z.object({ relativePath: z.string().min(1).max(1000), data: z.string().max(5_592_408) }).strict()).max(200) }).strict(),
    z.object({ action: z.literal("import-existing"), inventoryId: z.string().min(1).max(4096) }).strict(),
    z.object({ action: z.literal("discover-git"), url: z.string().min(1).max(2048), ref: z.string().max(200).nullable().optional() }).strict(),
    z.object({ action: z.literal("import-git"), url: z.string().min(1).max(2048), ref: z.string().max(200).nullable().optional(), commit: z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/), key: z.string().min(1).max(4096), skillId: z.string().uuid().optional() }).strict(),
  ]).parse(request.body);
  const action = body.action === "upload" ? "skill-upload" : body.action === "import-existing" ? "skill-import-existing" : body.action === "discover-git" ? "skill-discover-git" : "skill-import-git";
  response.status(action === "skill-discover-git" ? 200 : 201).json(await route(request, response, { ...body, action, id: webhookIdParam(request) } as Command));
}));
app.delete("/api/automations/:id/skills/:skillId", handle(async (request, response) => {
  await route(request, response, { action: "skill-remove", id: webhookIdParam(request), skillId: z.string().uuid().parse(request.params.skillId) });
  response.status(204).end();
}));
app.get("/api/automations/:id/memory", handle(async (request, response) => {
  response.json(await route(request, response, { action: "memory-read", id: webhookIdParam(request) }));
}));
app.put("/api/automations/:id/memory", handle(async (request, response) => {
  const body = z.object({ content: z.string().max(200_000), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(request.body);
  response.json(await route(request, response, { action: "memory-write", id: webhookIdParam(request), ...body }));
}));
app.post("/api/automations/:id/memory", handle(async (request, response) => {
  const body = z.object({ action: z.literal("enable"), enabled: z.boolean() }).strict().parse(request.body);
  response.json(await route(request, response, { action: "memory-enable", id: webhookIdParam(request), enabled: body.enabled }));
}));
app.put("/api/automations/:id", handle(async (request, response) => {
  response.json(await route(request, response, { action: "update", id: z.string().uuid().parse(request.params.id), input: webhookInputSchema.parse(request.body) }));
}));
app.post("/api/automations/:id/transfer", handle(async (request, response) => {
  const body = z.object({ nodeId: z.string().uuid() }).strict().parse(request.body);
  response.json(await route(request, response, { action: "transfer", id: webhookIdParam(request), nodeId: body.nodeId }));
}));
app.post("/api/automations/:id/regenerate", handle(async (request, response) => {
  response.json(await route(request, response, { action: "regenerate", id: z.string().uuid().parse(request.params.id) }));
}));
app.get("/api/automations/:id/history", handle(async (request, response) => {
  response.json(await route(request, response, { action: "history", id: z.string().uuid().parse(request.params.id) }));
}));
app.post("/api/automations/:id/run", handle(async (request, response) => {
  response.json(await route(request, response, { action: "run", id: z.string().uuid().parse(request.params.id) }));
}));
/** Which automations of a project hide their conversations, for the history list. Every signed-in person may ask; it carries no addresses or instructions. */
app.get("/api/projects/:projectId/automations", handle(async (request, response) => {
  if (!await getProject(request.params.projectId)) throw new WebhookError(404, "Project not found");
  const { automations, errors } = await listProjectAutomations(request.params.projectId);
  response.json({ automations: automations.filter(item => item.trigger === "schedule").map(({ id, hideFromHistory }) => ({ id, hideFromHistory })), errors });
}));
app.delete("/api/automations/:id", handle(async (request, response) => {
  await route(request, response, { action: "delete", id: z.string().uuid().parse(request.params.id) });
  response.status(204).end();
}));

