import { elements } from "./elements.js";
import { state } from "./state.js";

/** Keep the execution folder visible in the conversation, not just its list row. */
export function renderWorktreeIndicator() {
  let badge = document.getElementById("conversationWorktreeIndicator");
  if (!badge) {
    badge = document.createElement("span");
    badge.id = "conversationWorktreeIndicator";
    badge.dataset.testid = "conversation-worktree-indicator";
    badge.className = "session-worktree-badge";
    elements.sessionTitle.after(badge);
  }
  const session = state.sessions.find(item => item.id === state.activeSessionId);
  const worktree = session?.worktree;
  badge.hidden = !worktree;
  badge.textContent = worktree ? `Worktree: ${worktree.name}` : "";
  badge.title = worktree ? `This conversation runs in worktree: ${worktree.name}` : "";
  if (worktree) badge.dataset.worktreeColor = worktree.color;
  else delete badge.dataset.worktreeColor;
}
