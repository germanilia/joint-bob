import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { publishedRelayPolicy } from "../relay/resource-policy.js";
import { relayMachine, servingSettings } from "../relay/store.js";
import { relayTargets } from "../routing-decision-relay.js";
import { systemDecisionKey } from "../system-ai.js";
import { JEV_ENDPOINT } from "./model.js";

/**
 * A relay's Jev key never leaves the relay. A member sends each check for the relay's rules to the relay
 * over the signed machine channel; the relay adds its own System AI key, asks Jev and returns the answer.
 */
export const GUARDIAN_ASK_PATH = "/api/cluster/v2/guardian/ask";
/** Content is cut into pieces of 100,000 characters before it is asked; JSON escaping can double one. */
export const guardianAskSchema = z.object({ body: z.string().max(1_000_000) }).strict();

export class RelayGuardianRefused extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

/** On a member: a `fetch` that sends the Jev request to the relay that imposes the rule instead of to Jev. */
export function fetchThroughRelay(relayNodeId: string): typeof fetch {
  return async (_url, init) => {
    const target = (await relayTargets()).find((candidate) => candidate.relayNodeId === relayNodeId);
    if (!target) throw new Error("No route to the relay that imposes this rule");
    const { signedFetch } = await import("../server/cluster-v2.js");
    const db = await clusterV2Database(), local = await getClusterNode();
    return signedFetch(db, local.id, relayNodeId, target.clusterId, GUARDIAN_ASK_PATH, { body: String(init!.body) }, init!.signal!);
  };
}

/** On the relay: one admitted machine's check, asked of Jev with this relay's own key, while the relay imposes Jev rules. */
export async function answerRelayGuardian(db: DatabaseSync, sender: string, body: string, signal: AbortSignal,
  dependencies: { key?: () => string; fetchImpl?: typeof fetch } = {}): Promise<Response> {
  if (!servingSettings(db).enabled) throw new RelayGuardianRefused(403, "This machine does not serve a relay");
  if (relayMachine(db, sender)?.status !== "admitted") throw new RelayGuardianRefused(403, "Only machines admitted to this relay may use its Guardian model");
  if (publishedRelayPolicy(db, (await getClusterNode()).id).body.guardian?.model !== "jev") throw new RelayGuardianRefused(403, "This relay imposes no Jev rules");
  let key: string;
  try { key = (dependencies.key ?? (() => systemDecisionKey("typesafe")))(); }
  catch (error) { throw new RelayGuardianRefused(409, error instanceof Error ? error.message : "The relay has no TypeSafe key"); }
  return (dependencies.fetchImpl ?? fetch)(JEV_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body, redirect: "error", signal });
}
