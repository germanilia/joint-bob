import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { RELAY_DECISION_KEY } from "./classifiers/relay-key.js";
import { getClusterNode } from "./cluster.js";
import { clusterV2Database } from "./cluster-v2-store.js";
import { JEV_ENDPOINT } from "./guardian/model.js";
import { relayMachine, servingSettings } from "./relay/store.js";
import { RelayDecisionRefused, relayTargets } from "./routing-decision-relay.js";
import { systemAiSettings, type SystemAiSettings } from "./system-ai-config.js";
import { systemDecisionKey } from "./system-ai.js";

/**
 * Every Jev use on a machine without its own TypeSafe key (summaries, task assessment, feedback, team decisions,
 * knowledge cleanup, quality analytics) is asked through the relay that lends its decision model: the machine sends the
 * request body, the relay adds its System AI key and returns Jev's answer. The key never leaves the relay.
 */
export const DECISION_ASK_PATH = "/api/cluster/v2/decision-model/ask";
export const decisionAskSchema = z.object({ body: z.string().max(1_000_000) }).strict();

/** A machine's key for Jev: its own, else the stand-in for a relay that lends its decision model. Throws when neither exists. */
export async function systemDecisionKeyOrRelay(model: "typesafe" | "laya"): Promise<string> {
  try { return systemDecisionKey(model); }
  catch (error) {
    if (model === "typesafe" && (await relayTargets()).length) return RELAY_DECISION_KEY;
    throw error;
  }
}

/** On a machine: the Jev request, sent to the first relay that answers it. */
export async function fetchThroughDecisionRelay(init: RequestInit): Promise<Response> {
  const { signedFetch } = await import("./server/cluster-v2.js");
  const db = await clusterV2Database(), local = await getClusterNode();
  let last: Response | undefined;
  let lastError: unknown;
  for (const target of await relayTargets()) {
    try {
      const answer = await signedFetch(db, local.id, target.relayNodeId, target.clusterId, DECISION_ASK_PATH, { body: String(init.body) }, init.signal!);
      if (answer.ok) return answer;
      last = answer;
    } catch (error) { lastError = error; }
  }
  if (last) return last;
  if (lastError) throw lastError;
  throw new Error("No relay lends its decision model to this machine");
}

/** On the relay: one admitted machine's Jev request, asked with this relay's own key while it shares its decision model. */
export async function answerRelayAsk(db: DatabaseSync, sender: string, body: string, signal: AbortSignal,
  dependencies: { settings?: () => SystemAiSettings; key?: () => string; fetchImpl?: typeof fetch } = {}): Promise<Response> {
  if (!servingSettings(db).enabled || !(dependencies.settings ?? systemAiSettings)().routing.shareWithRelay) throw new RelayDecisionRefused(403, "This relay does not share its decision model");
  if (relayMachine(db, sender)?.status !== "admitted") throw new RelayDecisionRefused(403, "Only machines admitted to this relay may use its decision model");
  let key: string;
  try { key = (dependencies.key ?? (() => systemDecisionKey("typesafe")))(); }
  catch { throw new RelayDecisionRefused(409, "The relay has no decision credential"); }
  return (dependencies.fetchImpl ?? fetch)(JEV_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body, redirect: "error", signal });
}
