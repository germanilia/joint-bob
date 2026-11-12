# Smart Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every prompt to the cheapest adequate model on the conversation's harness, with the classifier key from System AI (twins share it, a relay can lend it), defaults kept in a repo data file that two daily Homeserver tasks review and update.

**Architecture:** Each routing level keeps its primary mapping and gains an ordered `fallbacks` list; the default policy is built from `src/routing-defaults.json`. Routing tries candidates in order, using the harness's own `validateSettings` as the availability check. The classifier key comes from `systemDecisionKey()`, else from a relay that shares its decision model over the signed machine channel. Daily tasks are ordinary scheduled agent prompts whose instructions live in `scripts/routing-review/`.

**Tech Stack:** TypeScript (Node 22, tsx), zod, node:sqlite, node:test, vanilla JS UI in `public/`.

**Spec:** `docs/superpowers/specs/2026-11-11-smart-model-routing-design.md`

## Global Constraints

- Routing never switches harness.
- "Cheapest" = API list price.
- Manual picks, manual mode, team conversations and internal events behave exactly as today.
- No new polling loops; no new replication channel (System AI settings and admin secrets already reach twins).
- The relay key never leaves the relay; members get only the classification.
- The routing-update task commits only `src/routing-defaults.json` (+ its CHANGELOG line) and never cuts a release.
- Existing saved routing configs keep working unchanged (`fallbacks` is optional).
- Work happens in a scratch export of `origin/main` (the shared checkout is behind with other sessions' edits); commits are built from a private index on top of `origin/main` (see memory `stale-head-synced-files`, `shared-tree-edit-safety`).

## Review Focus

1. A project with no TypeSafe attachment (Contigos) → routes using the System AI key. Test in Task 3.
2. Primary candidate rejected by `validateSettings` (model not on this machine) → next candidate is used, `candidateIndex` 1 recorded. Test in Task 3.
3. Every candidate rejected → model unchanged, status `unavailable`, `reason: "no candidate available"`. Test in Task 3.
4. No local key, relay offline or refusing → prompt not routed, `reason: "decision model unavailable"`, prompt still runs. Test in Task 4.
5. Defaults file with a disallowed model (`gpt-5.6-sol`) or unknown thinking level → test fails before release. Test in Task 1.

---

### Task 1: Defaults file and fallbacks in the policy

**Files:**
- Create: `src/routing-defaults.json`
- Modify: `src/routing-policy.ts` (schema, `validateRoutingPolicy`, `defaultRoutingPolicy`, remove `DEFAULT_ROUTING_TASKS`/`DEFAULT_ROUTING_MODELS`)
- Test: `test/routing-defaults.test.ts`, extend `test/routing-policy.test.ts`

**Interfaces:**
- Produces: `routingCandidateSchema = { provider?: string, modelId: string, thinkingLevel: string }`; `RoutingMapping` gains `fallbacks?: RoutingCandidate[]` (max 8); `routingDefaultsSchema` (`{ reviewedAt: "YYYY-MM-DD", notes: string ≤ 2000, categories: Array<{ level: "1".."10", description: string, candidates: Record<harnessId, RoutingCandidate[] (min 1)> }> }`); `readRoutingDefaults(): RoutingDefaults`; `defaultRoutingPolicy()` maps `candidates[h][0]` → mapping, rest → `fallbacks`.

- [ ] Step 1: Tests: `routing-defaults.json parses and every candidate passes validateRoutingPolicy`; `defaultRoutingPolicy uses the first candidate as mapping and the rest as fallbacks`; `validateRoutingPolicy rejects a fallback with gpt-5.6-sol` (message contains `not allowed for automatic routing`); `a saved policy without fallbacks still parses`.
- [ ] Step 2: Run `node --import ./test/setup.mjs --import tsx --test test/routing-defaults.test.ts test/routing-policy.test.ts` → FAIL.
- [ ] Step 3: Implement. Fallbacks are validated with the same rules as the primary mapping (fixed provider, allowed model, thinking level). Initial JSON: the six current categories and descriptions, today's mappings as first candidates; Task 6 replaces the content after research.
- [ ] Step 4: Same command → PASS, and `test/routing-configs.test.ts` still passes.
- [ ] Step 5: Commit `feat(routing): keep default routing in a data file with fallback models`.

### Task 2: System AI routing settings and decision source

**Files:**
- Modify: `src/system-ai-config.ts` (schema: `routing: { enabled: boolean, shareWithRelay: boolean }`, default `{ enabled: true, shareWithRelay: false }`, optional for older saved settings)
- Create: `src/routing-decision.ts`
- Test: `test/routing-decision.test.ts`

**Interfaces:**
- Consumes: `systemDecisionKey(model)` (`src/system-ai.ts`), `getDifficultyClassifier`.
- Produces:
  ```ts
  type DecisionResult = { classification: DifficultyClassification; source: "local" | `relay:${string}` }
    | { classification: null; source: "local" | `relay:${string}` | "none"; reason: string };
  classifyForRouting(classifierId: "typesafe" | "laya", text: string, options: DifficultyClassifierOption[]): Promise<DecisionResult>
  ```
  Local first: key from `systemDecisionKey(classifierId)` (Laya may run keyless). When it throws "No system TypeSafe key…", try relays (Task 4 hook `classifyThroughRelay`, injected so Task 2 tests stub it). Reasons: `decision model unavailable`, `classifier failed`.

- [ ] Step 1: Tests: `uses the system key, not project attachments`; `no system key and no relay → reason "decision model unavailable"`; `classifier returning null → reason "classifier failed"`; `older saved System AI without routing parses with defaults`.
- [ ] Step 2: Run → FAIL. Step 3: Implement. Step 4: Run → PASS, plus `test/system-ai-*.test.ts`.
- [ ] Step 5: Commit `feat(routing): classify with the System AI decision credential`.

### Task 3: Candidate walk and recording in prompt routing

**Files:**
- Modify: `src/server/harness-chat.ts` (`routePromptByDifficulty`, `poolCandidateSettings`), `src/usage-types.ts` (`usageDifficultySchema` optional: `reason`, `candidateIndex`, `provider`, `modelId`, `thinkingLevel`, `decisionSource`)
- Test: `test/routing-dispatch.test.ts` (extend; it already drives routing)

**Interfaces:** Consumes `classifyForRouting` (Task 2), `RoutingMapping.fallbacks` (Task 1).

Behaviour: when the active config is the Joint Bob default and `systemAiSettings().routing.enabled` is false → status `disabled`. Candidates = `[mapping, ...fallbacks]`; skip disallowed; `applyRoutedSettings` failure → next; first success records `candidateIndex`. Abstain → harness default, same as low confidence. With a pool active, only candidates whose provider is in the pool's providers. Every non-routed outcome stores `reason`.

- [ ] Step 1: Tests: `project without TypeSafe attachment is routed with the system key`; `primary rejected → fallback used, candidateIndex 1`; `all rejected → status unavailable, reason "no candidate available", settings unchanged`; `abstain returns to the harness default`; `routing.enabled false disables the default config only`.
- [ ] Step 2: Run `… --test test/routing-dispatch.test.ts` → FAIL. Step 3: Implement. Step 4: Run → PASS, plus `test/chat-subscription-routing.test.ts`, `test/subscription-pools-execution.test.ts`.
- [ ] Step 5: Commit `feat(routing): try fallback models and record why a prompt was not routed`.

### Task 4: Relay shares its decision model

**Files:**
- Create: `src/routing-decision-relay.ts`; route in `src/server/routes/routing.ts`
- Test: `test/routing-decision-relay.test.ts`

**Interfaces:**
- Produces: `DECISION_RELAY_PATH = "/api/cluster/v2/decision-model/classify"`; body `{ classifierId, text (≤ 120000 chars), options }`; answer `DifficultyClassification | null`. `classifyThroughRelay(...)` for Task 2.
- Server: only `machineProtocol === 2` senders that are admitted machines of the relay this node serves (`listRelayMachines`), only when `routing.shareWithRelay` is on; else 403. Uses its own `systemDecisionKey`.
- Member: admitted relay memberships (`listMemberships`, status `admitted`) ordered by `relayNodeId`; reaches the relay node with `signedFetch` through a cluster both belong to; no shared cluster → skipped. A 403/unreachable relay is remembered for 10 minutes. Timeout 15 s.

- [ ] Step 1: Tests: `relay with sharing on answers a member`; `sharing off → 403`; `non-member sender → 403`; `member without local key uses the relay and records source relay:<id>`; `relay unreachable → reason "decision model unavailable"`.
- [ ] Step 2: Run → FAIL. Step 3: Implement. Step 4: Run → PASS.
- [ ] Step 5: Commit `feat(routing): let a relay lend its decision model to its machines`.

### Task 5: System AI → Model routing section

**Files:**
- Modify: `src/server/routes/system-ai.ts` (view adds `routing: { enabled, shareWithRelay, servesRelay, decisionSource, defaults, instructions: { qualityReview, routingUpdate } }`; PUT accepts `system.routing`), `public/app/system-ai-settings.js`, `public/index.html`, `public/styles.css` (only if needed), `docs/system-ai.md`
- Test: `test/system-ai-api.test.ts` (extend), `test/ui/ui-system-ai-routing.test.ts`

Section content: on/off switch; relay share switch (shown only when `servesRelay`); which source classifies now (local / relay name / none + reason); defaults `reviewedAt`, `notes` and a read-only level → candidates list for the selected harness; the two instruction files shown read-only (collapsible, monospace). Instructions read from `scripts/routing-review/*.md` of the running install. Follow the Paper style and existing System AI patterns; save with the existing **Save settings**.

- [ ] Step 1: Tests: API `GET returns routing defaults and both instruction texts`; `PUT saves routing.enabled and shareWithRelay`; UI `shows candidates and instructions; share switch hidden when not serving a relay`.
- [ ] Step 2: Run → FAIL. Step 3: Implement. Step 4: Run → PASS.
- [ ] Step 5: Commit `feat(settings): show model routing, its defaults and daily-review instructions in System AI`.

### Task 6: Daily review instructions, data helper, researched defaults

**Files:**
- Create: `scripts/routing-review/quality-review.md`, `scripts/routing-review/routing-update.md`, `scripts/routing-review/routing-data.mjs`
- Modify: `src/routing-defaults.json`
- Test: `test/routing-review-data.test.ts`

**Interfaces:** `node scripts/routing-review/routing-data.mjs --days N [--db PATH]` prints JSON `{ days, decisions: [{ engine, level, status, reason, candidateIndex, provider, modelId, thinkingLevel, confidence, projectId, conversationId, turnId, occurredAt }], costByModel: [{ engine, provider, modelId, turns, apiCostUsd }], manualAfterRouted: [{ conversationId, turnId }] }`, opening `node.db` read-only.

- Instructions carry the spec's bounds verbatim: sample ≤ 30 conversations, trouble signals first; verdicts overkill/right/underpowered; report at `~/.joint-bob/routing-review/YYYY-MM-DD.json`; ≤ 10 Tavily searches; ≥ 10 judged turns per change; ≤ 3 changes/day; never empty a category; no change → no commit; validate with `test/routing-defaults.test.ts`; commit from a private index, push to `main`, no release.
- Researched defaults: Tavily research on current API prices and strengths; candidates for Claude (incl. Fable), Pi (openai-codex, zai, anthropic, cursor where present), Kiro, Antigravity; each candidate checked against the harness's model list on this machine.

- [ ] Step 1: Test `routing-data.mjs summarises a fixture db` (fixture rows for two engines, one manual-after-routed). Step 2: FAIL. Step 3: Implement + write both instruction files + research and fill defaults. Step 4: PASS, and `test/routing-defaults.test.ts` passes on the new file.
- [ ] Step 5: Commit `feat(routing): daily review instructions and researched default models`.

### Task 7: Ship and schedule

- [ ] Full `npm test` in the scratch copy; compare failures against `origin/main` baseline (memory `worktree-test-baseline`).
- [ ] Commits onto `origin/main` from a private index, push (release gate → `chore(release)` → push), apply my diff to the shared working tree only where files equal old HEAD, per memory `stale-head-synced-files`.
- [ ] After the Homeserver runs the release: create two scheduled tasks in the Joint Bob project on the Homeserver — "Routing quality review" daily 02:00 and "Routing defaults update" daily 03:00 — each prompt: `Follow scripts/routing-review/<file>.md exactly.`
