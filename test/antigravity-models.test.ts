import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { getSettings } from "../src/settings.js";
import { antigravityConfigOptions, antigravityModelsFromOptions, applyAntigravitySettings } from "../src/harnesses/antigravity/models.js";
import { antigravityEnvironment } from "../src/harnesses/antigravity/process.js";

const config = [
  { id: "model", name: "Model", type: "select", currentValue: "gemini-3.1-pro-medium", options: [
    { value: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
    { value: "gemini-3.1-pro-medium", name: "Gemini 3.1 Pro (Medium)" },
  ] },
  { id: "effortLevel", name: "Thinking level", type: "select", currentValue: "medium", options: [
    { value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "extra", name: "Extra" },
  ] },
];

test("Antigravity ACP model choices and thinking levels map into harness settings", () => {
  assert.deepEqual(antigravityModelsFromOptions(config), [
    { provider: "antigravity", id: "default", label: "Antigravity default", thinkingLevels: ["medium"] },
    { provider: "antigravity", id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)", thinkingLevels: ["low", "medium", "xhigh"] },
    { provider: "antigravity", id: "gemini-3.1-pro-medium", label: "Gemini 3.1 Pro (Medium)", thinkingLevels: ["low", "medium", "xhigh"] },
  ]);
});

test("Antigravity applies ACP model and reasoning options using native values", async () => {
  let current = structuredClone(config);
  const calls: unknown[] = [];
  const connection = { request: async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    const option = current.find((candidate) => candidate.id === params.configId)!;
    option.currentValue = String(params.value);
    return { configOptions: current };
  } } as never;
  const updated = await applyAntigravitySettings(connection, "native-1", current, {
    provider: "antigravity", modelId: "gemini-3.1-pro-low", reasoning: "xhigh",
  });

  assert.deepEqual(calls, [
    { method: "session/set_config_option", params: { sessionId: "native-1", configId: "model", value: "gemini-3.1-pro-low" } },
    { method: "session/set_config_option", params: { sessionId: "native-1", configId: "effortLevel", value: "extra" } },
  ]);
  assert.deepEqual(updated.map(({ currentValue }) => currentValue), ["gemini-3.1-pro-low", "extra"]);
});

test("Antigravity environment excludes API keys and ADC so it uses native CLI login", () => {
  const environment = antigravityEnvironment({
    HOME: "/tmp/test-home",
    AGY_ADC_AUTH: "true",
    GEMINI_API_KEY: "test-key",
    GOOGLE_API_KEY: "test-key",
    GOOGLE_APPLICATION_CREDENTIALS: "/tmp/test-credentials.json",
    GOOGLE_CLOUD_PROJECT: "test-project",
    KEEP_ME: "present",
  });

  assert.equal(environment.HOME, path.dirname(getSettings().runtimes.antigravity.configPath));
  for (const name of ["AGY_ADC_AUTH", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT"]) {
    assert.equal(environment[name], undefined);
  }
  assert.equal(environment.KEEP_ME, "present");
});
