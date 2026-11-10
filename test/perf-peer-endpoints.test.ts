import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensurePeerEndpointSchema, peerEndpoint, recordPeerEndpoint, recordSignedPeerSeen } from "../src/cluster-peer-endpoints.js";
import { counting } from "./perf-statement-counter.js";

/* ensurePeerEndpointSchema is asked before nearly every read of a peer. Its script ends with a
   backfill that writes, so nothing could skip it and all of it ran on every call. A connection
   now runs it once. These tests pin that, and that the backfill still reaches a database from
   before the activity table existed. */

function database(t: { after: (cleanup: () => void) => void }): { file: string; open: () => DatabaseSync } {
  const directory = mkdtempSync(path.join(os.tmpdir(), "jb-perf-peer-endpoints-"));
  const file = path.join(directory, "node.db");
  const opened: DatabaseSync[] = [];
  t.after(() => {
    for (const db of opened) { try { db.close(); } catch { /* closed by the test */ } }
    rmSync(directory, { recursive: true, force: true });
  });
  return { file, open: () => { const db = new DatabaseSync(file); db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 0"); opened.push(db); return db; } };
}

/** Runs `work` and reports every script given to a connection's `exec`. */
function scriptsRun<T>(work: () => T): { result: T; scripts: string[] } {
  const original = DatabaseSync.prototype.exec;
  const scripts: string[] = [];
  DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string): void { scripts.push(sql); original.call(this, sql); };
  try {
    const result = work();
    return { result, scripts };
  } finally { DatabaseSync.prototype.exec = original; }
}

const tables = (db: DatabaseSync): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cluster_v2_peer_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
const activity = (db: DatabaseSync, nodeId: string) => db.prepare("SELECT created_at, updated_at, last_seen_at FROM cluster_v2_peer_activity WHERE node_id = ?").get(nodeId) as { created_at: string; updated_at: string; last_seen_at: string | null } | undefined;

test("a connection runs the peer endpoint script once: a second call runs no statement and takes no write lock", (t) => {
  const { open } = database(t);
  const db = open();
  const first = scriptsRun(() => ensurePeerEndpointSchema(db));
  assert.equal(first.scripts.length, 1);
  assert.match(first.scripts[0], /INSERT OR IGNORE INTO cluster_v2_peer_activity/);
  assert.deepEqual(tables(db), ["cluster_v2_peer_activity", "cluster_v2_peer_endpoints"]);

  const again = scriptsRun(() => counting(() => { for (let call = 0; call < 100; call++) ensurePeerEndpointSchema(db); }));
  assert.deepEqual(again.scripts, []);
  assert.deepEqual(again.result.statements, []);

  // Someone else holds the write lock. The connection that already made sure does not wait for it;
  // one that has not made sure yet needs it for the backfill, and is not counted as done when it fails.
  const holder = open(), fresh = open();
  holder.exec("BEGIN IMMEDIATE");
  try {
    ensurePeerEndpointSchema(db);
    assert.throws(() => ensurePeerEndpointSchema(fresh), /database is locked/);
  } finally { holder.exec("ROLLBACK"); }
  assert.equal(scriptsRun(() => ensurePeerEndpointSchema(fresh)).scripts.length, 1, "it runs once the lock is free");
  assert.equal(scriptsRun(() => ensurePeerEndpointSchema(fresh)).scripts.length, 0);
});

test("a fresh connection to an old database still gets the backfill", (t) => {
  const { open } = database(t);
  // As a release from before the activity table left it: endpoints, and nothing known about when they were seen.
  const old = open();
  old.exec(`CREATE TABLE cluster_v2_peer_endpoints(
    context_kind TEXT NOT NULL CHECK(context_kind IN ('cluster','twin')),
    context_id TEXT NOT NULL,node_id TEXT NOT NULL,name TEXT NOT NULL,url TEXT NOT NULL,
    PRIMARY KEY(context_kind,context_id,node_id));
    INSERT INTO cluster_v2_peer_endpoints VALUES ('twin','context-1','node-1','One','https://one.example'),
      ('cluster','context-2','node-1','One','https://one.example'), ('cluster','context-2','node-2','Two','https://two.example');`);
  old.close();

  const db = open();
  assert.deepEqual(tables(db), ["cluster_v2_peer_endpoints"]);
  ensurePeerEndpointSchema(db);
  const filled = db.prepare("SELECT node_id, created_at, updated_at, last_seen_at FROM cluster_v2_peer_activity ORDER BY node_id").all().map((row) => ({ ...row })) as Array<{ node_id: string; created_at: string; updated_at: string; last_seen_at: string | null }>;
  assert.deepEqual(filled.map((row) => [row.node_id, row.last_seen_at]), [["node-1", null], ["node-2", null]], "one activity row for each endpoint's node");
  assert.ok(filled.every((row) => /^\d{4}-\d{2}-\d{2}T/.test(row.created_at) && row.updated_at === row.created_at));

  // From here on an endpoint gets its activity row when it is recorded: no backfill is needed for it.
  const context = { kind: "cluster" as const, id: randomUUID() }, nodeId = randomUUID();
  const recorded = scriptsRun(() => recordPeerEndpoint(db, context, { nodeId, name: "Three", url: "https://three.example" }));
  assert.deepEqual(recorded.scripts, []);
  assert.notEqual(activity(db, nodeId), undefined);
  assert.deepEqual({ ...peerEndpoint(db, "cluster", context.id, nodeId) }, { nodeId, name: "Three", url: "https://three.example" });
  recordSignedPeerSeen(db, nodeId, "2026-11-10T00:00:00.000Z");
  assert.equal(activity(db, nodeId)?.last_seen_at, "2026-11-10T00:00:00.000Z");

  // A row put in without its activity row (nothing in the app does this) waits for the next connection's first call.
  db.prepare("INSERT INTO cluster_v2_peer_endpoints VALUES ('twin','context-3','node-4','Four','https://four.example')").run();
  ensurePeerEndpointSchema(db);
  assert.equal(activity(db, "node-4"), undefined);
  const next = open();
  ensurePeerEndpointSchema(next);
  assert.notEqual(activity(next, "node-4"), undefined);
  assert.deepEqual({ ...activity(next, "node-1") }, { created_at: filled[0].created_at, updated_at: filled[0].updated_at, last_seen_at: null }, "rows already there are left as they are");
});

test("tables made inside a transaction that is rolled back are made again by the next call", (t) => {
  const { open } = database(t);
  const db = open();
  db.exec("BEGIN");
  ensurePeerEndpointSchema(db);
  assert.equal(tables(db).length, 2);
  db.exec("ROLLBACK");
  assert.deepEqual(tables(db), []);
  assert.equal(scriptsRun(() => ensurePeerEndpointSchema(db)).scripts.length, 1, "not remembered from inside the transaction");
  assert.equal(tables(db).length, 2);
  assert.equal(scriptsRun(() => ensurePeerEndpointSchema(db)).scripts.length, 0);
});
