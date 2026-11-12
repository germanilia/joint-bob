import { appendFile, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseCompletedJsonl } from "../../jsonl.js";
import { isInternalSession } from "../../internal-sessions.js";
import { mapWithConcurrency } from "../../concurrency.js";
import type { ChatMessage, SessionSummary } from "../../types.js";
import type { HarnessProject } from "../contract.js";
import type { HarnessOpenOptions, HarnessModelSettings } from "../runtime.js";
import { sessionCwds } from "../shared-paths.js";
import { configuredSessionPath } from "../runtime-configuration.js";
import { runtimeHome } from "../../account-runtime.js";

type JsonObject = Record<string, unknown>;
const safeId = /^[a-zA-Z0-9_-]+$/;

export interface AntigravityStoredSession {
  id: string;
  cwd: string;
  nativeSessionId: string | null;
  nativeProfileId: string | null;
  modelId: string;
  reasoning: string;
  enabledTools?: string[];
  handoffPending: boolean;
  title?: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

function root(): string {
  return configuredSessionPath("antigravity", path.join(runtimeHome(), ".joint-bob/antigravity/sessions"));
}

function assertId(id: string): void {
  if (!safeId.test(id)) throw new Error("Google Antigravity session ID must be safe");
}

export function antigravitySessionFilePath(id: string): string {
  assertId(id);
  return path.join(root(), `${id}.jsonl`);
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Google Antigravity transcript record");
  return value as JsonObject;
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid Google Antigravity ${label}`);
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("Invalid Google Antigravity transcript timestamp");
  return value;
}

async function validateFile(file: string): Promise<string> {
  const resolved = path.resolve(file);
  const expectedRoot = await realpath(root());
  if (await realpath(path.dirname(resolved)) !== expectedRoot || path.extname(resolved) !== ".jsonl") throw new Error("Google Antigravity transcript is outside its alias root");
  const info = await lstat(resolved);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Google Antigravity transcript must be a regular file");
  return resolved;
}

function validateHeader(value: JsonObject, file: string): void {
  const valid = value.type === "joint-bob-antigravity" && value.version === 1
    && typeof value.id === "string" && safeId.test(value.id) && path.basename(file, ".jsonl") === value.id
    && typeof value.cwd === "string" && path.isAbsolute(value.cwd)
    && (value.nativeSessionId === null || typeof value.nativeSessionId === "string")
    && typeof value.modelId === "string" && value.modelId.trim().length > 0
    && typeof value.reasoning === "string" && value.reasoning.trim().length > 0
    && (value.handoffPending === undefined || typeof value.handoffPending === "boolean");
  if (!valid) throw new Error("Invalid Google Antigravity transcript header");
  if (value.enabledTools !== undefined && (!Array.isArray(value.enabledTools) || value.enabledTools.some((name) => typeof name !== "string" || !name))) throw new Error("Invalid Google Antigravity enabled tools");
  timestamp(value.timestamp);
}

function applyRecord(session: AntigravityStoredSession, value: JsonObject, index: number): void {
  session.updatedAt = timestamp(value.timestamp);
  if (value.type === "native-session") {
    session.nativeSessionId = nonempty(value.id, "native session ID");
    session.nativeProfileId = value.profileId === undefined || value.profileId === null ? null : nonempty(value.profileId, "profile ID");
    if (value.handoffPending !== undefined) {
      if (typeof value.handoffPending !== "boolean") throw new Error("Invalid Google Antigravity handoff state");
      session.handoffPending = value.handoffPending;
    }
    return;
  }
  if (value.type === "handoff-completed") { session.handoffPending = false; return; }
  if (value.type === "settings") {
    session.modelId = nonempty(value.modelId, "settings model ID");
    session.reasoning = nonempty(value.reasoning, "settings reasoning level");
    session.enabledTools = undefined;
    if (value.enabledTools !== undefined) {
      if (!Array.isArray(value.enabledTools) || value.enabledTools.some((name) => typeof name !== "string" || !name)) throw new Error("Invalid Google Antigravity enabled tools");
      session.enabledTools = [...value.enabledTools];
    }
    return;
  }
  if (value.type === "title") { session.title = nonempty(value.title, "title"); return; }
  if (value.type === "message") {
    if ((value.role !== "user" && value.role !== "assistant") || typeof value.text !== "string") throw new Error("Invalid Google Antigravity message record");
    const provider = value.provider === undefined ? "antigravity" : nonempty(value.provider, "message provider");
    const modelId = value.modelId === undefined ? session.modelId : nonempty(value.modelId, "message model");
    const reasoning = value.reasoning === undefined ? session.reasoning : nonempty(value.reasoning, "message reasoning");
    session.messages.push({ id: `${session.id}:${index}`, role: value.role, text: value.text, timestamp: timestamp(value.timestamp),
      ...(value.role === "assistant" ? { attribution: { harnessId: "antigravity", provider, modelId, reasoning } } : {}) });
    return;
  }
  if (value.type === "tool") {
    if (typeof value.text !== "string" || value.isError !== undefined && typeof value.isError !== "boolean" || value.durationMs !== undefined && (typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0)) throw new Error("Invalid Google Antigravity tool record");
    session.messages.push({ id: `${session.id}:${index}`, role: "toolResult", toolName: nonempty(value.toolName, "tool name"), text: value.text,
      ...(value.isError === true ? { isError: true } : {}), ...(typeof value.durationMs === "number" ? { durationMs: value.durationMs } : {}), timestamp: timestamp(value.timestamp) });
    return;
  }
  throw new Error(`Invalid Google Antigravity transcript record type: ${String(value.type)}`);
}

export async function readAntigravitySession(file: string): Promise<AntigravityStoredSession> {
  const resolved = await validateFile(file);
  const records = parseCompletedJsonl(await readFile(resolved, "utf8")).map(object);
  const header = records.shift();
  if (!header) throw new Error("Google Antigravity transcript has no header");
  validateHeader(header, resolved);
  const createdAt = timestamp(header.timestamp);
  const session: AntigravityStoredSession = {
    id: String(header.id), cwd: String(header.cwd), nativeSessionId: header.nativeSessionId as string | null, nativeProfileId: null,
    modelId: String(header.modelId), reasoning: String(header.reasoning), handoffPending: header.handoffPending === true,
    ...(Array.isArray(header.enabledTools) ? { enabledTools: [...header.enabledTools] as string[] } : {}),
    messages: [], createdAt, updatedAt: createdAt,
  };
  for (let index = 0; index < records.length; index++) applyRecord(session, records[index], index + 1);
  return session;
}

export async function appendAntigravityRecord(file: string, value: JsonObject): Promise<void> {
  object(value);
  timestamp(value.timestamp);
  await appendFile(await validateFile(file), `${JSON.stringify(value)}\n`, "utf8");
}

export async function initializeAntigravitySession(options: HarnessOpenOptions, settings: HarnessModelSettings): Promise<string> {
  assertId(options.sessionId);
  if (!path.isAbsolute(options.cwd)) throw new Error("Google Antigravity session cwd must be absolute");
  nonempty(settings.modelId, "model ID");
  nonempty(settings.reasoning, "reasoning level");
  const file = antigravitySessionFilePath(options.sessionId);
  await mkdir(root(), { recursive: true, mode: 0o700 });
  const header = { type: "joint-bob-antigravity", version: 1, id: options.sessionId, cwd: options.cwd, nativeSessionId: null,
    modelId: settings.modelId, reasoning: settings.reasoning, ...(settings.enabledTools === undefined ? {} : { enabledTools: settings.enabledTools }),
    handoffPending: false, timestamp: new Date().toISOString() };
  await writeFile(file, `${JSON.stringify(header)}\n`, { flag: "wx", mode: 0o600 });
  return file;
}

async function sessionFiles(project: HarnessProject): Promise<string[]> {
  let entries;
  try { entries = await readdir(root(), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const cwdSet = new Set(sessionCwds(project).map((cwd) => path.resolve(cwd)));
  const cutoff = project.historyDays ? Date.now() - project.historyDays * 86_400_000 : 0;
  const included = new Set((project.includedSessionPaths ?? []).map((value) => path.resolve(value.replace(/^antigravity:/, ""))));
  const includedIds = new Set(project.includedSessionIds ?? []);
  const candidates = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl") && safeId.test(path.basename(entry.name, ".jsonl"))).map((entry) => path.join(root(), entry.name));
  const summaries = await mapWithConcurrency(candidates, 8, async (file) => {
    const session = await readAntigravitySession(file);
    if (!cwdSet.has(path.resolve(session.cwd))) return null;
    if (cutoff && !included.has(path.resolve(file)) && !includedIds.has(`antigravity:${session.id}`) && (await stat(file)).mtimeMs < cutoff) return null;
    return file;
  });
  return summaries.filter((file): file is string => file !== null);
}

function summary(file: string, session: AntigravityStoredSession): SessionSummary | null {
  const firstMessage = session.messages.find((message) => message.role === "user")?.text;
  if (isInternalSession(session.id, firstMessage)) return null;
  return { id: session.id, path: `antigravity:${file}`, harnessId: "antigravity", agentId: "antigravity", agentLabel: "Google Antigravity",
    agentModel: session.modelId, title: session.title ?? firstMessage?.split("\n")[0] ?? "Google Antigravity conversation", firstMessage,
    createdAt: session.createdAt, updatedAt: session.updatedAt };
}

export async function listAntigravitySessionFiles(project: HarnessProject): Promise<string[]> { return sessionFiles(project); }

export async function listAntigravitySessions(project: HarnessProject): Promise<SessionSummary[]> {
  const sessions = await mapWithConcurrency(await sessionFiles(project), 8, async (file) => summary(file, await readAntigravitySession(file)));
  return sessions.filter((session): session is SessionSummary => session !== null);
}

export async function refreshAntigravitySessions(project: HarnessProject, _previous: SessionSummary[], _changed: string[]): Promise<SessionSummary[]> {
  return listAntigravitySessions(project);
}

export async function loadAntigravityMessages(_project: HarnessProject, sessionPath: string): Promise<ChatMessage[]> {
  return (await readAntigravitySession(sessionPath.replace(/^antigravity:/, ""))).messages;
}

export async function readAntigravityCwd(file: string): Promise<string> { return (await readAntigravitySession(file)).cwd; }
