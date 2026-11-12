# Evidence-based model allocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recommend and eventually select the lowest-cost authorized model and harness likely to complete a task well, using public task-specific benchmarks and verified local outcomes without overstating either.

**Architecture:** Keep domain/complexity/risk assessment distinct from the existing static routing map. Add versioned benchmark evidence and task outcome records, first run selection in recommendation-only mode, and compare against the current policy on held-out authorized history before enabling automatic cross-provider/harness switches. Reuse existing access control, usage prices, quality analytics, conversation segments, and provider profiles.

**Tech Stack:** TypeScript, Node.js `node:sqlite`, existing Jev/System One adapter, routing configs, quality/usage stores, test fixtures with mocked providers.

**Spec:** `docs/superpowers/specs/2026-11-11-worktree-integration-and-evidence-routing-design.md` (sections 5–10; rollout phases 2–3)

## Global Constraints

- Manual model/provider/harness choice and explicit task instructions take precedence.
- Only use configured, authorized accounts and locally installed harnesses. No credential fallback, account creation, or runtime installation.
- Public benchmark scores are priors, not success probabilities for an arbitrary Joint Bob task.
- Unknown prices or outcomes are unknown, never zero-cost or successful.
- Reuse authorized local history; do not enable quality collection, fetch missing transcripts, replicate analytics, or save raw transcripts.
- Keep policy recommendation-only until held-out validation and explicit activation.
- Paid evaluation requires an approved finite allowance; never launch live duplicate-task tests by default.
- Authenticate/model failures are not reasoning failures and cannot count as agent success.

## Review Focus

- Same model ID differs by release or harness; test evidence never merges different identities/configurations.
- Manual provider/model pin conflicts with a proposed cross-harness switch; preserve the pin.
- No eligible candidate has known pricing or benchmark evidence; surface uncertainty rather than selecting the apparent cheapest.
- Sparse/biased local history conflicts with public benchmark rank; fall back conservatively, don't overfit raw success rates.
- Classifier returns low-confidence or unsupported domain/risk; remain on the approved baseline and explain why.

---

### Task 1: Verify benchmark sources and define an evidence catalog

**Files:**
- Create: `src/model-evidence.ts`
- Test: `test/model-evidence.test.ts`
- Document: `docs/model-evidence.md`

**Interfaces:**
- Produces: a versioned catalog record with source URL, retrieval date, benchmark/version, task category, exact model and release, harness/scaffold, reasoning configuration, published score/unit/sample size, and limitations.

- [ ] **Step 1: Research current public sources** relevant to software repair, terminal tasks, and coding. Confirm benchmark methodology, version, exact model identity, and reproducible data access; do not import unverified scores. Planning/UI categories may remain unsupported if evidence is absent.
- [ ] **Step 2: Add failing schema tests** for valid source snapshots, stale records, missing model identity, incompatible metrics, and unknown benchmark versions.
- [ ] **Step 3: Implement strict evidence validation and age handling** in `src/model-evidence.ts`; preserve source provenance and refuse to combine incomparable scores.
- [ ] **Step 4: Document data limitations and refresh behavior** in `docs/model-evidence.md`. Cache last verified evidence; explicit refresh only, no background scraper.
- [ ] **Step 5: Run `npm run test:file -- test/model-evidence.test.ts`.**

### Task 2: Persist classified task and outcome evidence

**Files:**
- Modify: `src/routing-policy.ts` or a focused new assessment module
- Modify: `src/usage-types.ts`, `src/quality-analytics.ts`, and relevant usage persistence modules only where existing records cannot support required attribution
- Test: `test/routing-policy.test.ts`
- Test: `test/quality-analytics.test.ts`
- Test: a focused new `test/model-allocation-evidence.test.ts`

**Interfaces:**
- Produces: a bounded `TaskAssessment` with domain, complexity, risk, required capabilities, classifier/version, confidence, and source task ID; outcome rows tie attempts to task, model release, provider, reasoning, harness, usage, verified checks, human feedback, and escalation chain.

- [ ] **Step 1: Add failing tests** for independent dimensions, missing/unknown outcomes, auth/model errors, retry attempts, access-scoped history queries, and no transcript persistence.
- [ ] **Step 2: Implement assessment schema and classifier questions** using existing System One/JeV calls; keep numeric rules and consequences in code, not generated model text.
- [ ] **Step 3: Reuse task-scoped authorized local records**. Add only derived evidence/source IDs and preserve machine-local quality analytics settings and project access filters.
- [ ] **Step 4: Attribute retries and cross-harness segments correctly**, including failed-attempt cost and the model that produced each verified result.
- [ ] **Step 5: Run focused tests** with `npm run test:file -- test/routing-policy.test.ts test/quality-analytics.test.ts test/model-allocation-evidence.test.ts`.

### Task 3: Recommend candidates using quality floor and expected cost

**Files:**
- Create: `src/model-allocation.ts`
- Modify: `src/usage-pricing.ts` only for proven missing rate dimensions
- Test: `test/model-allocation.test.ts`
- Test: `test/usage-accounting.test.ts`

**Interfaces:**
- Consumes: `TaskAssessment`, evidence catalog, authorized model/harness candidates, local outcome estimates, and usage pricing.
- Produces: ranked eligible candidates with estimated success evidence, total expected cost, uncertainty, exclusion reasons, and a readable selection reason; recommendation mode has no execution side effects.

- [ ] **Step 1: Add failing deterministic tests** for domain-specific benchmark selection, risk quality floors, capability/access exclusions, uncertainty fallback, missing price, total attempt cost, and stable ties.
- [ ] **Step 2: Implement a reviewed, versioned scoring policy** with explicit weights, thresholds, minimum samples, and confidence shrinkage toward the cold-start prior. Treat estimates as calibrated group evidence, not per-task guarantees.
- [ ] **Step 3: Include usage/caching, evaluation, handoff, and likely recovery cost**; missing price stays unknown and cannot win on zero cost.
- [ ] **Step 4: Add held-out historical evaluation** against current fixed routing, reporting success coverage, total cost, latency, and escalation rate without claiming observational causality.
- [ ] **Step 5: Run `npm run test:file -- test/model-allocation.test.ts test/usage-accounting.test.ts test/routing-policy.test.ts`.**

### Task 4: Recommendation-only UI and policy controls

**Files:**
- Modify: existing Routing settings modules under `public/app/` and matching `public/` styles only as needed
- Modify: `src/server/routes/routing.ts` and existing routing config persistence
- Test: `test/ui/ui-routing-policy.test.ts`
- Test: `test/routing-configs.test.ts`

**Interfaces:**
- Consumes: Task 3 candidate recommendations and current per-user routing config.
- Produces: an explicit opt-in policy, recommendation-only by default; per-task details show domain, risk, selected candidate/reason, benchmark age, local sample size, estimated cost, and uncertainty.

- [ ] **Step 1: Add failing API tests** for policy migration, explicit baseline, account scope, manual pin precedence, and recommendation-only no-switch behavior.
- [ ] **Step 2: Add failing UI tests** for recommendation evidence and uncertainty; do not add a polling loop or navigate away from the control center.
- [ ] **Step 3: Implement the smallest controls in the existing Routing settings**. Preserve all existing named configurations and default routing behavior until user opts in.
- [ ] **Step 4: Run `npm run test:file -- test/routing-configs.test.ts test/task-routing-api.test.ts test/routing-policy.test.ts` and the focused UI test with `npm run test:file -- test/ui/ui-routing-policy.test.ts`.**

### Task 5: Cross-provider/harness selection and bounded escalation

**Files:**
- Modify: `src/server/harness-chat.ts` at prompt dispatch and safe harness-switch boundaries
- Modify: `src/handoff-context.ts` or a focused task-checkpoint module
- Modify: `src/server/conversation-prompt.ts` only if durable recovery records require its queue lifecycle
- Modify: `src/server/routes/routing.ts`
- Test: `test/routing-dispatch.test.ts`
- Test: `test/conversation-routing.test.ts`
- Test: focused harness-switch/recovery tests

**Interfaces:**
- Consumes: activated allocation policy, eligible candidates, persistent task attempt record, and task worktree checkpoint.
- Produces: a safe-boundary model/harness switch with bounded checkpoint, attempt ID, cost reservation, stop reason, and durable completion status. Existing team-selected and manually pinned conversations do not auto-switch.

- [ ] **Step 1: Add failing tests** for safe turn-boundary switching, single-writer guarantees, preserved worktree/task ID, credential/resource constraints, handoff restart, exact retry idempotency, and no duplicate external mutation.
- [ ] **Step 2: Add failing escalation tests** proving at most two stronger attempts, approved allowance enforcement, unavailable auth not counted as reasoning failure, and user escalation with evidence.
- [ ] **Step 3: Implement durable checkpoint and recovery state**. Persist requirements, base/candidate revisions, changed paths, checks, previous attempts, spending reservations, and pending external operations; no raw secrets or unlimited transcript.
- [ ] **Step 4: Integrate candidate choice with existing harness segments and provider profiles**, switching only after the previous writer/tools stop and only when required capabilities/access are available.
- [ ] **Step 5: Enable automatic switching only behind explicit opt-in after Task 4's held-out validation.** Keep classifier/cost/provider failures visible and retain the approved baseline when uncertain.
- [ ] **Step 6: Run `npm run test:file -- test/routing-dispatch.test.ts test/conversation-routing.test.ts test/task-handoff-worktree.test.ts` and relevant harness-boundary tests from `TESTING.md`.**

### Task 6: Verification and rollout gate

- [ ] **Step 1: Run all focused evidence, routing, quality, usage, provider-profile, and harness-transition tests** through `npm run test:file`.
- [ ] **Step 2: Run `npm run typecheck`.**
- [ ] **Step 3: Run held-out analysis** with mocked provider evidence and authorized local samples; record limits and counterexamples.
- [ ] **Step 4: Keep automatic policy disabled** unless quality/cost/recovery acceptance checks pass and the user explicitly enables a finite paid-recovery allowance.

## Execution notes

Public benchmark source verification is a prerequisite; no current benchmark score or price is assumed. This checkout is 27 commits behind recorded `origin/main` and has other agents' changes, including an active edit to `src/server/harness-chat.ts`. Do not implement in this shared checkout until the user chooses an execution approach and file ownership/baseline is established. Do not edit the dirty harness file as part of planning.
