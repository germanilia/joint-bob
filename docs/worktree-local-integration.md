# Verified local worktree integration

Agent-created worktrees default to committed local `main`, including unpublished commits but excluding dirty tracked edits. `create --finish pr` explicitly retains the remote-base PR workflow. Neither finish path pushes or deploys implicitly.

```sh
node "$JOINT_BOB_WORKTREE_CLI" create --name parser-fix
node "$JOINT_BOB_WORKTREE_CLI" merge --worktree WORKTREE_ID --operation UUID --title 'fix: correct parser' --check 'npm test'
node "$JOINT_BOB_WORKTREE_CLI" status --operation UUID
```

The capability already scopes the project and conversation. Only the creating conversation on the creator node can finish a worktree. The operation ID binds its worktree, title, check and resolution target. Reusing it cannot repeat an uncertain check or silently target another operation.

The integration engine replays only the worktree's changes onto committed local main, verifies an isolated candidate, then installs it with compare-and-swap and a durable journal. It preserves unrelated working files and staged changes. Main movement, overlapping local edits, pending file sync, other active writers, verification failures and uncertain installations retain the worktree.

Verification includes committed regular Git files, including binary assets and executable modes, and checks that the command did not modify them. Symlinks and submodules are explicitly unsupported rather than omitted from the tested candidate. The verification snapshot is private and outside the synced worktree. Dependencies and environment files use the existing worktree runtime setup. Raw check commands and output are not stored in receipts; failed checks report their exit code.

## Conflicts

A conflict returns the inspected `targetCommit`. Combine both sides in the worktree, verify the resolution, and use a new operation ID with `--resolve-main TARGET_COMMIT`. If main moved again, that resolution is refused. Conflict resolution does not authorize overwriting unrelated dirty or staged project files.

## Retirement

A verified durable local commit is required for automatic retirement. Done marks and age alone never prove integration. PR-path worktrees remain intact until explicit handling; opening a PR is not a merge.

The active agent's cwd is not deleted during its merge tool call. Completion schedules a turn-aware grace period; cleanup rechecks writers, pending sync and the task digest. Later edits invalidate retirement eligibility. Existing housekeeping provides restart recovery. Archived cwd metadata keeps local native transcript discovery available after deletion.

The legacy UI **Merge to project** action remains a file-only merge and does **not** create verified retirement evidence. Explicit user deletion remains separate from automatic cleanup.

## Verification boundaries

Covered by disposable Git repositories, scoped CLI/API tests, cleanup/history tests, native-sync regressions, and a browser journey proving Done retains an unverified worktree. No live worktree was merged or deleted while implementing this feature. Full cross-node retired-history and production multi-user execution validation remain required before calling those paths production-validated.
