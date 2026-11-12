import assert from "node:assert/strict";
import test from "node:test";
import { defaultRoutingPolicy, readRoutingDefaults, routingDefaultsSchema, routingPolicySchema, scoredCandidates, subscriptionFirst, validateRoutingPolicy, type RoutingPolicy } from "../src/routing-policy.js";

test("routing-defaults.json parses, every model cites its evidence, and the generated policy validates", () => {
  const defaults = readRoutingDefaults();
  assert.match(defaults.reviewedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(defaults.sources.length >= 1);
  for (const [harness, models] of Object.entries(defaults.models)) {
    for (const model of models) assert.ok(model.evidence.trim(), `${harness} ${model.modelId} cites evidence`);
  }
  assert.doesNotThrow(() => validateRoutingPolicy(defaultRoutingPolicy()));
});

test("Pi routes only to its subscriptions: Codex and Z.ai", () => {
  const providers = new Set(readRoutingDefaults().models.pi.map((model) => model.provider));
  assert.deepEqual([...providers].sort(), ["openai-codex", "zai"]);
});

test("defaultRoutingPolicy maps each level to its scored candidates, first as mapping, rest as fallbacks", () => {
  const defaults = readRoutingDefaults();
  const policy = defaultRoutingPolicy();
  for (const category of defaults.categories) {
    for (const harness of Object.keys(defaults.models)) {
      const [first, ...rest] = scoredCandidates(defaults, harness, category.level);
      const mapping = policy.harnesses[harness]?.levels[category.level];
      if (!first) { assert.equal(mapping, undefined); continue; }
      assert.ok(mapping, `${harness} level ${category.level} is mapped`);
      assert.deepEqual([mapping.modelId, mapping.thinkingLevel, mapping.description], [first.modelId, first.thinkingLevel, category.description]);
      assert.deepEqual((mapping.fallbacks ?? []).map(({ modelId, thinkingLevel }) => [modelId, thinkingLevel]), rest.map(({ modelId, thinkingLevel }) => [modelId, thinkingLevel]));
    }
  }
});

const synthetic = routingDefaultsSchema.parse({
  reviewedAt: "2026-11-12", notes: "", sources: [{ id: "s1", title: "Fixture", url: "https://example.com", date: "2026-11-12" }],
  categories: [{ level: "6", description: "Complex coding", minimumScore: 70 }],
  models: { pi: [
    { provider: "api-cheap", modelId: "api-cheap", billing: "api", priceUsdPerMTok: { input: 0.1, output: 0.1 }, levels: { "6": { score: 90, thinkingLevel: "high" } }, evidence: "s1" },
    { provider: "sub", modelId: "sub-pricey", billing: "subscription", priceUsdPerMTok: { input: 5, output: 25 }, levels: { "6": { score: 80, thinkingLevel: "high" } }, evidence: "s1" },
    { provider: "sub", modelId: "sub-cheap", billing: "subscription", priceUsdPerMTok: { input: 1, output: 4 }, levels: { "6": { score: 75, thinkingLevel: "medium" } }, evidence: "s1" },
    { provider: "sub", modelId: "sub-weak", billing: "subscription", priceUsdPerMTok: { input: 0.1, output: 0.4 }, levels: { "6": { score: 40, thinkingLevel: "low" } }, evidence: "s1" },
  ] },
});

test("adequate models are tried subscription first, then cheapest; weaker ones are left out", () => {
  assert.deepEqual(scoredCandidates(synthetic, "pi", "6").map((item) => item.modelId), ["sub-cheap", "sub-pricey", "api-cheap"]);
});

test("when no model is good enough for a level, the strongest are tried first", () => {
  const strict = { ...synthetic, categories: [{ ...synthetic.categories[0], minimumScore: 95 }] };
  assert.deepEqual(scoredCandidates(strict, "pi", "6").map((item) => item.modelId), ["api-cheap", "sub-pricey", "sub-cheap", "sub-weak"]);
});

test("subscriptionFirst moves API-billed candidates of a custom configuration after subscription ones", () => {
  const ordered = subscriptionFirst("pi", [
    { provider: "anthropic", modelId: "claude-sonnet-5-5" },
    { provider: "openai-codex", modelId: "gpt-6.1-sol" },
    { provider: "zai", modelId: "glm-5.3" },
  ]);
  assert.deepEqual(ordered.map((item) => item.provider), ["openai-codex", "zai", "anthropic"]);
  assert.deepEqual(subscriptionFirst("claude", [{ modelId: "sonnet" }, { modelId: "opus" }]).map((item) => item.modelId), ["sonnet", "opus"], "a fixed-provider harness keeps its order");
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

test("a harness's own default model counts as listed even when the catalogue omits it", async () => {
  const { routingCandidateListed } = await import("../src/routing-policy.js");
  const listed = new Set(["kiro\0claude-sonnet-5.5"]);
  assert.equal(routingCandidateListed(listed, "kiro", "default"), true, "a signed-in Kiro lists real model IDs, not default");
  assert.equal(routingCandidateListed(listed, "kiro", "claude-sonnet-5.5"), true);
  assert.equal(routingCandidateListed(listed, "kiro", "missing"), false);
  assert.equal(routingCandidateListed(null, "kiro", "missing"), true, "no catalogue: validateSettings decides");
});
