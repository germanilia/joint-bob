import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensureConversationRecordSchema } from "../src/conversation-records.js";
import { ensureHubSchema } from "../src/server/cluster-hubs.js";
import { EVENT_HISTORY_DAYS } from "../src/server/replication-housekeeping.js";

/* Guards for costs that came back after being fixed (2026-11-10 review): the fixes made one row cheaper
   while the tables kept growing. Each guard pins how a hot query reaches its rows on a table of the size
   a busy node really has, so a change that turns it back into a scan fails here and not in production.
   Plans are pinned rather than wall time: this suite runs on loaded machines. */

function plan(db: DatabaseSync, sql: string, ...values: string[]): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values) as Array<{ detail: string }>).map((row) => row.detail).join("; ");
}

test("a conversation's projects are found through an index, not by reading every conversation record", () => {
  const db = new DatabaseSync(":memory:");
  ensureConversationRecordSchema(db);
  const insert = db.prepare("INSERT INTO conversation_records(project_id, engine, session_id, created_at, updated_at) VALUES(?, 'claude', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')");
  db.exec("BEGIN");
  for (let index = 0; index < 20_000; index++) insert.run(`project-${index % 25}`, `session-${index}`);
  db.exec("COMMIT");
  // Used every two seconds per credential scope (scoped-credentials.ts) and on every conversation change (server.ts).
  const sql = "SELECT DISTINCT project_id FROM conversation_records WHERE engine=? AND session_id=?";
  const detail = plan(db, sql, "claude", "session-7");
  assert.match(detail, /SEARCH .*conversation_records_session/, detail);
  assert.deepEqual(db.prepare(sql).all("claude", "session-7").map((row) => row.project_id), ["project-7"]);
  const started = process.hrtime.bigint();
  for (let index = 0; index < 2_000; index++) db.prepare(sql).all("claude", `session-${index}`);
  // A scan of 20,000 rows 2,000 times takes seconds; the index takes a few milliseconds. The bound is loose on purpose.
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 1_500, "2,000 lookups stay well under the cost of one scan each");
});

test("expiring old replicated events reaches them through the expiry indexes", () => {
  const db = new DatabaseSync(":memory:");
  ensureHubSchema(db);
  db.exec(`CREATE INDEX IF NOT EXISTS replication_outbox_expiry ON replication_outbox(entity_type, created_at);
    CREATE INDEX IF NOT EXISTS cluster_v2_relay_log_expiry ON cluster_v2_relay_log(json_extract(event,'$.entityType'), json_extract(event,'$.createdAt'));`);
  assert.match(plan(db, "SELECT event_id FROM replication_outbox WHERE entity_type=? AND created_at<? LIMIT 500", "model.usage", "2026-01-01"), /replication_outbox_expiry/);
  assert.match(plan(db, "SELECT cluster_id, event_id FROM cluster_v2_relay_log WHERE json_extract(event,'$.entityType')=? AND json_extract(event,'$.createdAt')<? LIMIT 500", "model.usage", "2026-01-01"), /cluster_v2_relay_log_expiry/);
});

test("replicated usage history stays bounded", () => {
  // Usage events were 78% of the relay log at a 30-day window. Raising the window again needs a reason and a measurement.
  assert.ok(EVENT_HISTORY_DAYS["model.usage"] <= 14);
  assert.ok(EVENT_HISTORY_DAYS["user.recent"] <= 7);
});
