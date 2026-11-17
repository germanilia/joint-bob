import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const schedule = { frequency: "daily" as const, hour: 9, minute: 15, weekday: 1, timezone: "UTC" };
const legacyTask = (id: string, extra: Record<string, unknown> = {}) => ({
  name: "Nightly check", prompt: "Check the build", projectId: "project", ownerNodeId: randomUUID(), engine: "claude", sessionId: null, assistantId: null, enabled: true,
  pauseOnFailure: true, markForReview: true, hideFromHistory: false, bypassGuardian: false, runInWorktree: true, schedule,
  model: { provider: "claude", modelId: "claude-opus-5-5", reasoning: "high" }, tags: { managedTagIds: [], manualTags: ["nightly"] }, ...extra, id,
});

function seedLegacy(db: DatabaseSync, tasks: Array<ReturnType<typeof legacyTask>>): void {
  db.exec("CREATE TABLE cron_tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner_node_id TEXT NOT NULL, input TEXT NOT NULL, next_run INTEGER NOT NULL)");
  for (const { id, ...input } of tasks) db.prepare("INSERT INTO cron_tasks VALUES (?, ?, ?, ?, ?)").run(id, input.projectId, input.ownerNodeId, JSON.stringify(input), 1_900_000_000_000);
}

test("scheduled tasks of an older build become automations with the same id, schedule and next run, and the old table is kept as a copy", async () => {
  const { ensureWebhookSchema, getWebhook, listWebhooks } = await import("../src/webhooks.js");
  const db = new DatabaseSync(":memory:");
  try {
    const task = legacyTask(randomUUID());
    seedLegacy(db, [task]);
    ensureWebhookSchema(db);
    const automation = getWebhook(db, task.id)!;
    assert.equal(automation.trigger, "schedule");
    assert.deepEqual(automation.schedule, schedule);
    assert.equal(automation.nextRun, 1_900_000_000_000);
    assert.equal(automation.context, "Check the build");
    assert.equal(automation.pauseOnFailure, true);
    assert.equal(automation.ownerNodeId, task.ownerNodeId);
    assert.deepEqual(automation.model, { provider: "claude", modelId: "claude-opus-5-5" }, "the automation's model has no reasoning of its own");
    assert.equal(automation.reasoning, "high", "the reasoning level moves out of the model");
    assert.deepEqual(automation.tags.manualTags, ["nightly"]);
    assert.equal(listWebhooks(db).length, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM cron_tasks_premerge").get()!.n, 1, "the old rows stay as a copy");
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'cron_tasks'").get(), undefined);
    ensureWebhookSchema(db);
    assert.equal(listWebhooks(db).length, 1, "starting again moves nothing twice");
  } finally { db.close(); }
});

test("a migrated scheduled task keeps its run history and no address can reach it", async () => {
  const { CronStore } = await import("../src/cron.js");
  const { hashWebhookSecret, webhookForSecret } = await import("../src/webhooks.js");
  const db = new DatabaseSync(":memory:");
  try {
    const task = legacyTask(randomUUID());
    seedLegacy(db, [task]);
    db.exec("CREATE TABLE cron_runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, due_at INTEGER NOT NULL, status TEXT NOT NULL, error TEXT, session_id TEXT, finished_at INTEGER, tags TEXT NOT NULL DEFAULT '[]', UNIQUE(task_id, due_at))");
    db.prepare("INSERT INTO cron_runs(id,task_id,due_at,status,error,session_id,finished_at) VALUES(?,?,?,'succeeded',NULL,'session',?)").run(randomUUID(), task.id, 1, 2);
    const store = new CronStore(db);
    const migrated = store.get(task.id)!;
    assert.equal(migrated.name, "Nightly check");
    assert.equal(migrated.lastRun?.status, "succeeded");
    assert.equal(store.list().length, 1);
    const stored = db.prepare("SELECT secret_hash FROM webhooks WHERE id = ?").get(task.id) as { secret_hash: string };
    assert.match(stored.secret_hash, /^[a-f0-9]{64}$/);
    assert.equal(webhookForSecret(db, "x".repeat(43)), undefined);
    assert.notEqual(stored.secret_hash, hashWebhookSecret("x".repeat(43)));
  } finally { db.close(); }
});

test("a webhook of an older build is untouched and keeps its address", async () => {
  const { ensureWebhookSchema, createWebhook, webhookForSecret, webhookInputSchema, getWebhook } = await import("../src/webhooks.js");
  const db = new DatabaseSync(":memory:");
  try {
    ensureWebhookSchema(db);
    const { webhook, secret } = createWebhook(db, webhookInputSchema.parse({ name: "GitHub issues", target: { kind: "project", projectId: "project" }, context: "Triage it" }));
    ensureWebhookSchema(db);
    assert.equal(webhookForSecret(db, secret)?.id, webhook.id);
    assert.equal(getWebhook(db, webhook.id)!.trigger, "webhook");
    assert.equal(getWebhook(db, webhook.id)!.schedule, null);
  } finally { db.close(); }
});

test("an automation switches trigger: a webhook becomes scheduled and loses its address, then gets a new one back", async () => {
  const { createWebhook, updateAutomation, webhookForSecret, webhookInputSchema, getWebhook } = await import("../src/webhooks.js");
  const db = new DatabaseSync(":memory:");
  try {
    const base = { name: "Nightly", target: { kind: "project", projectId: "project", engine: "claude" }, context: "Check the build" };
    const { webhook, secret } = createWebhook(db, webhookInputSchema.parse(base));
    const scheduled = updateAutomation(db, webhook.id, webhookInputSchema.parse({ ...base, trigger: "schedule", schedule }), { now: Date.parse("2026-11-17T08:00:00Z") });
    assert.equal(scheduled.secret, null);
    assert.equal(scheduled.webhook.trigger, "schedule");
    assert.equal(scheduled.webhook.nextRun, Date.parse("2026-11-17T09:15:00Z"));
    assert.equal(webhookForSecret(db, secret), undefined, "the old address stops working");
    const again = updateAutomation(db, webhook.id, webhookInputSchema.parse({ ...base, trigger: "webhook" }));
    assert.ok(again.secret, "going back to a webhook makes a new address");
    assert.notEqual(again.secret, secret);
    assert.equal(webhookForSecret(db, again.secret!)?.id, webhook.id);
    assert.equal(getWebhook(db, webhook.id)!.nextRun, null);
  } finally { db.close(); }
});

test("an unchanged schedule keeps its next run when other settings are saved", async () => {
  const { createAutomation, updateAutomation, webhookInputSchema } = await import("../src/webhooks.js");
  const db = new DatabaseSync(":memory:");
  try {
    const input = { name: "Nightly", target: { kind: "project", projectId: "project", engine: "claude" }, context: "Check the build", trigger: "schedule", schedule };
    const { webhook } = createAutomation(db, webhookInputSchema.parse(input), { ownerNodeId: randomUUID(), now: Date.parse("2026-11-17T08:00:00Z") });
    const renamed = updateAutomation(db, webhook.id, webhookInputSchema.parse({ ...input, name: "Nightly build check" }), { now: Date.parse("2026-11-17T12:00:00Z") });
    assert.equal(renamed.webhook.nextRun, webhook.nextRun);
    const moved = updateAutomation(db, webhook.id, webhookInputSchema.parse({ ...input, schedule: { ...schedule, hour: 10 } }), { now: Date.parse("2026-11-17T12:00:00Z") });
    assert.equal(moved.webhook.nextRun, Date.parse("2026-11-18T10:15:00Z"));
  } finally { db.close(); }
});

test("an automation's trigger decides which fields it may carry", async () => {
  const { webhookInputSchema } = await import("../src/webhooks.js");
  const base = { name: "x", target: { kind: "project", projectId: "p" }, context: "Do it" };
  assert.throws(() => webhookInputSchema.parse({ ...base, trigger: "schedule" }), /Choose when it runs/);
  assert.throws(() => webhookInputSchema.parse({ ...base, trigger: "webhook", schedule }), /Only a scheduled automation/);
  assert.throws(() => webhookInputSchema.parse({ ...base, trigger: "schedule", schedule, context: "" }), /needs instructions/);
  assert.throws(() => webhookInputSchema.parse({ ...base, trigger: "schedule", schedule, attachments: true }), /belong to webhook calls/);
  assert.throws(() => webhookInputSchema.parse({ ...base, trigger: "schedule", schedule, senders: { fields: ["a"], allowed: [] } }), /belong to webhook calls/);
  assert.equal(webhookInputSchema.parse({ ...base, trigger: "schedule", schedule }).trigger, "schedule");
  assert.equal(webhookInputSchema.parse(base).trigger, "webhook", "an input that names no trigger is a webhook, as before");
});

test("scheduled and webhook automations of one machine are listed together, and their id spaces do not meet", async () => {
  const { CronStore } = await import("../src/cron.js");
  const { createWebhook, listWebhooks, webhookInputSchema } = await import("../src/webhooks.js");
  const db = new DatabaseSync(":memory:");
  try {
    const store = new CronStore(db);
    const task = store.create({ name: "Report", prompt: "Report progress", projectId: "project", ownerNodeId: randomUUID(), engine: "claude", sessionId: null, assistantId: null, enabled: true, schedule } as never);
    const { webhook } = createWebhook(db, webhookInputSchema.parse({ name: "Hook", target: { kind: "project", projectId: "project" } }));
    assert.deepEqual(listWebhooks(db).map(item => [item.id, item.trigger]).sort(), [[task.id, "schedule"], [webhook.id, "webhook"]].sort());
    assert.deepEqual(store.list().map(item => item.id), [task.id], "the scheduler never sees a webhook");
    store.delete(task.id);
    assert.equal(listWebhooks(db).length, 1, "deleting a task leaves the webhook");
  } finally { db.close(); }
});
