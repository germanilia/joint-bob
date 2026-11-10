import { checkGuardian, guardianStartProblem, type GuardianIdentity } from "./check.js";
import { guardianGroups } from "./settings.js";
import { toolCategory } from "./rules.js";

type JsonObject = Record<string, unknown>;

export async function antigravityChecksTools(): Promise<boolean> {
  return (await guardianGroups()).some((group) => group.rules.some((rule) => rule.enabled && rule.check !== "outgoing"));
}

export async function guardAntigravityPrompt(identity: GuardianIdentity, text: string): Promise<string> {
  const problem = await guardianStartProblem("antigravity");
  if (problem) throw new Error(problem);
  const verdict = await checkGuardian(identity, { kind: "outgoing", source: "the user's message", text });
  if (verdict.action === "block") throw new Error(verdict.reason);
  return verdict.action === "replace" && verdict.text !== undefined ? verdict.text : text;
}

function category(kind: unknown, name: string): ReturnType<typeof toolCategory> {
  if (kind === "execute") return "commands";
  if (kind === "edit" || kind === "delete" || kind === "move") return "file-changes";
  return toolCategory(name);
}

export async function antigravityPermission(identity: GuardianIdentity, request: JsonObject, enabledTools: string[] | undefined, known?: { toolName: string; rawInput: unknown }): Promise<JsonObject> {
  const call = (request.toolCall ?? {}) as JsonObject;
  const toolName = known?.toolName ?? (typeof call.title === "string" ? call.title : "tool");
  const rawInput = known?.rawInput ?? call.rawInput;
  const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? rawInput as JsonObject : { value: rawInput ?? null };
  if (enabledTools !== undefined && !enabledTools.includes(category(call.kind, toolName))) return { outcome: { outcome: "cancelled" } };
  const verdict = await checkGuardian(identity, { kind: "tool", tool: toolName, category: category(call.kind, toolName), input });
  const kind = verdict.action === "block" ? "reject_once" : "allow_once";
  const options = Array.isArray(request.options) ? request.options as JsonObject[] : [];
  const option = options.find((item) => item.kind === kind && typeof item.optionId === "string");
  return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
}
