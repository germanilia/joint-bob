import { managedAntigravityExecutable } from "../antigravity-install.js";
import { runtimeHome } from "../account-runtime.js";
import path from "node:path";
import { defineHarness } from "./contract.js";
import { antigravityConversationDefault } from "./antigravity.defaults.js";
import { configuredSessionPath, localizeTranscript, type HarnessConfiguration } from "./runtime-configuration.js";

const configuration: HarnessConfiguration = {
  defaults: (home) => ({ executable: managedAntigravityExecutable(), configPath: path.join(home, ".gemini"), sessionPath: path.join(home, ".joint-bob/antigravity/sessions") }),
  fixedProvider: "antigravity",
  update: { type: "antigravity" },
  thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
  restartFields: ["executable", "configPath"],
};
function root(): string {
  return configuredSessionPath("antigravity", configuration.defaults(runtimeHome()).sessionPath);
}
function within(file: string): boolean {
  const relative = path.relative(root(), path.resolve(file));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export default defineHarness({
  id: "antigravity", label: "Google Antigravity", order: 40, defaults: antigravityConversationDefault, configuration,
  runtime: async () => (await import("./antigravity/runtime.js")).default,
  models: async () => (await import("./antigravity/models.js")).antigravityModels(),
  paths: {
    newSession: "antigravity:new",
    ownsSession: (value) => value.startsWith("antigravity:") || value.startsWith("draft:antigravity:"),
    ownsTranscript: (file) => file.endsWith(".jsonl") && within(file),
    sessionId: (value) => value === "antigravity:new" || value.startsWith("draft:") ? undefined : path.basename(value.replace(/^antigravity:/, ""), ".jsonl") || undefined,
    localize: (value, home) => localizeTranscript(value, home, ".joint-bob", "antigravity:", "Google Antigravity"),
    transcriptFile: (value) => {
      const file = path.resolve(value.replace(/^antigravity:/, ""));
      if (!value.startsWith("antigravity:") || !file.endsWith(".jsonl") || !within(file)) throw new Error("Google Antigravity transcript is outside the configured transcript root");
      return file;
    },
  },
  sync: {
    transcriptRoot: root,
    watchDirs: () => [root()],
    transcriptCwd: async (file) => (await import("./antigravity/storage.js")).readAntigravityCwd(file),
    sentByPerson: (entry) => entry.type === "message" && entry.role === "user",
  },
  sessions: {
    files: async (project) => (await import("./antigravity/storage.js")).listAntigravitySessionFiles(project),
    list: async (project) => (await import("./antigravity/storage.js")).listAntigravitySessions(project),
    refresh: async (project, previous, changed) => (await import("./antigravity/storage.js")).refreshAntigravitySessions(project, previous, changed),
    loadMessages: async (project, value) => (await import("./antigravity/storage.js")).loadAntigravityMessages(project, value),
  },
});
