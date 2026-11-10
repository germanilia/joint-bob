import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CloseoutRecord } from "../src/conversation-closeout.js";
import * as names from "../src/names.js";
import { importProject } from "../src/store.js";
import { countingAsync, touching } from "./perf-statement-counter.js";

/* The name lookups keep their answers between writes (src/names.ts). These tests hold them to
   it: an answer is never older than the last write to the database, whoever made it and whatever
   table it touched; between writes nothing is read again; and the shared answer cannot be changed
   by one of the callers under the others. */

const databaseFile = path.join(process.env.PI_WEB_DATA_DIR!, "node.db");
const COUNTERS = /total_changes|data_version|schema_version/;
const STAMP = "2026-01-01T00:00:00.000Z";

function otherConnection(t: { after: (cleanup: () => void) => void }): DatabaseSync {
  const other = new DatabaseSync(databaseFile);
  t.after(() => other.close());
  return other;
}

function put(other: DatabaseSync, scope: string, key: string, name: string): void {
  other.prepare(`INSERT INTO name_overrides (scope, key, name, updated_at, origin_node_id) VALUES (?, ?, ?, ?, '')
    ON CONFLICT(scope, key) DO UPDATE SET name = excluded.name`).run(scope, key, name, STAMP);
}

const allLookups = () => Promise.all([names.sessionTitleOverrides(), names.sessionColorOverrides(), names.sessionClassificationOverrides(), names.sessionDoneOverrides(), names.sessionFeedbackOverrides(), names.projectNameOverrides()]);

// First on purpose: it needs a database that has no projects table yet.
test("project names wait for the projects table, move to stable ids once, and the move is not asked about again", async (t) => {
  assert.deepEqual(await names.projectNameOverrides(), {});
  const other = otherConnection(t);
  assert.equal(other.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get(), undefined, "this test must run before anything creates the projects table");
  // A name saved under the folder's name, as an old release did.
  put(other, "projects", "perf-legacy", "Legacy name");
  assert.deepEqual(await names.projectNameOverrides(), {}, "still no projects table: asked again every time");
  const moved = () => other.prepare("SELECT 1 FROM name_override_migrations WHERE source = 'stable-project-id-v1'").get() !== undefined;
  assert.equal(moved(), false);

  const projectPath = path.join(process.env.HOME!, "perf-names", "perf-legacy");
  await importProject({ id: "perf-project", name: "perf-project", path: projectPath, createdAt: STAMP, updatedAt: STAMP }, projectPath);
  assert.deepEqual(await names.projectNameOverrides(), { "perf-project": "Legacy name" }, "the table appeared: the name moved to the project's id");
  assert.equal(moved(), true);

  await names.projectNameOverrides();
  const later = await countingAsync(async () => { for (let call = 0; call < 20; call++) { await names.projectNameOverrides(); await names.sessionTitleOverrides(); } });
  assert.equal(touching(later, "name_override_migrations"), 0, "the recorded move is not looked up again");
});

test("a name changes right after it is written, here or by another connection", async (t) => {
  const other = otherConnection(t);
  await names.setSessionTitle("perf-c1", "First");
  assert.equal((await names.sessionTitleOverrides())["perf-c1"], "First");
  await names.setSessionTitle("perf-c1", "Renamed");
  assert.equal((await names.sessionTitleOverrides())["perf-c1"], "Renamed");

  put(other, "sessions", "perf-c2", "From elsewhere");
  assert.equal((await names.sessionTitleOverrides())["perf-c2"], "From elsewhere");
  put(other, "sessions", "perf-c1", "Renamed elsewhere");
  assert.equal((await names.sessionTitleOverrides())["perf-c1"], "Renamed elsewhere");
  other.prepare("DELETE FROM name_overrides WHERE scope = 'sessions' AND key = 'perf-c2'").run();
  assert.equal((await names.sessionTitleOverrides())["perf-c2"], undefined);

  await names.setSessionDone("perf-c1", true);
  assert.ok((await names.sessionDoneOverrides())["perf-c1"]);
  await names.setSessionDone("perf-c1", false);
  assert.equal((await names.sessionDoneOverrides())["perf-c1"], undefined);
  await names.setSessionColor("perf-c1", "teal");
  assert.equal((await names.sessionColorOverrides())["perf-c1"], "teal");
  put(other, "session_colors", "perf-c1", "rose");
  assert.equal((await names.sessionColorOverrides())["perf-c1"], "rose");
  await names.setSessionClassification("perf-c1", "Bug");
  assert.equal((await names.sessionClassificationOverrides())["perf-c1"], "Bug");
  put(other, "session_classifications", "perf-c1", "Feature");
  assert.equal((await names.sessionClassificationOverrides())["perf-c1"], "Feature");
  // The scopes are separate answers.
  assert.equal((await names.sessionTitleOverrides())["perf-c1"], "Renamed elsewhere");
});

test("a project's name follows the projects table, which another connection writes", async (t) => {
  const other = otherConnection(t);
  const projectPath = path.join(process.env.HOME!, "perf-names", "perf-second");
  await importProject({ id: "perf-second", name: "perf-second", path: projectPath, createdAt: STAMP, updatedAt: STAMP }, projectPath);
  await names.setProjectName("perf-second", "Second");
  assert.equal((await names.projectNameOverrides())["perf-second"], "Second");
  // Only the project row goes. Its name is still stored, and no longer listed.
  other.prepare("DELETE FROM projects WHERE id = 'perf-second'").run();
  assert.equal((await names.projectNameOverrides())["perf-second"], undefined);
  assert.notEqual(other.prepare("SELECT 1 FROM name_overrides WHERE scope = 'projects' AND key = 'perf-second'").get(), undefined);
});

test("between writes every asker gets the same frozen answer and nothing is read", async (t) => {
  const other = otherConnection(t);
  await names.setSessionTitle("perf-kept", "Kept");
  const first = await names.sessionTitleOverrides();
  assert.equal(await names.sessionTitleOverrides(), first, "the same object, not a rebuilt one");
  assert.equal(Object.isFrozen(first), true);
  assert.throws(() => { (first as Record<string, string>)["perf-kept"] = "changed by a caller"; }, TypeError);
  assert.throws(() => { (first as Record<string, string>).added = "by a caller"; }, TypeError);
  assert.equal((await names.sessionTitleOverrides())["perf-kept"], "Kept");

  await allLookups();
  const repeated = await countingAsync(async () => { for (let call = 0; call < 50; call++) await allLookups(); });
  assert.equal(touching(repeated, "name_overrides"), 0);
  assert.equal(repeated.parses, 0);
  assert.deepEqual(repeated.statements.filter((sql) => !COUNTERS.test(sql)), [], "only SQLite's own counters are asked");

  put(other, "sessions", "perf-kept", "Changed elsewhere");
  const second = await names.sessionTitleOverrides();
  assert.notEqual(second, first);
  assert.equal(second["perf-kept"], "Changed elsewhere");
  assert.equal(first["perf-kept"], "Kept", "an answer already handed out stays what it was");
  const reread = await countingAsync(() => names.sessionTitleOverrides());
  assert.equal(touching(reread, "name_overrides"), 0);
});

test("a write that changes no name costs one read of the rows, and the answer stays the same object", async (t) => {
  const other = otherConnection(t);
  other.exec("CREATE TABLE IF NOT EXISTS perf_unrelated(id INTEGER PRIMARY KEY, n INTEGER)");
  const elsewhere = other.prepare("INSERT INTO perf_unrelated(id, n) VALUES (1, 0) ON CONFLICT(id) DO UPDATE SET n = n + 1");
  await names.setSessionFeedback("perf-same", { revision: "r1", projectId: "perf-project", engine: "claude", source: "automatic", feedback: null, status: "pending" });
  await names.setSessionTitle("perf-same", "Same");
  const before = await allLookups();

  elsewhere.run();
  const after = await countingAsync(allLookups);
  after.result.forEach((answer, index) => assert.equal(answer, before[index], "the rows did not change, so neither did the answer"));
  assert.equal(touching(after, "name_overrides"), 6, "each lookup read its rows once to compare them");
  assert.equal(after.parses, 0, "feedback that did not change is not parsed or checked again");
  assert.equal((await countingAsync(allLookups)).statements.filter((sql) => !COUNTERS.test(sql)).length, 0, "and until the next write nothing is read");

  // The rows are compared, not counted: a rename keeps their number and still gives a new answer.
  elsewhere.run();
  put(other, "sessions", "perf-same", "Renamed");
  const renamed = await names.sessionTitleOverrides();
  assert.notEqual(renamed, before[0]);
  assert.equal(renamed["perf-same"], "Renamed");
  assert.equal(before[0]["perf-same"], "Same");
  put(other, "sessions", "perf-same", "Same");
  assert.deepEqual(await names.sessionTitleOverrides(), before[0], "renamed back: the same names again");
  // The other scopes were not touched by the rename.
  const others = await allLookups();
  for (const index of [1, 2, 3, 4, 5]) assert.equal(others[index], before[index]);

  // A change another connection has not committed is not seen, before or after it is rolled back.
  other.exec("BEGIN IMMEDIATE");
  other.prepare("DELETE FROM name_overrides WHERE scope = 'sessions' AND key = 'perf-same'").run();
  assert.equal((await names.sessionTitleOverrides())["perf-same"], "Same", "another connection's open transaction is not visible");
  other.exec("ROLLBACK");
  assert.equal((await names.sessionTitleOverrides())["perf-same"], "Same");
});

test("feedback is read and checked once per write, and its records cannot be changed", async (t) => {
  const other = otherConnection(t);
  const record: CloseoutRecord = { revision: "r1", projectId: "perf-project", engine: "claude", source: "manual", feedback: { rating: "good", description: "clear" }, status: "pending" };
  await names.setSessionFeedback("perf-f1", record);
  const first = await names.sessionFeedbackOverrides();
  assert.deepEqual(first["perf-f1"], record);
  assert.equal(await names.sessionFeedbackOverrides(), first);
  assert.equal(Object.isFrozen(first) && Object.isFrozen(first["perf-f1"]) && Object.isFrozen(first["perf-f1"].feedback), true);
  assert.throws(() => { (first["perf-f1"] as CloseoutRecord).status = "complete"; }, TypeError);
  assert.throws(() => { (first["perf-f1"].feedback as { rating: string }).rating = "bad"; }, TypeError);
  const repeated = await countingAsync(async () => { for (let call = 0; call < 50; call++) await names.sessionFeedbackOverrides(); });
  assert.equal(touching(repeated, "name_overrides"), 0);
  assert.equal(repeated.parses, 0);

  await names.setSessionFeedback("perf-f1", { ...record, revision: "r2", status: "complete" });
  assert.equal((await names.sessionFeedbackOverrides())["perf-f1"].revision, "r2");
  assert.equal(first["perf-f1"].revision, "r1");
  put(other, "session_feedback", "perf-f1", JSON.stringify({ ...record, revision: "r3", feedback: null, status: "error", error: "failed" }));
  assert.deepEqual((await names.sessionFeedbackOverrides())["perf-f1"], { ...record, revision: "r3", feedback: null, status: "error", error: "failed" });

  // A stored record that does not pass is an error on every call, never an answer that is kept.
  put(other, "session_feedback", "perf-bad", JSON.stringify({ revision: "r1" }));
  await assert.rejects(names.sessionFeedbackOverrides());
  await assert.rejects(names.sessionFeedbackOverrides());
  other.prepare("DELETE FROM name_overrides WHERE scope = 'session_feedback' AND key = 'perf-bad'").run();
  assert.equal((await names.sessionFeedbackOverrides())["perf-f1"].revision, "r3");
  await names.setSessionFeedback("perf-f1", null);
  assert.equal((await names.sessionFeedbackOverrides())["perf-f1"], undefined);
});
