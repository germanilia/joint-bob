import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAsAccount } from "../src/account-context.js";
import { getClusterNode } from "../src/cluster.js";
import { getSettings, updateSettings } from "../src/settings.js";
import { openAIAuthPath } from "../src/provider-profiles/service.js";
import { createProviderProfile } from "../src/provider-profiles/store.js";
import { createSessionModelRuntime } from "../src/provider-profiles/pi.js";
import { createPiProviderCatalog } from "../src/harnesses/pi/provider-catalog.js";

const provider = "fixture-dynamic";
const actor = (accountId: string) => ({ accountId, username: "fixture", role: "member" as const, isRemoteLogin: false, homeNodeId: null });

test("dynamic Pi models are listed and selectable using only the active profile's catalog", async (t) => {
  await getClusterNode();
  const previous = process.env.PI_DYNAMIC_FIXTURE_KEY;
  process.env.PI_DYNAMIC_FIXTURE_KEY = "ambient";
  t.after(() => { if (previous === undefined) delete process.env.PI_DYNAMIC_FIXTURE_KEY; else process.env.PI_DYNAMIC_FIXTURE_KEY = previous; });
  const pkg = await mkdtemp(path.join(os.tmpdir(), "pi-dynamic-provider-"));
  t.after(() => rm(pkg, { recursive: true, force: true }));
  await mkdir(path.join(pkg, "extensions"));
  await writeFile(path.join(pkg, "extensions/provider.ts"), `export default pi => {
    let models = [];
    const id = ${JSON.stringify(provider)};
    pi.registerProvider({
      id, name: "Dynamic fixture", baseUrl: "http://127.0.0.1:1",
      auth: { apiKey: { name: "Fixture key", resolve: async ({ credential, ctx }) => {
        const key = credential?.key ?? await ctx.env("PI_DYNAMIC_FIXTURE_KEY");
        return key && { auth: { apiKey: key }, source: "fixture" };
      } } },
      getModels: () => models,
      stream: () => { throw new Error("This fixture only tests discovery"); },
      streamSimple: () => { throw new Error("This fixture only tests discovery"); },
      refreshModels: async ({ credential, allowNetwork, publish }) => {
        if (!allowNetwork) return;
        if (credential.key === "unavailable") throw new Error("Fixture catalog unavailable");
        const model = { id: credential.key, name: "Discovered model", provider: id, api: "openai-completions",
          baseUrl: "http://127.0.0.1:1", reasoning: true, input: ["text"],
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 };
        await publish({ persist: { models: [model], checkedAt: Date.now() }, update: () => { models = [model]; } });
      },
    });
  };`);
  const agentDir = path.join(pkg, "agent");
  await mkdir(agentDir);
  updateSettings({ pi: { ...getSettings().pi, configPath: agentDir } });
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [pkg] }));
  const { catalogModelSummary, listAvailableModels, modelIsRunnable } = await import("../src/pi-service.js");
  const configured = async (account: string, key: string) => {
    const profile = createProviderProfile(account, { provider: "pi", label: account });
    const file = openAIAuthPath(profile);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ [provider]: { type: "api_key", key } }));
  };
  await configured("fixture-alice", "model-a");
  await configured("fixture-bob", "model-b");
  const modelsFor = (account: string) => runAsAccount(actor(account), async () => (await listAvailableModels()).filter((model) => model.provider === provider));
  const [alice, bob, unauthenticated] = await Promise.all([modelsFor("fixture-alice"), modelsFor("fixture-bob"), modelsFor("fixture-unsigned")]);
  assert.deepEqual(alice.map((model) => model.id), ["model-a"]);
  assert.deepEqual(bob.map((model) => model.id), ["model-b"]);
  assert.deepEqual(unauthenticated, []);
  assert.ok(alice[0].thinkingLevels.includes("high"));
  assert.equal(alice[0].pricing?.rates.input, 1);
  assert.equal(await runAsAccount(actor("fixture-bob"), () => modelIsRunnable(provider, "model-a")), false);
  assert.equal((await runAsAccount(actor("fixture-alice"), () => catalogModelSummary(provider, "model-a")))?.id, "model-a");

  let key: string | undefined;
  const runtime = await createSessionModelRuntime(async (id) => id === provider && key ? { type: "api_key", key } : undefined,
    async () => key ? [{ providerId: provider, type: "api_key" }] : []);
  const catalog = await createPiProviderCatalog(runtime, { agentDir, strictResourceIsolation: true, extensionPaths: [] });
  t.after(() => catalog.dispose());
  const ids = async () => (await runtime.getAvailable(provider)).map((model) => model.id);
  assert.deepEqual(await ids(), []);
  key = "model-a";
  assert.deepEqual(await ids(), ["model-a"]);
  key = "unavailable";
  assert.deepEqual(await ids(), [], "a failed catalog refresh must not reveal another profile's models");
  key = "model-b";
  assert.deepEqual(await ids(), ["model-b"]);
});
