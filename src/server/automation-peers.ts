// Talking to the other machines about their automations, kept apart from the routes that manage them so the
// conversation lists and the scheduler can ask without loading every route module before the server has set up
// its body parsing.
import { getClusterNode } from "../cluster.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { signClusterRequest } from "../cluster-protocol.js";
import { peerFetch } from "../relay/transport.js";
import { listWebhooks, WebhookError, type Webhook } from "../webhooks.js";
import { peerSnapshot, staleSnapshotReason } from "./peer-snapshots.js";
import { listRuntimePeers } from "./runtime-peers.js";

/** One signed command to another machine's automation commands. A lost answer may follow a successful write, so nothing here retries. */
export async function signedAutomationFetch(peer: { id: string; url: string }, command: object, timeoutMs: number): Promise<unknown> {
  const local = await getClusterNode();
  const target = "/api/cluster/v2/automations", body = Buffer.from(JSON.stringify(command));
  try {
    const reply = await peerFetch(new URL(target, peer.url), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs), body,
      headers: { "Content-Type": "application/json", Authorization: signClusterRequest(await clusterV2Database(), local.id, peer.id, "POST", target, body) },
    }, peer.id);
    const result = await reply.json() as { error?: string };
    if (!reply.ok) throw new WebhookError(reply.status, result.error || "The machine that owns it rejected the request");
    return result;
  } catch (error) {
    if (error instanceof WebhookError) throw error;
    throw new WebhookError(503, "The machine that owns it did not respond. Check its list before retrying.");
  }
}

/** The automations of one project on every machine that holds some, as other lists and the history filter read them. A slow machine shows its last answer. */
export async function listProjectAutomations(projectId: string): Promise<{ automations: Webhook[]; errors: Array<{ nodeId: string; error: string }> }> {
  const local = await getClusterNode();
  const nodes = [local, ...await listRuntimePeers(projectId)];
  const results = await Promise.all(nodes.map(async (node) => {
    try {
      if (node.id === local.id) return { nodeId: node.id, automations: listWebhooks(await clusterV2Database()).filter(hook => !hook.reply && hook.target.projectId === projectId) };
      const remote = await peerSnapshot(`automations:${projectId}`, node.id, async () => await signedAutomationFetch(node, { action: "list", projectId }, 3000) as { automations: Webhook[] });
      return { nodeId: node.id, automations: remote.value.automations, ...(remote.fresh ? {} : { error: staleSnapshotReason(remote.fetchedAt) }) };
    } catch (error) {
      return { nodeId: node.id, automations: [] as Webhook[], error: error instanceof Error ? error.message : String(error) };
    }
  }));
  return { automations: results.flatMap((result) => result.automations), errors: results.flatMap((result) => "error" in result && result.error ? [{ nodeId: result.nodeId, error: result.error }] : []) };
}
