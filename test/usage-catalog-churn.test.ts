import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProjectRecord, SessionSummary } from "../src/types.js";
import { scheduleUsageIngest, USAGE_RESCHEDULE_MS, usageIngestIdle, withFreshUsage } from "../src/usage-ingest.js";
import { clearUsageTotalsCache, conversationUsage, forgetUsageInventoryReports, usageDatabase, upsertUsageInventory } from "../src/usage-ledger.js";

// 2026-11-23: while the Mac catalogued 860 conversations of a shared project, every new catalogue
// row dropped the cached totals of every conversation in that project (about 100 recomputed a
// second), each count scanned the project's whole catalogue, and every list pass re-walked every
// project's transcripts.

const db = usageDatabase();
const inventory = (projectId: string, conversationId: string, sessionId: string, usageStatus = "unavailable") =>
  upsertUsageInventory({ projectId, conversationId, sessionId, engine: "kiro", title: sessionId, classification: null, usageStatus });

test("a conversation's missing-usage count is read through an index, not a scan of the project", () => {
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) count FROM usage_inventory i WHERE i.project_id IN (?) AND i.usage_status IN ('missing','unavailable') AND i.conversation_id=?")
    .all("p", "c") as Array<{ detail: string }>;
  assert.ok(plan.some((row) => /usage_inventory_conversation/.test(row.detail)), JSON.stringify(plan));
});

test("a catalogue change drops only the totals of the conversations it touches", (t) => {
  const project = "churn-project";
  t.after(() => { db.exec(`DELETE FROM usage_inventory WHERE project_id='${project}'`); clearUsageTotalsCache(); });
  assert.equal(conversationUsage(project, "a").unavailableSessions, 0);
  assert.equal(conversationUsage(project, "b").unavailableSessions, 0);
  // Written behind the cache's back: a cached total keeps reading 0 until something drops it.
  db.prepare("INSERT INTO usage_inventory(project_id,conversation_id,session_id,engine,title,classification,usage_status) VALUES(?,?,?,?,?,?,?)")
    .run(project, "b", "hidden", "kiro", "hidden", null, "unavailable");
  inventory(project, "a", "s1");
  assert.equal(conversationUsage(project, "a").unavailableSessions, 1, "the conversation that gained the row is recounted");
  assert.equal(conversationUsage(project, "b").unavailableSessions, 0, "another conversation's total stays cached");

  inventory(project, "b", "s1");
  assert.equal(conversationUsage(project, "a").unavailableSessions, 0, "the conversation the row left is recounted");
  assert.equal(conversationUsage(project, "b").unavailableSessions, 2, "and so is the one it joined");
});

test("an unchanged listing does not re-walk a project's transcripts until its interval passes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const home = await mkdtemp(path.join(os.tmpdir(), "joint-bob-usage-churn-"));
  const project: ProjectRecord = { id: "reschedule-project", name: "Reschedule", path: home, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" };
  t.after(async () => { db.exec(`DELETE FROM usage_inventory WHERE project_id='${project.id}'`); clearUsageTotalsCache(); await rm(home, { recursive: true, force: true }); });
  const session = async (id: string): Promise<SessionSummary> => {
    const file = path.join(home, `${id}.jsonl`);
    await writeFile(file, `${JSON.stringify({ type: "session", id, timestamp: project.createdAt })}\n`);
    return { id, path: file, harnessId: "pi", agentId: "pi", agentLabel: "Pi", title: id, createdAt: project.createdAt };
  };
  const catalogued = () => (db.prepare("SELECT session_id id FROM usage_inventory WHERE project_id=? ORDER BY session_id").all(project.id) as Array<{ id: string }>).map((row) => row.id);
  // The rows are removed behind the ledger's back to see whether a walk writes them again, so its memory of them goes too.
  const forget = () => { db.exec(`DELETE FROM usage_inventory WHERE project_id='${project.id}'`); forgetUsageInventoryReports(); };
  const first = await session("first");

  scheduleUsageIngest(project, [first], []);
  await usageIngestIdle();
  assert.deepEqual(catalogued(), ["first"]);

  forget();
  scheduleUsageIngest(project, [{ ...first }], []);
  await usageIngestIdle();
  assert.deepEqual(catalogued(), [], "the same listing right after an import is not walked again");

  const second = await session("second");
  scheduleUsageIngest(project, [first, second], []);
  await usageIngestIdle();
  assert.deepEqual(catalogued(), ["first", "second"], "a new session is walked at once");

  forget();
  scheduleUsageIngest(project, [first, { ...second, title: "Renamed" }], []);
  await usageIngestIdle();
  assert.deepEqual(catalogued(), ["first", "second"], "so is a renamed one");

  forget();
  await withFreshUsage(async () => scheduleUsageIngest(project, [first, { ...second, title: "Renamed" }], []));
  assert.deepEqual(catalogued(), ["first", "second"], "a forced refresh never waits");

  forget();
  t.mock.timers.tick(USAGE_RESCHEDULE_MS);
  scheduleUsageIngest(project, [first, { ...second, title: "Renamed" }], []);
  await usageIngestIdle();
  assert.deepEqual(catalogued(), ["first", "second"], "after the interval the same listing is walked again");
});

test("a session reported again unchanged asks the database nothing; a changed or forced report is written", () => {
  const row = { projectId: "kept-report-project", conversationId: "c1", sessionId: "s1", engine: "pi", title: "One", classification: null, usageStatus: "reported" };
  const titles = () => (db.prepare("SELECT title FROM usage_inventory WHERE project_id=?").all(row.projectId) as Array<{ title: string }>).map((entry) => entry.title);
  const remove = () => db.exec(`DELETE FROM usage_inventory WHERE project_id='${row.projectId}'`);
  try {
    upsertUsageInventory(row);
    assert.deepEqual(titles(), ["One"]);
    remove();
    upsertUsageInventory({ ...row });
    assert.deepEqual(titles(), [], "the same report is not sent to the database again");
    upsertUsageInventory({ ...row, title: "Two" });
    assert.deepEqual(titles(), ["Two"], "a changed one is");
    remove();
    upsertUsageInventory({ ...row, title: "Two" }, true);
    assert.deepEqual(titles(), ["Two"], "and so is a forced one");
  } finally { remove(); forgetUsageInventoryReports(); clearUsageTotalsCache(); }
});
