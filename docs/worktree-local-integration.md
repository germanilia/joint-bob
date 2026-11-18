# Verified local worktree integration

Agent-created worktrees default to committed local `main`, including unpublished commits but excluding dirty tracked edits. `create --finish pr` explicitly retains the remote-base PR workflow. Neither finish path pushes or deploys implicitly.

```sh
node "$JOINT_BOB_WORKTREE_CLI" create --name parser-fix
node "$JOINT_BOB_WORKTREE_CLI" merge --worktree WORKTREE_ID --operation UUID --title 'fix: correct parser' --check 'npm test'
node "$JOINT_BOB_WORKTREE_CLI" status --operation UUID
```

The capability already scopes the project and conversation. Only the creating conversation (or the worktree's own conversation) can finish a worktree, on any node that has its files: the commit lands on the main of the node that runs the merge. If that node's main lacks the worktree's base commit (for example an unpublished commit made on the creating node), integration stops with that reason, and `pr --merge` is the way through. A command that finds the worktree's baseline still arriving from another machine reports that files are arriving; run it again in a moment. The operation ID binds its worktree, title, check and resolution target. Reusing it cannot repeat an uncertain check or silently target another operation.

The integration engine replays only the worktree's changes onto committed local main, verifies an isolated candidate, then installs it with compare-and-swap and a durable journal. It preserves unrelated working files and staged changes. Main movement, overlapping local edits, pending file sync, other active writers, verification failures and uncertain installations retain the worktree.

Verification includes committed regular Git files, including binary assets and executable modes, and checks that the command did not modify them. Symlinks and submodules are explicitly unsupported rather than omitted from the tested candidate. The verification snapshot is private and outside the synced worktree. Dependencies and environment files use the existing worktree runtime setup. Raw check commands and output are not stored in receipts; failed checks report their exit code.

## Conflicts

A conflict returns the inspected `targetCommit`. Combine both sides in the worktree, verify the resolution, and use a new operation ID with `--resolve-main TARGET_COMMIT`. If main moved again, that resolution is refused. Conflict resolution does not authorize overwriting unrelated dirty or staged project files.

## Retirement

Verified integration can retire a worktree immediately when its writers stop. In **Settings → Workspace cleanup**, an administrator can preview inactivity cleanup, run it manually, or enable the hourly job across their machines. Worktrees without conversations qualify after one idle hour. Worktrees with conversations qualify after more than three idle days. Cleanup skips active or unverifiable copies, saves unmerged changes to a named Git recovery ref before removing files, and keeps conversation history. Restore creates a new worktree on the machine that holds the recovery entry. Opening a PR is not a merge, and Done alone does not authorize deleting unmerged work.

Expiration protects running conversations, background tasks, open harness working directories and unresolved integrations. It waits for file sync and checks eligible peers even when this machine created the worktree. Unknown activity or an unavailable peer retains the worktree rather than guessing.

The active agent's cwd is not deleted during its merge tool call. Completion schedules a turn-aware grace period; cleanup rechecks writers, pending sync and the task digest. Later edits invalidate retirement eligibility. Existing housekeeping provides restart recovery. A deletion leaves a synced retirement marker; every other node removes what it still holds of that worktree (its own `.env` copies, dependency links, path file) at its next sweep, without the usual 30-minute grace period, unless a session is open in the folder. Archived cwd metadata keeps local native transcript discovery available after deletion.

The legacy UI **Merge to project** action remains a file-only merge, not a verified commit. An unchanged file-only merge qualifies for five-day inactivity cleanup. Later edits require a new merge or the ten-day expiry. Explicit user deletion remains separate from automatic cleanup.

## Conversation indicator, secrets and sync

The open conversation shows **Worktree: name** beside its title on desktop and phone. Ordinary project-folder conversations do not show this indicator. The conversation list keeps its colored worktree badges.

Worktree conversations use normal conversation secret scopes. Agent-started child conversations inherit their caller's attached secret accounts; the new-conversation dialog uses its selected accounts. Local environment files and dependency links use the existing worktree setup. Secrets are not added to the synced source tree: each machine resolves its authorized local secret accounts and local files. Worktree code, metadata and deletion continue through the project's file-sync engine; archived cwd metadata preserves conversation history.

## Verification boundaries

Covered by disposable Git repositories, scoped CLI/API tests, cleanup/history tests, native-sync regressions, and a browser journey proving Done retains an unverified worktree. No live worktree was merged or deleted while implementing this feature. Full cross-node retired-history and production multi-user execution validation remain required before calling those paths production-validated.
