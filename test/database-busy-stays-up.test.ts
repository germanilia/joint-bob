import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { databaseBusy } from "../src/server/error-capture.ts";

// A write that cannot get the lock another process holds must not take the node down.
test("a write refused because another connection holds the write lock is recognised as busy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-db-busy-"));
  const file = path.join(root, "node.db");
  const holder = new DatabaseSync(file), waiter = new DatabaseSync(file);
  try {
    holder.exec("PRAGMA journal_mode=WAL; CREATE TABLE notes(text TEXT)");
    waiter.exec("PRAGMA busy_timeout=0");
    holder.exec("BEGIN IMMEDIATE");
    let refused: unknown;
    try { waiter.prepare("INSERT INTO notes VALUES(?)").run("late"); } catch (error) { refused = error; }
    assert.ok(refused, "the write is refused while the lock is held");
    assert.equal(databaseBusy(refused), true);
    holder.exec("COMMIT");

    let broken: unknown;
    try { waiter.exec("INSERT INTO missing VALUES(1)"); } catch (error) { broken = error; }
    assert.equal(databaseBusy(broken), false, "any other database error still ends the node");
    assert.equal(databaseBusy(new Error("database is locked")), false, "a message alone is not enough");
    assert.equal(databaseBusy(undefined), false);
  } finally { holder.close(); waiter.close(); await rm(root, { recursive: true, force: true }); }
});
