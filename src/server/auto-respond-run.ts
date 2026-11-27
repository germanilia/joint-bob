import { prepareBackgroundTurn } from "./background-turn.js";
import { internalSessionId } from "../internal-sessions.js";
import { getHarness, getHarnessRuntime } from "../harnesses.js";
import type { HarnessEvent, HarnessModelSettings } from "../harnesses/runtime.js";
import { validateAutoRespondProfile, type AutoRespondConfig } from "../conversation-auto-respond.js";
import { withAutomationProfile } from "../provider-profiles/context.js";

// Checking the agent's work can mean running a test suite; judging text alone is quick.
const RESPONDER_TIMEOUT_MS = 20 * 60_000;
const TEXT_ONLY_TIMEOUT_MS = 120_000;
const STARTUP_TIMEOUT_MS = 120_000;

export class AutoResponderStartupTimeoutError extends Error {
  constructor() { super("The auto responder did not start within 2 minutes"); }
}

export interface AutoRespondRunInput {
  projectId: string;
  conversationId: string;
  cwd: string;
  accountIds?: string[];
  creatorAccountId?: string | null;
  config: AutoRespondConfig;
  prompt: string;
  signal: AbortSignal;
  /** Names each tool the responder starts, so the conversation can show what it is checking. */
  onStep: (step: string) => void;
}

/**
 * One responder decision in a throwaway harness session. Its deadline includes setup and
 * teardown, so a stalled harness cannot hold the conversation's prompt queue.
 */
export async function runAutoResponder(input: AutoRespondRunInput): Promise<string> {
  if (input.signal.aborted) throw new Error("Auto respond was cancelled");
  const accountId = input.creatorAccountId;
  if (!accountId) throw new Error("Auto responder creator is missing; save its settings again");
  validateAutoRespondProfile(accountId, input.config);
  const { providerProfileId, providerPoolId } = input.config;
  const deadline = new AbortController();
  const signal = AbortSignal.any([input.signal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(new Error("The auto responder timed out")), input.config.useTools ? RESPONDER_TIMEOUT_MS : TEXT_ONLY_TIMEOUT_MS);
  timer.unref();
  const startupTimer = input.config.useTools ? setTimeout(() => deadline.abort(new AutoResponderStartupTimeoutError()), STARTUP_TIMEOUT_MS) : undefined;
  startupTimer?.unref();
  const onStarted = () => clearTimeout(startupTimer);
  let onAbort!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(deadline.signal.aborted ? deadline.signal.reason : new Error("Auto respond was cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const runInput = { ...input, signal, onStep: (step: string) => { if (!signal.aborted) input.onStep(step); } };
    const run = withAutomationProfile({ accountId, profileId: providerProfileId ?? null, ...(providerPoolId ? { poolId: providerPoolId } : {}) }, () => executeAutoResponder(runInput, stopped, onStarted));
    // Cleanup still runs inside the throwaway session, but the conversation need not wait for it.
    return await Promise.race([run, stopped]);
  } finally {
    clearTimeout(timer);
    clearTimeout(startupTimer);
    signal.removeEventListener("abort", onAbort);
  }
}

async function executeAutoResponder(input: AutoRespondRunInput, stopped: Promise<never>, onStarted: () => void): Promise<string> {
  const cancelled = () => { if (input.signal.aborted) throw new Error("Auto respond was cancelled"); };
  const override = process.env.JOINT_BOB_AUTO_RESPONDER;
  if (override) {
    const module = await import(override) as { default: (input: AutoRespondRunInput) => Promise<string> };
    cancelled();
    onStarted();
    return module.default(input);
  }
  const adapter = getHarness(input.config.harnessId as never);
  if (!adapter.runtime) throw new Error(`${adapter.label} cannot run the auto responder`);
  const runtime = await getHarnessRuntime(input.config.harnessId as never);
  cancelled();
  const session = await runtime.open({ projectId: input.projectId, cwd: input.cwd, sessionId: internalSessionId(), conversationId: input.conversationId, ...(input.accountIds ? { accountIds: input.accountIds } : {}) });
  const events: string[] = [];
  const unsubscribeText = session.subscribe((event: HarnessEvent) => {
    if (event.type === "agent_start") events.length = 0;
    if (event.type === "textDelta" && typeof event.text === "string") events.push(event.text);
    if (event.type === "toolStart") input.onStep(String(event.toolName));
  });
  let unsubscribeEnd: (() => void) | undefined;
  try {
    cancelled();
    const base = session.settings();
    const settings: HarnessModelSettings = { ...base, provider: input.config.provider, modelId: input.config.modelId, reasoning: input.config.thinkingLevel };
    if (!input.config.useTools) settings.enabledTools = [];
    const turn = await prepareBackgroundTurn({ ...input, harnessId: input.config.harnessId as never, runtime, session, settings });
    cancelled();
    // With tools off the responder only judges text; a harness that cannot turn its tools off cannot run that way.
    if (!input.config.useTools) await session.setTools([]);
    cancelled();
    const ended = turn.pooled ? undefined : new Promise<void>((resolve, reject) => {
      unsubscribeEnd = session.subscribe((event: HarnessEvent) => {
        if (event.type === "agent_end") resolve();
        if (event.type === "error") reject(new Error(typeof event.error === "string" ? event.error : "The auto responder failed"));
      });
    });
    const prompt = turn.prompt({ text: input.prompt, beforeStart: async () => cancelled(), onStarted });
    await Promise.race([ended ? Promise.all([prompt, ended]) : prompt, stopped]);
    // After tool calls the reply spans several messages; the decision is in the last one.
    const last = [...session.messages].reverse().find((message) => message.role === "assistant" && message.text.trim());
    return (last?.text ?? events.join("")).trim();
  } finally {
    unsubscribeEnd?.();
    unsubscribeText();
    try { if (session.isBusy()) await session.cancel(); } catch { /* torn down regardless */ }
    session.dispose();
  }
}
