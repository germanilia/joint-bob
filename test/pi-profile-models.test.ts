import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_OAUTH_TOKEN;
// Profile writes are stamped with this node's identity for twin sync.
await (await import("../src/cluster.js")).getClusterNode();

async function signIn(authPath: string, provider: string): Promise<void> {
  await mkdir(path.dirname(authPath), { recursive: true, mode: 0o700 });
  await writeFile(authPath, JSON.stringify({ [provider]: { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3_600_000 } }), { mode: 0o600 });
}

test("signed-in profiles offer their Pi models, and validating one model does not wait for unrelated catalogs", async context => {
  const { runAsAccount } = await import("../src/account-context.js");
  const { createProviderProfile } = await import("../src/provider-profiles/store.js");
  const { openAIAuthPath } = await import("../src/provider-profiles/service.js");
  const { listAvailableModels, modelIsRunnable } = await import("../src/pi-service.js");
  const account = { accountId: "pi-profile-models-owner", username: "fixture", role: "member" as const, isRemoteLogin: false, homeNodeId: null };
  const offered = async (provider: string) => (await runAsAccount(account, listAvailableModels)).filter((model) => model.provider === provider);

  const claude = createProviderProfile(account.accountId, { label: "Claude work", provider: "claude" });
  assert.equal((await offered("anthropic")).length, 0, "a Claude profile that is not signed in offers no models");

  const chatgpt = createProviderProfile(account.accountId, { label: "ChatGPT work", provider: "openai-codex" });
  await signIn(openAIAuthPath(chatgpt), "openai-codex");
  assert.ok((await offered("openai-codex")).length > 0, "a signed-in ChatGPT profile offers Codex models");
  assert.equal((await offered("anthropic")).length, 0);

  await signIn(openAIAuthPath(claude), "anthropic");
  const anthropic = await offered("anthropic");
  assert.ok(anthropic.some((model) => model.id.startsWith("claude-")), "a signed-in Claude profile offers Pi's Claude models");
  assert.ok((await offered("openai-codex")).length > 0, "Codex models stay offered alongside Claude models");
  assert.deepEqual(await offered("zai"), [], "a Z.ai Coding Plan model needs an app sign-in");
  const pi = createProviderProfile(account.accountId, { label: "Pi API keys", provider: "pi" });
  await mkdir(path.dirname(openAIAuthPath(pi)), { recursive: true, mode: 0o700 });
  await writeFile(openAIAuthPath(pi), JSON.stringify({ zai: { type: "api_key", key: "fixture-zai" }, openai: { type: "api_key", key: "fixture-openai" } }), { mode: 0o600 });
  const { profileModelRuntime } = await import("../src/provider-profiles/service.js");
  const catalog = await profileModelRuntime(pi);
  assert.ok((await offered("zai")).length > 0, `a Pi profile offers z.ai models with its API key; known=${catalog.getModels("zai").map((model) => model.id)}, available=${(await catalog.getAvailable("zai")).map((model) => model.id)}`);
  const glm = (await offered("zai")).find((model) => model.id === "glm-5.4");
  assert.ok(glm, "a signed-in Z.ai profile offers GLM-5.4 in the picker");
  assert.equal(glm.label, "GLM-5.4");
  assert.equal(await runAsAccount(account, () => modelIsRunnable("zai", "glm-5.4")), true);
  assert.ok((await offered("openai")).length > 0, "the same Pi profile also offers OpenAI API-key models");
  const all = await runAsAccount(account, listAvailableModels);
  assert.equal(new Set(all.map((model) => `${model.provider}/${model.id}`)).size, all.length, "model catalog has no duplicates");

  const { getHarnessRuntime } = await import("../src/harnesses.js");
  const { ModelRuntime } = await import("../src/pi-sdk.js");
  const runtime = await getHarnessRuntime("pi");
  const nativeAvailable = ModelRuntime.prototype.getAvailable;
  context.mock.method(ModelRuntime.prototype, "getAvailable", function (this: InstanceType<typeof ModelRuntime>, provider?: string, options?: Parameters<typeof nativeAvailable>[1]) {
    assert.ok(provider, "a single-model validation must not wait for every provider");
    assert.ok(this !== catalog || provider !== "openai-codex", "a model already offered by a signed-in Codex profile does not need the unrelated Pi profile");
    return nativeAvailable.call(this, provider, options);
  });
  const codex = all.find((model) => model.provider === "openai-codex")!;
  await runAsAccount(account, () => runtime.validateSettings({ provider: codex.provider, modelId: codex.id, reasoning: codex.thinkingLevels[0] }));
  await runAsAccount(account, () => runtime.validateSettings({ provider: glm.provider, modelId: glm.id, reasoning: glm.thinkingLevels[0] }));
  await assert.rejects(runAsAccount(account, () => runtime.validateSettings({ provider: "zai", modelId: "not-a-model", reasoning: "off" })), /Model not found/);
});
