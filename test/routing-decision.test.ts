import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { getClusterNode } from "../src/cluster.js";
import { addProject } from "../src/store.js";
import { deleteSecretAccount, genericSecretEnvironment, saveSecretAccount } from "../src/secrets.js";
import { save, settingsDatabase, value } from "../src/settings-store.js";
import { systemAiDefaults, systemAiSchema, systemAiSettings } from "../src/system-ai-config.js";
import { classifyForRouting } from "../src/routing-decision.js";
import type { DifficultyClassifier } from "../src/classifiers/contract.js";

const options = [{ level: 2, description: "Git work" }, { level: 6, description: "Complex coding" }];
const persist = (config: ReturnType<typeof systemAiDefaults>) => save(settingsDatabase(), "systemAI", JSON.stringify(config));

function recordingClassifier(result: { level: number; confidence: number } | null) {
  const keys: string[] = [];
  const classifier: DifficultyClassifier = { id: "typesafe", label: "stub", variableName: "TYPESAFE_AI_API_KEY",
    classify: async (_text, apiKey) => { keys.push(apiKey); return result && { ...result, score: result.level }; } };
  return { classifier, keys };
}

test("uses the system key, not project attachments", async () => {
  await getClusterNode();
  const account = await saveSecretAccount({ label: "system jev", provider: "typesafe", variables: [{ name: "TYPESAFE_AI_API_KEY", kind: "value", value: "synthetic-system" }] });
  const config = systemAiDefaults(); config.decision.typesafeAccountId = account.id; persist(config);
  const project = await addProject("No attachment", path.join(process.env.HOME!, "routing-decision-project"));
  assert.deepEqual(genericSecretEnvironment(project.id), {}, "the project carries no TypeSafe key");
  const { classifier, keys } = recordingClassifier({ level: 6, confidence: 0.8 });
  const result = await classifyForRouting("typesafe", "refactor the store", options, { classifier: () => classifier, relay: async () => { throw new Error("relay must not be asked"); } });
  assert.equal(result.source, "local");
  assert.equal(result.classification?.level, 6);
  assert.deepEqual(keys, ["synthetic-system"]);
  await deleteSecretAccount(account.id);
  persist(systemAiDefaults());
});

test("no system key and no relay → reason decision model unavailable", async () => {
  persist(systemAiDefaults());
  const { classifier, keys } = recordingClassifier({ level: 2, confidence: 0.9 });
  const result = await classifyForRouting("typesafe", "git status", options, { classifier: () => classifier, relay: async () => ({ classification: null, source: "none", reason: "decision model unavailable" }) });
  assert.deepEqual(result, { classification: null, source: "none", reason: "decision model unavailable" });
  assert.deepEqual(keys, [], "nothing is classified without a key");
});

test("no system key uses the relay's answer", async () => {
  persist(systemAiDefaults());
  const { classifier } = recordingClassifier(null);
  const result = await classifyForRouting("typesafe", "git status", options, { classifier: () => classifier,
    relay: async () => ({ classification: { level: 2, score: 2, confidence: 0.9 }, source: "relay:relay-node" }) });
  assert.equal(result.source, "relay:relay-node");
  assert.equal(result.classification?.level, 2);
});

test("classifier returning null → reason classifier failed", async () => {
  const account = await saveSecretAccount({ label: "system jev 2", provider: "typesafe", variables: [{ name: "TYPESAFE_AI_API_KEY", kind: "value", value: "synthetic-2" }] });
  const config = systemAiDefaults(); config.decision.typesafeAccountId = account.id; persist(config);
  const { classifier } = recordingClassifier(null);
  const result = await classifyForRouting("typesafe", "anything", options, { classifier: () => classifier, relay: async () => { throw new Error("relay must not be asked"); } });
  assert.deepEqual(result, { classification: null, source: "local", reason: "classifier failed" });
  await deleteSecretAccount(account.id);
  persist(systemAiDefaults());
});

test("older saved System AI without routing parses with defaults", () => {
  const { routing: _routing, ...older } = systemAiDefaults();
  save(settingsDatabase(), "systemAI", JSON.stringify(older));
  assert.ok(value("systemAI"));
  assert.deepEqual(systemAiSettings().routing, { enabled: true, shareWithRelay: false });
  assert.throws(() => systemAiSchema.parse({ ...older, routing: { enabled: true } }));
});

test("saving System AI without routing keeps the stored routing (older twin or old page)", async () => {
  const { withStoredRouting } = await import("../src/system-ai-config.js");
  const stored = systemAiDefaults(); stored.routing = { enabled: false, shareWithRelay: true };
  save(settingsDatabase(), "systemAI", JSON.stringify(stored));
  const { routing: _dropped, ...older } = systemAiDefaults();
  assert.deepEqual((withStoredRouting(older) as { routing: unknown }).routing, { enabled: false, shareWithRelay: true });
  const explicit = { ...systemAiDefaults(), routing: { enabled: true, shareWithRelay: false } };
  assert.deepEqual((withStoredRouting(explicit) as { routing: unknown }).routing, { enabled: true, shareWithRelay: false }, "an explicit value wins");
  persist(systemAiDefaults());
});
