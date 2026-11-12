import { withProjectRuntime } from "../project-runtime.js";
import type { ProjectRecord } from "../types.js";
import { onConversationTurn } from "./harness-sessions.js";
import { cleanupDoneWorktrees } from "./worktree-cleanup.js";

const pending = new Map<string, { project: ProjectRecord; timer: NodeJS.Timeout }>();

/** One event-driven attempt after the turn/peer-lease grace period; no polling loop.
 * The existing durable housekeeping sweep recovers pending retirements after restart. */
export function scheduleWorktreeRetirement(project: ProjectRecord): void {
  const previous = pending.get(project.id);
  if (previous) clearTimeout(previous.timer);
  const timer = setTimeout(() => {
    void withProjectRuntime(project.id, () => cleanupDoneWorktrees(project)).then(result => {
      if (result.deletedWorktreeIds.length && pending.get(project.id)?.timer === timer) pending.delete(project.id);
    }).catch(error => console.warn(`Verified worktree retirement failed for ${project.id}`, error));
  }, 11_000);
  timer.unref();
  pending.set(project.id, { project, timer });
}

onConversationTurn(shared => {
  const entry = pending.get(shared.projectId);
  if (entry) scheduleWorktreeRetirement(entry.project);
});
