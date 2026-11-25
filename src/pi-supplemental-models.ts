import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ModelRuntime, getAgentDir } from "./pi-sdk.js";

/** Models a provider has released that the installed Pi does not list yet. Only added when Pi's own
    catalog lacks the id, so the moment a Pi update lists a model its record wins and ours is ignored.
    Specs are copied from the predecessor of the same tier; prices are the published ones. */
const CODEX = { api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text", "image"], maxTokens: 128000,
  thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
  compat: { supportsOpenAIGrammarTools: true, supportsAdditionalTools: true, supportsToolSearch: true, supportsMidConvoSystemMessages: true },
  inputLimits: { images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 } } } };

export const SUPPLEMENTAL_MODELS: ReadonlyArray<{ provider: string; model: Record<string, unknown> & { id: string } }> = [
  { provider: "openai-codex", model: { ...CODEX, id: "gpt-6.2-sol", name: "GPT-6.2 Sol", contextWindow: 500000,
    cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }] } } },
  { provider: "openai-codex", model: { ...CODEX, id: "gpt-6.2-astra", name: "GPT-6.2 Astra", contextWindow: 272000,
    cost: { input: 8, output: 40, cacheRead: 0.8, cacheWrite: 10, tiers: [{ inputTokensAbove: 272000, input: 16, output: 60, cacheRead: 1.6, cacheWrite: 20 }] } } },
  // Z.ai offers GLM-5.4 on the Coding Plan, not the metered Model API.
  { provider: "zai", model: { id: "glm-5.4", name: "GLM-5.4", api: "openai-completions", baseUrl: "https://api.z.ai/api/coding/paas/v4",
    reasoning: true, input: ["text", "image"], contextWindow: 1000000, maxTokens: 131072,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
    compat: { supportsStore: false, supportsReasoningEffort: true, maxTokensField: "max_tokens", thinkingFormat: "zai", supportsStrictMode: true, zaiToolStream: true } } },
];

const noCredentials = { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} };
let missingFromPi: Promise<typeof SUPPLEMENTAL_MODELS> | undefined;

/** Our records for models the installed Pi lacks. Pi's catalog cannot change inside one process. */
function modelsPiLacks(): Promise<typeof SUPPLEMENTAL_MODELS> {
  missingFromPi ??= ModelRuntime.create({ credentials: noCredentials, modelsPath: null, refreshOnCreate: false })
    .then((pi) => SUPPLEMENTAL_MODELS.filter(({ provider, model }) => !pi.getModel(provider, model.id)));
  return missingFromPi;
}

/** The models file Pi should read: the person's own models.json plus our records Pi lacks. A model
    the person defined themselves is never replaced. Undefined when nothing is added, so Pi reads
    its own file. The person's file itself is never written. */
export async function modelsPathWithSupplements(): Promise<string | undefined> {
  const missing = await modelsPiLacks();
  if (missing.length === 0) return undefined;
  const agentDir = getAgentDir();
  const own = path.join(agentDir, "models.json");
  let config: { providers?: Record<string, { models?: Array<{ id: string }> }> } = {};
  try { config = JSON.parse(await readFile(own, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined; }
  config.providers ??= {};
  for (const { provider, model } of missing) {
    const entry = config.providers[provider] ??= {};
    entry.models ??= [];
    if (!entry.models.some((existing) => existing.id === model.id)) entry.models.push(model as { id: string });
  }
  const composed = path.join(agentDir, "models.joint-bob.json");
  await mkdir(agentDir, { recursive: true });
  await writeFile(composed, JSON.stringify(config, null, 2), { mode: 0o600 });
  return composed;
}
