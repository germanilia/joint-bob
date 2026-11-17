# Automations merge implementation plan

> **For agentic workers:** Implement phases in order, test-first. Each phase ships on its own and leaves the app working. Keep other people's edits in the shared checkout untouched.

**Goal:** Scheduled tasks and webhooks become one stored entity, an **automation**, with exactly one trigger: a schedule or a webhook. The trigger can be switched later. Automations are managed only from the control center's Automations tab. Bob reports stay a separate kind.

**Spec:** Approved 2026-11-17 in conversation 796b1582: one trigger per automation (schedule or webhook, switchable), a real data merge (not a rename on screen), one editor per `mockups/automations-unified.html` (tabs Setup · Trigger · Run · Context · History), and the old screens removed.

**Tech stack:** TypeScript, Express/Zod, SQLite `node.db` (PostgreSQL when `JOINT_BOB_DATABASE_URL` is set), browser JavaScript, node:test and the Playwright UI fixture.

## What exists today (survey, 2026-11-17)

| | Scheduled task | Webhook |
|---|---|---|
| Type / schema | `src/cron.ts` `cronInputSchema`, `CronTask` | `src/webhooks.ts` `webhookInputSchema`, `Webhook` |
| Storage | `cron_tasks` (JSON `input` blob, `next_run`), `cron_runs` | `webhooks` (columns), `webhook_deliveries` (last 25) |
| Where | the owner machine's `node.db`; not replicated | the owner machine's `node.db`; not replicated |
| Runner | `src/server/cron.ts` `startCronScheduler` (1 s timer), `executeCronRun` | `src/server/webhooks.ts` `acceptWebhookCall` → `deliverWithProfile` |
| Routes | `/api/cron`, `/api/cluster/cron`, `/api/projects/:id/cron` | `/api/webhooks/*`, `/api/cluster/v2/webhooks`, public `POST /hooks/<secret>` |
| Context | none | resources/skills/memory tables keyed by `webhook_id`, `secret_account_ids` |
| Transfer | install paused, delete source (`routes/cron.ts:135`) | bundle with files (`src/webhook-transfer.ts`); makes a **new** secret |
| Shared already | `automation_executions` (`source_kind` scheduled/webhook), title CLI (`src/webhook-title.ts`), worktree, automation profile, silent review |

Personal assistants reuse the `webhooks` table (assistant target, Telegram reply) and the `webhook_skills*`, `webhook_resources*` and `webhook_memory_settings` tables under the assistant's id.

## Global constraints

- **Existing webhook addresses keep working.** `secret_hash` values move unchanged, and `/hooks/<secret>`, `/hooks/<machine>/<secret>`, `bobtelegram-*` and `teamtelegram-*` are untouched. Telegram registrations must keep working.
- **Existing schedules keep their next run, run history and conversations.** Ids are preserved, so `cron_task_id`, `webhookHistory.webhookId`, resource rows and folders keyed by `webhook_id` stay valid with no rewrite.
- **Formats that are stored or replicated keep their names:**
  - conversation-record fields `cron_task_id` and `webhook_history`;
  - `automation_executions.source_kind`;
  - `SCHEDULED_PROMPT_MARKER`, which is stored in transcripts;
  - the env vars `JOINT_BOB_WEBHOOK_*` (old agent prompts name them);
  - on-disk `webhook-resources/` and `webhook-workspaces/`.

  Code reads these as "automation id"; renaming them is out of scope.
- The migration runs once per node at start-up, in a transaction, and is idempotent. The old tables are renamed to `*_premerge` and kept for one release as a rollback copy, never dropped in the same release.
- **One automation, one owner machine** (the database that holds it), as today. Cross-machine reads and commands go through one signed cluster route.
- No polling beyond the existing 1 s scheduler tick ([[cluster-sync-no-polling]]). List views page, not scroll.

## What was built (supersedes the original data-model and phase notes)

Implementation notes, written after building it; where they differ from the first plan, this is what shipped.

- **One table, trigger column.** Automations live in the existing `webhooks` table, extended with `trigger_kind` (`webhook`|`schedule`), `schedule`, `next_run`, `auto_respond`, `pause_on_failure` and `owner_node_id`. The table keeps its name so an older build still finds its webhooks after a downgrade, and every `webhook_*` table (files, skills, memory, bindings, deliveries) keeps its `webhook_id` column, so existing resources, memory and address hashes stay valid with no rewrite. A scheduled automation has no address: its `secret_hash` is the hash of a random value nobody holds, and `webhookForSecret` only matches `trigger_kind='webhook'`. Switching a webhook to a schedule replaces its hash the same way; switching back makes a new secret, returned once.
- **Migration.** `ensureWebhookSchema` adds the columns and moves every row of `cron_tasks` into `webhooks` with the same id (so `cron_runs`, `cron_task_id` on conversations and the history stay attached), then renames the old table to `cron_tasks_premerge` as a copy. It runs on every start, moves nothing twice, and runs before either store is used. `cron_runs` and `webhook_deliveries` stay separate logs, both keyed by the automation id; the editor's History shows both.
- **Types.** `webhookInputSchema` / `Webhook` in `src/webhooks.ts` are the automation input and entity: an input without a `trigger` is a webhook, as before. `src/schedule.ts` holds the pure calendar rules (`scheduleSchema`, `nextCronRun`). `CronStore` in `src/cron.ts` keeps its API and is now the scheduled view of the same table.
- **One executor path for context.** `src/server/automation-context.ts` gives every run, scheduled or called, the automation's files, tools, skills and memory, its picked secret accounts and the memory binding. A webhook call and a scheduled run still start differently (a call has a payload and a sender; a run has a due time), so the two entry points stay `server/webhooks.ts` and `server/cron.ts`, sharing that helper. Webhooks gained auto reply and turn-off-after-failure.
- **One API.** `src/server/routes/automations.ts` serves `/api/automations` (list, create, update with trigger change, delete, run now, history, transfer, regenerate address, files/skills/memory, `GET /api/projects/:id/automations` for the history filter) and `/api/cluster/v2/automations` between machines. It replaces `/api/cron`, `/api/cluster/cron`, `/api/projects/:id/cron` and `/api/webhooks/*`. `src/server/automation-peers.ts` holds the signed peer call and the project list, apart from the routes, so the conversation lists can use them without loading route modules early (a route module imported early registers before the JSON body parser exists).
- **Remote-login users** manage scheduled automations only; the server hides webhooks from them and refuses commands naming one.
- **Transfer** works for both triggers through the webhook bundle, which now also carries a scheduled automation's settled runs. A webhook still gets a new address on the new machine; a scheduled one has none.
- **Same release on every machine** from this release on: the peer route changed, and an older machine cannot list or edit automations on a newer one until it updates.

## Review focus (kept from the first plan)

- No webhook address or Telegram bot stops working after migration.
- No schedule fires twice or is skipped across the migration restart (`next_run` preserved, active-run uniqueness).
- Personal assistants' skills, files and memory still resolve, because they share the resource tables.
- Switching trigger never leaves a live address on a scheduled automation.

## Rollout

- All machines in a cluster must run the same release from Phase 3 on.
  - An older peer cannot list or edit automations on an upgraded machine; it sees "update this machine".
  - The `/hooks` addresses keep working throughout, because they are served by the owner machine itself.
- Phases 1 and 2 ship together: the store and its first consumer. Phases 3 and 4 ship together: the API and its only UI. That gives two releases plus clean-up.
