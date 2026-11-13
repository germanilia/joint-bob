import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { getSharingCluster } from "../cluster-sharing-policy.js";
import { pinnedClusterPublicKey, verifyClusterMessage } from "../cluster-identity.js";
import { ClusterV2HttpError } from "../cluster-v2-errors.js";
const uuid = z.string().uuid();
const authorizationSchema = z.object({ clusterId: uuid, poolOwnerNodeId: uuid, poolId: uuid, profileId: uuid, requesterNodeId: uuid, authorized: z.literal(true) }).strict();
const replySchema = z.object({ authorization: authorizationSchema, signerNodeId: uuid, signature: z.string() }).strict();
/** A disconnected host cannot spend on a cached membership the manager has revoked. */
export async function authorizeClusterPoolUse(db: DatabaseSync, localNodeId: string, requesterNodeId: string, input: { clusterId: string; poolId: string; profileId: string }): Promise<void> {
  const state = getSharingCluster(db, input.clusterId), manager = state.managerNodeId;
  if (state.closed || !manager) throw new ClusterV2HttpError(403, "Cluster is closed");
  if (manager === localNodeId) return;
  const { signedPost } = await import("../server/cluster-v2.js");
  const payload = { ...input, poolOwnerNodeId: localNodeId, requesterNodeId };
  const reply = replySchema.parse(await signedPost(db, localNodeId, manager, input.clusterId, "/api/cluster/v2/subscription-pools/authorize-token", payload));
  const expected = authorizationSchema.parse({ ...payload, authorized: true }), key = pinnedClusterPublicKey(db, manager);
  if (!key || reply.signerNodeId !== manager || JSON.stringify(reply.authorization) !== JSON.stringify(expected)
    || !verifyClusterMessage(key, "provider-pool-token-authorization", JSON.stringify(reply.authorization), reply.signature)) throw new ClusterV2HttpError(403, "Cluster manager did not authorize this pool use");
}
