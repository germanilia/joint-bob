import { DEFAULT_AUTO_RESPOND_INSTRUCTIONS, DEFAULT_AUTO_RESPOND_STOP_INSTRUCTIONS, enableAutoRespond, getAutoRespond, type AutoRespondConfig } from "../conversation-auto-respond.js";
import { listHarnessModels } from "../harnesses.js";
import type { HarnessId } from "../types.js";
import type { BobSettings } from "./bob-store.js";
import type { BobDecision } from "./decisions.js";

/** Team turns, including Bob and source placeholders, advance only through assignments. */
export async function personalContinuationAllowed(projectId: string, conversationId: string): Promise<boolean> {
  return !await (await import('../assistant-teams/runtime.js')).teamConversation(projectId, conversationId);
}

/** What Bob adds to the default stop instructions: the things only the person may decide. */
const BOB_STOP_EXTRAS = [
  "The agent presents a plan or a design and waits for the user's approval.",
  "The agent asks for a decision that changes what users will see or how the product behaves.",
  "The next step touches production, deploys, pushes or merges to main, or cannot be undone.",
  "Something only the user can decide, or the agent is unsure what the user wants.",
].map((line) => `- ${line}`);

export const BOB_AUTO_RESPOND_STOP_INSTRUCTIONS = [DEFAULT_AUTO_RESPOND_STOP_INSTRUCTIONS, ...BOB_STOP_EXTRAS].join("\n");
export const BOB_AUTO_RESPOND_LIMIT = 10;

/**
 * Whether Bob turns on auto respond for a task it starts, so its responder answers the agent's routine questions: always when
 * the person said so, never when they said never, and otherwise when the decision model found the work routine.
 */
export function bobWantsAutoRespond(settings: BobSettings, decision: BobDecision): boolean {
  if (decision.kind !== "task" || settings.autoRespond === "never") return false;
  return settings.autoRespond === "always" || decision.autoRespond;
}

// ── Delegating a conversation to Bob ─────────────────────────────────────────────────────────────────────
// After the person's first instructions, Bob's responder drives the agent through the work, the fixes and an end-to-end check,
// and brings the conversation back only when it is ready for review, or for what only the person can give.

/** How the responder's REASON starts when the delegated work is done: Bob's chat then says it is ready for review. */
export const READY_FOR_REVIEW = "Ready for review";
export const BOB_DELEGATION_LIMIT = 40;

/** What the agent is told with the person's instructions when the work is delegated to Bob. */
export const DELEGATION_BRIEF = [
  "Bob drives this work for me from here; I will look at it when it is ready for review.",
  "Work through it on your own: implement it, fix what you find, and verify it end to end the way a user meets it (run the tests, run the app, and check the flow in a browser, an API call or a script). When something cannot be checked with what exists, add a way to check it. Do not stop for progress updates.",
  "Ask me only for access only I can give (a password, a token, a sign-in), a decision only I can make, or a risky or irreversible step (production, deploys, pushing or merging to main, deleting data, sending messages, spending money).",
  "When it is done, end with a review report: what you changed, how you verified it end to end with the evidence (the commands and their results, the tests, the pages or calls you checked), and anything left or risky.",
].join("\n");

const DELEGATION_INSTRUCTIONS = [
  DEFAULT_AUTO_RESPOND_INSTRUCTIONS,
  "The user delegated this work to you and will see it only when it is ready for review. Drive it to the end: when the agent stops with work left, tell it to go on; when it says it is done, check it yourself before you accept it.",
  "Done means implemented and verified end to end, with evidence you checked: the tests pass when you run them, and it works the way a user meets it. Until then, tell the agent what is missing.",
  "When it is done and verified but the agent has not written its review report (what changed, how it was verified with the evidence, anything left), ask for it.",
].join("\n\n");

const DELEGATION_STOP_INSTRUCTIONS = [
  `${READY_FOR_REVIEW}: the work is implemented and verified end to end, you checked the evidence yourself, and the agent's last message is its review report. Start REASON with "${READY_FOR_REVIEW}:" and say what you checked.`,
  "The agent needs access only the user can give: a password, token, one-time code, sign-in or payment detail.",
  "The agent needs a decision only the user can make: what users will see or how the product behaves, a plan or design to approve, or what the user wants when it is unclear.",
  "The next step is risky or cannot be undone: production, deploys, pushing or merging to main, deleting data, force pushing, sending messages or email, spending money.",
  "The agent is blocked by something it cannot fix, after trying.",
].map((line) => `- ${line}`).join("\n");

/** Bob's responder for a delegated conversation: it drives the work to a verified end instead of answering routine questions only. */
export async function bobDelegationConfig(settings: BobSettings, harnessId: HarnessId): Promise<AutoRespondConfig> {
  return { ...await bobAutoRespondConfig(settings, harnessId), instructions: DELEGATION_INSTRUCTIONS, stopInstructions: DELEGATION_STOP_INSTRUCTIONS, maxResponses: BOB_DELEGATION_LIMIT };
}

/** Whether the responder stopped because the delegated work is ready for review, not for something only the person can give. */
export function readyForReview(stopReason: string | null): boolean {
  return Boolean(stopReason?.startsWith(READY_FOR_REVIEW));
}

/** How Bob's chat labels delegated work that came back ready for review; a reply to it is the person's review. */
export const DELEGATED_READY_VIA = "Delegated to Bob · ready for review";

/** The person answered work Bob brought back for review: Bob drives it on with their feedback, with the setup it had. */
export async function resumeDelegation(projectId: string, conversationId: string): Promise<void> {
  const state = await getAutoRespond(projectId, conversationId);
  if (state?.status !== "stopped" || !readyForReview(state.stopReason)) return;
  const { providerProfileId, harnessId, provider, modelId, thinkingLevel, instructions, stopInstructions, maxResponses, useTools } = state;
  await enableAutoRespond(projectId, conversationId, { providerProfileId, harnessId, provider, modelId, thinkingLevel, instructions, stopInstructions, maxResponses, useTools }, state.enabledBy, state.creatorAccountId);
}

/** The responder uses Bob's own agent settings when they name a model, otherwise the harness's first model. */
export async function bobAutoRespondConfig(settings: BobSettings, harnessId: HarnessId): Promise<AutoRespondConfig> {
  let { provider, modelId, thinkingLevel } = settings;
  if (!provider || !modelId) {
    const models = await listHarnessModels(harnessId);
    const model = models[0];
    if (!model) throw new Error("The agent has no model to answer with");
    provider = model.provider;
    modelId = model.id;
    thinkingLevel = model.thinkingLevels.includes("medium") ? "medium" : model.thinkingLevels[0] ?? "default";
  }
  return {
    providerProfileId: null, harnessId, provider, modelId,
    thinkingLevel: (thinkingLevel || "medium") as AutoRespondConfig["thinkingLevel"],
    instructions: DEFAULT_AUTO_RESPOND_INSTRUCTIONS, stopInstructions: BOB_AUTO_RESPOND_STOP_INSTRUCTIONS,
    maxResponses: BOB_AUTO_RESPOND_LIMIT, useTools: true,
  };
}
