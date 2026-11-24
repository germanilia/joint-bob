import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { nodeMcpServersApply } from "../../account-runtime.js";
import { actingAccount } from "../../account-context.js";
import { adminAccountId } from "../../ownership.js";
import { agentResourcePaths } from "../../agent-resources.js";
import { agentInstructionFiles, renderInstructions } from "../../agent-instructions.js";
import { activeMcpServers, activeSkillRoot } from "../../resource-activation.js";
import { assertClusterResourcesPresent, clusterPolicySkillPaths, prepareClusterPolicySkills } from "../../cluster-agent-resources.js";
import { managedMcpBridgeConfigs } from "../../mcp/agent.js";
import { withProjectFolderResources } from "../../project-folder-resources.js";
import { getScopedResourcePaths } from "../../settings.js";
import { readConfiguredSkillPath } from "../../skills.js";
import { JOINT_BOB_TOOL_SERVER, withoutReservedMcpServers } from "../../assistant-collaboration/bridge-tools.js";
import { personalAssistantSettings } from "../../personal-assistants.js";
import type { HarnessOpenOptions } from "../runtime.js";

const stringMap = z.record(z.string(), z.string());
const stdio = z.object({ type: z.literal("stdio").optional(), command: z.string().min(1), args: z.array(z.string()).optional(), env: stringMap.optional() }).strict();
const remote = z.object({ type: z.enum(["http", "streamable-http", "sse"]).optional(), url: z.string().url(), headers: stringMap.optional() }).strict();
const serverSchema = z.union([stdio, remote]);
type Entries = { name: string; value: string }[];
export type AntigravityMcpServer = { name: string; command: string; args: string[]; env: Entries }
  | { name: string; type: "http" | "sse"; url: string; headers: Entries };

async function nodeServers(file: string): Promise<Record<string, unknown>> {
  try {
    const config = z.object({ mcpServers: z.record(z.string(), z.unknown()) }).safeParse(JSON.parse(await readFile(file, "utf8")));
    if (!config.success) throw new Error("Invalid shared MCP configuration");
    return withoutReservedMcpServers(config.data.mcpServers);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (error instanceof SyntaxError) throw new Error("Invalid shared MCP configuration JSON");
    throw error;
  }
}

function acpServer(name: string, raw: unknown): AntigravityMcpServer[] {
  // ACP cannot express options such as per-tool filters or stdio cwd. Never drop them silently.
  const { disabled, ...config } = z.looseObject({ disabled: z.boolean().optional() }).parse(raw);
  if (disabled) return [];
  const parsed = serverSchema.safeParse(config);
  if (!parsed.success) throw new Error(`Shared MCP server ${name} has options unsupported by Antigravity`);
  const server = parsed.data;
  const entries = (values: Record<string, string> | undefined) => Object.entries(values ?? {}).map(([name, value]) => ({ name, value }));
  if ("command" in server) return [{ name, command: server.command, args: server.args ?? [], env: entries(server.env) }];
  return [{ name, type: server.type === "sse" ? "sse" : "http", url: server.url, headers: entries(server.headers) }];
}

async function antigravityMcpServers(options: HarnessOpenOptions, file: string) {
  const { projectId, sessionId } = options;
  const conversationId = options.conversationId ?? sessionId;
  const account = actingAccount();
  const assistant = account && await personalAssistantSettings(account.accountId, projectId, "antigravity", conversationId);
  const configured = {
    ...(nodeMcpServersApply(adminAccountId()) ? await nodeServers(file) : {}),
    ...managedMcpBridgeConfigs(),
  };
  const servers = Object.entries(activeMcpServers("antigravity", configured, projectId)).flatMap(([name, config]) => {
    if (name !== JOINT_BOB_TOOL_SERVER && assistant?.mcpServerNames && !assistant.mcpServerNames.includes(name)) return [];
    return acpServer(name, config);
  });
  assertClusterResourcesPresent(projectId, "antigravity", "mcp", servers.map(({ name }) => name));
  return servers;
}

async function skillInstructions(roots: string[], required: string[], context: { projectId: string; conversationId: string }) {
  const skills = new Map<string, string>();
  for (const root of [...roots, ...required]) {
    const active = activeSkillRoot("antigravity", root, context);
    const folder = path.basename(active) === "SKILL.md" ? path.dirname(active) : active;
    const entries = await readConfiguredSkillPath(folder, "antigravity", "project");
    if (required.includes(root) && !entries.length) throw new Error(`Required cluster skill ${path.basename(root)} is blocked or unavailable`);
    for (const skill of entries) skills.set(skill.name, `- ${skill.name}: ${skill.description} (${path.join(skill.path!, "SKILL.md")})`);
  }
  return skills.size ? `# Available skills\n\nRead the matching SKILL.md before using a skill.\n\n${[...skills.values()].join("\n")}` : "";
}

export async function antigravityResources(options: HarnessOpenOptions) {
  const { projectId, sessionId, cwd } = options, conversationId = options.conversationId ?? sessionId;
  await prepareClusterPolicySkills(projectId, "antigravity");
  assertClusterResourcesPresent(projectId, "antigravity", "plugins", []);
  const resources = agentResourcePaths();
  const { global, project } = withProjectFolderResources(getScopedResourcePaths(projectId, conversationId, "antigravity"), cwd);
  const instructions = renderInstructions(agentInstructionFiles(resources, "antigravity", { cwd, rules: [...global.rules, ...project.rules] }));
  const [mcpServers, skills] = await Promise.all([
    antigravityMcpServers(options, resources.mcpConfig),
    skillInstructions([resources.sharedSkills, ...global.skills, ...project.skills], clusterPolicySkillPaths(projectId, "antigravity"), { projectId, conversationId }),
  ]);
  return { mcpServers, instructions: [instructions, skills].filter(Boolean) };
}
