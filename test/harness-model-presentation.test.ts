import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Pi model catalogue supplies native provider presentation metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-model-presentation-"));
  const configPath = path.join(root, "pi");
  const previousEnvironment = { ...process.env };
  try {
    await mkdir(configPath);
    const model = { reasoning: true, input: ["text", "image"], contextWindow: 32000, maxTokens: 1024 };
    await writeFile(path.join(configPath, "models.json"), JSON.stringify({ providers: {
      "openai-codex": {
        baseUrl: "http://127.0.0.1:1", apiKey: "fixture-openai-key", api: "openai-completions",
        models: [{ ...model, id: "fixture-gpt", name: "Fixture GPT" }],
      },
      zai: {
        baseUrl: "http://127.0.0.1:2", apiKey: "fixture-zai-key", api: "openai-completions",
        models: [{ ...model, id: "fixture-glm", name: "Fixture GLM" }],
      },
    } }));
    const settings = await import("../src/settings.js");
    const previousSettings = settings.getSettings();
    settings.updateSettings({ ...previousSettings, pi: { ...previousSettings.runtimes.pi, configPath } });
    try {
      const { listHarnessModels } = await import("../src/harnesses.js");
      // Models are offered only for providers an app profile signs in to; the catalogue file supplies the protocol.
      const { createProviderProfile } = await import("../src/provider-profiles/store.js");
      const { runAsAccount } = await import("../src/account-context.js");
      const { openAIAuthPath } = await import("../src/provider-profiles/service.js");
      await (await import("../src/cluster.js")).getClusterNode();
      const actor = { accountId: "model-presentation-owner", username: "fixture", role: "member" as const, isRemoteLogin: false, homeNodeId: null };
      const profile = createProviderProfile(actor.accountId, { provider: "pi", label: "Fixture account" });
      await mkdir(path.dirname(openAIAuthPath(profile)), { recursive: true });
      await writeFile(openAIAuthPath(profile), JSON.stringify({ "openai-codex": { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 8 * 3_600_000 }, zai: { type: "api_key", key: "fixture-zai-key" } }));
      const models = await runAsAccount(actor, () => listHarnessModels("pi"));
      const gpt = models.find(({ provider, id }) => provider === "openai-codex" && id.startsWith("gpt-"));
      const glm = models.find(({ provider, id }) => provider === "zai" && id.startsWith("glm-"));
      assert.equal(gpt?.providerLabel, "GPT");
      assert.equal(gpt?.providerIcon, "openai");
      assert.equal(glm?.providerLabel, "GLM");
      assert.equal(glm?.providerIcon, undefined);
    } finally {
      settings.updateSettings(previousSettings);
    }
  } finally {
    process.env = previousEnvironment;
    await rm(root, { recursive: true, force: true });
  }
});
