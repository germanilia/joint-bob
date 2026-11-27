import { access } from "node:fs/promises";
import { agentRunDescriptor } from "../../agent-run-monitor.js";
import { recordConversationWork } from "../../conversation-work.js";
import { getSettings } from "../../settings.js";
import { teamAssistantForConversation } from '../../assistant-resources.js';
import { UpdateRefusalError } from "../../updater.js";
import { listRunningPiSessions } from "../../pi-runtime.js";
import * as service from "../../pi-service.js";
import { rewindPiTranscript } from "../../pi-session-core.js";
import { poolProfileContext } from "../../provider-profiles/context.js";
import type { ChatMessage, ModelSummary } from "../../types.js";
import type {
  HarnessEvent,
  HarnessModelSettings,
  HarnessOpenOptions,
  HarnessPrompt,
  HarnessRuntime,
  HarnessSession,
} from "../runtime.js";

type PiHandle = Awaited<ReturnType<typeof service.createPiSession>>;
type Listener = (event: HarnessEvent) => void;

function assistantFailure(messages: unknown[]): string | undefined {
  const last = messages.at(-1);
  if (!last || typeof last !== "object") return undefined;
  const value = last as { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
  if (value.role !== "assistant" || (value.stopReason !== "error" && value.stopReason !== "aborted")) return undefined;
  if (typeof value.errorMessage === "string" && value.errorMessage) return value.errorMessage;
  return `Pi turn ${value.stopReason}`;
}

/** Pi writes a provider's HTTP error as "<status>: <body>" or "<provider> (<status>): <body>" (pi-ai formatProviderError). */
const PROVIDER_ERROR_STATUS = /^(?:(\d{3})|[^():\n]+ \((\d{3})\)): /;

/**
 * A failed turn as an error that keeps the provider's HTTP status, so a subscription pool can tell an exhausted account (429)
 * or a rejected sign-in (401/403) and hand the turn to its next member.
 * fix: a z.ai member's "429: Insufficient balance" ended the turn instead of moving on (ilia-mac-2, 2026-11-27).
 */
function turnFailure(message: string): Error {
  const match = PROVIDER_ERROR_STATUS.exec(message);
  return match ? Object.assign(new Error(message), { status: Number(match[1] ?? match[2]) }) : new Error(message);
}

export class PiSession implements HarnessSession {
  private handle: PiHandle;
  private readonly listeners = new Set<Listener>();
  private unsubscribeNative: () => void = () => {};
  private stoppingForUpdate = false;
  /**
   * A model picked while the conversation runs on a subscription pool. Outside a member's attempt no profile is
   * signed in to switch with, so the session keeps its model and reports this one; the next attempt switches.
   * fix: picking a model on a pool failed with "Selected cluster subscription pool requires pool-aware execution"
   * (homeserver, 2026-11-15).
   */
  private poolPick: { model: ModelSummary; reasoning: string; levels: string[] } | undefined;

  constructor(private readonly options: HarnessOpenOptions, handle: PiHandle) {
    this.handle = handle;
    this.subscribeNative();
  }

  private subscribeNative(): void {
    this.unsubscribeNative();
    this.unsubscribeNative = this.handle.session.subscribe((event) => {
      const run = agentRunDescriptor(event);
      if (run) {
        recordConversationWork({ engine: "pi", sessionId: this.handle.session.sessionId, descriptor: run, summary: run.summary });
        for (const listener of this.listeners) listener({ type: "conversationWorkChanged" });
      }
      const payload = service.eventPayload(event);
      const expectedUpdateAbort = this.stoppingForUpdate
        && payload.type === "assistantError"
        && /\babort(?:ed)?\b/i.test(String(payload.error ?? ""));
      if (!expectedUpdateAbort) for (const listener of this.listeners) listener(payload);
    });
  }

  get id(): string {
    return this.handle.session.sessionId;
  }

  get file(): string | undefined {
    return this.handle.session.sessionFile;
  }

  get messages(): ChatMessage[] {
    return service.simplifyTranscriptEntries(this.snapshotEntries());
  }

  snapshotEntries(): unknown[] {
    return JSON.parse(JSON.stringify([this.handle.session.sessionManager.getHeader(), ...this.handle.session.sessionManager.getBranch()]));
  }

  status() {
    const status = service.getSessionStatus(this.handle.session, this.handle.safeguardsEnabled);
    if (!this.poolPick) return status;
    return { ...status, model: this.poolPick.model, thinkingLevel: this.poolPick.reasoning, availableThinkingLevels: this.poolPick.levels };
  }

  isBusy(): boolean {
    return service.sessionIsBusy(this.handle);
  }

  queuedPrompts(): string[] {
    return [...this.handle.session.getSteeringMessages(), ...this.handle.session.getFollowUpMessages()];
  }

  settings(): HarnessModelSettings {
    const enabledTools = this.handle.session.getActiveToolNames();
    if (this.poolPick) return { provider: this.poolPick.model.provider, modelId: this.poolPick.model.id, reasoning: this.poolPick.reasoning, enabledTools };
    const model = this.handle.session.model;
    if (!model) throw new Error("Pi session has no selected model");
    return { provider: model.provider, modelId: model.id, reasoning: this.handle.session.thinkingLevel, enabledTools };
  }

  /** Puts a model picked on a pool in place before work that needs it; inside a member's attempt the profile is signed in. */
  private async applyPoolPick(): Promise<void> {
    if (this.poolPick) await this.configure(this.settings());
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async preflight(): Promise<void> {
    await this.applyPoolPick();
    const model = this.handle.session.model;
    if (!model) throw new Error("Pi session has no selected model");
    const check = async () => {
      if (!await this.handle.session.modelRuntime.getAuth(model)) throw new Error("Pi model authentication unavailable on this node");
    };
    if (this.handle.withModelProfile) await this.handle.withModelProfile(model.provider, check);
    else { await service.reloadPiAuth(); await check(); }
  }

  async prompt(input: HarnessPrompt): Promise<void> {
    if (this.handle.reloadingSkills) throw new Error("Pi session is reloading skills");
    await this.applyPoolPick();
    let started = false;
    await service.promptIdlePiSession(this.handle, async () => {
      if (teamAssistantForConversation(this.options.projectId, this.options.conversationId ?? this.id)) await service.reloadPiSkills(this.handle);
      const send = async () => {
      await input.beforeStart?.();
      const previousLastMessage = this.handle.session.messages.at(-1);
      const unsubscribe = this.handle.session.subscribe((event) => {
        if (!started && event.type === "agent_start") {
          started = true;
          input.onStarted?.();
        }
      });
      try {
        await this.handle.session.prompt(input.text, { images: input.images });
        const messages = this.handle.session.messages;
        if (messages.at(-1) !== previousLastMessage) {
          const failure = assistantFailure(messages);
          if (failure) throw turnFailure(failure);
        }
        if (!started) {
          started = true;
          input.onStarted?.();
        }
      } finally {
        unsubscribe();
      }
      };
      const provider = this.handle.session.model?.provider;
      if (this.handle.withModelProfile && provider) await this.handle.withModelProfile(provider, send);
      else await send();
    });
  }

  async checkpointPoolAttempt(): Promise<unknown> {
    if (this.isBusy()) throw new Error("Cannot checkpoint a busy Pi session");
    return { leafId: this.handle.session.sessionManager.getLeafId() };
  }

  /**
   * Rewinds only the transcript. Switching the model back would need a signed-in profile, and a restore
   * runs between pool attempts, outside any member's profile; the next attempt configures its own model.
   */
  async restorePoolAttempt(checkpoint: unknown): Promise<void> {
    if (this.isBusy()) throw new Error("Cannot restore a busy Pi session");
    const { leafId } = checkpoint as { leafId: string | null };
    const session = this.handle.session;
    // A session in a worker rewinds there, on these same calls; one in this process is rewound here.
    if ((session as { agent?: unknown }).agent) rewindPiTranscript(session, leafId);
    else if (leafId) await session.sessionManager.branch(leafId); else await session.sessionManager.resetLeaf();
  }

  async configure(settings: HarnessModelSettings): Promise<void> {
    if (service.sessionIsBusy(this.handle)) throw new Error("Pi session is busy");
    const currentModel = this.handle.session.model;
    const switching = !currentModel || currentModel.provider !== settings.provider || currentModel.id !== settings.modelId;
    if (switching && !poolProfileContext() && await this.handle.modelFromPool?.()) {
      // The catalog a switch reads (setSessionModel); a pool member's sign-in, not this node's, decides whether it runs.
      const model = await service.catalogModelSummary(settings.provider, settings.modelId);
      if (!model) throw new Error(`Model not found: ${settings.provider}/${settings.modelId}`);
      const levels = model.thinkingLevels;
      if (!levels.includes(settings.reasoning)) throw new Error("Pi reasoning level is not supported");
      this.poolPick = { model, reasoning: settings.reasoning, levels };
      if (settings.enabledTools !== undefined) {
        const available = new Set(this.handle.session.getAllTools().map((tool) => tool.name));
        await this.setTools(settings.enabledTools.filter((name) => available.has(name)));
      }
      return;
    }
    this.poolPick = undefined;
    if (switching) {
      const changeModel = () => service.setSessionModel(this.handle.session, settings.provider, settings.modelId);
      if (this.handle.withModelProfile) await this.handle.withModelProfile(settings.provider, changeModel);
      else await changeModel();
    }
    const levels = this.handle.session.getAvailableThinkingLevels();
    if (!levels.includes(settings.reasoning as Parameters<typeof this.handle.session.setThinkingLevel>[0])) {
      throw new Error("Pi reasoning level is not supported");
    }
    this.handle.session.setThinkingLevel(settings.reasoning as Parameters<typeof this.handle.session.setThinkingLevel>[0]);
    if (settings.enabledTools !== undefined) {
      const available = new Set(this.handle.session.getAllTools().map((tool) => tool.name));
      await this.setTools(settings.enabledTools.filter((name) => available.has(name)));
    }
  }

  tools() {
    const active = new Set(this.handle.session.getActiveToolNames());
    return this.handle.session.getAllTools()
      .map((tool) => ({ name: tool.name, description: tool.description, active: active.has(tool.name) }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async setTools(names: string[]): Promise<void> {
    if (service.sessionIsBusy(this.handle)) throw new Error("Pi session is busy");
    const available = new Set(this.handle.session.getAllTools().map((tool) => tool.name));
    const unknown = names.find((name) => !available.has(name));
    if (unknown) throw new Error(`Unknown tool: ${unknown}`);
    const active = new Set(this.handle.session.getActiveToolNames());
    if (active.size === names.length && names.every((name) => active.has(name))) return;
    this.handle.session.sessionManager.appendCustomEntry("joint-bob:tools", { enabledTools: names });
    this.handle.session.setActiveToolsByName(names);
    for (const listener of this.listeners) listener({ type: "configuration" });
  }

  async compact(instructions?: string, beforeStart?: () => Promise<void>): Promise<void> {
    if (service.sessionIsBusy(this.handle)) throw new Error("Pi session is busy");
    await this.applyPoolPick();
    await beforeStart?.();
    const provider = this.handle.session.model?.provider;
    if (this.handle.withModelProfile && provider) await this.handle.withModelProfile(provider, () => this.handle.session.compact(instructions));
    else await this.handle.session.compact(instructions);
  }

  async rename(name: string): Promise<void> {
    this.handle.session.setSessionName(name);
  }

  async reload(): Promise<void> {
    await service.reloadPiSkills(this.handle);
  }

  async setSafeguards(enabled: boolean): Promise<void> {
    if (this.handle.safeguardsEnabled === enabled) return;
    if (service.sessionIsBusy(this.handle)) throw new Error("Wait for the Pi session to finish before changing safeguards");
    const previous = this.handle;
    previous.reloadingSkills = true;
    try {
      previous.session.sessionManager.appendCustomEntry("joint-bob:safeguards", { enabled });
      try {
        this.handle = await service.createPiSession({
          cwd: this.options.cwd,
          projectId: this.options.projectId,
          sessionPath: previous.session.sessionFile,
          conversationId: this.options.conversationId,
          safeguardsEnabled: enabled,
          conversation: { engine: "pi", sessionId: this.options.sessionId },
        });
      } catch (error) {
        previous.session.sessionManager.appendCustomEntry("joint-bob:safeguards", { enabled: previous.safeguardsEnabled });
        throw error;
      }
      this.subscribeNative();
      previous.dispose();
    } finally {
      previous.reloadingSkills = false;
    }
  }

  async cancel(): Promise<void> {
    this.abortOperations();
    await this.handle.session.abort();
  }

  private abortOperations(): void {
    this.handle.session.abortRetry();
    this.handle.session.abortCompaction();
    this.handle.session.abortBranchSummary();
    this.handle.session.abortBash();
  }

  async stopForUpdate(): Promise<void> {
    this.stoppingForUpdate = true;
    this.handle.session.clearQueue();
    this.abortOperations();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.handle.session.abort(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new UpdateRefusalError("Pi did not stop within 60 seconds. Update refused; recovery records retained. Verify tools have stopped before restarting the service.")), 60_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  dispose(): void {
    this.unsubscribeNative();
    this.handle.dispose();
    this.listeners.clear();
  }
}

export function piForkEntries(session: HarnessSession): unknown[] {
  if (!(session instanceof PiSession)) throw new Error("Pi fork callback received a non-Pi session");
  return session.snapshotEntries();
}

const runtime: HarnessRuntime = {
  async open(options) {
    const handle = await service.createPiSession({
      cwd: options.cwd,
      projectId: options.projectId,
      sessionPath: options.sessionPath,
      sessionId: options.sessionId,
      conversationId: options.conversationId,
      conversation: { engine: "pi", sessionId: options.sessionId, accountIds: options.sessionPath ? undefined : options.accountIds },
    });
    return new PiSession(options, handle);
  },

  async providers() {
    // Pi lists only models whose provider has usable authentication, so their providers are the configured ones.
    const ids = [...new Set((await service.listAvailableModels()).map((model) => model.provider))];
    return ids.sort().map((id) => ({ id, label: id }));
  },

  async validateSettings(settings) {
    const model = await service.runnablePiModel(settings.provider, settings.modelId);
    if (!model) throw new Error(`Model not found: ${settings.provider}/${settings.modelId}`);
    if (!model.thinkingLevels.includes(settings.reasoning)) {
      throw new Error("Pi reasoning level is not supported");
    }
  },

  async externalRunning() {
    return listRunningPiSessions().map(({ sessionId, runId }) => ({ sessionId, runId }));
  },

  async readiness() {
    const configPath = getSettings().runtimes.pi.configPath;
    try {
      await access(configPath);
      return [];
    } catch (error) {
      if (["ENOENT", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        return [`Pi configuration unavailable: ${configPath}`];
      }
      throw error;
    }
  },

  async signInProblems() {
    // Pi lists only models whose provider has usable authentication.
    return (await service.listAvailableModels()).length ? [] : ["Pi is not signed in to any model provider on this node"];
  },
};

export default runtime;
