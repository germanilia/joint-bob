import path from "node:path";
import { backgroundTaskConversationId, readActiveBackgroundTaskIdentities } from "../background-tasks.js";
import { resolveDataDirectory } from "../data-directory.js";
import { getProjectLock } from "../project-locks.js";
import { createProjectWorktree, deleteProjectWorktree, getProjectWorktree, type ProjectWorktree } from "../project-worktrees.js";
import { genericSecretEnvironment } from "../secrets.js";
import { getProject } from "../store.js";
import { getClusterNode } from "../cluster.js";
import { listConversationRecords } from "../conversation-records.js";
import { disposeHarnessSession, harnessSessionBusy, harnessSessions } from "./harness-sessions.js";
import { broadcastToProject, send } from "./realtime.js";

export const automationWorktreeInstruction = "This run has its own temporary Joint Bob worktree, created from origin/main. Do not create another worktree. Finish any required changes through the normal verified merge workflow before your final response. This worktree and all files left in it are removed when the run ends.";

export const automationCleanupInstruction = "Clean up after run is enabled. Keep downloads, attachments and generated files inside this worktree, including temporary files. Do not leave background work running after the run. Joint Bob removes the worktree after success or failure and keeps the run metadata and logs. Shared project files and credentials are not cleanup targets.";

export async function withAutomationWorktree<T>(source: { projectId: string; name: string; runInWorktree: boolean; cleanupAfterRun?: boolean }, requestId: string, run: (worktree?: ProjectWorktree) => Promise<T>): Promise<T> {
  if (source.cleanupAfterRun && !source.runInWorktree) throw new Error("Cleanup requires a fresh worktree");
  if (!source.runInWorktree) return run();
  const project = await getProject(source.projectId);
  if (!project) throw new Error("Automation project not found");
  const local = await getClusterNode();
  const lock = await getProjectLock(project.id);
  if (lock && lock.nodeId !== local.id) throw new Error(`Project is locked by ${lock.nodeName}`);
  const worktree = await createProjectWorktree(project, {
    name: `${source.name.replace(/\s+/g, " ").trim().slice(0, 40)} ${requestId}`,
    originMain: true, gitEnvironment: genericSecretEnvironment(project.id),
  });
  broadcastToProject(project.id, { type: "worktreesChanged" });
  let runError: unknown;
  try {
    return await run(worktree);
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    try {
      await removeAutomationWorktree(worktree);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const prior = runError === undefined ? "" : `Run failed: ${runError instanceof Error ? runError.message : String(runError)}. `;
      throw new Error(`${prior}Cleanup failed: ${detail}`, { cause: error });
    }
  }
}

async function removeAutomationWorktree(worktree: ProjectWorktree): Promise<void> {
  // A verified merge can already have retired it. Never remove live agent or background work.
  if (!await getProjectWorktree(worktree.projectId, worktree.id)) return;
  const sessions = [...harnessSessions.values()].filter(session => session.cwd === worktree.path || session.cwd.startsWith(`${worktree.path}${path.sep}`));
  const records = await listConversationRecords(worktree.projectId);
  const conversations = new Set(records.filter(record => record.worktree?.id === worktree.id).map(record => record.conversationId ?? record.sessionId));
  const background = [...readActiveBackgroundTaskIdentities(resolveDataDirectory())].some(id => conversations.has(backgroundTaskConversationId(id)));
  if (background || sessions.some(harnessSessionBusy)) throw new Error(`Automation worktree ${worktree.id} still has active work; it was retained`);
  for (const session of sessions) disposeHarnessSession(session);
  await deleteProjectWorktree(worktree.projectId, worktree.id);
  for (const session of sessions) for (const client of session.clients) send(client, { type: "sessionFileChanged" });
  broadcastToProject(worktree.projectId, { type: "worktreesChanged" });
  broadcastToProject(worktree.projectId, { type: "sessionsChanged" });
}
