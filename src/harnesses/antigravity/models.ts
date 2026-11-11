import os from "node:os";
import { currentRuntime, runtimeHome } from "../../account-runtime.js";
import { stopProcessGroup } from "../process-lifecycle.js";
import { execFile } from "../../subprocess.js";
import { promisify } from "node:util";
import { antigravityRuntimeCommand, spawnAntigravity, antigravitySettings } from "./process.js";
import { createAntigravityConnection } from "./transport.js";
import type { HarnessModel, HarnessModelSettings } from "../runtime.js";

const execute = promisify(execFile);
export const antigravityThinkingLevels = ["low", "medium", "high", "xhigh", "max"];
type Rpc = ReturnType<typeof createAntigravityConnection>;
type Choice = { value: string; name: string };
type SelectOption = { id: string; name: string; currentValue: string; options: Choice[] };

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Antigravity ACP ${label}`);
  return value as Record<string, unknown>;
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid Antigravity ACP ${label}`);
  return value;
}

export function antigravityConfigOptions(value: unknown): SelectOption[] {
  if (!Array.isArray(value)) throw new Error("Antigravity ACP did not return configuration options");
  return value.flatMap((item) => {
    const option = object(item, "configuration option");
    if (option.type !== "select") return [];
    if (!Array.isArray(option.options)) throw new Error("Invalid Antigravity ACP option choices");
    return [{ id: nonempty(option.id, "option ID"), name: nonempty(option.name, "option name"), currentValue: nonempty(option.currentValue, "option value"),
      options: option.options.map((entry) => { const choice = object(entry, "option choice"); return { value: nonempty(choice.value, "choice value"), name: nonempty(choice.name, "choice name") }; }) }];
  });
}

function modelOption(options: SelectOption[]): SelectOption {
  const model = options.find((option) => option.id === "model");
  if (!model) throw new Error("Antigravity ACP did not advertise model selection");
  return model;
}

function effortOption(options: SelectOption[]): SelectOption | undefined {
  return options.find((option) => /effort|reasoning|thinking/i.test(`${option.id} ${option.name}`));
}

function level(value: string): string {
  return value.toLowerCase() === "extra" ? "xhigh" : value.toLowerCase();
}

export function antigravityModelsFromOptions(raw: unknown): HarnessModel[] {
  const options = antigravityConfigOptions(raw), models = modelOption(options), effort = effortOption(options);
  const thinkingLevels = effort ? effort.options.map((choice) => level(choice.value)) : ["medium"];
  return [
    { provider: "antigravity", id: "default", label: "Antigravity default", thinkingLevels: ["medium"] },
    ...models.options.map((choice) => ({ provider: "antigravity", id: choice.value, label: choice.name, thinkingLevels })),
  ];
}

function nativeLevel(selected: string, option: SelectOption): string {
  const value = selected === "xhigh" ? "extra" : selected;
  const choice = option.options.find((item) => item.value.toLowerCase() === value.toLowerCase());
  if (!choice) throw new Error(`Antigravity does not support thinking level ${selected}`);
  return choice.value;
}

export async function applyAntigravitySettings(connection: Rpc, sessionId: string, raw: unknown, settings: HarnessModelSettings): Promise<SelectOption[]> {
  let options = antigravityConfigOptions(raw);
  const model = modelOption(options);
  if (settings.modelId !== "default") {
    if (!model.options.some((choice) => choice.value === settings.modelId)) throw new Error(`Antigravity does not offer model ${settings.modelId}`);
    if (model.currentValue !== settings.modelId) {
      const updated = object(await connection.request("session/set_config_option", { sessionId, configId: model.id, value: settings.modelId }), "model selection response");
      options = antigravityConfigOptions(updated.configOptions);
    }
  }
  const effort = effortOption(options);
  if (effort) {
    const selected = nativeLevel(settings.reasoning, effort);
    if (effort.currentValue !== selected) {
      const updated = object(await connection.request("session/set_config_option", { sessionId, configId: effort.id, value: selected }), "thinking-level response");
      options = antigravityConfigOptions(updated.configOptions);
    }
  } else if (settings.reasoning !== "medium") {
    throw new Error("This Antigravity model does not expose a separate thinking-level option");
  }
  return options;
}

async function openCatalogSession(cwd: string, environment: NodeJS.ProcessEnv, home?: string) {
  const child = spawnAntigravity(cwd, ["acp"], environment, home);
  const connection = createAntigravityConnection(child, () => {}, async (method) => { throw new Error(`Unexpected Antigravity ACP request during model discovery: ${method}`); });
  const deadline = setTimeout(() => child.kill(), 30_000);
  deadline.unref();
  try {
    const initialized = object(await connection.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "joint-bob", version: "1" } }), "initialize response");
    if (initialized.protocolVersion !== 1) throw new Error(`Unsupported Antigravity ACP protocol version: ${String(initialized.protocolVersion)}`);
    const opened = object(await connection.request("session/new", { cwd, mcpServers: [] }), "new session response");
    nonempty(opened.sessionId, "session ID");
    antigravityConfigOptions(opened.configOptions);
    return opened.configOptions;
  } finally {
    clearTimeout(deadline);
    child.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([connection.closed, new Promise<void>((resolve) => { timer = setTimeout(resolve, 3_000); })]); }
    finally { clearTimeout(timer); if (child.pid && child.exitCode === null && child.signalCode === null) await stopProcessGroup(child, "Google Antigravity"); }
  }
}

export async function probeAntigravity(cwd = runtimeHome(), environment: NodeJS.ProcessEnv = process.env, home?: string): Promise<unknown> { return openCatalogSession(cwd, environment, home); }

const MODEL_CACHE_MS = 10 * 60_000;
const modelCache = new Map<string, { at: number; models: Promise<HarnessModel[]> }>();

export function invalidateAntigravityModels(): void {
  for (const key of modelCache.keys()) if (key.startsWith(`${currentRuntime().key}\n`)) modelCache.delete(key);
}

export async function antigravityModels(): Promise<HarnessModel[]> {
  const settings = antigravitySettings();
  const key = `${currentRuntime().key}\n${settings.executable}\n${settings.configPath}`;
  const cached = modelCache.get(key);
  if (cached && Date.now() - cached.at < MODEL_CACHE_MS) return cached.models;
  const models = probeAntigravity(os.tmpdir()).then((options) => antigravityModelsFromOptions(options)).catch((error: unknown) => {
    if (error instanceof Error && error.message.includes("Authentication required")) return [{ provider: "antigravity", id: "default", label: "Antigravity default", thinkingLevels: ["medium"] }];
    console.warn("Google Antigravity model discovery unavailable", { error: error instanceof Error ? error.message : String(error) });
    return [{ provider: "antigravity", id: "default", label: "Antigravity default", thinkingLevels: ["medium"] }];
  });
  modelCache.set(key, { at: Date.now(), models });
  return models;
}

export async function checkAntigravityExecutable(cwd: string, environment: NodeJS.ProcessEnv = process.env, home?: string): Promise<void> {
  const launch = antigravityRuntimeCommand(["--version"], environment, home);
  await execute(launch.command, launch.args, { cwd, env: launch.env, timeout: 5_000 });
  const acp = antigravityRuntimeCommand(["acp", "--help"], environment, home);
  await execute(acp.command, acp.args, { cwd, env: acp.env, timeout: 5_000 });
}
