import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensureScriptCounts } from "../src/sqlite-statements.js";
import { counting } from "./perf-statement-counter.js";

/* The statement wrapper runs under every query of the app, tens of thousands of times a second.
   These tests pin what it must keep doing after it was made cheaper: which statement is dropped
   when a connection holds too many, and that a make-sure script is skipped only while the
   schema really is the one it last ran against, whoever changed it. */

const KEPT = 256;
const ENSURE = "CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY, body TEXT);\n CREATE INDEX IF NOT EXISTS notes_body ON notes(body);";

function counted(run: () => void): { ran: number; skipped: number } {
  const before = ensureScriptCounts();
  run();
  const after = ensureScriptCounts();
  return { ran: after.ran - before.ran, skipped: after.skipped - before.skipped };
}

function fileDatabase(t: { after: (cleanup: () => void) => void }): { file: string; db: DatabaseSync } {
  const root = mkdtempSync(path.join(os.tmpdir(), "jb-perf-wrapper-"));
  const file = path.join(root, "node.db");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  t.after(() => { try { db.close(); } catch { /* closed by the test */ } rmSync(root, { recursive: true, force: true }); });
  return { file, db };
}

test("the statement used longest ago is dropped, not the one compiled first", () => {
  const db = new DatabaseSync(":memory:");
  const first = db.prepare("SELECT 0 AS value");
  const second = db.prepare("SELECT 1 AS value");
  for (let index = 2; index < KEPT; index++) db.prepare(`SELECT ${index} AS value`);
  // The connection is full. The oldest statement is used once more, which makes it the newest.
  assert.equal(db.prepare("SELECT 0 AS value"), first);
  db.prepare(`SELECT ${KEPT} AS value`);
  assert.equal(db.prepare("SELECT 0 AS value"), first, "compiled first, used last: it stays");
  assert.notEqual(db.prepare("SELECT 1 AS value"), second, "used longest ago: it was dropped and is compiled again");
  assert.deepEqual({ ...db.prepare("SELECT 1 AS value").get() }, { value: 1 });
  db.close();
});

test("using a statement again and again keeps every other statement of the connection", () => {
  const db = new DatabaseSync(":memory:");
  const kept = Array.from({ length: KEPT }, (_, index) => db.prepare(`SELECT ${index} AS value`));
  for (let use = 0; use < 10_000; use++) assert.equal(db.prepare("SELECT 7 AS value"), kept[7]);
  for (let index = 0; index < KEPT; index++) assert.equal(db.prepare(`SELECT ${index} AS value`), kept[index], `statement ${index} was dropped`);
  db.close();
});

test("a skipped make-sure script asks SQLite for the schema version and nothing else", (t) => {
  const { db } = fileDatabase(t);
  db.exec(ENSURE);
  const skipped = counting(() => counted(() => db.exec(ENSURE)));
  assert.deepEqual(skipped.result, { ran: 0, skipped: 1 });
  assert.deepEqual(skipped.statements, ["PRAGMA schema_version"]);
  const many = counting(() => counted(() => { for (let call = 0; call < 500; call++) db.exec(ENSURE); }));
  assert.deepEqual(many.result, { ran: 0, skipped: 500 });
  assert.equal(many.statements.length, 500, "one question per call: another process may change the schema between any two");
});

test("making sure of a schema never pushes one of the caller's statements out", (t) => {
  const { db } = fileDatabase(t);
  db.exec(ENSURE);
  const kept = Array.from({ length: KEPT }, (_, index) => db.prepare(`SELECT ${index} AS value`));
  assert.deepEqual(counted(() => { for (let call = 0; call < 20; call++) db.exec(ENSURE); }), { ran: 0, skipped: 20 });
  for (let index = 0; index < KEPT; index++) assert.equal(db.prepare(`SELECT ${index} AS value`), kept[index], `statement ${index} was dropped`);
});

test("a make-sure script runs again after the schema changed, however and by whomever", (t) => {
  const { file, db } = fileDatabase(t);
  const other = new DatabaseSync(file);
  t.after(() => other.close());
  const exists = (): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'notes'").get());
  assert.deepEqual(counted(() => db.exec(ENSURE)), { ran: 1, skipped: 0 });
  assert.deepEqual(counted(() => db.exec(ENSURE)), { ran: 0, skipped: 1 });

  db.prepare("DROP TABLE notes").run();
  assert.deepEqual(counted(() => db.exec(ENSURE)), { ran: 1, skipped: 0 }, "dropped through a prepared statement, which the wrapper never sees run");
  assert.equal(exists(), true);

  other.prepare("DROP TABLE notes").run();
  assert.deepEqual(counted(() => db.exec(ENSURE)), { ran: 1, skipped: 0 }, "dropped by another connection");
  assert.equal(exists(), true);

  other.exec("CREATE TABLE elsewhere(id TEXT)");
  assert.deepEqual(counted(() => db.exec(ENSURE)), { ran: 1, skipped: 0 }, "any change of schema makes it run, also one that leaves its own tables alone");
  assert.deepEqual(counted(() => db.exec(ENSURE)), { ran: 0, skipped: 1 });

  // Another process altogether: nothing in this process can know of it but SQLite's own count.
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA busy_timeout = 5000; DROP TABLE notes");
    db.close();
  `, file], { env: { ...process.env, NODE_OPTIONS: "", NODE_NO_WARNINGS: "1" }, stdio: "pipe" });
  assert.deepEqual(counted(() => db.exec(ENSURE)), { ran: 1, skipped: 0 }, "dropped by another process");
  assert.equal(exists(), true);

  db.prepare("INSERT INTO notes(body) VALUES('kept')").run();
  other.prepare("INSERT INTO notes(body) VALUES('also kept')").run();
  assert.deepEqual(counted(() => db.exec(ENSURE)), { ran: 0, skipped: 1 }, "rows written here or elsewhere change no schema");
});

test("a closed and reopened connection makes sure again and then skips again", (t) => {
  const { db } = fileDatabase(t);
  assert.deepEqual(counted(() => { db.exec(ENSURE); db.exec(ENSURE); }), { ran: 1, skipped: 1 });
  db.close();
  db.open();
  assert.deepEqual(counted(() => { db.exec(ENSURE); db.exec(ENSURE); db.exec(ENSURE); }), { ran: 1, skipped: 2 });
  assert.throws(() => { db.close(); db.exec(ENSURE); }, /database is not open/);
  db.open();
});

test("inside a transaction a make-sure script runs every time and is not remembered", (t) => {
  const { db } = fileDatabase(t);
  db.exec(ENSURE);
  db.exec("BEGIN");
  db.exec("DROP TABLE notes");
  const inside = counting(() => counted(() => { db.exec(ENSURE); db.exec(ENSURE); }));
  assert.deepEqual(inside.result, { ran: 0, skipped: 0 }, "not counted as skipped or remembered");
  assert.deepEqual(inside.statements, [], "and no question is asked: it simply runs");
  assert.equal(Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'notes'").get()), true);
  db.exec("ROLLBACK");
  db.exec("DROP TABLE notes");
  assert.deepEqual(counted(() => db.exec(ENSURE)), { ran: 1, skipped: 0 });
});
