import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { AuthSession } from "../auth.js";
import { listEntityAuditEvents, recordAuditEvent } from "../audit.js";
import { removeAssistantCapabilities } from "../assistant-capabilities.js";
import { AskRefusal, startAskOn, waitForAsk } from "../assistant-collaboration/ask.js";
import { localAssistantSummaries } from "../assistant-collaboration/directory.js";
import { getAsk } from "../assistant-collaboration/store.js";
import { announceAssistantChanges } from "../assistant-collaboration/twin-sync.js";
import { accountInCluster } from "../cluster-accounts.js";
import { clusterAssistant, forgetClusterAssistant, hostedClusterAssistants, type ClusterAssistantRecord } from "../cluster-assistants.js";
import { getClusterNode } from "../cluster.js";
import { ensureMembershipSchema } from "../cluster-membership.js";
import { getSharingCluster, listSharingClusterMembers, listSharingMemberships } from "../cluster-sharing-policy.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { deletePersonalAssistant, getPersonalAssistantById, personalAssistantDatabase, savePersonalAssistant } from "../personal-assistants.js";
import { listWebhookSkills, removeWebhookSkill } from "../webhook-skills.js";
import { signedMachinePost as signedPost } from "./machine-post.js";
import { sendError } from "./http-auth.js";
import { peers } from "./saved-commands.js";
import { app } from "./state.js";

// Cluster assistants at work: what this machine hosts, what the person's clusters offer on other machines, asking one (here
// or on its host, over the signed machine channel), and changing one. Every ask and every change is written to the host's
// audit log under the assistant, with who did it.

const AUDIT_ENTITY = "cluster-assistant";
const LIST_TARGET = "/api/cluster/v2/cluster-assistants/list";
const ASK_TARGET = "/api/cluster/v2/cluster-assistants/ask";
const STATUS_TARGET = "/api/cluster/v2/cluster-assistants/ask-status";
const DIRECTORY_TTL_MS = 60_000;
const PEER_TIMEOUT_MS = 5_000;
const POLL_MS = 3_000;

/** A cluster assistant as a member sees it: what it is for, where it runs, and which cluster it belongs to. */
export interface ClusterAssistantView {
  id: string; name: string; about: string; has: string[];
  clusterId: string; clusterName: string; nodeId: string; machineName: string;
}
const viewSchema = z.object({
  id: z.string().max(100), name: z.string().max(200), about: z.string().max(300), has: z.array(z.string().max(200)).max(100),
  clusterId: z.string().max(100), clusterName: z.string().max(200), nodeId: z.string().max(100), machineName: z.string().max(200),
}).strict();

/** Who asked, as the asking machine says: the machine is proven by its signature, the person by that machine. */
export interface ClusterAsker { nodeId: string; accountId: string; name: string }

const audit = (eventType: string, assistantId: string, actor: { type: "user" | "node"; id: string }, details: Record<string, string | number | boolean | null>): void => {
  recordAuditEvent({ eventType: `cluster-assistant.${eventType}`, actorType: actor.type, actorId: actor.id, entityType: AUDIT_ENTITY, entityId: assistantId, details });
};
export function auditClusterAssistantCreated(assistantId: string, accountId: string, clusterId: string, name: string): void {
  audit("created", assistantId, { type: "user", id: accountId }, { clusterId, name });
}

/** The cluster assistants this machine hosts, for the clusters named; with no list, for every cluster. */
export async function hostedViews(clusterIds?: string[]): Promise<ClusterAssistantView[]> {
  const db = await clusterV2Database(), local = await getClusterNode();
  const views: ClusterAssistantView[] = [];
  for (const record of hostedClusterAssistants()) {
    if (clusterIds && !clusterIds.includes(record.clusterId)) continue;
    const assistant = await getPersonalAssistantById(record.assistantId);
    const summary = assistant && (await localAssistantSummaries(assistant.accountId)).find((candidate) => candidate.id === assistant.id);
    if (!assistant || !summary) continue;
    views.push({ id: assistant.id, name: assistant.name, about: summary.about, has: summary.has, clusterId: record.clusterId, clusterName: getSharingCluster(db, record.clusterId).name, nodeId: local.id, machineName: local.name });
  }
  return views;
}

const directory = new Map<string, { at: number; views: ClusterAssistantView[] }>();

/** What one member machine hosts for the clusters shared with it, as last read; a machine that cannot be reached offers nothing now. */
async function remoteViews(nodeId: string, clusterIds: string[]): Promise<ClusterAssistantView[]> {
  const held = directory.get(nodeId);
  if (held && Date.now() - held.at < DIRECTORY_TTL_MS) return held.views;
  let views: ClusterAssistantView[] = [];
  try {
    const response = await signedPost(nodeId, LIST_TARGET, {}, PEER_TIMEOUT_MS);
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Peer returned ${response.status}`); }
    // A host may only speak for itself, and only for clusters this machine shares with it.
    views = z.object({ assistants: z.array(viewSchema).max(200) }).strict().parse(await response.json()).assistants
      .filter((view) => view.nodeId === nodeId && clusterIds.includes(view.clusterId));
  } catch (error) {
    console.warn(`Could not list the cluster assistants on ${nodeId}: ${(error as Error).message}`);
  }
  directory.set(nodeId, { at: Date.now(), views });
  return views;
}

/** Every cluster assistant the person may ask: those of the clusters they joined, on this machine and on the other members'. */
export async function clusterAssistantsFor(accountId: string): Promise<ClusterAssistantView[]> {
  // A machine that never joined a cluster has no member tables yet; reading its peers needs them.
  ensureMembershipSchema(await clusterV2Database());
  const context = await peers();
  const mine = context.clusters.map((cluster) => cluster.id).filter((clusterId) => accountInCluster(context.db, accountId, clusterId));
  if (!mine.length) return [];
  const remote = await Promise.all(context.nodes.filter((node) => node.clusterIds.some((id) => mine.includes(id)))
    .map((node) => remoteViews(node.nodeId, node.clusterIds.filter((id) => mine.includes(id)))));
  return [...await hostedViews(mine), ...remote.flat()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** Starts the ask on this machine, the host: the assistant's turn runs as its owner, with its own sign-ins, in its shared project. */
async function startHostedAsk(assistantId: string, asker: ClusterAsker, message: string, purpose: string): Promise<string> {
  const record = clusterAssistant(assistantId);
  const assistant = record && await getPersonalAssistantById(assistantId);
  if (!record || !assistant) throw new AskRefusal("That cluster assistant is no longer here.");
  const local = await getClusterNode();
  const ask = await startAskOn({ id: assistant.id, name: assistant.name, nodeId: local.id }, {
    accountId: assistant.accountId, askerId: `cluster:${asker.nodeId}:${asker.accountId}`, askerName: asker.name, askerTurnRequestId: null, message, purpose,
  });
  audit("asked", assistant.id, { type: "user", id: asker.accountId }, { askId: ask.id, askerName: asker.name, askerNodeId: asker.nodeId, purpose: purpose.slice(0, 300) });
  return ask.id;
}

export interface ClusterAskOutcome { status: "completed" | "failed" | "running"; answer: string | null; error: string | null }

async function hostedStatus(askId: string, asker: Pick<ClusterAsker, "nodeId" | "accountId">, waitMs: number): Promise<ClusterAskOutcome> {
  const done = await waitForAsk(askId, `cluster:${asker.nodeId}:${asker.accountId}`, waitMs);
  return { status: done.status, answer: done.answer, error: done.error };
}

const outcomeSchema = z.object({ status: z.enum(["completed", "failed", "running"]), answer: z.string().max(1_000_000).nullable(), error: z.string().max(100_000).nullable() }).strict();

/**
 * Asks a cluster assistant for the person and waits up to `waitMs` for its answer. On another machine the ask is sent once
 * over the signed channel and only its status is read again. A refusal or an unreachable host is a failed outcome.
 */
export async function askClusterAssistant(view: ClusterAssistantView, asker: Omit<ClusterAsker, "nodeId">, message: string, purpose: string, waitMs: number): Promise<ClusterAskOutcome> {
  const local = await getClusterNode();
  try {
    if (view.nodeId === local.id) return await hostedStatus(await startHostedAsk(view.id, { ...asker, nodeId: local.id }, message, purpose), { ...asker, nodeId: local.id }, waitMs);
    const started = await signedPost(view.nodeId, ASK_TARGET, { assistantId: view.id, accountId: asker.accountId, name: asker.name, message, purpose }, 15_000);
    if (started.status === 409) return { status: "failed", answer: null, error: z.object({ error: z.string().max(500) }).parse(await started.json()).error };
    if (started.status !== 202) { await started.body?.cancel(); throw new Error(`Peer returned ${started.status}`); }
    const { askId } = z.object({ askId: z.string().uuid() }).parse(await started.json());
    for (const deadline = Date.now() + waitMs; ;) {
      const response = await signedPost(view.nodeId, STATUS_TARGET, { askId, accountId: asker.accountId }, 10_000);
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Peer returned ${response.status}`); }
      const outcome = outcomeSchema.parse(await response.json());
      if (outcome.status !== "running" || Date.now() >= deadline) return outcome;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } catch (error) {
    if (error instanceof AskRefusal) return { status: "failed", answer: null, error: error.message };
    console.warn(`Asking ${view.name} on ${view.machineName} failed: ${(error as Error).message}`);
    return { status: "failed", answer: null, error: `Couldn't reach ${view.name} on ${view.machineName}.` };
  }
}

// ── The machine channel: other members of the assistant's cluster ────────────────────────────────────────

function memberRoute(action: (sender: string, response: Response, body: unknown) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction): void => {
    void (async () => {
      if (response.locals.machineProtocol !== 2 || typeof response.locals.machineNodeId !== "string") { sendError(response, 403, "Forbidden"); return; }
      await action(response.locals.machineNodeId, response, request.body);
    })().catch((error) => error instanceof z.ZodError ? sendError(response, 400, "Invalid cluster assistant request") : next(error));
  };
}

/** The clusters this machine and the sender are both in. */
async function sharedClusters(sender: string): Promise<string[]> {
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  return listSharingMemberships(db, local).map((membership) => membership.clusterId)
    .filter((clusterId) => !getSharingCluster(db, clusterId).closed && listSharingClusterMembers(db, clusterId).some((member) => member.nodeId === sender));
}

app.post(LIST_TARGET, memberRoute(async (sender, response, body) => {
  z.object({}).strict().parse(body);
  response.json({ assistants: await hostedViews(await sharedClusters(sender)) });
}));

app.post(ASK_TARGET, memberRoute(async (sender, response, body) => {
  const input = z.object({ assistantId: z.string().uuid(), accountId: z.string().min(1).max(200), name: z.string().trim().min(1).max(200), message: z.string().min(1).max(100_000), purpose: z.string().max(2000) }).strict().parse(body);
  const record = clusterAssistant(input.assistantId);
  // Only a machine of the assistant's own cluster may ask it; any other is told nothing about it.
  if (!record || !(await sharedClusters(sender)).includes(record.clusterId)) { sendError(response, 404, "Assistant not found"); return; }
  try { response.status(202).json({ askId: await startHostedAsk(input.assistantId, { nodeId: sender, accountId: input.accountId, name: input.name }, input.message, input.purpose) }); }
  catch (error) { if (error instanceof AskRefusal) { sendError(response, 409, error.message); return; } throw error; }
}));

app.post(STATUS_TARGET, memberRoute(async (sender, response, body) => {
  const input = z.object({ askId: z.string().uuid(), accountId: z.string().min(1).max(200) }).strict().parse(body);
  const ask = await getAsk(input.askId);
  // An ask is read only by the machine and person that made it.
  if (!ask || ask.askerId !== `cluster:${sender}:${input.accountId}`) { sendError(response, 404, "Ask not found"); return; }
  response.json(await hostedStatus(input.askId, { nodeId: sender, accountId: input.accountId }, 0));
}));

// ── Changing one: on its host, or from the cluster's manager machine ─────────────────────────────────────
// Three kinds of people may change a cluster assistant, delete it and read its log: its creator and the admins of its host
// machine who are in the cluster (on the host), and the admins of the cluster's manager machine (from there, over the signed
// channel). A cluster has a manager machine and no admin role for people, so that machine's admins are the cluster's.

const MANAGE_TARGET = "/api/cluster/v2/cluster-assistants/manage";
type Hosted = NonNullable<Awaited<ReturnType<typeof getPersonalAssistantById>>>;
/** Who is changing it: the person, and the machine they are on when that is not the host. */
interface Manager { accountId: string; name: string; nodeId: string | null }

const manageSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read") }).strict(),
  z.object({ action: z.literal("change"), name: z.string().trim().min(1).max(100), instructions: z.string().max(20_000) }).strict(),
  z.object({ action: z.literal("remove-skill"), skillId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("delete") }).strict(),
  z.object({ action: z.literal("audit") }).strict(),
]);
type ManageCommand = z.infer<typeof manageSchema>;

const by = (manager: Manager) => ({ by: manager.name, ...(manager.nodeId ? { fromNodeId: manager.nodeId } : {}) });

/** Does what a manager asked to the assistant this machine hosts, and writes each change to its audit log. */
async function manageHosted(assistant: Hosted, manager: Manager, command: ManageCommand): Promise<unknown> {
  const db = await personalAssistantDatabase();
  const actor = { type: "user" as const, id: manager.accountId };
  if (command.action === "read") {
    return { name: assistant.name, instructions: assistant.instructions, skills: listWebhookSkills(db, assistant.id).map((skill) => ({ id: skill.id, name: skill.name })) };
  }
  if (command.action === "audit") {
    return { events: listEntityAuditEvents(AUDIT_ENTITY, assistant.id, 200).map(({ id, eventType, actorId, details, createdAt }) => ({ id, eventType, actorId, details, createdAt })) };
  }
  if (command.action === "change") {
    await savePersonalAssistant(assistant.accountId, { ...assistant, name: command.name, instructions: command.instructions }, assistant.id);
    audit("changed", assistant.id, actor, { ...by(manager), name: command.name, renamed: command.name !== assistant.name, instructionsChanged: command.instructions !== assistant.instructions });
  } else if (command.action === "remove-skill") {
    const skill = listWebhookSkills(db, assistant.id).find((candidate) => candidate.id === command.skillId);
    if (!skill) throw new ManageRefusal(404, "Skill not found");
    await removeWebhookSkill(db, assistant.id, skill.id);
    audit("skill-removed", assistant.id, actor, { ...by(manager), skill: skill.name });
  } else {
    await deletePersonalAssistant(assistant.accountId, assistant.id);
    await removeAssistantCapabilities(db, assistant.id);
    forgetClusterAssistant(assistant.id);
    audit("deleted", assistant.id, actor, { ...by(manager), name: assistant.name });
  }
  announceAssistantChanges();
  directory.clear();
  return { done: true };
}

class ManageRefusal extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

// The manager machine vouches for its own admin: its signature proves the machine, and only the cluster's manager is heard.
app.post(MANAGE_TARGET, memberRoute(async (sender, response, body) => {
  const input = z.object({ assistantId: z.string().uuid(), accountId: z.string().min(1).max(200), name: z.string().trim().min(1).max(200), command: manageSchema }).strict().parse(body);
  const record = clusterAssistant(input.assistantId);
  const assistant = record && getSharingCluster(await clusterV2Database(), record.clusterId).managerNodeId === sender ? await getPersonalAssistantById(record.assistantId) : undefined;
  if (!assistant) { sendError(response, 404, "Assistant not found"); return; }
  try { response.json(await manageHosted(assistant, { accountId: input.accountId, name: input.name, nodeId: sender }, input.command)); }
  catch (error) { if (error instanceof ManageRefusal) { sendError(response, error.status, error.message); return; } throw error; }
}));

/** On the host: its creator, and any admin of this machine who is in the assistant's cluster. */
async function managesHere(session: AuthSession, record: ClusterAssistantRecord): Promise<boolean> {
  return session.accountId === record.createdBy || (session.role === "admin" && accountInCluster(await clusterV2Database(), session.accountId, record.clusterId));
}

/** From elsewhere: an admin of this machine, when this machine is the manager of the assistant's cluster. */
async function managesFromHere(session: AuthSession, clusterId: string): Promise<boolean> {
  const db = await clusterV2Database();
  return session.role === "admin" && accountInCluster(db, session.accountId, clusterId) && getSharingCluster(db, clusterId).managerNodeId === (await getClusterNode()).id;
}

function personRoute(action: (session: AuthSession, request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction): void => {
    void action(response.locals.authSession as AuthSession, request, response).catch((error) => {
      if (error instanceof z.ZodError) sendError(response, 400, "Invalid cluster assistant change");
      else if (error instanceof ManageRefusal) sendError(response, error.status, error.message);
      else next(error);
    });
  };
}

/** Runs a manager's command on the assistant: here when this machine hosts it, otherwise on its host. Anyone else gets a 404. */
async function manage(session: AuthSession, id: string, command: ManageCommand): Promise<unknown> {
  const assistantId = z.string().uuid().parse(id);
  const record = clusterAssistant(assistantId);
  if (record) {
    const assistant = await managesHere(session, record) ? await getPersonalAssistantById(assistantId) : undefined;
    if (!assistant) throw new ManageRefusal(404, "Assistant not found");
    return manageHosted(assistant, { accountId: session.accountId, name: session.username, nodeId: null }, command);
  }
  const view = (await clusterAssistantsFor(session.accountId)).find((candidate) => candidate.id === assistantId);
  if (!view || !await managesFromHere(session, view.clusterId)) throw new ManageRefusal(404, "Assistant not found");
  const answer = await signedPost(view.nodeId, MANAGE_TARGET, { assistantId, accountId: session.accountId, name: session.username, command }, 15_000);
  const result = await answer.json() as { error?: string };
  if (!answer.ok) throw new ManageRefusal(answer.status === 404 ? 404 : 502, result.error ?? `${view.machineName} refused the change`);
  if (command.action !== "read" && command.action !== "audit") directory.clear();
  return result;
}

app.get("/api/control-center/cluster-assistants", personRoute(async (session, request, response) => {
  z.object({}).strict().parse(request.query);
  const local = (await getClusterNode()).id;
  const views = await clusterAssistantsFor(session.accountId);
  response.json({ assistants: await Promise.all(views.map(async (view) => {
    const record = view.nodeId === local ? clusterAssistant(view.id) : undefined;
    return { ...view, local: view.nodeId === local, canManage: record ? await managesHere(session, record) : await managesFromHere(session, view.clusterId) };
  })) });
}));

app.get("/api/control-center/cluster-assistants/:id", personRoute(async (session, request, response) => {
  response.json(await manage(session, request.params.id, { action: "read" }));
}));

app.put("/api/control-center/cluster-assistants/:id", personRoute(async (session, request, response) => {
  const input = z.object({ name: z.string().trim().min(1).max(100), instructions: z.string().max(20_000) }).strict().parse(request.body);
  response.json(await manage(session, request.params.id, { action: "change", ...input }));
}));

app.delete("/api/control-center/cluster-assistants/:id/skills/:skillId", personRoute(async (session, request, response) => {
  response.json(await manage(session, request.params.id, { action: "remove-skill", skillId: z.string().uuid().parse(request.params.skillId) }));
}));

app.delete("/api/control-center/cluster-assistants/:id", personRoute(async (session, request, response) => {
  response.json(await manage(session, request.params.id, { action: "delete" }));
}));

app.get("/api/control-center/cluster-assistants/:id/audit", personRoute(async (session, request, response) => {
  response.json(await manage(session, request.params.id, { action: "audit" }));
}));
