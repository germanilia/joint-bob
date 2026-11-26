import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { getClusterNode, type ClusterPeer } from "../cluster.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { isTrustedTwin } from "../cluster-sharing-policy.js";
import { getConversationOwnership, sameConversationOwnership, type ConversationOwnership } from "../conversation-ownership.js";
import { getConversationRecord } from "../conversation-records.js";
import { requireAdmin } from "./admin.js";
import { sendError } from "./http-auth.js";
import { announceToNodeAdmins } from "./realtime.js";
import { getRuntimePeer, listRuntimePeers, runtimeFetch } from "./runtime-peers.js";
import { ownershipSchema } from "./schemas.js";
import { ConversationTransferError } from "./sessions-helpers.js";
import { app } from "./state.js";
import { TakebackWindow, TAKEBACK_WINDOW_MS } from "./takeback-window.js";

const route = "/api/cluster/sessions/takeback";
const noticeSchema = z.object({ id: z.string().uuid(), title: z.string().max(120), requester: z.string().max(255), owner: z.string().max(255) });
type Notice = z.infer<typeof noticeSchema>;
const requests = new Map<string, {
  projectId: string; record: ConversationOwnership; destinationId: string; window: TakebackWindow; twins: ClusterPeer[];
}>();
const notices = new Map<string, { notice: Notice; ownerId: string; deadline: number; closeTimer: NodeJS.Timeout }>();

function closeNotice(id: string): void {
  const entry = notices.get(id);
  if (!entry) return;
  clearTimeout(entry.closeTimer);
  notices.delete(id);
  announceToNodeAdmins({ type: "takebackClosed", id });
}

function showNotice(notice: Notice, ownerId: string, waitMs: number): void {
  if (notices.has(notice.id) || !Number.isFinite(waitMs) || waitMs <= 0 || waitMs > TAKEBACK_WINDOW_MS) return;
  notices.set(notice.id, { notice, ownerId, deadline: Date.now() + waitMs, closeTimer: setTimeout(() => closeNotice(notice.id), waitMs).unref() });
  announceToNodeAdmins({ type: "takebackRequested", ...notice, waitMs });
}

async function peerRequest(peer: ClusterPeer, body: object, signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(15_000);
  return runtimeFetch(`${peer.url}${route}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
}

function notifyTwin(peer: ClusterPeer, body: object): void {
  void peerRequest(peer, body).then(response => {
    if (!response.ok) console.warn(`Could not update takeback notice on ${peer.name} (${response.status})`);
  }).catch(error => console.warn(`Could not update takeback notice on ${peer.name}:`, error));
}

function decide(id: string, action: "accept" | "decline"): boolean {
  const request = requests.get(id);
  if (!request || !request.window[action]()) return false;
  closeNotice(id);
  for (const twin of request.twins) notifyTwin(twin, { action: "close", id });
  return true;
}

export async function waitForOwnerTakeback(projectId: string, record: ConversationOwnership, owner: ClusterPeer, title: string, signal: AbortSignal): Promise<void> {
  const begin = await peerRequest(owner, { action: "begin", projectId, record, title }, signal);
  if (!begin.ok) throw new ConversationTransferError(`Could not notify ${owner.name}: ${(await begin.json()).error ?? begin.status}`);
  const { id, waitMs } = z.object({ id: z.string().uuid(), waitMs: z.number().int().min(0).max(TAKEBACK_WINDOW_MS) }).parse(await begin.json());
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await delay(Math.min(1000, deadline - Date.now()), undefined, { signal });
    const status = await peerRequest(owner, { action: "status", projectId, id }, signal);
    if (!status.ok) {
      await delay(Math.max(0, deadline - Date.now()), undefined, { signal });
      break;
    }
    if ((await status.json()).result !== "pending") break;
  }
  const finish = await peerRequest(owner, { action: "finish", projectId, id }, signal);
  if (!finish.ok) throw new ConversationTransferError(`Takeback did not complete: ${(await finish.json()).error ?? finish.status}`);
}

const id = z.string().uuid();
const machineRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("begin"), projectId: z.string().min(1), record: ownershipSchema, title: z.string().max(120) }),
  z.object({ action: z.literal("finish"), projectId: z.string().min(1), id }),
  z.object({ action: z.literal("status"), projectId: z.string().min(1), id }),
  z.object({ action: z.literal("notice"), notice: noticeSchema, waitMs: z.number().int().min(0).max(TAKEBACK_WINDOW_MS) }),
  z.object({ action: z.literal("close"), id }),
  z.object({ action: z.literal("decline"), id }),
  z.object({ action: z.literal("accept"), id }),
]);

async function beginTakeback(payload: Extract<z.infer<typeof machineRequest>, { action: "begin" }>, sender: string) {
  const { projectId, record, title } = payload;
  const local = await getClusterNode();
  if (!await getConversationRecord(projectId, record.engine, record.sessionId)) throw new ConversationTransferError("Conversation not found in this project");
  const requester = await getRuntimePeer(sender);
  if (!requester) throw new ConversationTransferError("Requesting node is unavailable");
  const db = await clusterV2Database();
  const twins = (await listRuntimePeers()).filter(peer => peer.id !== sender && isTrustedTwin(db, local.id, peer.id));
  if (record.ownerNodeId !== local.id || !sameConversationOwnership(await getConversationOwnership(record.engine, record.sessionId), record)) {
    throw new ConversationTransferError("Conversation ownership changed; reopen it and try again");
  }
  const window = new TakebackWindow();
  const notice = { id: randomUUID(), title, requester: requester.name, owner: local.name };
  requests.set(notice.id, { projectId, record, destinationId: sender, window, twins });
  setTimeout(() => requests.delete(notice.id), TAKEBACK_WINDOW_MS + 60_000).unref();
  showNotice(notice, local.id, TAKEBACK_WINDOW_MS);
  for (const twin of twins) notifyTwin(twin, { action: "notice", notice, waitMs: TAKEBACK_WINDOW_MS });
  return { id: notice.id, waitMs: TAKEBACK_WINDOW_MS };
}

app.post(route, async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const sender = response.locals.machineNodeId as string;
    const payload = machineRequest.parse(request.body);
    if (payload.action === "begin") { response.json(await beginTakeback(payload, sender)); return; }
    if (payload.action === "finish" || payload.action === "status") {
      const pending = requests.get(payload.id);
      if (!pending || pending.projectId !== payload.projectId || pending.destinationId !== sender) { sendError(response, 409, "Takeback request is no longer available"); return; }
      const result = pending.window.result();
      if (payload.action === "status") { response.json({ result }); return; }
      const current = await getConversationOwnership(pending.record.engine, pending.record.sessionId);
      if (result !== "elapsed" || !sameConversationOwnership(current, pending.record)) {
        sendError(response, 409, result === "declined" ? "The controlling node declined the request" : "Takeback is still pending or ownership changed"); return;
      }
      response.json({ ok: true }); return;
    }
    // The signed runtime gate already verified that this sender is a trusted twin.
    if (payload.action === "notice") { showNotice(payload.notice, sender, payload.waitMs); response.json({ ok: true }); return; }
    if (payload.action === "close") {
      if (notices.get(payload.id)?.ownerId === sender) closeNotice(payload.id);
      response.json({ ok: true }); return;
    }
    if (!requests.get(payload.id)?.twins.some(twin => twin.id === sender) || !decide(payload.id, payload.action)) {
      sendError(response, 409, "Takeback request is no longer pending"); return;
    }
    response.json({ ok: true });
  } catch (error) {
    if (error instanceof ConversationTransferError) { sendError(response, 409, error.message); return; }
    next(error);
  }
});

app.get("/api/conversation-takebacks", requireAdmin, (_request, response) => {
  response.json({ notices: [...notices.values()].filter(entry => entry.deadline > Date.now())
    .map(({ notice, deadline }) => ({ ...notice, waitMs: Math.max(0, deadline - Date.now()) })) });
});

app.post("/api/conversation-takebacks/:id/:action", requireAdmin, async (request, response, next) => {
  try {
    const requestId = id.parse(request.params.id);
    const action = z.enum(["accept", "decline"]).parse(request.params.action);
    const entry = notices.get(requestId);
    if (!entry) { sendError(response, 409, "Takeback request is no longer pending"); return; }
    if (entry.ownerId === (await getClusterNode()).id) {
      if (!decide(requestId, action)) { sendError(response, 409, "Takeback request is no longer pending"); return; }
    } else {
      const owner = await getRuntimePeer(entry.ownerId);
      if (!owner) { sendError(response, 409, "The controlling node is unavailable"); return; }
      const reply = await peerRequest(owner, { action, id: requestId });
      if (!reply.ok) { sendError(response, reply.status, (await reply.json()).error); return; }
      closeNotice(requestId);
    }
    response.json({ ok: true });
  } catch (error) { next(error); }
});
