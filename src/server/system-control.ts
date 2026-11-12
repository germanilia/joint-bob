import { personalContinuationAllowed, READY_FOR_REVIEW } from "../control-center/auto-respond.js";
import { actingAccountFromSession } from "../account-context.js";
import { bobDatabase, readBobSettings, rememberBobAccount } from "../control-center/bob-store.js";
import { bobSessionFor } from "./control-center-session.js";
import { DEFAULT_AUTO_RESPOND_INSTRUCTIONS, enableAutoRespond, getAutoRespond, type AutoRespondConfig, type AutoRespondState, type SystemControlLimits } from "../conversation-auto-respond.js";
import type { MessageAuthor } from "../message-author-schema.js";

// System control: a conversation the person puts under it is driven by Bob's responder, on the conversation's own agent and model
// (so it runs on the same subscription pool as the agent), firmly following the person's standing instructions from Bob's
// settings and what they add for this conversation. It decides for them, keeps the agent going through failures, restarts,
// updates and subscription limits, and stops only when the work is ready for review, for credentials, or for an irreversible
// step. It is auto respond underneath, so it survives restarts the way auto respond does (auto-respond-recovery.ts).

const DRIVE = [
  "The user put this conversation under system control: you drive it for them and follow their instructions below firmly. Keep the agent working until the task is done and verified end to end; never let it stop for progress updates, confirmations or routine questions.",
  "Decide for the user: answer the agent's questions, choose between options and approve plans yourself, from the user's instructions and the original request. Take the agent's recommendation when it fits them, otherwise the simplest option that meets the request. Do not stop to ask the user.",
  "When the agent drifts from the user's instructions, say so and bring it back. When a turn failed or was interrupted (a restart, an update, a subscription limit), tell it to inspect the current state and partial results and carry on, without repeating side effects.",
  DEFAULT_AUTO_RESPOND_INSTRUCTIONS.split("\n\n").slice(1).join("\n\n"),
  "When the work is done and verified but the agent has not written its review report (what changed, how it was verified with the evidence, anything left), ask for it.",
].join("\n\n");

export const SYSTEM_CONTROL_STOP_INSTRUCTIONS = [
  `${READY_FOR_REVIEW}: the conversation's goal is achieved and verified end to end. For software, require relevant test coverage, passing tests and evidence the feature works. Require successful deployment only when explicitly requested. You checked the evidence yourself, and the agent's last message is its review report. Start REASON with "${READY_FOR_REVIEW}:" and say what you checked.`,
  "The agent needs something only the user can supply: a password, token, one-time code, sign-in or payment detail.",
  "The next step needs authorization the user has not given: deployment not explicitly requested, deleting data, force pushing, sending messages or email, spending money. Never answer Guardian approvals or bypass sign-in challenges; those require the person.",
].map((line) => `- ${line}`).join("\n");

/** The model the conversation runs on, which the responder runs on too. */
export interface ConversationModel { harnessId: string; provider: string; modelId: string; reasoning: string }

/** The responder's setup for a conversation under system control: no limit, tools on, the person's instructions inside. */
export function systemControlConfig(standing: string, extra: string, model: ConversationModel, limits: SystemControlLimits = {}): AutoRespondConfig {
  const instructions = [
    DRIVE,
    standing.trim() && `The user's standing instructions:\n${standing.trim()}`,
    extra.trim() && `The user's instructions for this conversation:\n${extra.trim()}`,
  ].filter(Boolean).join("\n\n");
  return {
    providerProfileId: null, harnessId: model.harnessId, provider: model.provider, modelId: model.modelId,
    thinkingLevel: (model.reasoning || "default") as AutoRespondConfig["thinkingLevel"],
    instructions, stopInstructions: SYSTEM_CONTROL_STOP_INSTRUCTIONS, maxResponses: limits.maxResponses ?? null, useTools: true,
    systemControl: { instructions: extra.trim(), maxMinutes: limits.maxMinutes ?? null, deadline: limits.maxMinutes ? new Date(Date.now() + limits.maxMinutes * 60_000).toISOString() : null },
  };
}

/** Puts a conversation under system control as the person, with their standing instructions and what they add for it. */
export async function enableSystemControl(projectId: string, conversationId: string, model: ConversationModel, author: MessageAuthor, extra: string, limits: SystemControlLimits = {}): Promise<AutoRespondState> {
  const db = await bobDatabase();
  // Bob tells the people he knows: what comes back from a conversation under system control reaches its person.
  const session = bobSessionFor(author.accountId, "system-control");
  if (session) rememberBobAccount(db, actingAccountFromSession(session));
  const settings = readBobSettings(db, author.accountId);
  await (await import("./control-center-review-check.js")).resumeBobChecks(projectId, conversationId);
  return enableAutoRespond(projectId, conversationId, systemControlConfig(settings.systemInstructions, extra, model, limits), author, author.accountId);
}

/**
 * A new conversation a person starts comes under system control when their default in Bob's settings says so. One that already
 * had auto respond (on, stopped or turned off) keeps what the person chose for it.
 */
export async function applySystemControlDefault(projectId: string, conversationId: string, model: ConversationModel, author: MessageAuthor): Promise<AutoRespondState | undefined> {
  if (!readBobSettings(await bobDatabase(), author.accountId).systemControl) return undefined;
  if (await getAutoRespond(projectId, conversationId)) return undefined;
  if (!await personalContinuationAllowed(projectId, conversationId)) return undefined;
  return enableSystemControl(projectId, conversationId, model, author, "");
}
