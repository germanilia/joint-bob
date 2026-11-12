import { randomUUID } from "node:crypto";
import type { AuthSession } from "../auth.js";
import { assistantIdForConversation } from "../assistant-resources.js";
import { assistantSetupBrief, beginAssistantSetup, finishAssistantSetup } from "../assistant-setup.js";
import { announceAssistantChanges } from "../assistant-collaboration/twin-sync.js";
import { accountInCluster } from "../cluster-accounts.js";
import { markClusterAssistant } from "../cluster-assistants.js";
import { getClusterNode } from "../cluster.js";
import { getSharingCluster } from "../cluster-sharing-policy.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { auditClusterAssistantCreated } from "./cluster-assistants.js";
import { shareProjectWithCluster } from "./routes/sharing.js";
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

/** The person's project of that name, made when they have none. */
async function ownProject(accountId: string, name: string): Promise<ProjectRecord> {
  const mine = (await projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false }))
    .find((project) => project.name === name && [undefined, accountId].includes(resourceOwner("project", project.id)));
  if (mine) return mine;
  const [workspace] = await listWorkspaces();
  if (!workspace) throw new Error("Create a workspace first: the Assistants project needs one to live in");
  return createProjectAsActor({ name, type: workspace.id });
}

/** A cluster's assistants live in a project of their own, shared with that cluster and nothing else of the person's. */
export const clusterAssistantsProject = (clusterName: string): string => `${ASSISTANTS_PROJECT} · ${clusterName}`.slice(0, 100);

/**
 * Where a new assistant lives. A person's own go to their private Assistants project. A cluster's go to that cluster's project,
 * shared with the cluster: its members can read its conversations, and its turns run on the cluster's subscriptions.
 */
async function projectFor(accountId: string, clusterId: string | undefined): Promise<ProjectRecord> {
  if (!clusterId) return ownProject(accountId, ASSISTANTS_PROJECT);
  const db = await clusterV2Database();
  if (!accountInCluster(db, accountId, clusterId)) throw new Error("You are not in that cluster on this machine");
  const cluster = getSharingCluster(db, clusterId);
  if (cluster.closed) throw new Error("That cluster is closed");
  const project = await ownProject(accountId, clusterAssistantsProject(cluster.name));
  await shareProjectWithCluster(clusterId, project.id);
  return project;
}

/**
 * Creates an assistant for the person and starts its setup: its first conversation researches how the job is done, gets the
 * sign-ins and secrets it needs from the person, writes the assistant's skill and instructions, and tests them. Bob drives
 * that conversation as delegated work and brings it back when the assistant is ready. Runs as the person.
 */
export async function createAssistantWithSetup(session: AuthSession, settings: BobSettings, name: string, purpose: string, clusterId?: string): Promise<{ project: ProjectRecord; assistantId: string }> {
  if ((await listPersonalAssistants(session.accountId)).some((assistant) => assistant.name.toLowerCase() === name.toLowerCase())) throw new Error(`You already have an assistant called "${name}"`);
  const project = await projectFor(session.accountId, clusterId);
  const harnessId = (settings.harnessId || iconHarnessId()) as HarnessId;
  const sessionId = randomUUID();
  await ensureConversationRecord(project.id, harnessId, sessionId, (await getClusterNode()).id);
  await ensureSessionTitle(sessionId, name);
  const assistant = await savePersonalAssistant(session.accountId, { projectId: project.id, engine: harnessId, sessionId, name, instructions: "", nodeId: (await getClusterNode()).id });
  // Opening the store again registers the new assistant's first conversation as its topic, which the setup tool is keyed by.
  await personalAssistantDatabase();
  if (clusterId) {
    markClusterAssistant(assistant.id, clusterId, session.accountId);
    auditClusterAssistantCreated(assistant.id, session.accountId, clusterId, name);
  }
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
