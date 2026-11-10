import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { keptAnswers, untilNextWrite } from "../src/sqlite-generation.js";

function fixture(): { db: DatabaseSync; other: DatabaseSync; directory: string; close: () => void } {
  const directory = mkdtempSync(path.join(os.tmpdir(), "jb-generation-"));
  const file = path.join(directory, "node.db");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE things(id TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO things VALUES ('a', 'one');");
  const other = new DatabaseSync(file);
  return { db, other, directory, close: () => { db.close(); other.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function reader(db: DatabaseSync): { read: () => string | undefined; computed: () => number } {
  let count = 0;
  return {
    read: () => untilNextWrite(db, "thing:a", () => { count++; return (db.prepare("SELECT value FROM things WHERE id = 'a'").get() as { value: string } | undefined)?.value; }),
    computed: () => count,
  };
}

test("an answer is computed once between writes and again after one on the same connection", () => {
  const { db, close } = fixture();
  try {
    const { read, computed } = reader(db);
    assert.equal(read(), "one");
    assert.equal(read(), "one");
    assert.equal(computed(), 1);
    db.prepare("UPDATE things SET value = 'two' WHERE id = 'a'").run();
    assert.equal(read(), "two");
    assert.equal(read(), "two");
    assert.equal(computed(), 2);
    // A write to any other table ends the generation too: the helper does not know what an answer read.
    db.exec("CREATE TABLE other(id TEXT)");
    assert.equal(read(), "two");
    assert.equal(computed(), 3, "a change of schema is a write");
    db.prepare("INSERT INTO other VALUES ('x')").run();
    assert.equal(read(), "two");
    assert.equal(computed(), 4);
  } finally { close(); }
});

test("a commit by another connection ends the generation", () => {
  const { db, other, close } = fixture();
  try {
    const { read, computed } = reader(db);
    assert.equal(read(), "one");
    other.prepare("UPDATE things SET value = 'from elsewhere' WHERE id = 'a'").run();
    assert.equal(read(), "from elsewhere");
    assert.equal(computed(), 2);
    other.exec("CREATE TABLE made_elsewhere(id TEXT)");
    assert.equal(read(), "from elsewhere");
    assert.equal(computed(), 3);
  } finally { close(); }
});

test("nothing read inside a transaction is kept, so a rollback leaves no answer behind", () => {
  const { db, close } = fixture();
  try {
    const { read, computed } = reader(db);
    assert.equal(read(), "one");
    db.exec("BEGIN");
    db.prepare("UPDATE things SET value = 'uncommitted' WHERE id = 'a'").run();
    assert.equal(read(), "uncommitted", "a transaction reads its own writes");
    assert.equal(read(), "uncommitted");
    assert.equal(computed(), 3, "each read inside the transaction computes");
    assert.equal(keptAnswers(db), 0);
    db.exec("ROLLBACK");
    assert.equal(read(), "one", "the rolled back value is not served");
    assert.equal(read(), "one");
    assert.equal(computed(), 4);
  } finally { close(); }
});

test("an answer kept before a transaction is still served inside it until the transaction writes", () => {
  const { db, close } = fixture();
  try {
    const { read, computed } = reader(db);
    assert.equal(read(), "one");
    db.exec("BEGIN");
    assert.equal(read(), "one");
    assert.equal(computed(), 1, "no write yet: the kept answer is exact");
    db.prepare("UPDATE things SET value = 'changed' WHERE id = 'a'").run();
    assert.equal(read(), "changed");
    db.exec("COMMIT");
    assert.equal(read(), "changed");
    assert.equal(read(), "changed");
    assert.equal(computed(), 3);
  } finally { close(); }
});

test("a compute that writes is not kept, keys are separate, and a closed database computes", () => {
  const { db, other, directory } = fixture();
  try {
    let writes = 0;
    const writing = () => untilNextWrite(db, "writer", () => { writes++; db.prepare("INSERT OR REPLACE INTO things VALUES ('b', ?)").run(String(writes)); return writes; });
    assert.equal(writing(), 1);
    assert.equal(writing(), 2, "its own write ended the generation it was computed in");
    assert.equal(untilNextWrite(db, "k1", () => "first"), "first");
    assert.equal(untilNextWrite(db, "k2", () => "second"), "second");
    assert.equal(untilNextWrite(db, "k1", () => "never"), "first");
    assert.equal(untilNextWrite(db, "undefined-is-an-answer", () => undefined), undefined);
    assert.equal(untilNextWrite(db, "undefined-is-an-answer", () => "not asked again"), undefined);
    other.close();
    assert.equal(untilNextWrite(other, "k1", () => "after close"), "after close");
    assert.equal(untilNextWrite(other, "k1", () => "computed each time"), "computed each time");
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
