import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { DifficultyClassification, DifficultyClassifier } from "./classifiers/contract.js";
import { getDifficultyClassifier } from "./classifiers/registry.js";
import { getClusterNode } from "./cluster.js";
import { listSharingClusterMembers, listSharingMemberships } from "./cluster-sharing-policy.js";
import { clusterV2Database } from "./cluster-v2-store.js";
import { listMemberships, relayMachine, servingSettings } from "./relay/store.js";
import type { RelayClassify } from "./routing-decision.js";
import { systemAiSettings, type SystemAiSettings } from "./system-ai-config.js";
import { systemDecisionKey } from "./system-ai.js";

/** A member without its own decision credential asks the relay it uses; the relay classifies
    with its own key and returns only the classification. The key never leaves the relay. */
export const DECISION_RELAY_PATH = "/api/cluster/v2/decision-model/classify";
const MAX_DECISION_TEXT = 120_000;

export const decisionRelayRequestSchema = z.object({
  classifierId: z.enum(["typesafe", "laya"]),
  text: z.string().min(1).max(MAX_DECISION_TEXT),
  options: z.array(z.object({ level: z.number().int().min(1).max(10), description: z.string().min(1).max(1000) }).strict()).max(10),
}).strict();
export type DecisionRelayRequest = z.infer<typeof decisionRelayRequestSchema>;

const classificationSchema = z.object({ level: z.number().int().min(1).max(10), score: z.number(), confidence: z.number().min(0).max(1), abstained: z.boolean().optional() }).strict();

export class RelayDecisionRefused extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

interface RelayAnswerDependencies {
  settings?: () => SystemAiSettings;
  key?: (model: "typesafe" | "laya") => string;
  classifier?: (id: string) => DifficultyClassifier | undefined;
}

/** The relay side: only admitted machines of the relay this node serves, only while sharing is on. */
export async function answerRelayDecision(db: DatabaseSync, sender: string, input: DecisionRelayRequest, dependencies: RelayAnswerDependencies = {}): Promise<DifficultyClassification | null> {
  if (!servingSettings(db).enabled || !(dependencies.settings ?? systemAiSettings)().routing.shareWithRelay) throw new RelayDecisionRefused(403, "This relay does not share its decision model");
  if (relayMachine(db, sender)?.status !== "admitted") throw new RelayDecisionRefused(403, "Only machines admitted to this relay may use its decision model");
  const classifier = (dependencies.classifier ?? getDifficultyClassifier)(input.classifierId);
  if (!classifier) throw new RelayDecisionRefused(409, `Unknown classifier: ${input.classifierId}`);
  let apiKey: string;
  try { apiKey = (dependencies.key ?? systemDecisionKey)(input.classifierId); }
  catch { throw new RelayDecisionRefused(409, "The relay has no decision credential"); }
  try { return await classifier.classify(input.text, apiKey, { options: input.options }); } catch { return null; }
}

export interface RelayTarget { relayNodeId: string; clusterId: string }

interface RelayAskDependencies {
  targets?: () => Promise<RelayTarget[]>;
  send?: (target: RelayTarget, body: DecisionRelayRequest) => Promise<Response>;
}

const RELAY_TIMEOUT_MS = 15_000;
const REFUSAL_MEMORY_MS = 10 * 60_000;
/** Relays that refused or could not be reached are not asked again for ten minutes. */
const refusedUntil = new Map<string, number>();

/** Admitted relays, in a stable order, reachable through a cluster (relay groups included) both machines belong to. */
async function relayTargets(): Promise<RelayTarget[]> {
  const db = await clusterV2Database(), local = await getClusterNode();
  const clusters = listSharingMemberships(db, local.id, true).map(({ clusterId }) => clusterId);
  return listMemberships(db)
    .filter((relay) => relay.status === "admitted" && relay.relayNodeId)
    .map((relay) => relay.relayNodeId!)
    .sort()
    .flatMap((relayNodeId) => {
      const clusterId = clusters.find((id) => listSharingClusterMembers(db, id).some((member) => member.nodeId === relayNodeId));
      return clusterId ? [{ relayNodeId, clusterId }] : [];
    });
}

async function sendToRelay(target: RelayTarget, body: DecisionRelayRequest): Promise<Response> {
  const { signedFetch } = await import("./server/cluster-v2.js");
  const db = await clusterV2Database(), local = await getClusterNode();
  return signedFetch(db, local.id, target.relayNodeId, target.clusterId, DECISION_RELAY_PATH, body, AbortSignal.timeout(RELAY_TIMEOUT_MS));
}

export const classifyThroughRelay = async (classifierId: "typesafe" | "laya", text: string, options: DecisionRelayRequest["options"], dependencies: RelayAskDependencies = {}): ReturnType<RelayClassify> => {
  // The newest part of a long conversation is what the classifier judges; the relay accepts at most this much.
  const body = { classifierId, text: text.slice(-MAX_DECISION_TEXT), options };
  for (const target of await (dependencies.targets ?? relayTargets)()) {
    if ((refusedUntil.get(target.relayNodeId) ?? 0) > Date.now()) continue;
    const source = `relay:${target.relayNodeId}` as const;
    try {
      const answer = await (dependencies.send ?? sendToRelay)(target, body);
      if (!answer.ok) {
        // A rejected request (400) says nothing about the relay; refusals and outages are remembered.
        if (answer.status !== 400) refusedUntil.set(target.relayNodeId, Date.now() + REFUSAL_MEMORY_MS);
        continue;
      }
      const classification = classificationSchema.nullable().parse(await answer.json());
      return classification ? { classification, source } : { classification: null, source, reason: "classifier failed" };
    } catch {
      refusedUntil.set(target.relayNodeId, Date.now() + REFUSAL_MEMORY_MS);
    }
  }
  return { classification: null, source: "none", reason: "decision model unavailable" };
};
