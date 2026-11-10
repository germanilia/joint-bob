import { currentRuntime, runtimeExec, spawnInRuntime } from "../../account-runtime.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { getSettings } from "../../settings.js";
import path from "node:path";
import { configuredRuntime } from "../runtime-configuration.js";

const GOOGLE_AUTH_ENV = [
  "AGY_ADC_AUTH", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_GEMINI_BASE_URL",
];

export function antigravitySettings() {
  return configuredRuntime("antigravity", getSettings().runtimes.antigravity);
}

export function antigravityEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const settings = antigravitySettings();
  const result: NodeJS.ProcessEnv = { ...environment, HOME: settings.configPath ? path.dirname(settings.configPath) : currentRuntime().home };
  for (const name of GOOGLE_AUTH_ENV) delete result[name];
  return result;
}

export function spawnAntigravity(cwd: string, args: string[], environment: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  const settings = antigravitySettings();
  return spawnInRuntime(currentRuntime(), settings.executable || "agy", args, {
    cwd, env: antigravityEnvironment(environment), detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
  });
}

export function antigravityRuntimeCommand(args: string[], environment: NodeJS.ProcessEnv) {
  const settings = antigravitySettings();
  return runtimeExec(settings.executable || "agy", args, antigravityEnvironment(environment));
}
