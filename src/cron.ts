import { randomUUID } from "node:crypto";
import { autoRespondConfigSchema } from "./conversation-auto-respond.js";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openNodeDatabase } from "./node-database.js";
import { z } from "zod";
import { resolveDataDirectory } from "./data-directory.js";
import { listDiscoveredHarnesses } from "./harnesses/registry.js";
import { isHarnessId } from "./types.js";
import { automationTagAssignmentSchema, tagSnapshotSchema, type TagSnapshot } from "./automation-tags.js";
import { createAutomationExecution, transitionAutomationExecution } from "./automation-executions.js";
import { calendarDateSchema, nextCronRun, NO_MORE_RUNS, reasoningSchema, scheduleSchema, type Schedule } from "./schedule.js";
import { webhookTitleTemplateSchema } from "./webhook-title.js";
import { ensureWebhookSchema, hashWebhookSecret, newWebhookSecret } from "./webhooks.js";
export { calendarDateSchema, nextCronRun, NO_MORE_RUNS };


const cronModelSchema = z.object({
  provider: z.string().trim().min(1).max(80),
  modelId: z.string().trim().min(1).max(200),
  reasoning: reasoningSchema.optional(),
}).strict();
export const cronInputSchema = z.object({
  creatorAccountId: z.string().min(1).nullable().optional(),
  assistantId: z.string().uuid().nullable().default(null),
  providerProfileId: z.string().min(1).nullable().optional(),
  providerPoolId: z.string().uuid().nullable().optional(),
  secretAccountIds: z.array(z.string().uuid()).max(100).default([]),
  /** Names each run's conversation; blank uses the task's name. */
  titleTemplate: webhookTitleTemplateSchema,
  tags: automationTagAssignmentSchema.default({ managedTagIds: [], manualTags: [] }),
  projectId: z.string().min(1).max(240), name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(100000), ownerNodeId: z.string().uuid(),
  engine: z.string().refine(isHarnessId, "Harness ID is invalid")
    .refine(id => listDiscoveredHarnesses().some(adapter => adapter.id === id && adapter.runtime), "Harness is not registered on this node"),
  model: cronModelSchema.nullable().optional(), reasoning: reasoningSchema.optional(),
  autoRespond: autoRespondConfigSchema.nullable().optional(),
  runInWorktree: z.boolean().default(true),
  bypassGuardian: z.boolean().default(false),
  sessionId: z.string().min(1).max(240).nullable(), enabled: z.boolean(), pauseOnFailure: z.boolean().default(false), markForReview: z.boolean().default(false), hideFromHistory: z.boolean().default(false),
  schedule: scheduleSchema,
}).strict().superRefine((input, context) => {
  if (input.assistantId && input.sessionId) context.addIssue({ code: z.ZodIssueCode.custom, path: ["sessionId"], message: "Assistant tasks route to the assistant, not a pinned conversation" });
  const adapter = listDiscoveredHarnesses().find((candidate) => candidate.id === input.engine);
  if (!adapter?.configuration) return;
  const reasoning = input.reasoning ?? input.model?.reasoning;
  const reservedProvider = input.model
    ? listDiscoveredHarnesses().find((candidate) => candidate.id !== input.engine && candidate.configuration?.fixedProvider === input.model!.provider)
    : undefined;
  const fixedProvider = adapter.configuration.fixedProvider;
  const providerMismatch = input.model
    ? (fixedProvider ? input.model.provider !== fixedProvider : Boolean(reservedProvider))
    : false;
  const thinkingMismatch = reasoning !== undefined && !adapter.configuration.thinkingLevels.includes(reasoning as (typeof adapter.configuration.thinkingLevels)[number]);
  if (providerMismatch || thinkingMismatch) context.addIssue({ code: z.ZodIssueCode.custom, path: ["model"], message: "Model settings do not belong to the selected harness" });
});
export type CronInput = z.infer<typeof cronInputSchema>;
export const cronRunSchema = z.object({ id: z.string().uuid(), taskId: z.string().uuid(), dueAt: z.number().int(), status: z.enum(["waiting", "running", "succeeded", "failed"]), error: z.string().nullable(), sessionId: z.string().nullable(), finishedAt: z.number().int().nullable(), tags: z.array(tagSnapshotSchema).default([]) }).strict();
export type CronRun = z.infer<typeof cronRunSchema>;
export interface CronTask extends CronInput { id: string; nextRun: number; lastRun: CronRun | null }


type Row = Record<string, unknown>;

/** The column values of a scheduled task. Columns a webhook alone uses stay empty; the secret is set only when a row is made. */
function taskColumns(data: CronInput): Record<string, string | number | null> {
  return {
    name: data.name, target_kind: data.sessionId ? "conversation" : "project", project_id: data.projectId, session_id: data.sessionId, engine: data.engine, assistant_id: data.assistantId, context: data.prompt,
    enabled: data.enabled ? 1 : 0, attachments: 0, preserve_files: 0, mark_for_review: data.markForReview ? 1 : 0, senders: null, model: data.model ? JSON.stringify(data.model) : null, reasoning: data.reasoning ?? null,
    secret_account_ids: JSON.stringify(data.secretAccountIds), title_template: data.titleTemplate, creator_account_id: data.creatorAccountId ?? null, provider_profile_id: data.providerProfileId ?? null,
    provider_pool_id: data.providerPoolId ?? null, tags: JSON.stringify(data.tags), hide_from_history: data.hideFromHistory ? 1 : 0, reply: null, run_in_worktree: data.runInWorktree ? 1 : 0,
    bypass_guardian: data.bypassGuardian ? 1 : 0, trigger_kind: "schedule", schedule: JSON.stringify(data.schedule), auto_respond: data.autoRespond ? JSON.stringify(data.autoRespond) : null,
    pause_on_failure: data.pauseOnFailure ? 1 : 0, owner_node_id: data.ownerNodeId,
  };
}

/** A scheduled automation's settings as the task they run as, so the checks a task has always had can be applied before it is saved. */
export function cronInputOf(input: { creatorAccountId?: string | null; providerProfileId?: string | null; providerPoolId?: string | null; secretAccountIds: string[]; titleTemplate: string; tags: CronInput["tags"];
  name: string; context: string; model: { provider: string; modelId: string } | null; reasoning: string | null; autoRespond: CronInput["autoRespond"]; runInWorktree: boolean; bypassGuardian: boolean; enabled: boolean;
  pauseOnFailure: boolean; markForReview: boolean; hideFromHistory: boolean; schedule: Schedule | null; target: { kind: string; projectId: string; sessionId?: string; assistantId?: string } }, ownerNodeId: string, engine: string): unknown {
  return {
    creatorAccountId: input.creatorAccountId ?? null, assistantId: input.target.kind === "assistant" ? input.target.assistantId : null, providerProfileId: input.providerProfileId ?? null, providerPoolId: input.providerPoolId ?? null,
    secretAccountIds: input.secretAccountIds, titleTemplate: input.titleTemplate, tags: input.tags, projectId: input.target.projectId, name: input.name, prompt: input.context, ownerNodeId, engine,
    model: input.model, ...(input.reasoning ? { reasoning: input.reasoning } : {}), autoRespond: input.autoRespond, runInWorktree: input.runInWorktree, bypassGuardian: input.bypassGuardian,
    sessionId: input.target.kind === "conversation" ? input.target.sessionId : null, enabled: input.enabled, pauseOnFailure: input.pauseOnFailure, markForReview: input.markForReview,
    hideFromHistory: input.hideFromHistory, schedule: input.schedule,
  };
}

/** What a stored row says, checked the way a new input is. */
function taskInput(row: Row): CronInput {
  return cronInputSchema.parse({
    creatorAccountId: row.creator_account_id ?? null, assistantId: row.assistant_id ?? null, providerProfileId: row.provider_profile_id ?? null, providerPoolId: row.provider_pool_id ?? null,
    secretAccountIds: JSON.parse(String(row.secret_account_ids ?? "[]")), titleTemplate: String(row.title_template ?? ""), tags: JSON.parse(String(row.tags || "{}")),
    projectId: String(row.project_id), name: String(row.name), prompt: String(row.context), ownerNodeId: String(row.owner_node_id), engine: String(row.engine),
    model: row.model ? JSON.parse(String(row.model)) : null, ...(row.reasoning ? { reasoning: String(row.reasoning) } : {}), autoRespond: row.auto_respond ? JSON.parse(String(row.auto_respond)) : null,
    runInWorktree: row.run_in_worktree === 1, bypassGuardian: row.bypass_guardian === 1, sessionId: row.session_id ? String(row.session_id) : null, enabled: row.enabled === 1,
    pauseOnFailure: row.pause_on_failure === 1, markForReview: row.mark_for_review === 1, hideFromHistory: row.hide_from_history === 1, schedule: JSON.parse(String(row.schedule)),
  });
}

/** The scheduled automations. They share the `webhooks` table with webhook automations, told apart by `trigger_kind`. */
export class CronStore {
  constructor(private readonly db: DatabaseSync) {
    ensureWebhookSchema(db);
    db.exec(`CREATE TABLE IF NOT EXISTS cron_runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, due_at INTEGER NOT NULL, status TEXT NOT NULL, error TEXT, session_id TEXT, finished_at INTEGER, tags TEXT NOT NULL DEFAULT '[]', UNIQUE(task_id, due_at));
      CREATE UNIQUE INDEX IF NOT EXISTS cron_active_run ON cron_runs(task_id) WHERE status IN ('waiting', 'running');`);
    const columns = db.prepare("PRAGMA table_info(cron_runs)").all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "tags")) db.exec("ALTER TABLE cron_runs ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
  }
  get(id: string): CronTask | null {
    const row = this.db.prepare("SELECT * FROM webhooks WHERE id = ? AND trigger_kind = 'schedule'").get(id) as Row | undefined;
    return row ? { creatorAccountId: null, providerProfileId: null, ...taskInput(row), id: String(row.id), nextRun: Number(row.next_run), lastRun: this.history(id, 1)[0] ?? null } : null;
  }
  list(projectId?: string): CronTask[] {
    const rows = (projectId === undefined ? this.db.prepare("SELECT id FROM webhooks WHERE trigger_kind = 'schedule'").all() : this.db.prepare("SELECT id FROM webhooks WHERE trigger_kind = 'schedule' AND project_id = ?").all(projectId)) as { id: string }[];
    return rows.map(row => this.get(row.id)!);
  }
  history(id: string, limit = 100): CronRun[] {
    return (this.db.prepare("SELECT id, task_id AS taskId, due_at AS dueAt, status, error, session_id AS sessionId, finished_at AS finishedAt, tags FROM cron_runs WHERE task_id = ? ORDER BY due_at DESC LIMIT ?").all(id, limit) as Array<Omit<CronRun, "tags"> & { tags: string }>).map(run => ({ ...run, tags: JSON.parse(run.tags) }));
  }
  taskForRun(runId: string, sessionId: string): CronTask | null {
    const run = this.db.prepare("SELECT task_id FROM cron_runs WHERE id = ? AND session_id = ? AND status IN ('waiting', 'running')").get(runId, sessionId) as { task_id: string } | undefined;
    return run ? this.get(run.task_id) : null;
  }
  create(input: CronInput, now = Date.now(), id: string = randomUUID()): CronTask {
    const data = cronInputSchema.parse(input);
    const at = new Date(now).toISOString();
    const columns = { id, ...taskColumns(data), secret_hash: hashWebhookSecret(newWebhookSecret()), created_at: at, updated_at: at, next_run: nextCronRun(data.schedule, now) };
    const names = Object.keys(columns);
    this.db.prepare(`INSERT INTO webhooks(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`).run(...Object.values(columns));
    return this.get(id)!;
  }
  install(id: string, input: CronInput, runs: CronRun[]): CronTask {
    if (input.enabled || runs.some(run => run.taskId !== id || !["failed", "succeeded"].includes(run.status))) throw new Error("Only paused tasks with settled history can move");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.create(input, Date.now(), id);
      for (const run of runs) this.db.prepare("INSERT INTO cron_runs (id,task_id,due_at,status,error,session_id,finished_at,tags) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, error = excluded.error, session_id = excluded.session_id, finished_at = excluded.finished_at, tags = excluded.tags").run(run.id, id, run.dueAt, run.status, run.error, run.sessionId, run.finishedAt, JSON.stringify(run.tags));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.get(id)!;
  }
  update(id: string, input: CronInput, now = Date.now()): CronTask {
    const data = cronInputSchema.parse(input);
    const old = this.get(id);
    if (!old) throw new Error("Scheduled task not found");
    if (old.ownerNodeId !== data.ownerNodeId || old.projectId !== data.projectId) throw new Error("Task owner and project cannot be changed in place");
    if (old.assistantId !== data.assistantId) throw new Error("Assistant target cannot be changed in place");
    const next = JSON.stringify(old.schedule) === JSON.stringify(data.schedule) && old.enabled === data.enabled ? old.nextRun : nextCronRun(data.schedule, now);
    const columns = { ...taskColumns(data), updated_at: new Date(now).toISOString(), next_run: next };
    this.db.prepare(`UPDATE webhooks SET ${Object.keys(columns).map(name => `${name} = ?`).join(", ")} WHERE id = ? AND trigger_kind = 'schedule'`).run(...Object.values(columns), id);
    return this.get(id)!;
  }
  runNow(id: string, now = Date.now()): CronTask {
    const task = this.get(id);
    if (!task) throw new Error("Scheduled task not found");
    if (this.active(id)) throw new Error("The scheduled task is already running");
    this.db.prepare("UPDATE webhooks SET enabled = 1, next_run = ? WHERE id = ? AND trigger_kind = 'schedule'").run(now, id);
    return this.get(id)!;
  }
  delete(id: string): void {
    if (this.active(id)) throw new Error("Wait for the scheduled run to finish before deleting");
    this.db.prepare("DELETE FROM webhooks WHERE id = ? AND trigger_kind = 'schedule'").run(id);
  }
  /** Forgets a deleted automation's runs, so a later one with the same id starts clean. */
  purge(id: string): void {
    this.db.prepare("DELETE FROM cron_runs WHERE task_id = ? AND status NOT IN ('waiting', 'running')").run(id);
  }
  active(id: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM cron_runs WHERE task_id = ? AND status IN ('waiting', 'running')").get(id));
  }
  claim(id: string, nodeId: string, now = Date.now(), tags: TagSnapshot[] = [], workspaceId: string | null = null): CronRun | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const task = this.get(id);
      if (!task || task.ownerNodeId !== nodeId || !task.enabled || task.nextRun > now) return null;
      this.db.prepare("UPDATE webhooks SET next_run = ? WHERE id = ?").run(nextCronRun(task.schedule, now), id);
      // A late minute is missed, not replayed after reconnect/restart.
      if (now - task.nextRun >= 60000 || this.active(id)) return null;
      const run: CronRun = { id: randomUUID(), taskId: id, dueAt: task.nextRun, status: "waiting", error: null, sessionId: task.sessionId, finishedAt: null, tags };
      this.db.prepare("INSERT INTO cron_runs (id, task_id, due_at, status, session_id, tags) VALUES (?, ?, ?, ?, ?, ?)").run(run.id, id, run.dueAt, run.status, run.sessionId, JSON.stringify(tags));
      createAutomationExecution(this.db, { id: run.id, sourceKind: "scheduled", sourceId: task.id, sourceName: task.name, workspaceId, projectId: task.projectId, ownerNodeId: nodeId, engine: task.engine, requestId: run.id, sessionId: run.sessionId, tags, status: "queued", error: null, acceptedAt: new Date(now).toISOString(), startedAt: null, finishedAt: null });
      return run;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    finally { if (this.db.isTransaction) this.db.exec("COMMIT"); }
  }
  target(id: string, sessionId: string): void {
    this.db.prepare("UPDATE cron_runs SET session_id = ? WHERE id = ?").run(sessionId, id);
  }
  started(id: string, sessionId: string): void {
    this.db.prepare("UPDATE cron_runs SET status = 'running', session_id = ? WHERE id = ?").run(sessionId, id);
  }
  finish(id: string, status: "succeeded" | "failed", error: string | null): void {
    this.db.prepare("UPDATE cron_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?").run(status, error, Date.now(), id);
  }
  recover(now = Date.now(), continuingTaskIds: ReadonlySet<string> = new Set()): void {
    // Never replay an uncertain dispatch. Settle interrupted runs, then let
    // enabled schedules without pause-on-failure continue at their next due time.
    for (const task of this.list()) if (this.active(task.id) && !continuingTaskIds.has(task.id)) {
      if (task.enabled && task.pauseOnFailure) {
        const { id, nextRun, lastRun, ...input } = task;
        this.update(id, { ...input, enabled: false }, now);
      }
      const interruptedRuns = this.db.prepare("SELECT id FROM cron_runs WHERE task_id=? AND status IN ('waiting','running')").all(task.id) as Array<{ id: string }>;
      for (const { id } of interruptedRuns) transitionAutomationExecution(this.db, id, "interrupted", "Node restarted during scheduled run; outcome uncertain.");
      this.db.prepare("UPDATE cron_runs SET status = 'failed', error = ?, finished_at = ? WHERE task_id = ? AND status IN ('waiting', 'running')")
        .run(task.enabled && task.pauseOnFailure
          ? 'Node restarted during scheduled run; outcome uncertain. Task paused.'
          : 'Node restarted during scheduled run; outcome uncertain. Task will resume at the next scheduled time.', now, task.id);
    }
    for (const task of this.list()) if (task.nextRun <= now) this.db.prepare("UPDATE webhooks SET next_run = ? WHERE id = ?").run(nextCronRun(task.schedule, now), task.id);
  }
}
let store: CronStore | undefined;
export function cronStore(): CronStore {
  if (!store) {
    const directory = resolveDataDirectory();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const db = openNodeDatabase(path.join(directory, "node.db"));
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    store = new CronStore(db);
  }
  return store;
}
