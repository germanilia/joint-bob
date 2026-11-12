import { worktreeSessionPaths } from "../project-worktrees.js";

/** Paths outside the project folder whose conversations still belong to it: its worktrees. */
export async function projectAdditionalPaths(projectId: string): Promise<string[]> {
  return worktreeSessionPaths(projectId).catch((error) => {
    console.warn("Worktree paths unavailable", error);
    return [];
  });
}
