import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { AgentCapabilityIdentity } from "./agent-capabilities.js";
import { nodeSettings } from "./settings.js";
import { settingsDatabase } from "./settings-store.js";
import { isHarnessId, type HarnessId } from "./types.js";

const lifetime = 30 * 24 * 60 * 60 * 1000;
const hash = (token: string): string => createHash("sha256").update(token).digest("hex");

/** The caller's logical conversation plus the harness session its secrets and worktree marker use. */
export interface WorktreeAgentIdentity extends AgentCapabilityIdentity { sessionId: string }

function database(): DatabaseSync {
  const db = settingsDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS worktree_agent_tokens (
    token_hash TEXT PRIMARY KEY, project_id TEXT NOT NULL, engine TEXT NOT NULL,
    conversation_id TEXT NOT NULL, session_id TEXT NOT NULL, expires_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS worktree_agent_tokens_expiry ON worktree_agent_tokens(expires_at);`);
  return db;
}

export function worktreeAgentEnvironment(projectId: string, engine: HarnessId, conversationId: string, sessionId: string): NodeJS.ProcessEnv {
  if (!projectId || !conversationId || !sessionId) throw new Error("Worktree agent requires a project and conversation identity");
  if (!isHarnessId(engine)) throw new Error("Worktree agent requires a valid harness identity");
  const db = database();
  db.prepare("DELETE FROM worktree_agent_tokens WHERE expires_at <= ?").run(Date.now());
  const token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO worktree_agent_tokens VALUES (?, ?, ?, ?, ?, ?)").run(hash(token), projectId, engine, conversationId, sessionId, Date.now() + lifetime);
  return {
    JOINT_BOB_WORKTREE_CLI: fileURLToPath(new URL("../bin/joint-bob-worktree.mjs", import.meta.url)),
    JOINT_BOB_WORKTREE_URL: `http://127.0.0.1:${process.env.PORT || 8790}/api/worktrees/agent`,
    JOINT_BOB_WORKTREE_TOKEN: token,
    JOINT_BOB_WORKTREE_TIMEOUT_SECONDS: String(nodeSettings().gitPullTimeoutSeconds),
  };
}

export function worktreeAgentIdentity(token: string): WorktreeAgentIdentity | undefined {
  if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
  const row = database().prepare("SELECT project_id AS projectId, engine, conversation_id AS conversationId, session_id AS sessionId FROM worktree_agent_tokens WHERE token_hash=? AND expires_at>?").get(hash(token), Date.now()) as WorktreeAgentIdentity | undefined;
  return row ? { ...row } : undefined;
}

export const worktreeAgentInstructions = `# Joint Bob worktrees

A Joint Bob worktree is an isolated copy of this project's code and text. It has the project's \`.env\` files and links to its installed dependency folders (node_modules, .venv and similar), so tests and tools run there. It has no \`.git\`; its changes normally become one verified task-only commit on local main. A GitHub pull request is a separate finish path, used only when explicitly requested.

Work where this conversation runs: the project folder, or the worktree it was started in. Whether work gets a worktree is the user's decision, made when they start a conversation or write a scheduled task. Run create or start only when the user's request asks for a worktree, never on your own initiative. A scheduled task's prompt is the user's request: when it asks for a worktree, create one on each run that needs it. A large or risky task, several issues at once, uncommitted changes in the project folder, or a wish for isolation is not such a request: do the work here and leave changes that are not yours untouched. If you think a worktree would help, say so in your reply and carry on here. If the task cannot be finished here, for example it needs a new branch for a pull request, tell the user it needs a worktree and let them decide.

node "$JOINT_BOB_WORKTREE_CLI" <command>, output is JSON:
- list: this project's worktrees with id, name, path, whether this conversation runs in it, and any pull request.
- create --name NAME [--color COLOR] [--finish local|pr]: only when the user asked for a worktree. Defaults to committed local main, including unpublished commits but not uncommitted edits. Use --finish pr only for an explicitly requested pull request; that starts from the fetched remote default branch. Local configuration and dependency links are included. Non-Git projects are copied as files but cannot produce Git commits. Names are unique; list first and reuse the worktree that already handles the same issue.
- start --worktree ID --prompt TEXT | --prompt-stdin [--title TITLE]: only when the user asked for a worktree. Starts a new conversation inside the worktree with the same agent and this conversation's secret accounts, and returns once it begins. The prompt must stand alone: the issue, the evidence, what done means, and to finish with merge and a real verification command, or pr only if explicitly requested.
- pr [--worktree ID] --title TITLE [--body TEXT | --body-stdin] [--base BRANCH] [--merge]: commits the worktree's changes since it was created to a new branch on GitHub and opens a pull request into the default branch (main), or pushes a new commit to the open pull request it already has. The changes are replayed on the base branch as it is at that moment, so the pull request carries only the worktree's edits. If they conflict with what landed since, the output names the files: a new pull request then starts from the worktree's original commit, and an open one is left as it was. Defaults to the worktree this conversation runs in. It merges only with --merge: GitHub then merges the pull request it just published, and nothing is published when the changes conflict with the base branch as it is now.
- merge [--worktree ID] --title TITLE --check COMMAND [--operation ID]: prepares a task-only commit against current local main, runs COMMAND on the combined candidate, preserves others' staged/unstaged work, and commits locally without pushing. Successful integration retires the folder only when its conversations and background work have stopped. A conflict or failed check retains the worktree. When merge is blocked by local main (reconciliation blocked, diverged or unpublished local commits, shared files out of step with upstream), the task still has to land: finish with pr --merge, which needs no reconciliation. Stop editing after a committed result. For conflicts, inspect the committed main files read-only, combine main's changes with this task's changes in the worktree, and retry with --resolve-main TARGET_COMMIT from the conflict result and a new operation ID. That option explicitly accepts your resolved versions of the conflict files only; it refuses if main moved. Preserve every unrelated main change and run the real checks; never overwrite other agents' uncommitted edits. If resolution fails, use an available stronger model within the current harness and the user's approved allowance, at most twice, then ask the user. Never change harnesses for recovery. Do not start paid recovery without an approved finite allowance.
- reconcile-main [--worktree ID]: fetches upstream and moves local main onto it when the changed files already match upstream. Local commits upstream lacks are replayed on top of it; ones upstream already has (pushed from another machine) are dropped, and the old main stays in the reflog. Preserves unrelated staged/unstaged work and never rewrites shared files. Merge runs this automatically when main lacks the worktree base. A blocked result gives exact paths and a reason: finish with pr --merge instead of asking anyone to reconcile. After an uncertain reconciliation, rerun this same command to recover its journaled installation.
- status --operation ID: read this conversation's durable integration status, including after deletion. After a timeout, inspect status; retry a merge only with the same operation ID and arguments. Never replay an uncertain check or external mutation.
- delete --worktree ID: removes a worktree this conversation created. Others need the user.

When the user asked for worktrees, use one per issue: for several independent issues, one worktree and one started conversation each. Work inside a worktree by editing files under its path; never edit the project folder for a worktree's task. Run the project's tests and finish with merge by default; provide the real test command via --check. Use pr only if explicitly requested, or as pr --merge when merge is blocked by local main. Merge a pull request only when the user explicitly asks you to merge it, or to land a requested merge that local main blocked; otherwise report the pull request URL. Local main, its unpublished commits and how it gets reconciled are yours to handle with these commands: never ask the user whether to keep local commits or to reconcile main for you. PR creation never deletes a worktree; PR-path deletion needs a separate request. A verified local merge handles safe cleanup itself, so do not manually delete the active working directory. Do not read or print the capability token.

After start, the started conversation owns that issue. Do not edit its worktree, fix the same issue in the project folder, or delete the worktree; do not wait or poll for it. Report the worktree and conversation IDs and continue with other work. If tests cannot run in a worktree, say so in the pull request body instead of moving the work elsewhere. The project folder holds other people's uncommitted work, so for a worktree's task use the commands above before touching its Git state.

When these commands run out (pr --merge has no GitHub remote or token, GitHub refuses the merge, or the state is one they do not cover), do not stop or hand Git back to the user: find a way through with git, gh and the shell, as the user would. You may commit, fetch, replay or rebase local-only commits, move local main, push main, and open or merge the pull request with gh. Prefer moves that leave the working tree alone (git merge-tree --write-tree, git commit-tree, git update-ref, git read-tree), note the old main's hash before moving it, and stage only the paths you mean to commit. Keep others' uncommitted work: never git reset --hard, git stash, git clean, or git checkout/restore over files you did not change, and never force-push main. Ask the user only when every way forward would destroy someone's uncommitted work or needs access you do not have.`;
