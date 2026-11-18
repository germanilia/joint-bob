# Hourly workspace cleanup

## Scope and controls

One system setting enables automatic cleanup for all current and future projects on all participating nodes. Start disabled. In Settings → Workspace cleanup, show a read-only preview, a confirmed Run now action, each node’s last run and the outcome per workspace. Apply the same permissions as project/workspace administration. Never expose another user's private projects. Link to the view from Manage worktrees. The displayed conversation count is not evidence of an empty workspace.

## Scheduling

Register one built-in hourly cron task per node, not one per project or a conversation automation. Run at `0 * * * *` while the node service is available, without a browser or an agent turn. One pass after readiness suffices for missed hours. Enumerate the node's projects at run time. Do not overlap a scheduled pass with a manual pass. Coalesce repeated requests and coordinate shared-workspace retirement so that only one node archives and retires the same revision. Report offline nodes; do not claim they ran.

Replace the half-hour age-based sweep in `src/server.ts`. Separate verified finish and known-retired-folder housekeeping from age-based cleanup in `src/server/worktree-cleanup.ts`. Opening a project, marking a conversation done or listing worktrees must not run the legacy five/ten-day deletion behind the new setting. Keep explicit finish/integration behavior. A missing metadata file alone is not evidence that a directory contains no work.

## Eligibility

Use the latest of creation, workspace edits and conversation activity across all copies and all segments of associated conversations. Use persisted membership, not the inbox filter or sidebar count. With no conversations, a workspace qualifies after one idle hour. With conversations, it qualifies after more than 72 idle hours. Remove at the next pass, not at the exact expiry time.

Skip running sessions, background jobs, pending integration, conflicting locks, offline holders, incomplete sync and unknown activity or membership. Recheck membership, changes, policy and activity under the retirement claim just before removal; abort on new work. A remote failure must not prevent an unrelated local-only project from being cleaned. Never close a PR, remove a remote branch or merge unrequested code.

## Removal and recovery

An eligible workspace with no conversations and no unique work goes completely, without a stash. For any workspace with unmerged edits, save a stash-compatible Git snapshot against its original baseline in the owning project's local repository. Joint Bob workspaces are file copies without `.git`; do not run `git stash` on the shared project's working directory or modify its index. Preserve additions, removals, binary changes, links and executable modes. Do not archive dependencies, private copied credentials or app metadata. If exclusions could discard unique user work, the base is unavailable, the project lacks Git, or recovery cannot be verified, skip rather than delete.

Pin the saved Git object under a stable local ref outside the workspace. Never rely on `stash@{0}`. Persist the project, node, workspace name/ID, time, base and recovery ref before allowing deletion to propagate. Verify the snapshot can reconstruct the intended contents and that the history entry is durable. Retry interrupted work without double deletion or duplicate saves. Keep recovery refs until explicitly removed. Restore creates a new workspace without overwriting a live one or consuming the recovery entry. If its holding node is offline, show that instead of offering an unusable local restore.

Workspace cleanup does not delete conversations. Preserve transcript lookup independently of the removed folder. Existing history, pins and stars remain readable under the normal conversation retention policy.

## Verification

Test both time boundaries and fresh activity, zero visible rows with real conversation records, disabled and newly joined nodes, two concurrent ticks, a busy/offline holder, safe retry after a failed save or crash, restore of a mixed change set, and opening a retired workspace's conversation after restart. Verify preview performs no writes and that scheduled and confirmed manual runs make identical eligibility decisions. Run destructive tests only in disposable fixture projects.
