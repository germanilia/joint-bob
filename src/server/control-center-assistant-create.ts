import { randomUUID } from "node:crypto";
import type { AuthSession } from "../auth.js";
import { assistantIdForConversation } from "../assistant-resources.js";
import { assistantSetupBrief, beginAssistantSetup, finishAssistantSetup } from "../assistant-setup.js";
import { announceAssistantChanges } from "../assistant-collaboration/twin-sync.js";
import { getClusterNode } from "../cluster.js";
import { bobDelegationConfig, readyForReview } from "../control-center/auto-respond.js";
import type { BobSettings } from "../control-center/bob-store.js";
import { recordBobStart } from "../control-center/started.js";
import { enableAutoRespond, onAutoRespondStopped } from "../conversation-auto-respond.js";
import { ensureConversationRecord } from "../conversation-records.js";
import { ensureSessionTitle } from "../names.js";
import { resourceOwner } from "../ownership.js";
import { listPersonalAssistants, personalAssistantDatabase, savePersonalAssistant } from "../personal-assistants.js";
import { listWorkspaces } from "../store.js";
import type { HarnessId, ProjectRecord } from "../types.js";
import { delegatedBrief } from "./control-center-start.js";
import { queueConversationPrompt } from "./conversation-prompt.js";
import { iconHarnessId } from "./label-icon.js";
import { projectsWithSharedNames } from "./projects.js";
import { createProjectAsActor } from "./routes/projects.js";

/** The project every assistant Bob creates lives in. It is the person's own, made the first time they ask for an assistant. */
export const ASSISTANTS_PROJECT = "Assistants";

async function assistantsProject(accountId: string): Promise<ProjectRecord> {
  const mine = (await projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false }))
    .find((project) => project.name === ASSISTANTS_PROJECT && [undefined, accountId].includes(resourceOwner("project", project.id)));
  if (mine) return mine;
  const [workspace] = await listWorkspaces();
  if (!workspace) throw new Error("Create a workspace first: the Assistants project needs one to live in");
  return createProjectAsActor({ name: ASSISTANTS_PROJECT, type: workspace.id });
}

/**
 * Creates an assistant for the person and starts its setup: its first conversation researches how the job is done, gets the
 * sign-ins and secrets it needs from the person, writes the assistant's skill and instructions, and tests them. Bob drives
 * that conversation as delegated work and brings it back when the assistant is ready. Runs as the person.
 */
export async function createAssistantWithSetup(session: AuthSession, settings: BobSettings, name: string, purpose: string): Promise<{ project: ProjectRecord; assistantId: string }> {
  if ((await listPersonalAssistants(session.accountId)).some((assistant) => assistant.name.toLowerCase() === name.toLowerCase())) throw new Error(`You already have an assistant called "${name}"`);
  const project = await assistantsProject(session.accountId);
  const harnessId = (settings.harnessId || iconHarnessId()) as HarnessId;
  const sessionId = randomUUID();
  await ensureConversationRecord(project.id, harnessId, sessionId, (await getClusterNode()).id);
  await ensureSessionTitle(sessionId, name);
  const assistant = await savePersonalAssistant(session.accountId, { projectId: project.id, engine: harnessId, sessionId, name, instructions: "", nodeId: (await getClusterNode()).id });
  // Opening the store again registers the new assistant's first conversation as its topic, which the setup tool is keyed by.
  await personalAssistantDatabase();
  beginAssistantSetup(assistant.id, session.accountId, purpose);
  await recordBobStart(project.id, sessionId, session.accountId);
  await enableAutoRespond(project.id, sessionId, await bobDelegationConfig(settings, harnessId), null, session.accountId);
  await queueConversationPrompt({ projectId: project.id, engine: harnessId, sessionId, message: delegatedBrief(assistantSetupBrief(name, purpose)), requestId: randomUUID(), label: "Bob", until: "started" });
  announceAssistantChanges();
  return { project, assistantId: assistant.id };
}

// The setup ends when Bob finds the assistant ready for review: from then on its agent can no longer change the assistant.
onAutoRespondStopped((state) => {
  if (!readyForReview(state.stopReason)) return;
  const assistantId = assistantIdForConversation(state.projectId, state.conversationId);
  if (assistantId && finishAssistantSetup(assistantId)) announceAssistantChanges();
});
