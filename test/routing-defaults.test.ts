import assert from "node:assert/strict";
import test from "node:test";
import { defaultRoutingPolicy, readRoutingDefaults, routingPolicySchema, validateRoutingPolicy, type RoutingPolicy } from "../src/routing-policy.js";

test("routing-defaults.json parses and every candidate passes validateRoutingPolicy", () => {
  const defaults = readRoutingDefaults();
  assert.match(defaults.reviewedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(defaults.categories.length >= 1);
  for (const category of defaults.categories) {
    for (const [harness, candidates] of Object.entries(category.candidates)) assert.ok(candidates.length >= 1, `${harness} level ${category.level} has candidates`);
  }
  assert.doesNotThrow(() => validateRoutingPolicy(defaultRoutingPolicy()));
});

test("defaultRoutingPolicy uses the first candidate as mapping and the rest as fallbacks", () => {
  const defaults = readRoutingDefaults();
  const policy = defaultRoutingPolicy();
  for (const category of defaults.categories) {
    for (const [harness, [first, ...rest]] of Object.entries(category.candidates)) {
      const mapping = policy.harnesses[harness]?.levels[category.level];
      assert.ok(mapping, `${harness} level ${category.level} is mapped`);
      assert.equal(mapping.modelId, first.modelId);
      assert.equal(mapping.thinkingLevel, first.thinkingLevel);
      assert.equal(mapping.description, category.description);
      assert.deepEqual((mapping.fallbacks ?? []).map(({ modelId, thinkingLevel }) => [modelId, thinkingLevel]), rest.map(({ modelId, thinkingLevel }) => [modelId, thinkingLevel]));
    }
  }
});

function piPolicy(fallbacks: unknown[]): RoutingPolicy {
  return routingPolicySchema.parse({
    enabled: true, classifierId: "typesafe", evalCadence: { mode: "every-n", n: 1 }, confidenceThreshold: 0.3,
    harnesses: { pi: { levels: { "2": { provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "medium", description: "Git work", fallbacks } } } },
  });
}

test("validateRoutingPolicy rejects a fallback with gpt-5.6-sol", () => {
  assert.throws(() => validateRoutingPolicy(piPolicy([{ provider: "openai-codex", modelId: "gpt-5.6-sol", thinkingLevel: "medium" }])), /not allowed for automatic routing/);
  assert.throws(() => validateRoutingPolicy(piPolicy([{ provider: "openai-codex", modelId: "gpt-6-sol", thinkingLevel: "ultra" }])), /thinking level/);
  assert.throws(() => validateRoutingPolicy(piPolicy([{ modelId: "gpt-6-sol", thinkingLevel: "medium" }])), /needs a provider/);
  assert.doesNotThrow(() => validateRoutingPolicy(piPolicy([{ provider: "openai-codex", modelId: "gpt-6-sol", thinkingLevel: "medium" }])));
});

test("a saved policy without fallbacks still parses", () => {
  const policy = routingPolicySchema.parse({
    enabled: true, classifierId: "typesafe", evalCadence: { mode: "first-message" }, confidenceThreshold: 0.5,
    harnesses: { claude: { levels: { "6": { modelId: "sonnet", thinkingLevel: "medium", description: "Complex coding" } } } },
  });
  assert.equal(policy.harnesses.claude.levels["6"]?.fallbacks, undefined);
});
