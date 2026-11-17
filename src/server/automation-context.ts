// What an automation hands its agent on every run, whatever started the run: the files, tools, skills and
// memory the person attached to it, and the secret accounts picked for it. A webhook call and a scheduled
// run both go through here, so an automation behaves the same when its trigger changes.
import { getClusterNode } from "../cluster.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { conversationScopeId, getScopeSecretAccounts, setScopeSecretAccounts, validateProjectSecretAccounts } from "../secrets.js";
import { isHarnessId } from "../types.js";
import { bindWebhookConversation } from "../webhook-agent.js";
import { readWebhookMemory } from "../webhook-memory.js";
import { resolveWebhookResources, snapshotWebhookResources, webhookResourceInstructions, type WebhookResourceSnapshot } from "../webhook-resources.js";

/**
 * The instructions that list the automation's files, tools, skills and memory, or an empty string when it has none.
 * A webhook call passes the snapshot it took when the call arrived; a scheduled run takes one now.
 */
export async function automationResourceContext(automationId: string, snapshot?: WebhookResourceSnapshot): Promise<string> {
  const local = await getClusterNode();
  const db = await clusterV2Database();
  const resourceSnapshot = snapshot ?? snapshotWebhookResources(db, automationId, local.id);
  if (resourceSnapshot.ownerNodeId !== local.id || resourceSnapshot.webhookId !== automationId) throw new Error("Automation resources belong to another owner");
  const resources = await resolveWebhookResources(db, resourceSnapshot);
  const memory = resourceSnapshot.memoryEnabled ? await readWebhookMemory(automationId) : undefined;
  return webhookResourceInstructions({
    files: resources.files.map(({ name, description, path: filePath }) => ({ name, description, path: filePath })),
    tools: resources.tools.map(({ name, description, usage, path: filePath }) => ({ name, description, usage, path: filePath })),
    skills: resources.skills, memoryPath: memory?.path, memoryCli: memory ? 'node "$JOINT_BOB_WEBHOOK_MEMORY_CLI"' : undefined,
  });
}

/** The automation's picked secret accounts join the conversation's own; they never replace them. */
export async function attachAutomationSecrets(automation: { secretAccountIds: string[] }, projectId: string, engine: string, sessionId: string): Promise<void> {
  if (!automation.secretAccountIds.length) return;
  if (!isHarnessId(engine)) throw new Error("The automation's harness is not available");
  validateProjectSecretAccounts(projectId, automation.secretAccountIds);
  const scope = conversationScopeId(engine, sessionId);
  const { accountIds } = await getScopeSecretAccounts("conversation", scope);
  await setScopeSecretAccounts("conversation", scope, [...new Set([...accountIds, ...automation.secretAccountIds])]);
}

/** Lets the conversation's agent reach the automation's memory. */
export async function bindAutomationConversation(automationId: string, projectId: string, sessionId: string, created: boolean): Promise<void> {
  bindWebhookConversation(await clusterV2Database(), automationId, projectId, sessionId, (await getClusterNode()).id, created);
}
