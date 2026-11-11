import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PostgresDatabase } from "../src/postgres/connection.js";
import { openNodeDatabase } from "../src/node-database.js";

// A disposable PostgreSQL (16 or newer) to run against, e.g. postgres://user:password@127.0.0.1:5432/scratch.
const url = process.env.JOINT_BOB_TEST_POSTGRES_URL;
const live = { skip: url ? false : "JOINT_BOB_TEST_POSTGRES_URL is not set" };

function database(): PostgresDatabase {
  return new PostgresDatabase(url!, `jb_adapter_${randomUUID().replaceAll("-", "")}`);
}

test("a node whose database moved to PostgreSQL refuses to start an empty SQLite one", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "joint-bob-postgres-marker-"));
  writeFileSync(path.join(directory, "node-database-is-postgres"), "");
  const saved = process.env.JOINT_BOB_DATABASE_URL;
  delete process.env.JOINT_BOB_DATABASE_URL;
  try {
    assert.throws(() => openNodeDatabase(path.join(directory, "node.db")), /keeps its database in PostgreSQL/);
  } finally {
    if (saved !== undefined) process.env.JOINT_BOB_DATABASE_URL = saved;
  }
});

test("statements run as SQLite runs them", live, () => {
  const db = database();
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, profileId TEXT, startedAt INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS sessions_profile ON sessions(profileId)`);
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run("a", "p1", 1_794_336_526_199);
  assert.equal(db.prepare("INSERT OR IGNORE INTO sessions VALUES (?, ?, ?)").run("a", "p2", 2).changes, 0);
  assert.throws(() => db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run("b", "p1", 3), /UNIQUE constraint failed: sessions\.profileId/);
  db.prepare("INSERT OR REPLACE INTO sessions (id, profileId, startedAt) VALUES (?, ?, ?)").run("a", "p3", 4);
  assert.deepEqual(db.prepare("SELECT id, profileId, startedAt FROM sessions WHERE profileId IS ?").all("p3"), [{ id: "a", profileId: "p3", startedAt: 4 }]);
  assert.deepEqual(Object.keys(db.prepare("SELECT * FROM sessions").get()!), ["id", "profileId", "startedAt"], "the hidden rowid stays hidden");
  assert.equal(db.prepare("SELECT rowid FROM sessions").get()!.rowid, 1);
  assert.deepEqual(db.prepare("SELECT ? IS NULL AS missing, max(2, ?) AS larger, json_extract(?, '$.a[1]') AS item").get(null, 5, '{"a":[1,"x"]}'), { missing: 1, larger: 5, item: "x" });
  assert.deepEqual(db.prepare("SELECT value FROM json_each(?) ORDER BY key").all('["x","y"]'), [{ value: "x" }, { value: "y" }]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sessions WHERE id LIKE ?").get("A")!.n, 1, "LIKE ignores case");
  db.close();
});

test("transactions keep SQLite's rules", live, () => {
  const db = database();
  db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)");
  db.exec("BEGIN IMMEDIATE");
  assert.equal(db.isTransaction, true);
  assert.throws(() => db.exec("BEGIN"), /cannot start a transaction within a transaction/);
  db.prepare("INSERT INTO t VALUES (?, ?)").run("a", 1);
  assert.throws(() => db.prepare("INSERT INTO t VALUES (?, ?)").run("a", 2), /UNIQUE constraint failed/);
  db.prepare("INSERT INTO t VALUES (?, ?)").run("b", 2);
  db.exec("COMMIT");
  assert.equal(db.prepare("SELECT count(*) AS n FROM t").get()!.n, 2, "the failed insert failed alone");

  db.exec("SAVEPOINT outer_write");
  assert.equal(db.isTransaction, true, "a savepoint outside a transaction opens one");
  db.exec("SAVEPOINT inner_write");
  db.prepare("DELETE FROM t").run();
  db.exec("ROLLBACK TO inner_write; RELEASE inner_write");
  db.prepare("UPDATE t SET n = n + 10").run();
  db.exec("RELEASE outer_write");
  assert.equal(db.isTransaction, false, "releasing it commits");
  assert.deepEqual(db.prepare("SELECT n FROM t ORDER BY id").all(), [{ n: 11 }, { n: 12 }]);
  db.close();
});

test("schema introspection answers as SQLite's catalog would", live, () => {
  const db = database();
  db.exec("CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, engine TEXT NOT NULL CHECK (engine IN ('pi', 'claude')))");
  db.exec("CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY)");
  assert.match(String(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tokens'").get()!.sql), /engine IN \('pi', 'claude'\)/);
  db.exec("ALTER TABLE tokens ADD COLUMN credentials TEXT");
  assert.deepEqual(db.prepare("PRAGMA table_info(tokens)").all().map((row) => [row.name, row.type, row.pk]), [["hash", "TEXT", 1], ["engine", "TEXT", 0], ["credentials", "TEXT", 0]]);
  assert.match(String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'tokens'").get()!.sql), /credentials TEXT\)$/);
  const version = Number(db.prepare("SELECT schema_version FROM pragma_schema_version").get()!.schema_version);
  db.exec("DROP TABLE tokens");
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'tokens'").get(), undefined);
  assert.ok(Number(db.prepare("SELECT schema_version FROM pragma_schema_version").get()!.schema_version) > version);
  db.close();
});

test("UPDATE OR IGNORE leaves only the conflicting rows, and triggers fire", live, () => {
  const db = database();
  db.exec(`CREATE TABLE owners (resource TEXT NOT NULL, account TEXT NOT NULL, UNIQUE(resource, account));
    CREATE TABLE revision (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL);
    INSERT INTO revision VALUES (1, 0);
    CREATE TRIGGER IF NOT EXISTS owners_bump AFTER INSERT ON owners BEGIN UPDATE revision SET value = value + 1 WHERE id = 1; END`);
  for (const [resource, account] of [["r1", "old"], ["r2", "old"], ["r2", "new"]]) db.prepare("INSERT INTO owners VALUES (?, ?)").run(resource, account);
  assert.equal(db.prepare("SELECT value FROM revision").get()!.value, 3);
  assert.equal(db.prepare("UPDATE OR IGNORE owners SET account = ? WHERE account = ?").run("new", "old").changes, 1);
  assert.deepEqual(db.prepare("SELECT resource, account FROM owners ORDER BY resource, account").all(), [
    { resource: "r1", account: "new" }, { resource: "r2", account: "new" }, { resource: "r2", account: "old" },
  ]);
  db.close();
});

test("one writer at a time across connections", live, () => {
  const schema = `jb_adapter_${randomUUID().replaceAll("-", "")}`;
  const first = new PostgresDatabase(url!, schema);
  const second = new PostgresDatabase(url!, schema);
  first.exec("CREATE TABLE counter (id INTEGER PRIMARY KEY, n INTEGER NOT NULL); INSERT INTO counter VALUES (1, 0)");
  first.exec("BEGIN IMMEDIATE");
  const started = Date.now();
  assert.throws(() => second.prepare("UPDATE counter SET n = n + 1").run(), /database is locked/);
  assert.ok(Date.now() - started >= 4_000, "the second writer waited for the lock, as busy_timeout does");
  first.exec("COMMIT");
  second.prepare("UPDATE counter SET n = n + 1").run();
  assert.equal(first.prepare("SELECT n FROM counter").get()!.n, 1);
  first.close();
  second.close();
});

test("references accept a missing parent, as SQLite does by default, and still cascade deletes", live, () => {
  const db = database();
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE logins (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE aliases (alias TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id))`);
  db.prepare("INSERT INTO aliases VALUES (?, ?)").run("a", "missing-project");
  db.prepare("INSERT INTO users VALUES (?)").run("u1");
  db.prepare("INSERT INTO logins VALUES (?, ?)").run("l1", "u1");
  db.prepare("DELETE FROM users WHERE id = ?").run("u1");
  assert.equal(db.prepare("SELECT count(*) AS n FROM logins").get()!.n, 0);
  assert.deepEqual(db.prepare("SELECT m.alias, project_id AS project, count(*) AS n FROM aliases m GROUP BY m.alias").all(), [{ alias: "a", project: "missing-project", n: 1 }]);
  db.close();
});

test("ON DELETE CASCADE works even when the child table is created before its parent", live, () => {
  const db = database();
  db.exec(`CREATE TABLE notes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE);
    CREATE TABLE projects (id TEXT PRIMARY KEY)`);
  db.prepare("INSERT INTO projects VALUES (?)").run("p1");
  db.prepare("INSERT INTO notes VALUES (?, ?)").run("n1", "p1");
  db.prepare("DELETE FROM projects WHERE id = ?").run("p1");
  assert.equal(db.prepare("SELECT count(*) AS n FROM notes").get()!.n, 0);
  db.close();
});

test("json_extract returns a nested value's JSON as it was stored", live, () => {
  const db = database();
  const row = db.prepare("SELECT instr(json_extract(?, '$.summary'), '\"status\":\"queued\"') > 0 AS found").get(JSON.stringify({ summary: { runId: "r", status: "queued" } }));
  assert.equal(row!.found, 1);
  db.close();
});

test("json_extract with several paths returns an array of the values, as SQLite does", live, () => {
  const db = database();
  assert.equal(db.prepare("SELECT json_extract(?, '$.a', '$.b.c', '$.missing') AS v").get('{"a":1,"b":{"c":"x"}}')!.v, '[1,"x",null]');
  assert.equal(db.prepare("SELECT json_extract(json_extract(?, '$.a', '$.b'), '$[1]') AS v").get('{"a":1,"b":"y"}')!.v, "y");
  db.close();
});

test("setReturnArrays returns rows as arrays of their values, as StatementSync does", live, () => {
  const db = database();
  db.exec("CREATE TABLE names (key TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO names VALUES ('a', 'Alpha'), ('b', 'Beta')");
  const statement = db.prepare("SELECT key, name FROM names ORDER BY key");
  (statement as unknown as { setReturnArrays(on: boolean): void }).setReturnArrays(true);
  assert.deepEqual(statement.all(), [["a", "Alpha"], ["b", "Beta"]]);
  db.close();
});

test("json_group_array and json_object give text that json_each and json_extract read back", live, () => {
  const db = database();
  db.exec("CREATE TABLE issues (kind TEXT NOT NULL, rule TEXT NOT NULL); INSERT INTO issues VALUES ('a', 'r1'), ('b', 'r2')");
  const row = db.prepare("SELECT json_group_array(json_object('kind', kind, 'rule', rule)) AS grouped FROM issues").get()!;
  assert.equal(typeof row.grouped, "string");
  assert.deepEqual(JSON.parse(String(row.grouped)).map((item: { kind: string }) => item.kind).sort(), ["a", "b"]);
  const kinds = db.prepare("SELECT json_extract(j.value, '$.kind') AS kind FROM json_each(?) j ORDER BY kind").all(row.grouped);
  assert.deepEqual(kinds, [{ kind: "a" }, { kind: "b" }]);
  db.close();
});

test("answers are kept between writes, and a committed write from any handle ends them", live, async () => {
  const schema = `jb_adapter_${randomUUID().replaceAll("-", "")}`;
  const reader = new PostgresDatabase(url!, schema);
  const writer = new PostgresDatabase(url!, schema);
  reader.exec("CREATE TABLE t (id TEXT PRIMARY KEY)");
  const { untilNextWrite } = await import("../src/sqlite-generation.js");
  let computed = 0;
  const count = () => untilNextWrite(reader as never, "count", () => { computed++; return reader.prepare("SELECT count(*) AS n FROM t").get()!.n; });
  assert.equal(count(), 0);
  assert.equal(count(), 0);
  assert.equal(computed, 1, "kept until a write");
  writer.prepare("INSERT INTO t VALUES (?)").run("x");
  assert.equal(count(), 1, "another handle's write ends it");
  reader.prepare("INSERT INTO t VALUES (?)").run("y");
  assert.equal(count(), 2, "the handle's own write ends it");
  assert.equal(computed, 3);
  writer.exec("BEGIN");
  writer.prepare("INSERT INTO t VALUES (?)").run("z");
  assert.equal(count(), 2, "a write not yet committed is not seen");
  writer.exec("ROLLBACK");
  assert.equal(count(), 2);
  assert.equal(computed, 3, "a rolled-back write changes nothing");
  reader.close();
  writer.close();
});
