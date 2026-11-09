import type { DatabaseSync } from "node:sqlite";
import { runAsAccount, type ActingAccount } from "../account-context.js";
import { askSystemOneChoices } from "../classifiers/typesafe.js";
import { bobDatabase, listBobAccounts, listOpenBobMessages, resolveBobMessage, type BobSettings } from "../control-center/bob-store.js";
import { describeCall } from "../control-center/triggers-describe.js";
import { onWebhookCall, type AcceptedWebhookCall } from "../control-center/triggers-observe.js";
import type { JudgeDeps } from "../control-center/triggers-outcome.js";
import { ensureTriggerSchema, insertTrigger } from "../control-center/triggers-store.js";
import { getProject } from "../store.js";
import type { ProjectRecord } from "../types.js";
import { agentFor } from "../background-agent.js";
import { bobDecisionModel } from "./bob.js";
import { runGitReview } from "./git-review-run.js";
import { projectsWithSharedNames } from "./projects.js";
import { broadcastToAllClients } from "./realtime.js";

/**
 * The webhook log. Each call a webhook accepts is kept for every person who uses Bob and can see the webhook's project, and
 * shown in the control center when they open the log; none of it goes to Bob's chat. Bob follows each call to the
 * conversation its run started and notes how that ended (control-center-outcomes.ts). The payload is outside text and is
 * only ever read as data.
 */

export async function triggerDatabase(): Promise<DatabaseSync> {
  const db = await bobDatabase();
  ensureTriggerSchema(db);
  return db;
}

const changed = (accountId: string): void => broadcastToAllClients({ type: "controlCenterChanged" }, accountId);

/** The decision model Bob uses, and a tool-less agent turn in the webhook's own project: what judges how a call ended. */
async function bobJudgeDeps(actor: ActingAccount, settings: BobSettings, project: ProjectRecord): Promise<JudgeDeps> {
  const projects = await runAsAccount(actor, () => projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false }));
  const model = await runAsAccount(actor, () => bobDecisionModel([project, ...projects.filter((candidate) => candidate.id !== project.id)], settings));
  return {
    stateCharacters: model?.target.stateCharacters ?? 0,
    ...model ? { ask: async (state, questions) => askSystemOneChoices(model.target, state, questions, model.apiKey) } : {},
    agent: async (step) => (await runGitReview({
      projectId: project.id, cwd: project.path, ...agentFor(settings),
      selection: { scope: "context", label: "Webhook log" }, question: "", diff: step.material, instructions: step.instructions,
    })).answer,
  };
}

let judgeDeps: typeof bobJudgeDeps = bobJudgeDeps;

/** For tests: what judges a call, instead of the decision model and Bob's agent. */
export function setTriggerJudgeDeps(build: typeof bobJudgeDeps): void { judgeDeps = build; }

/** What judges a call now: the decision model and Bob's agent, or what a test put in their place. */
export const triggerJudgeDeps: typeof bobJudgeDeps = (actor, settings, project) => judgeDeps(actor, settings, project);

/** Takes in one accepted call: logs it for each person it concerns. */
export async function receiveWebhookCall({ webhook, call }: AcceptedWebhookCall): Promise<void> {
  // A webhook behind a connected Telegram bot is a chat with an assistant, not something arriving.
  if (webhook.reply) return;
  const described = describeCall(webhook.name, call);
  const db = await triggerDatabase();
  const receivedAt = new Date().toISOString();
  await Promise.all(listBobAccounts(db).map(async (actor) => {
    const project = await runAsAccount(actor, () => getProject(webhook.target.projectId));
    if (!project) return;
    insertTrigger(db, actor.accountId, { webhookId: webhook.id, webhookName: webhook.name, projectId: project.id, projectName: project.name, receivedAt, requestId: call.requestId ?? null, ...described });
    changed(actor.accountId);
  }));
}

onWebhookCall(receiveWebhookCall);

/**
 * Webhook calls used to be Bob's chat items (alerts, snoozes, what needed the person). Whatever of them this machine wrote
 * and is still open leaves the chat; the person's other machines clear their own. The calls stay in the log.
 */
export async function clearWebhookItemsFromChat(): Promise<void> {
  const db = await triggerDatabase();
  for (const actor of listBobAccounts(db)) {
    const open = listOpenBobMessages(db, actor.accountId).filter((message) => !message.originNodeId && message.via?.startsWith("Webhook · "));
    for (const message of open) resolveBobMessage(db, actor.accountId, message.id, "Webhook calls are in the webhook log now, not in the chat.");
    if (open.length) changed(actor.accountId);
  }
}
