import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { agentCapabilityEnvironment } from "../../agent-capabilities.js";
import { agentEnvironment, persistConversationSecretAccounts } from "../../secrets.js";
import { buildHandoffContext, stripHandoffEnvelope } from "../../handoff-context.js";
import { getSettings } from "../../settings.js";
import type { ChatMessage, ModelSummary, SessionStatus } from "../../types.js";
import { antigravityPermission, guardAntigravityPrompt } from "../../guardian/antigravity.js";
import type { GuardianIdentity } from "../../guardian/check.js";
import { stopProcessGroup } from "../process-lifecycle.js";
import type { HarnessEvent, HarnessModelSettings, HarnessOpenOptions, HarnessPrompt, HarnessRuntime, HarnessSession, HarnessTool } from "../runtime.js";
import { antigravityConfigOptions, antigravityThinkingLevels, applyAntigravitySettings, checkAntigravityExecutable, probeAntigravity } from "./models.js";
import { appendAntigravityRecord, initializeAntigravitySession, readAntigravitySession } from "./storage.js";
import { createAntigravityConnection } from "./transport.js";
import { spawnAntigravity } from "./process.js";

type Listener = (event: HarnessEvent) => void;
type JsonObject = Record<string, unknown>;
type Connection = ReturnType<typeof createAntigravityConnection>;
type ToolCall = { title: string; toolName: string; rawInput: unknown; startedAt: number };
const toolCategories = ["commands", "file-changes", "other"];

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Antigravity ACP ${label}`);
  return value as JsonObject;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid Antigravity ACP ${label}`);
  return value;
}

function validate(settings: HarnessModelSettings): void {
  if (settings.provider !== "antigravity") throw new Error("Provider must be antigravity");
  if (!settings.modelId.trim() || settings.modelId.length > 300) throw new Error("Google Antigravity model ID must be between 1 and 300 characters");
  if (!antigravityThinkingLevels.includes(settings.reasoning)) throw new Error("Google Antigravity thinking level is not supported");
  if (settings.enabledTools?.some((name) => !toolCategories.includes(name))) throw new Error("Unknown Google Antigravity tool category");
}

function defaultSettings(): HarnessModelSettings {
  const selected = getSettings().conversationDefaults.antigravity;
  return { provider: "antigravity", modelId: selected.modelId, reasoning: selected.thinkingLevel };
}

function loginProblem(error: unknown): string | undefined {
  return error instanceof Error && error.message.includes("Authentication required")
    ? "Google Antigravity is not signed in on this node. Sign in through the official Antigravity CLI and try again."
    : undefined;
}

class AntigravitySession implements HarnessSession {
  readonly id: string;
  private aliasFile: string | undefined;
  private nativeSessionId: string | null = null;
  private transcript: ChatMessage[] = [];
  private config: HarnessModelSettings;
  private title: string | undefined;
  private handoffPending = false;
  private enabledTools: string[] | undefined;
  private actualModel: ModelSummary | undefined;
  private availableThinking = ["medium"];
  private readonly listeners = new Set<Listener>();
  private running = false;
  private replaying = false;
  private cancelRequested = false;
  private started = false;
  private replied = false;
  private assistant = "";
  private currentInput: HarnessPrompt | undefined;
  private child: ChildProcessWithoutNullStreams | undefined;
  private connection: Connection | undefined;
  private readonly toolCalls = new Map<string, ToolCall>();
  private writes: Promise<void> = Promise.resolve();
  private writeFailure: unknown;

  constructor(private readonly options: HarnessOpenOptions) {
    this.id = options.sessionId;
    this.aliasFile = options.sessionPath?.replace(/^antigravity:/, "");
    this.config = options.sessionPath ? { provider: "antigravity", modelId: "default", reasoning: "medium" } : defaultSettings();
  }

  async load(): Promise<void> {
    if (!this.aliasFile) return;
    const stored = await readAntigravitySession(this.aliasFile);
    this.transcript = stored.messages;
    this.nativeSessionId = stored.nativeSessionId;
    this.title = stored.title;
    this.handoffPending = stored.handoffPending;
    this.config = { provider: "antigravity", modelId: stored.modelId, reasoning: stored.reasoning };
    this.enabledTools = stored.enabledTools;
  }

  get file(): string | undefined { return this.aliasFile ? `antigravity:${this.aliasFile}` : undefined; }
  get messages(): ChatMessage[] { return this.transcript; }

  status(): SessionStatus {
    return {
      sessionFile: this.file, sessionId: this.id, sessionName: this.title,
      model: this.actualModel ?? { provider: "antigravity", id: this.config.modelId, label: this.config.modelId === "default" ? "Antigravity default" : this.config.modelId },
      thinkingLevel: this.config.reasoning, availableThinkingLevels: this.availableThinking,
      isStreaming: this.running, isCompacting: false, isRetrying: false, isBashRunning: false,
      pendingMessageCount: 0, messageCount: this.transcript.length,
      activeTools: this.enabledTools ?? toolCategories, promptTemplates: [],
    };
  }

  isBusy(): boolean { return this.running; }
  queuedPrompts(): string[] { return []; }
  settings(): HarnessModelSettings { return { ...this.config, ...(this.enabledTools === undefined ? {} : { enabledTools: [...this.enabledTools] }) }; }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: HarnessEvent): void { for (const listener of this.listeners) listener(event); }

  private identity(): GuardianIdentity {
    return { projectId: this.options.projectId, conversationId: this.options.conversationId ?? this.id, harness: "antigravity", cwd: this.options.cwd, canReplaceTool: false };
  }

  private environment(): NodeJS.ProcessEnv {
    const conversation = { engine: "antigravity", sessionId: this.id };
    return {
      ...process.env,
      ...agentEnvironment(this.options.projectId, conversation),
      ...agentCapabilityEnvironment(this.options.projectId, "antigravity", this.options.conversationId ?? this.id, conversation),
    };
  }

  async preflight(): Promise<void> {
    await checkAntigravityExecutable(this.options.cwd, this.environment());
    try { await probeAntigravity(this.options.cwd); }
    catch (error) { throw new Error(loginProblem(error) ?? (error instanceof Error ? error.message : String(error))); }
  }

  async prompt(input: HarnessPrompt): Promise<void> {
    if (this.running) throw new Error("Google Antigravity session is busy");
    this.running = true;
    this.currentInput = input;
    this.started = false;
    this.replied = false;
    this.assistant = "";
    this.cancelRequested = false;
    this.toolCalls.clear();
    this.emit({ type: "agent_start" });
    let failure: unknown;
    try {
      await this.startProcess();
      await this.initializeNativeSession();
      const text = await guardAntigravityPrompt(this.identity(), input.text);
      const expanded = this.handoffPending ? `${buildHandoffContext(this.transcript)}${text}` : text;
      await input.beforeStart?.();
      this.throwIfCancelled();
      const response = object(await this.connection!.request("session/prompt", { sessionId: this.nativeSessionId, prompt: this.promptContent(expanded, input) }), "prompt response");
      await this.finishPrompt(response);
    } catch (error) {
      this.persistAssistant();
      failure = this.cancelRequested ? new Error("Google Antigravity turn cancelled") : new Error(loginProblem(error) ?? (error instanceof Error ? error.message : String(error)));
    }
    for (const finish of [() => this.finishWrites(), () => this.cleanup()]) {
      try { await finish(); }
      catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], "Google Antigravity prompt and cleanup failed"); }
    }
    this.currentInput = undefined;
    this.running = false;
    this.emit({ type: "status", status: this.status() });
    this.emit({ type: "agent_end" });
    if (failure !== undefined) throw failure;
  }

  private promptContent(text: string, input: HarnessPrompt): JsonObject[] {
    const prompt: JsonObject[] = [{ type: "text", text }];
    for (const image of input.images ?? []) prompt.push({ type: "image", data: image.data, mimeType: image.mimeType });
    return prompt;
  }

  private async startProcess(): Promise<void> {
    const env = this.environment();
    this.child = spawnAntigravity(this.options.cwd, ["acp"], env);
    this.connection = createAntigravityConnection(this.child, (method, params) => this.notification(method, params), (method, params) => this.serverRequest(method, params));
  }

  private async initializeNativeSession(): Promise<void> {
    const initialized = object(await this.connection!.request("initialize", {
      protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "joint-bob", version: "1" },
    }), "initialize response");
    if (initialized.protocolVersion !== 1) throw new Error(`Unsupported Antigravity ACP protocol version: ${String(initialized.protocolVersion)}`);
    const method = this.nativeSessionId ? "session/load" : "session/new";
    const params = this.nativeSessionId
      ? { sessionId: this.nativeSessionId, cwd: this.options.cwd, mcpServers: [] }
      : { cwd: this.options.cwd, mcpServers: [] };
    this.replaying = method === "session/load";
    let response: JsonObject;
    try { response = object(await this.connection!.request(method, params), "session response"); }
    finally { this.replaying = false; }
    this.nativeSessionId ??= requiredString(response.sessionId, "session ID");
    const options = await applyAntigravitySettings(this.connection!, this.nativeSessionId, response.configOptions, this.config);
    this.applyConfiguration(options);
    if (method === "session/new") {
      if (!this.aliasFile) this.aliasFile = await initializeAntigravitySession(this.options, this.settings());
      this.queueRecord({ type: "native-session", id: this.nativeSessionId, handoffPending: this.handoffPending, timestamp: new Date().toISOString() });
      this.emit({ type: "sessionFile", sessionId: this.id, sessionFile: this.file });
    }
  }

  private applyConfiguration(options: ReturnType<typeof antigravityConfigOptions>): void {
    const model = options.find((option) => option.id === "model")!;
    const selected = model.options.find((choice) => choice.value === model.currentValue);
    this.actualModel = { provider: "antigravity", id: model.currentValue, label: selected?.name ?? model.currentValue };
    const effort = options.find((option) => /effort|reasoning|thinking/i.test(`${option.id} ${option.name}`));
    this.availableThinking = effort ? effort.options.map((choice) => choice.value.toLowerCase() === "extra" ? "xhigh" : choice.value.toLowerCase()) : ["medium"];
    this.emit({ type: "status", status: this.status() });
  }

  private notification(method: string, params: unknown): void {
    if (method !== "session/update" || this.replaying) return;
    const envelope = object(params, "session update envelope");
    if (envelope.sessionId !== this.nativeSessionId) return;
    const update = object(envelope.update, "session update");
    const kind = requiredString(update.sessionUpdate, "session update type");
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const content = object(update.content, "content chunk");
      if (content.type !== "text" || typeof content.text !== "string") return;
      this.markStarted();
      if (kind === "agent_message_chunk") { this.assistant += content.text; this.replied ||= content.text.trim().length > 0; }
      this.emit({ type: kind === "agent_message_chunk" ? "textDelta" : "thinkingDelta", text: content.text });
      return;
    }
    if (kind === "tool_call") { this.handleToolStart(update); return; }
    if (kind === "tool_call_update") { this.handleToolUpdate(update); return; }
    if (["available_commands_update", "current_mode_update", "plan", "user_message_chunk", "config_option_update", "session_info_update"].includes(kind)) return;
  }

  private handleToolStart(update: JsonObject): void {
    const id = requiredString(update.toolCallId, "tool call ID"), title = requiredString(update.title, "tool title");
    const metadata = update._meta === undefined ? undefined : object(update._meta, "tool metadata");
    const toolName = typeof metadata?.toolName === "string" ? metadata.toolName : title;
    this.toolCalls.set(id, { title, toolName, rawInput: update.rawInput, startedAt: Date.now() });
    this.markStarted();
    this.persistAssistant();
    this.emit({ type: "toolStart", toolCallId: id, toolName, title, args: update.rawInput });
  }

  private handleToolUpdate(update: JsonObject): void {
    const id = requiredString(update.toolCallId, "tool call ID"), call = this.toolCalls.get(id);
    if (!call) throw new Error(`Antigravity ACP tool update references unknown call: ${id}`);
    const parts = Array.isArray(update.content) ? update.content.flatMap((value) => {
      const part = object(value, "tool content");
      if (part.type === "diff") return [`${requiredString(part.path, "diff path")}\n${requiredString(part.newText, "diff text")}`];
      if (part.type !== "content") return [];
      const content = object(part.content, "tool content value");
      return content.type === "text" && typeof content.text === "string" ? [content.text] : [];
    }) : [];
    const text = parts.length ? parts.join("\n") : update.rawOutput === undefined ? "" : typeof update.rawOutput === "string" ? update.rawOutput : JSON.stringify(update.rawOutput);
    if (update.status !== "completed" && update.status !== "failed") {
      if (text) this.emit({ type: "toolUpdate", toolCallId: id, toolName: call.toolName, title: call.title, text });
      return;
    }
    const finishedAt = Date.now(), isError = update.status === "failed", durationMs = Math.max(0, finishedAt - call.startedAt);
    this.emit({ type: "toolEnd", toolCallId: id, toolName: call.toolName, title: call.title, text, isError });
    if (!this.currentInput) return;
    const timestamp = new Date(finishedAt).toISOString();
    this.transcript.push({ id: `${this.id}:tool:${this.transcript.length}`, role: "toolResult", toolName: call.toolName, text, timestamp, durationMs, ...(isError ? { isError: true } : {}) });
    this.queueRecord({ type: "tool", toolName: call.toolName, text, durationMs, ...(isError ? { isError: true } : {}), timestamp });
  }

  private async serverRequest(method: string, params: unknown): Promise<unknown> {
    if (method !== "session/request_permission") throw new Error(`Unsupported Antigravity ACP request: ${method}`);
    const request = object(params, "permission request");
    if (request.sessionId !== this.nativeSessionId) return { outcome: { outcome: "cancelled" } };
    const call = request.toolCall === undefined ? undefined : object(request.toolCall, "permission tool call");
    const id = typeof call?.toolCallId === "string" ? call.toolCallId : undefined;
    return antigravityPermission(this.identity(), request, this.enabledTools, id ? this.toolCalls.get(id) : undefined);
  }

  private markStarted(): void {
    if (this.started) return;
    this.started = true;
    if (this.handoffPending) {
      this.queueRecord({ type: "handoff-completed", timestamp: new Date().toISOString() });
      this.handoffPending = false;
    }
    const text = stripHandoffEnvelope(this.currentInput!.text), timestamp = new Date().toISOString();
    this.transcript.push({ id: `${this.id}:user:${this.transcript.length}`, role: "user", text, timestamp });
    this.queueRecord({ type: "message", role: "user", text, timestamp });
    this.currentInput!.onStarted?.();
  }

  private persistAssistant(): void {
    if (!this.assistant) return;
    const timestamp = new Date().toISOString(), provider = "antigravity", modelId = this.actualModel?.id ?? this.config.modelId;
    this.transcript.push({ id: `${this.id}:assistant:${this.transcript.length}`, role: "assistant", text: this.assistant, timestamp,
      attribution: { harnessId: "antigravity", provider, modelId, reasoning: this.config.reasoning } });
    this.queueRecord({ type: "message", role: "assistant", text: this.assistant, provider, modelId, reasoning: this.config.reasoning, timestamp });
    this.assistant = "";
  }

  private async finishPrompt(response: JsonObject): Promise<void> {
    const reason = requiredString(response.stopReason, "stop reason");
    if (reason === "cancelled") throw new Error("Google Antigravity turn cancelled");
    if (reason !== "end_turn") throw new Error(`Google Antigravity turn failed with stop reason: ${reason}`);
    this.markStarted();
    if (!this.replied) throw new Error("Google Antigravity ended the turn without a reply");
    this.persistAssistant();
    await this.finishWrites();
  }

  private queueRecord(value: JsonObject): void {
    if (!this.aliasFile) throw new Error("Google Antigravity transcript is not initialized");
    this.writes = this.writes.then(() => appendAntigravityRecord(this.aliasFile!, value)).catch((error) => { this.writeFailure = error; });
  }

  private async finishWrites(): Promise<void> {
    await this.writes;
    if (this.writeFailure) throw this.writeFailure;
  }

  private throwIfCancelled(): void { if (this.cancelRequested) throw new Error("Google Antigravity turn cancelled"); }

  private async cleanup(): Promise<void> {
    const child = this.child, connection = this.connection;
    this.child = undefined;
    this.connection = undefined;
    if (!child || !connection) return;
    child.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([connection.closed, new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000); })]); }
    finally { clearTimeout(timer); if (child.pid) await stopProcessGroup(child, "Google Antigravity"); }
  }

  async configure(settings: HarnessModelSettings): Promise<void> {
    if (this.running) throw new Error("Google Antigravity session is busy");
    validate(settings);
    if (this.config.modelId === settings.modelId && this.config.reasoning === settings.reasoning && JSON.stringify(this.enabledTools) === JSON.stringify(settings.enabledTools)) return;
    this.config = { provider: "antigravity", modelId: settings.modelId, reasoning: settings.reasoning };
    this.actualModel = undefined;
    this.enabledTools = settings.enabledTools === undefined ? undefined : [...settings.enabledTools];
    if (this.aliasFile) {
      this.queueRecord({ type: "settings", modelId: settings.modelId, reasoning: settings.reasoning, enabledTools: this.enabledTools, timestamp: new Date().toISOString() });
      await this.finishWrites();
    }
  }

  tools(): HarnessTool[] {
    return toolCategories.map((name) => ({ name, description: name, active: this.enabledTools === undefined || this.enabledTools.includes(name) }));
  }

  async setTools(names: string[]): Promise<void> {
    if (this.running) throw new Error("Google Antigravity session is busy");
    if (names.some((name) => !toolCategories.includes(name))) throw new Error("Unknown Google Antigravity tool category");
    this.enabledTools = [...names];
    if (this.aliasFile) {
      this.queueRecord({ type: "settings", modelId: this.config.modelId, reasoning: this.config.reasoning, enabledTools: this.enabledTools, timestamp: new Date().toISOString() });
      await this.finishWrites();
    }
  }

  async compact(): Promise<void> { throw new Error("Google Antigravity ACP does not support compaction through Joint Bob"); }

  async rename(name: string): Promise<void> {
    if (!name.trim()) throw new Error("Google Antigravity title must not be empty");
    this.title = name.trim();
    if (this.aliasFile) {
      this.queueRecord({ type: "title", title: this.title, timestamp: new Date().toISOString() });
      await this.finishWrites();
    }
  }

  async reload(): Promise<void> {}
  async setSafeguards(): Promise<void> { throw new Error("Google Antigravity does not support Pi safeguards"); }

  async cancel(): Promise<void> {
    if (!this.running) throw new Error("Google Antigravity session is not running");
    this.cancelRequested = true;
    if (this.connection && this.nativeSessionId) this.connection.notify("session/cancel", { sessionId: this.nativeSessionId });
    if (this.child) await stopProcessGroup(this.child, "Google Antigravity");
  }

  async stopForUpdate(): Promise<void> { if (this.child) await stopProcessGroup(this.child, "Google Antigravity"); }
  dispose(): void { if (this.running) throw new Error("Cannot dispose a running Google Antigravity session"); this.listeners.clear(); }
}

const runtime: HarnessRuntime = {
  async open(options) {
    if (!options.sessionPath) await persistConversationSecretAccounts("antigravity", options.sessionId, options.accountIds ?? []);
    const session = new AntigravitySession(options);
    await session.load();
    return session;
  },

  async providers() { return [{ id: "antigravity", label: "Google Antigravity" }]; },
  async validateSettings(settings) { validate(settings); },
  async externalRunning() { return []; },

  async readiness(cwd, env) {
    try { await checkAntigravityExecutable(cwd, env ?? process.env); return []; }
    catch (error) { return [`Google Antigravity CLI unavailable: ${error instanceof Error ? error.message : String(error)}`]; }
  },

  async signInProblems() {
    try { await probeAntigravity(); return []; }
    catch (error) { return [loginProblem(error) ?? `Google Antigravity sign-in check failed: ${error instanceof Error ? error.message : String(error)}`]; }
  },
};

export default runtime;
