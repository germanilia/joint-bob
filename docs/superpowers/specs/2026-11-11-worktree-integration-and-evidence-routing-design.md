# Worktree integration and evidence-based model routing

Status: approved for single-agent implementation; in progress. The user explicitly chose a single agent. Earlier independent builder review could not run because its Codex authentication failed. The commit/verification engine has focused tests, but CLI/API wiring, safe retirement, sync, and model allocation are unfinished. No live setting has been changed.

## Intent and agreed requirements

Several agents currently edit the same project checkout. Isolate their work without making the user coordinate every merge, and spend less on models without accepting worse results.

The user specified:

- Agents should work through Joint Bob worktrees.
- Unless instructed otherwise, finished work merges into local `main`.
- Finish by committing to local `main` unless instructed otherwise. Create a GitHub pull request only when requested instead of the local-merge path. Do not implicitly push local `main`, merge a PR, or deploy.
- Resolve conflicts with best effort. Escalate to a stronger model if necessary; ask the user if that still cannot finish safely.
- Assess task domain and complexity, use public benchmarks and past conversations, and select the cheapest model capable of the task.
- Automatic selection and escalation may change both provider and agent harness.

This is two connected deliverables: reliable worktree integration first, then evidence-based allocation and recovery. Explicit instructions always override defaults, within existing safety and access rules.

## Findings in the current checkout

- `src/project-worktrees.ts` already performs a three-way file merge, serializes calls within one process, checks changed file hashes, and uses `src/merge-journal.ts` for recovery. It does not commit to a Git branch. A conflict returns filenames and changes nothing.
- `src/worktree-agent.ts` and `src/server/worktree-agent.ts` expose `list`, `create`, `start`, `pr`, and `delete`, but not local merge or synchronization. Agent instructions currently prescribe finishing with a PR.
- `src/worktree-git.ts` exports the remote default branch and builds PR changes with a private Git index. New worktrees consequently omit unpublished commits already on local `main`. On a conflicting new PR, the current path can publish on an old base instead.
- Worktrees are application-managed directories without `.git`. Preserve this model; do not introduce native Git branches or Git worktrees for workers.
- `src/routing-policy.ts` maps task descriptions to fixed models. `src/server/harness-chat.ts` classifies prompts and applies mappings within the current harness. Manual model choices already take precedence.
- The same chat module supports harness switching with conversation segments. `src/handoff-context.ts` supplies a truncated recent transcript, not a durable work/resolution checkpoint.
- `src/usage-pricing.ts` prices known token usage and treats missing prices as unknown. `src/quality-analytics.ts` and `docs/quality-analytics.md` provide machine-local, access-controlled observations. Collection is off by default; unknown outcomes are not successes.

These are working-tree findings, not a claim that the checkout is clean or up to date. At inspection, local `main` was behind its recorded `origin/main` and held other agents' staged, unstaged, and untracked work. Implementation must first revalidate the relevant upstream code without resetting, stashing, or sweeping up those edits.

## Proposed defaults, not additional user decisions

These choices need approval with this design:

- Reuse the existing `newConversationWorktree` preference to default new writable conversations to a worktree, and extend it to agent-start paths that do not currently honor it. Do not add a duplicate setting. Scheduled runs and existing conversations keep their current behavior unless explicitly opted in. Existing running conversations stay where they are until safely handed over.
- Completion means an explicit verified finish operation, not the end of an assistant message, a timeout, or a Done badge alone.
- A successful local integration creates one atomic task commit on local `main`, without unrelated staged or unstaged changes.
- Local `main` has one designated integration machine per project. Default to the machine where the project policy is enabled. Worktrees record that destination; a worker on another machine requests integration there. There is no automatic failover to a different checkout.
- Each recovery episode gets the current model's best effort and at most two stronger-model attempts. No stronger eligible model or exhausted recovery allowance means a user-facing escalation.
- Paid automatic recovery requires a finite spending allowance approved when enabling the policy. Do not invent a monetary allowance, silently use an unlimited one, or treat a subscription as unlimited free inference. Manual operation remains available without this allowance.

After a local merge is durably committed and verified, automatically delete that completed worktree. If commit/install outcome is uncertain, keep it for recovery. PR-only worktrees are not locally merged and remain until separately cleaned up. Do not enable these settings, relocate existing agents, or analyze additional history as a side effect of installing the feature.

## 1. Worktree creation and ownership

Create one application worktree per independently integrated task. A conversation continuing the same task reuses its worktree. The app chooses the worktree before launching a writable agent, so a cheap model cannot accidentally edit the shared checkout before noticing instructions.

Persist the task/conversation identity, finish policy, worktree identity, integration node, target ref, and exact base commit. The default finish policy is local merge; an explicit PR request selects the PR path instead. Explicit stay-in-worktree or no-merge instructions remain in force.

For local integration, start from the integration machine's committed `main`, never its dirty working directory. Fetch and compare the upstream default branch before claiming freshness. If upstream is ahead, prepare its integration through the same safe mechanism described below; never force-reset the shared checkout. Local unpublished commits must remain available to later tasks. Divergence is a three-way integration problem, not permission to discard local history.

A failed upstream refresh must be visible. Existing local work can continue with a recorded stale base, but cannot be labelled current. Recheck upstream before finishing. An offline local-only project does not require a remote.

For an explicit PR, use the fetched remote target branch as the initial base. Do not export other agents' unpublished local commits with the PR.

Only repositories whose project root is the Git root and whose integration checkout is on `main` participate in automatic Git integration initially. If the branch differs, stop and report it without switching. Non-Git projects keep their existing explicit file-merge behavior; do not label it a merge to `main`. Other default branch names and nested repositories remain explicit/manual until separately supported.

Track base commit, content baseline, authored change revisions, and successful local integration commits separately. A sync or local merge must not erase the worktree's contribution or make a later requested PR empty. Dependency folders/configuration retain existing ignore and linking rules. Unsupported file types must be reported, not silently omitted from a claimed complete change.

Existing shared-checkout agents are a migration boundary: stop them at a turn boundary and show their changes before assigning ownership. Never copy the entire dirty checkout into every new worktree or guess which agent owns a hunk.

## 2. Agent commands and conflict resolution

Extend the existing scoped worktree CLI rather than introducing another agent tool:

- `sync [--worktree ID] [--target local|pr]`: prepare the worktree against the chosen current target. Default target follows the task's finish policy. Return the target commit, candidate revision, clean changes, and structured conflicts.
- `merge [--worktree ID] --title TITLE`: request verified local integration. Default worktree is the caller's current one. Return a durable operation ID, status, target node/ref, commit, and verification evidence.
- Keep `pr` as the explicit remote-publication path. It must use the same conflict-resolution and verification contract; never quietly publish an old-base alternative.

The server checks project edit permissions, worktree/conversation ownership, pending file sync, and operation revision. Supplying an ID never bypasses scope. Retries use the operation ID and return its existing result rather than duplicating a commit or PR.

Synchronization presents conflicts inside the worktree, with common ancestor, incoming target, task version, and conflict kind. Resolve text changes there. Binary, rename/delete, mode, and path collisions need explicit handling; choosing one whole side is not a generic resolution strategy.

The agent reads the competing intent, resolves the conflict, and runs the required checks from the project's testing instructions. Execute through the existing supervised runtime as the authorized account. Record command, cwd, candidate digest, exit status, and bounded result references from actual execution; agent prose cannot certify a pass. Missing required checks or an unrelated pre-existing failure must be reported with evidence, not silently waived. A user may explicitly approve an exception, which stays attached to the integration record. A failed attempt passes the actual diff and failure evidence to recovery. No model gets permission to overwrite the shared checkout directly.

When ready, record a candidate digest tied to the exact target commit and complete worktree tree. Any relevant edit or target change invalidates that candidate and its checks. Re-sync and re-verify before publication.

## 3. Safe local integration

Use one durable integration queue on the designated machine, keyed by project. The existing process-local promise lock is insufficient for restarts or requests from several machines. Reuse project/conversation ownership and existing journal facilities where possible; do not add a second cluster authority or a polling sync loop.

Prepare and test the candidate in the worktree, outside the short final installation lock. At installation, confirm the branch, target commit, worktree digest, Git index, and relevant project file versions still match. If another task merged first, prepare again against that new commit. Queue churn is not evidence that the model failed.

A task commit contains committed `main` plus this task's resolved contribution only. Build it with a private index. Never run `git add .`, commit the shared index, or use a reset/stash/checkout operation to clear other agents' work.

Preserve both layers of existing local work:

1. Snapshot committed HEAD, the shared index, and working files.
2. Build the task commit independently of staged and unstaged edits.
3. Preview reapplying the original staged delta to the new HEAD, then the original unstaged delta to that result. Preserve which edits were staged, file modes, and untracked files.
4. If either replay conflicts, leave the checkout and branch unchanged. Attempt task-side changes that avoid the collision where possible. Do not absorb, discard, or silently resolve someone else's uncommitted work into this task's commit. If safe separation remains impossible, report the protected paths and ask the user to coordinate their owner.
5. Journal the intended ref/index/file transition. Use a compare-and-swap ref update and checked installation. A changed index, file, branch, or owner invalidates installation.

Git locks do not exclude an external editor. Do not claim filesystem-wide atomicity. Detect concurrent modification, retain preimages, and use a recoverable transaction with explicit phases. Recovery must distinguish before-ref, after-ref, and installed states and must never roll back over a later writer. If safe automatic recovery cannot establish which state is authoritative, stop with the operation record intact.

After installation, verify the recorded commit and installed states, advance both Git and content baselines, and retain contribution lineage for a subsequent PR. Report the commit hash and checks. Only after durable verification, delete the completed local-merge worktree and confirm removal. If outcome or removal is uncertain, retain/recover from the operation journal rather than deleting evidence. Do not push or deploy automatically.

A repeated merge with no new task changes is a no-op. An uncertain result is inspected by operation ID, never blindly retried.

## 4. PR behavior

A PR publishes only the retained worktree contribution, replayed onto the current remote target. Resolve conflicts and test before publication, including updates to an existing PR. If GitHub publication has an uncertain outcome, inspect the recorded branch/commit/PR identity instead of issuing a second mutation.

The task chooses one finish path: local integration or an explicitly requested PR. Do not silently publish a task that was already committed locally. If a PR task depends on another unpublished local change, surface that dependency and ask whether to publish it separately or include it; never silently broaden scope.

PR creation does not merge the PR. A locally merged worktree is deleted after verified integration. A PR-only worktree stays until the user separately requests deletion. Never delete a running or unintegrated worktree.

## 5. Task assessment and model eligibility

Extend the existing classifier integration to assess independent dimensions:

- Domain/task type, such as repository implementation, debugging, Git/conflict resolution, UI work, or architecture.
- Complexity, using described levels for scope, ambiguity, and dependency reasoning.
- Risk, including security, persistence, irreversible actions, and shared-state changes.
- Required capabilities: tools, images, usable context, and supported resources.

Use bounded relevant task context, not just the latest short message and not the entire project transcript. Record classifier version, evidence, and uncertainty. Classifier confidence is not the probability that a coding model will succeed. Numerical ranking, costs, thresholds, and control flow belong in code.

Candidates must be available through the user's configured, authorized provider profiles and installed harnesses on the execution machine. Respect access scopes, availability, quotas, context limits, tool/MCP/browser requirements, and provider data restrictions. Cross-provider permission does not grant new credentials or broader resource access. Do not sign into accounts or install harnesses automatically.

Manual model/provider/harness pins and explicit task instructions win. If a manual pin prohibits the only viable escalation, explain that constraint rather than breaking it.

## 6. Public benchmark evidence

Use several domain-relevant evaluations, not one global score. Candidate source families for implementation research include SWE-bench for repository repair, Terminal-Bench for terminal tasks, and LiveCodeBench for coding problems. These are proposed sources, not verified current feeds or interchangeable measures of success. Planning and UI judgments may lack a suitable public benchmark and must retain that uncertainty.

Store versioned evidence with the public source URL, retrieval date, benchmark/version, task category, model/version, harness/scaffold, reasoning setting, score/unit, sample size when published, and limitations. Keep exact provider model identity separate from marketing aliases. Missing identity, undocumented configuration, stale evidence, or unknown coverage lowers confidence or excludes the evidence; never fabricate a match.

Do not turn a benchmark percentage into a probability of success on an arbitrary user task, average incompatible scores, or compare materially different scaffolds as if only the model changed. Public results provide a cold-start capability prior. Local outcomes calibrate task suitability where there is enough comparable evidence.

Use documented machine-readable sources where available and validated imports where not. Cache last verified evidence with its age; an unavailable source is visible. Refresh at policy activation, explicit refresh, or when a new model needs evidence, subject to a freshness check. Do not add an always-running scrape loop.

No current numeric rankings or prices are asserted in this design. Live source verification is an implementation prerequisite; the proposed sources have not yet been researched for this change.

## 7. Learning from past conversations

Reuse authorized local history and existing machine-local quality analytics. Do not enable the collector elsewhere, fetch extra conversations, replicate analytics to a relay, or retain a new transcript archive. If collection is off or evidence is missing, show that limitation and use public evidence plus conservative defaults.

Record task outcomes separately from inferred reply quality. Useful evidence includes verified checks, accepted human feedback, corrections, reopened failures, attempts, escalation, elapsed time, and observed usage. An agent's claim of success, a Done flag, silence, or a missing transcript is not a verified success. A process exit code of zero does not override a harness turn error or missing result. Test pass is scoped to what those tests cover.

Attribute results to model version, provider, reasoning setting, harness, task domain/complexity, and project context. Preserve a switched task's attempt chain: the last model must not get credit for all work, and a failed cheap attempt must not disappear from the total cost.

Use conservative, sample-aware estimates. Sparse observations fall back toward the public prior rather than declaring a new winner. Keep evaluator versions and human feedback distinguishable. Hard tasks are not randomly assigned, so raw success rates cannot establish which model is better. Validate policy changes on held-out historical cases and review counterexamples before activation. No live duplicate-task experiments or speculative paid evaluations by default.

Persist derived metrics and source identifiers only. Scope every query to the acting user's accessible projects. Reuse the collector's redaction and source-retention constraints.

## 8. Selection, costs, and escalation

First establish eligibility and a quality floor appropriate to domain and risk. Then minimize expected total task cost among candidates meeting it. Include input/output/reasoning and cache charges, likely attempts, handoff context, evaluation overhead, and recovery. Record monetary costs separately from subscription usage, quota pressure, and latency.

Missing prices are unknown, not zero. With insufficient capability or cost evidence, retain an explicitly approved capable baseline and expose uncertainty rather than inventing the cheapest answer. If no candidate meets the quality floor, escalate or ask. Thresholds and any cold-start benchmark mapping are reviewed constants validated against labeled cases before automatic rollout; they are not an LLM's free-form choice.

Reassess at task start, a substantive task change, failed verification, or unresolved conflict. Do not switch models on every conversational acknowledgement. A stronger escalation means better relevant capability evidence, not merely a higher price. Recovery does not bounce down to a model that already failed the same problem without new evidence.

Distinguish causes before escalation. Missing credentials, offline integration machines, stale candidates, exhausted quotas, and test infrastructure failures are not automatically reasoning failures. Report or recover through the correct boundary. Never replay an external mutation with an uncertain result.

Use a persistent recovery record containing attempt count, selected candidates, why escalation is needed, failed checks, remaining allowance, and a stop reason. Reserve estimated cost before starting a paid attempt and enforce output/turn limits through the harness where supported. Provider estimates cannot guarantee an exact invoice ceiling; report that limit. If cost cannot be bounded sufficiently, request permission before the paid attempt.

Stop when verified, cancelled, the approved allowance is exhausted, two stronger attempts fail, no eligible stronger model exists, or missing information/authorization makes further work unsafe. Ask the user with concrete evidence and the smallest required decision.

## 9. Cross-harness continuity

Switch only at a safe turn boundary after the old writer and relevant tool work have stopped. Keep the same logical conversation, task, worktree, execution node, operation IDs, and finish policy. Reuse existing conversation segments and ownership checks.

Persist a structured handoff checkpoint: user requirements, task scope, base/candidate revisions, changed files, unresolved conflicts, verification commands/results, prior attempts, budgets, and pending external operations. Include source references for authorized retrieval, not raw secrets or an unbounded transcript. Treat repository and retrieved text as data, not instructions granting new access.

The receiving harness must support the task's required resources and reload them under the same access rules. Reconcile persisted queue/lease state before starting. A restart or interrupted handoff cannot leave two writers, run the prompt twice, or publish twice. Failure to launch the new harness leaves a recoverable stopped operation rather than silently resuming both.

Existing team-selected and pinned conversations retain their authority boundaries. This first version does not override team member selection; team-wide automatic reallocation is a separate feature.

## 10. Visibility and rollout

Use the existing new-conversation worktree preference plus Worktrees and Routing/Quality settings, not a new management modal. Show the target node/ref, integration stage, conflict paths, verification evidence, selected model/provider/harness, selection reason, benchmark age, local sample coverage, estimated/actual cost, and escalation outcome in the existing task/conversation details.

Long histories paginate and fit the available height. Automatic routing, handoff, and merge events must not navigate the person away from the control center.

Roll out in order:

1. Scoped sync/merge commands, contribution tracking, safe local commits, concurrency/recovery tests, and updated agent instructions. Recovery can use the current allowed mappings while evidence routing is not active; state that limitation.
2. Evidence storage, assessment, costs, and historical validation in recommendation-only mode. No automatic model switches during evaluation.
3. Enable cross-provider/harness selection and bounded recovery for opted-in policies after the acceptance checks pass and an allowance is approved.

Do not silently replace existing named routing configurations or move already-running agents. Provide an explicit adoption path and preserve their current settings.

## Acceptance checks

Worktrees:

- Two agents finish disjoint tasks concurrently; both verified contributions appear in local `main` as separate commits, with no extra files or push.
- Same-file conflicts resolve inside the worktree. The final integrated tree is tested, not merely the pre-merge version.
- A commit arriving between validation and installation invalidates the candidate and triggers revalidation.
- Unrelated staged, unstaged, and untracked work survives byte-for-byte where unchanged, with staging intent preserved. Protected overlapping changes never enter the task commit or disappear.
- Wrong branch, non-root repository, unavailable integration machine, and pending file sync produce explicit statuses, not a different target or stale success.
- Local unpublished commits seed subsequent local worktrees. A remote advance cannot erase them.
- Crash and duplicate-request tests cover each journal/ref/index installation boundary, preserving later writers and preventing duplicate commits.
- The local-merge path creates only the task commit and removes its worktree only after the merge is durably verified. The explicit-PR path contains only the task contribution and retains its worktree until the user separately requests deletion.
- Added/deleted/binary files, modes, and rename collisions are either handled correctly or explicitly blocked, never silently skipped.

Routing and recovery:

- Domain, complexity, and risk can select different models. The cheapest candidate below the quality floor is rejected.
- Missing/stale/incomparable benchmark evidence, unknown prices, sparse history, and unknown outcomes remain visible.
- Held-out evaluation reports task success, total cost including failures, latency, and escalation rate against current fixed mappings. Evidence is not presented as a causal improvement from observational history alone.
- Manual pins, unavailable credentials, resource restrictions, and access scopes survive every route and handoff.
- A stronger model receives the same task/worktree checkpoint and failure evidence. Cancellation, restart, and handoff never produce competing writers or duplicate external actions.
- Recovery attempts and spending reservations are enforced; exhaustion produces an actionable question, not another automatic retry.
- A harness that exits zero after an authentication/model error with no result is recorded as failed, not successful. Authentication errors do not count as reasoning failures.
- Analytics-off behavior and cross-account isolation remain unchanged. No raw transcript archive, automatic collector enablement, or broadened project access is introduced.

Use this project's documented isolated test harness. All integration tests use disposable repositories/data, synthetic accounts, and mocked public evidence/providers. Live paid model tests require an approved allowance. UI tests must verify existing navigation rules and cleanup.

## Builder discretion

The builder may choose internal table names, module boundaries, typed result shapes, benchmark import adapters after source verification, and the statistical estimator after held-out validation. Prefer extending the current worktree, routing, journal, pricing, quality, and conversation-segment modules. Keep decisions reproducible and avoid a generic orchestration framework.

Changes to the agreed finish policy, access boundaries, local-main destination, preservation of others' work, cost authorization, or automatic publishing behavior require returning to the user.
