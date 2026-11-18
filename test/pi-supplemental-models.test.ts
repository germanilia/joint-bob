import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { getAgentDir, ModelRuntime } from "../src/pi-sdk.js";
import { createSessionModelRuntime } from "../src/provider-profiles/pi.js";
import { SUPPLEMENTAL_MODELS } from "../src/pi-supplemental-models.js";

const noCredential = async () => undefined;
const noList = async () => [];

test("models a provider has released but Pi does not list yet are added without touching Pi's own", async () => {
  const runtime = await createSessionModelRuntime(noCredential, noList, () => true);
  const plain = await ModelRuntime.create({ credentials: { read: noCredential, list: noList, modify: noCredential, delete: async () => {} }, modelsPath: null, refreshOnCreate: false });
  const ids = runtime.getModels("openai-codex").map((model) => model.id);
  for (const { provider, model } of SUPPLEMENTAL_MODELS) assert.ok(runtime.getModel(provider, model.id), `${provider}/${model.id} is listed`);
  for (const model of plain.getModels("openai-codex")) assert.deepEqual(runtime.getModel("openai-codex", model.id), model, `Pi's own ${model.id} is unchanged`);
  assert.ok(ids.length >= plain.getModels("openai-codex").length);
});

test("a model the person defined in models.json is never replaced by ours, and their file is not rewritten", async () => {
  const file = path.join(getAgentDir(), "models.json");
  const own = JSON.stringify({ providers: { "openai-codex": { models: [{ id: "gpt-6.2-sol", name: "Mine", contextWindow: 1234 }] } } });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, own);
  try {
    const runtime = await createSessionModelRuntime(noCredential, noList, () => true);
    assert.equal(runtime.getModel("openai-codex", "gpt-6.2-sol")?.name, "Mine");
    assert.ok(runtime.getModel("openai-codex", "gpt-6.2-astra"), "the other supplemental model is still added");
    assert.equal(await readFile(file, "utf8"), own);
  } finally { await rm(file, { force: true }); await rm(path.join(getAgentDir(), "models.joint-bob.json"), { force: true }); }
});
