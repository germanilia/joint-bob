# Smart model routing and daily routing review

Date: 2026-11-11 · Status: approved 2026-11-11

## Why

The prompt router ("Bob auto") picks a model for each prompt. A review on 2026-11-11 of this Mac's `node.db` (last 30 days) found:

- About 40% of evaluated prompts (2,846 of 7,032) were never routed. The classifier reads `TYPESAFE_AI_API_KEY` from the project's own secret attachments, and Contigos, skills-staging, AIDLC and Internal-assistant have none. The reason is not stored, so the failure was invisible.
- The default ("Joint Bob default", `src/routing-policy.ts`) maps each task category to one hard-coded model per harness. If that model cannot run, the prompt is skipped instead of trying another one.
- It only knows Pi via `openai-codex` and Claude via `haiku`/`sonnet`/`opus`. Fable, Pi's other providers (zai, anthropic, cursor), Kiro and Antigravity are never used.
- The default lives in code and only changes when someone edits it. Nothing learns from how the picks worked out.
- The most expensive spend is on the top tiers: Opus 5.5 ≈ $13.4k and `gpt-6-astra` ≈ $10.5k in API-equivalent cost over 30 days.

## Goal

For every prompt, run the **cheapest model that gets the job done well**, chosen from the models this machine can actually run on the conversation's harness, and keep that choice improving from real results.

## Goals

1. The routing classifier uses the global decision credential in **Settings → System AI** (the system TypeSafe account), not project attachments.
2. Each task category has, per harness, an **ordered list of candidates** (provider, model, thinking level), cheapest adequate first, across all of that harness's providers (Pi: openai-codex, zai, anthropic, cursor, …).
3. At routing time, candidates that this machine cannot run are skipped; if applying a candidate fails, the next one is tried.
4. Routing **never switches harness** (decided 2026-11-11). It picks only among the conversation's current harness's candidates; every harness (Claude, Pi, Kiro, Antigravity) gets its own list.
5. Every routing outcome stores its reason (key missing, classifier failed, no candidate available, model failed, low confidence, routed).
6. The default candidates live in a data file in the repo, `src/routing-defaults.json`.
7. Two **external scheduled tasks** in the Joint Bob project on the **Homeserver**:
   - **Quality review** (daily): judges whether recent routing picks did the job, without overkill.
   - **Routing update** (daily, after the quality review): researches models with Tavily, updates `src/routing-defaults.json`, and commits and pushes to `main` automatically. It does not cut a release; machines get the new defaults with the next normal release and deployment (decided 2026-11-11).
8. All of the above ships together.

## Non-goals

- No change to the built-in Quality collector (Settings → Quality). The external tasks do not depend on it.
- No new scheduler, CLI or API for the tasks. They are ordinary Joint Bob scheduled tasks (agent prompts).
- The tasks do not change named routing configurations people made themselves, only the shipped default.
- No live (non-release) distribution of the defaults.

## Anti-goals (failure even if it works)

- Overkill: drifting toward the top model for everything. "Good enough at the lowest cost" is the target; quality matters, but a stronger model is only justified by evidence that the cheaper one failed.
- Silent failure: a prompt that is not routed without a stored reason.
- A routing update that pushes a broken or invalid defaults file to `main`.
- The review itself costing more than it saves (reading every conversation, unbounded research).

## The selector

### Defaults file

`src/routing-defaults.json`, loaded by `defaultRoutingPolicy()` in place of today's `DEFAULT_ROUTING_TASKS` / `DEFAULT_ROUTING_MODELS` constants. Shape (builder may refine names):

```json
{
  "reviewedAt": "2026-11-11",
  "notes": "short rationale of the last change",
  "categories": [
    {
      "id": "questions",
      "description": "General questions about the app, the project, or how something works…",
      "candidates": {
        "pi": [
          { "provider": "zai", "modelId": "glm-5.3-flash", "thinkingLevel": "medium" },
          { "provider": "openai-codex", "modelId": "gpt-6-luna", "thinkingLevel": "medium" }
        ],
        "claude": [
          { "provider": "claude", "modelId": "haiku", "thinkingLevel": "medium" }
        ]
      }
    }
  ]
}
```

- The six existing categories (questions, terminal/git, simple coding, complex coding, debugging, planning) are kept; their descriptions are what Jev chooses between.
- Order within each harness's list is the preference: first is cheapest adequate.
- **"Cheapest" means API price** (per-token list price, as in `model_usage_events.apiCostUsd`), even for models used through a subscription (decided 2026-11-11).
- A unit test validates the file against the schema and the allowed-model rule (`automaticRoutingModelAllowed`), so a broken file fails CI before release.
- Initial content: built by me from current pricing and the Tavily research; includes Fable, Pi's other providers, Kiro and Antigravity where they fit.

### Policy shape

The routing policy gains the category → candidate-list form. Existing per-harness level mappings (named configurations already saved on nodes) are migrated on read into the new shape, each becoming a one-entry candidate list for its harness, so they keep behaving as before. (My call.)

### Routing a prompt

1. Manual model picks and manual mode still win, unchanged. Team conversations and internal events are still skipped.
2. Classifier key: the System AI decision credential (system TypeSafe account, same resolution rules as Quality: explicit selection, or exactly one eligible account). Laya works as today. Project attachments are no longer read.
3. Jev picks a category from the recent context (as today).
4. Low confidence or abstain: the conversation returns to its harness default (as today for low confidence; abstain now does the same instead of silently staying). Reason recorded.
5. Walk the category's candidates in order. A candidate is **available** when its harness is installed and ready on this machine and the harness's model list (`models()`) contains that provider/model. Unavailable ones are skipped.
6. Apply the first available candidate on the current harness. If applying fails (e.g. pool-aware execution required, model rejected), try the next. If none works, keep the current model and record "no candidate available".
7. Model lists are read from the harnesses' existing (cached) catalogs; no new polling.

### Decision model: twins and relay (added 2026-11-11)

- **Twins:** the classifier key is the System AI decision credential resolved by `systemDecisionKey()` (`src/system-ai.ts`). Admin-owned secret accounts already replicate to twins, and System AI settings already replicate to trusted twins, so setting the key once on one twin makes it work on the other. Routing must use exactly this resolution; no new replication.
- **Relay:** a machine that serves a relay can share its decision model with the machines on that relay. In **Settings → System AI** on the relay: **Let machines on this relay use this decision model** (off by default).
  - A member with no usable local decision credential sends the classification request (state, question, criteria) to the relay over the signed machine channel, the same channel relay pools use (`src/provider-profiles/relay-proxy.ts` pattern). The relay checks membership and its switch, calls TypeSafe/Laya with its own key and returns only the answer. The key never leaves the relay.
  - Order: the member's own System AI credential first; the relay only when the member has none. If several relays offer it, the first reachable one in a stable order (relay id).
  - The routing decision records which source was used (`local` or `relay:<id>`).
  - A relay that is offline or refuses: the prompt is not routed, reason recorded (`decision model unavailable`).

### Recording

`usage_difficulty` payload gains: `reason`, `category`, `candidateIndex`, and the chosen `harness`/`provider`/`modelId`/`thinkingLevel`. The quality and routing tasks read these.

### Settings

In **Settings → System AI**, a **Model routing** section shows:
- on/off for the default routing,
- which decision credential it uses (the existing System AI selection),
- the current defaults' `reviewedAt` and `notes`, and the category → candidates list (read-only).

- the relay sharing switch (only on a machine that serves a relay), and on a member, which relay supplies its decision model when it has no local key,
- the **instructions of the two daily tasks**, read from `scripts/routing-review/quality-review.md` and `scripts/routing-review/routing-update.md` in the installed app, shown read-only (added 2026-11-11). They change only through the repo, like the defaults.

The existing routing-configuration screen (named configs, selection, sharing) stays where it is.

## The external tasks

Both are scheduled tasks in the Joint Bob project, running on the Homeserver, created through the normal scheduled-task UI. Their prompts are committed in the repo (`scripts/routing-review/quality-review.md`, `scripts/routing-review/routing-update.md`) so they can be improved like code; each scheduled task's prompt says "follow the instructions in <file>".

### 1. Quality review (daily, e.g. 02:00)

- Reads the last day's routed turns from the Homeserver `node.db` (read-only): routing payloads, plus cost from `model_usage_events`.
- Picks a bounded sample (default up to 30 conversations), prioritising trouble signals: a manual model change soon after a routed pick, routing failures, abstains, retries/errors in the turn, unusually high cost for the category.
- For each sampled turn, reads that part of the transcript and judges: **overkill** (a cheaper candidate would have done), **right**, or **underpowered** (the model struggled, the user had to redo or switch).
- Writes a dated report outside the repo on the Homeserver: `~/.joint-bob/routing-review/YYYY-MM-DD.json` (per category and model: counts of overkill/right/underpowered, cost, routing failures with reasons, short evidence notes without transcript text or secrets).

### 2. Routing update (daily, after the quality review, e.g. 03:00)

- Reads the last 7 days of reports.
- Tavily research, bounded (default ≤ 10 searches): new models and price changes for the providers this cluster has, and what each model is good at.
- Decides changes to `src/routing-defaults.json`: reorder, add or remove candidates; adjust thinking level. Rules:
  - Move toward cheaper when a category shows overkill with enough samples; move up only on evidence of underpowered picks.
  - Minimum sample size per change (default 10 judged turns), except adding a newly released model as a non-first candidate.
  - At most a few changes per day (default 3); never leave a category with no candidates.
  - No change → no commit.
- Updates `reviewedAt`/`notes`, runs the defaults-file test, commits only that file (`chore(routing): …`) and pushes to `main`. Changes reach machines with the next release.
- The Homeserver checkout is shared with other sessions: the task stages and commits only `src/routing-defaults.json` and must not pull in other uncommitted work.

## Constraints

- Follows the existing rules on git (no branches), secrets (no values printed), and the shared working tree.
- The tasks need: Tavily (attached to the workspace), read access to the Homeserver `node.db` and transcripts, and a GitHub account that can push to `main`.
- The quality task's model choice is part of its scheduled-task settings; it should be a mid-tier model, not the top one.

## Calls I made (check these)

- **Failures that count for fallback:** only failures before the prompt is sent (settings validation, configure, readiness). Errors during a turn (rate limit, quota) are not retried on another model; that is a separate feature.
- **Classifier choice:** for the default routing, the System AI decision model (TypeSafe or Laya) and its credential win (or the relay's, see above). Named configurations keep their own `classifierId` but also take the key from System AI; project attachments are no longer read. The machine owner's TypeSafe account pays for all classification on that machine.
- **Subscription pools:** while a pool is active, routing only considers candidates inside the pool's harness and providers; it never leaves the pool.
- **On/off switch in System AI:** node-wide. Off means the default routing does not route on this machine; a person's own selection of another named configuration is unaffected.
- **Commit hooks on the Homeserver:** the routing task commits with the normal hook and then checks HEAD contains only the defaults file and its CHANGELOG line; it pushes with the account that has push rights, as other agents already do.

## Left to the builder

- Exact JSON field names and how the policy schema carries both forms during migration.
- How "available" is computed per harness from existing readiness and model catalogs, and the cache lifetime.
- Concrete signals and thresholds for the sample, within the bounds above.
- The read-only list layout in System AI (follow the Paper style and existing Settings patterns).
- Schedule times.

## Update 2026-11-12: the review is not an app feature

At the user's request the daily review was taken out of the app (2.273.5). No instruction files, data script or Settings panel ship with Joint Bob. The two reviews are ordinary scheduled tasks on the user's own Homeserver, with all their instructions inside the task prompts. Anyone can set up the same thing with their own scheduled tasks. The selector (System AI key, fallback lists, relay sharing, `src/routing-defaults.json`) stays in the app.
