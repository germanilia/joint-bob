import type { DatabaseSync } from "node:sqlite";
import { getSharingCluster, listSharingClusterMembers } from "../cluster-sharing-policy.js";
import { getClusterSubscriptionPool } from "./pool-sharing.js";
import { listSubscriptionSelections, type ProfileProvider } from "./store.js";

// A cluster assistant runs only on its cluster's subscriptions: the pool a relay assigned to the whole group, or, in a cluster
// without a relay, the profile or pool its owner chose for that cluster (a Cluster exception). It never falls back to the
// owner's workspace or default choice, to their only profile, or to the machine's own sign-in.

/** Whether the cluster has a subscription for these providers, for a cluster assistant owned by `ownerAccountId`. */
export function clusterHasSubscription(db: DatabaseSync, clusterId: string, ownerAccountId: string, providers: ProfileProvider[]): boolean {
  const assigned = getClusterSubscriptionPool(db, clusterId);
  if (assigned && listSharingClusterMembers(db, clusterId).some(({ nodeId }) => nodeId === assigned.poolOwnerNodeId)) return true;
  return listSubscriptionSelections(ownerAccountId).some((entry) => entry.scope === "cluster" && entry.scopeId === clusterId && providers.includes(entry.provider) && Boolean(entry.profileId || entry.poolId));
}

/** What the person is told when it has none. */
export function clusterSubscriptionMissing(db: DatabaseSync, clusterId: string): string {
  const name = getSharingCluster(db, clusterId).name;
  return `A cluster assistant runs only on its cluster's subscriptions, and "${name}" has none for this agent. Choose a profile or pool for the cluster "${name}" in Settings › Connections (a Cluster exception), or have its relay assign a pool to the group, then try again.`;
}
