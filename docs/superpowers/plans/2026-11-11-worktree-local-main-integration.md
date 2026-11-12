# Worktree local-main integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a finished Joint Bob worktree contribute one verified, task-only commit to the designated local `main`, then remove that worktree only after commit durability is confirmed.

**Architecture:** Keep application worktrees as synced file copies without `.git`. Turn their tracked base-to-task diff into a Git commit using the project repository's private index, then integrate on the designated machine through a durable, serialized operation. Preserve unrelated staged, unstaged, and untracked project edits; uncertain operations keep the worktree for recovery.

**Tech Stack:** TypeScript, Node.js `node:sqlite`, Git subprocesses, existing file-sync metadata, merge journal, agent CLI/API, `node:test` fixtures.

**Spec:** `docs/superpowers/specs/2026-11-11-worktree-integration-and-evidence-routing-design.md` (sections 1–4; rollout phase 1)

## Global Constraints

- Do not reset, stash, force-update, or switch the shared project checkout.
- Do not include unrelated staged, unstaged, or untracked files in a task commit; preserve staged intent.
- Keep `.git` out of app-managed worktrees; file sync moves their content between machines.
- Require the configured integration node and local `main`; do not silently choose another checkout or branch.
- Delete a local-merge worktree only after commit and installed state verify; retain it on uncertainty. A PR request does not imply PR merge.
- Never push, deploy, or replay an uncertain mutation automatically.
- Use disposable repos and test data; don't test against a real project checkout.

## Review Focus

- A second task or outside writer changes `main` after candidate validation; test rebase/revalidation before install.
- Staged and unstaged edits overlap task paths; test preservation and refuse unsafe integration.
- Crash occurs between Git ref update and file/index installation; test journal recovery without overwriting later writes.
- Remote and local `main` diverge, or remote fetch fails; test explicit freshness and no loss of local commits.
- File sync has not delivered the newest worktree changes; test explicit pending status, not a partial commit.

---

### Task 1: Build exact task commits and preserve separate finish paths

**Files:**
- Modify: `src/worktree-git.ts`
- Modify: `src/project-worktrees.ts`
- Test: `test/worktree-git.test.ts`
- Test: `test/project-worktrees.test.ts`

**Interfaces:**
- Consumes: `WorktreeChanges` (`gitBase`, `writes`, `deletes`, `uncommittedPaths`) from `src/project-worktrees.ts`.
- Produces: a typed prepared-integration result carrying the exact current `main` commit, candidate commit/tree, conflicts, and source worktree digest. Explicit PR and local merge are distinct finish paths; PR consumes the original worktree diff.

- [ ] **Step 1: Add failing isolated Git tests** for clean task-only commits, concurrent change on another line, same-line conflict, add/delete/mode changes, local unpublished commit as base, and preservation of the project index and files.
- [ ] **Step 2: Run the focused tests** with `npm run test:file -- test/worktree-git.test.ts test/project-worktrees.test.ts` and confirm the new assertions fail.
- [ ] **Step 3: Implement candidate creation** in `src/worktree-git.ts` with a unique private index and exact worktree base. Do not move the real project ref or write into its real index during preparation. Return conflicts rather than silently using stale base content.
- [ ] **Step 4: Add failing tests** proving the explicit PR path uses only the worktree diff and is not selected after local merge.
- [ ] **Step 5: Implement only the base and content revision metadata required to validate the selected finish path.** Validate metadata schema.
- [ ] **Step 6: Rerun focused tests** and verify the real project index and working files remain unchanged during preparation.

### Task 2: Durable local integration and staged-work preservation

**Files:**
- Modify: `src/project-worktrees.ts`
- Modify: `src/merge-journal.ts` and/or add a focused module under `src/` only if the existing journal cannot represent Git ref phases
- Test: `test/project-worktrees.test.ts`
- Test: a new `test/worktree-local-integration.test.ts`

**Interfaces:**
- Consumes: Task 1's prepared candidate and existing `mergeProjectWorktree` validation/ownership conventions.
- Produces: an idempotent integration operation keyed by project/worktree/revision, returning status, commit hash, checks, and deletion outcome. Duplicate operation IDs return the existing result.

- [ ] **Step 1: Add failing tests** for two disjoint integrations serialized against the latest `main`, branch-not-`main`, non-Git and nested repos, stale upstream, pending sync, changed index/file digest, and duplicate requests.
- [ ] **Step 2: Add transaction-boundary tests** for committed HEAD, staged tree, unstaged changes, and untracked files. Assert task changes alone form the commit and protected edits survive with their staged/unstaged distinction.
- [ ] **Step 3: Implement a durable per-project integration queue** with restart-visible operation phases and compare-and-swap on the expected `main` SHA. Revalidate if `main`, worktree content, or the shared index changed after preparation.
- [ ] **Step 4: Implement snapshot, preview, install, and recovery** for committed/index/worktree layers. If replaying somebody else's change conflicts, leave the branch and checkout unchanged and return protected paths. Never resolve their edits into the task commit.
- [ ] **Step 5: Integrate through the existing journal** or the minimal dedicated journal table needed for ref-before-install, ref-updated, and installed states. Recovery must never roll back across a later writer.
- [ ] **Step 6: Run `npm run test:file -- test/worktree-local-integration.test.ts test/project-worktrees.test.ts test/worktree-git.test.ts`; verify concurrent, crash, and duplicate cases pass.**

### Task 3: Agent merge command, verified cleanup, and instructions

**Files:**
- Modify: `src/worktree-agent.ts`
- Modify: `src/server/worktree-agent.ts`
- Modify: `src/server/routes/worktrees.ts`
- Modify: `bin/joint-bob-worktree.mjs`
- Modify: `test/worktree-agent-api.test.ts`
- Modify: `test/project-worktrees-api.test.ts`
- Modify: `test/worktree-cleanup.test.ts`

**Interfaces:**
- Consumes: Task 2's idempotent integration operation plus current worktree conversation ownership and running-session checks.
- Produces: `merge [--worktree ID] --title TITLE [--operation ID]` for task-local integration; existing `pr` remains the explicit remote path.

- [ ] **Step 1: Add failing API/CLI tests** for caller's current worktree, unauthorized IDs, busy conversations, repeated operations, stale sync, unresolved conflicts, and successful commit result.
- [ ] **Step 2: Add failing cleanup tests** proving successful verified local merge deletes the completed worktree and broadcasts its removal, while a crash/uncertain status, running conversation, or failed verification keeps it.
- [ ] **Step 3: Implement the scoped `merge` operation** in the server and CLI; serialize same-project integration requests and reject operation revisions that changed.
- [ ] **Step 4: Delete only after commit/ref/index state is durably verified.** PR creation itself never triggers cleanup; PR-only worktrees remain until separately requested for deletion. Broadcast worktree and session updates after deletion.
- [ ] **Step 5: Update worktree agent instructions** so requested/default local integration ends with `merge`; only an explicit PR request uses `pr`; never ask an agent to delete an integrated tree itself.
- [ ] **Step 6: Run `npm run test:file -- test/worktree-agent-api.test.ts test/project-worktrees-api.test.ts test/worktree-cleanup.test.ts test/worktree-merged-pr.test.ts`; verify PR-only tasks keep their tree and local merges remove theirs.**

### Task 4: Reuse the existing worktree-by-default preference

**Files:**
- Modify: `public/app/new-session.js`
- Modify: `src/server/worktree-agent.ts` only for an agent-start entry point that bypasses existing new-session selection
- Test: `test/ui/ui-worktrees.test.ts`
- Test: `test/worktree-agent-api.test.ts`

The node preference `newConversationWorktree` and Settings checkbox already exist in `src/settings.ts`, `src/server/schemas.ts`, `public/index.html`, and `public/app/settings.js`; do not add a duplicate setting.

**Interfaces:**
- Consumes: Task 3's worktree selection and finish policy.
- Produces: new writable conversations honor the existing `newConversationWorktree` preference; explicit task instructions and worktree selection take precedence. Scheduled tasks and existing conversations keep their current behavior unless explicitly opted in.

- [ ] **Step 1: Add failing tests** for the existing preference selecting a worktree for new writable conversations and explicit selection overriding it.
- [ ] **Step 2: Apply the existing preference consistently to supported new writable-agent entry points** before the first write; reuse the task's worktree for follow-up conversations.
- [ ] **Step 3: Keep scheduled tasks and existing conversations unchanged** unless their task explicitly asks for a worktree.
- [ ] **Step 4: Run `npm run test:file -- test/ui/ui-worktrees.test.ts test/worktree-agent-api.test.ts`; verify no automatic navigation from the control center.

### Task 5: Regression verification

**Files:**
- Test: the worktree and multi-node suites identified above

- [ ] **Step 1: Run `npm run test:file -- test/project-worktrees.test.ts test/worktree-git.test.ts test/worktree-agent-api.test.ts test/project-worktrees-api.test.ts test/worktree-cleanup.test.ts test/worktree-merged-pr.test.ts test/worktree-native-sync.test.ts test/task-handoff-worktree.test.ts`.**
- [ ] **Step 2: Run `npm run typecheck`.**
- [ ] **Step 3: Run `npm run test:file -- test/ui/ui-worktrees.test.ts`; use only the documented isolated browser harness from `TESTING.md`.**
- [ ] **Step 4: Check `git status --short` and task commits in the implementation checkout; verify no unrelated staged, unstaged, or untracked edits entered the change.**

## Execution notes

The user approved single-agent implementation. Progress and verification evidence are recorded in `.superpowers/sdd/2026-11-11-worktree-local-main-integration/progress.md`. Candidate preparation, durable installation/recovery, and a verification-to-commit engine are implemented, but no task is yet complete end-to-end. Existing CLI/API/cleanup behavior is unchanged; model allocation has not started.

Fetch succeeded. Fast-forward-only pull with autostash disabled was refused because it would overwrite other agents' staged, unstaged, and untracked files. The worktree core files matched fetched `origin/main` before edits. Preserve the shared checkout; do not reset, stash, or sweep in others' changes. Create no branch or worktree unless explicitly requested. Recheck each additional path against upstream and concurrent edits before changing it.
