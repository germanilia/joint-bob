import { getClusterNode } from "../cluster.js";
import { ensureConversationRecord, getConversationRecord, setConversationWorktree } from "../conversation-records.js";
import type { ConversationEngine } from "../conversation-ownership.js";
import { sessionTitleOverrides } from "../names.js";
import { createProjectWorktree, getProjectWorktree, markWorktreeConversation, type ProjectWorktree } from "../project-worktrees.js";
import { genericSecretEnvironment } from "../secrets.js";
import { getSettings } from "../settings.js";
import type { ProjectRecord } from "../types.js";

const pending = new Map<string, Promise<ProjectWorktree | undefined>>();

/** Every launch path uses the socket, so the default belongs here, not in a particular form. */
export async function newConversationWorktree(project: ProjectRecord, engine: ConversationEngine, sessionId: string, choice: "new" | "project" | null): Promise<ProjectWorktree | undefined> {
  const key = `${project.id}:${engine}:${sessionId}`;
  const opening = pending.get(key);
  if (opening) return opening;
  const creating = createConversationWorktree(project, engine, sessionId, choice);
  pending.set(key, creating);
  try { return await creating; }
  finally { pending.delete(key); }
}

async function createConversationWorktree(project: ProjectRecord, engine: ConversationEngine, sessionId: string, choice: "new" | "project" | null): Promise<ProjectWorktree | undefined> {
  const local = await getClusterNode();
  await ensureConversationRecord(project.id, engine, sessionId, local.id);
  const record = (await getConversationRecord(project.id, engine, sessionId))!;
  // A saved folder choice, including an opt-out or a deleted worktree, never changes on reconnect.
  if (record.worktreeAt !== undefined) {
    if (!record.worktree) return undefined;
    const worktree = await getProjectWorktree(project.id, record.worktree.id);
    if (!worktree) throw new Error("Worktree is not synchronized on this node");
    return worktree;
  }
  if (choice === "project" || choice !== "new" && !getSettings().newConversationWorktree) {
    await setConversationWorktree(project.id, engine, sessionId, null, local.id);
    return undefined;
  }
  const title = (await sessionTitleOverrides())[sessionId] || "Conversation";
  const name = `${title.replace(/\s+/g, " ").trim().slice(0, 65)} ${sessionId.slice(0, 8)}`;
  const worktree = await createProjectWorktree(project, { name, gitEnvironment: genericSecretEnvironment(project.id) });
  await markWorktreeConversation(project.id, worktree.id, engine, sessionId);
  await setConversationWorktree(project.id, engine, sessionId, worktree, local.id);
  return worktree;
}
