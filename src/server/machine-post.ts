import { signClusterRequest } from "../cluster-protocol.js";
import { peerFetch } from "../relay/transport.js";
import { peers } from "./saved-commands.js";

/** A signed request to another machine of one of the person's clusters; the machine proves itself by its signature, not by an address. */
export async function signedMachinePost(nodeId: string, target: string, body: unknown, timeoutMs: number): Promise<globalThis.Response> {
  const context = await peers(), peer = context.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (!peer) throw new Error("That machine is no longer in one of your clusters");
  const bytes = Buffer.from(JSON.stringify(body));
  return peerFetch(new URL(target, peer.url), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs), body: bytes,
    headers: { "Content-Type": "application/json", Authorization: signClusterRequest(context.db, context.local, peer.nodeId, "POST", target, bytes) },
  }, peer.nodeId);
}
