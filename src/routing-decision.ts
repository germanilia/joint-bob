import type { DifficultyClassification, DifficultyClassifier, DifficultyClassifierOption } from "./classifiers/contract.js";
import { getDifficultyClassifier } from "./classifiers/registry.js";
import { systemDecisionKey } from "./system-ai.js";

export type DecisionSource = "local" | `relay:${string}`;
export type DecisionResult =
  | { classification: DifficultyClassification; source: DecisionSource }
  | { classification: null; source: DecisionSource | "none"; reason: string };

export type RelayClassify = (classifierId: "typesafe" | "laya", text: string, options: DifficultyClassifierOption[]) => Promise<DecisionResult>;

interface DecisionDependencies {
  classifier?: (id: string) => DifficultyClassifier | undefined;
  relay?: RelayClassify;
}

const relayFromModule: RelayClassify = async (...input) => (await import("./routing-decision-relay.js")).classifyThroughRelay(...input);

/** Classifies a prompt for routing with the System AI decision credential, which twins share.
    Without one, a relay that lends its decision model answers instead. Never throws. */
export async function classifyForRouting(classifierId: "typesafe" | "laya", text: string, options: DifficultyClassifierOption[], dependencies: DecisionDependencies = {}): Promise<DecisionResult> {
  const classifier = (dependencies.classifier ?? getDifficultyClassifier)(classifierId);
  if (!classifier) return { classification: null, source: "none", reason: "unknown classifier" };
  let apiKey: string;
  try { apiKey = systemDecisionKey(classifierId); }
  catch {
    try { return await (dependencies.relay ?? relayFromModule)(classifierId, text, options); }
    catch { return { classification: null, source: "none", reason: "decision model unavailable" }; }
  }
  let classification: DifficultyClassification | null = null;
  try { classification = await classifier.classify(text, apiKey, { options }); } catch { classification = null; }
  return classification ? { classification, source: "local" } : { classification: null, source: "local", reason: "classifier failed" };
}
