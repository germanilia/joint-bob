import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import "../src/sqlite-statements.js";
import {
  addSharingMember, answerIsNotKept, asOneLookup, createSharingCluster, ensureClusterSharingPolicySchema,
  mayReceiveResource, recordRelaySharingHeartbeat, registerOwnedResource, relaySharingGroupActive,
  removeSharingMember, setResourceShares, setTrustedTwin, untilWriteOrLeaseEnd,
} from "../src/cluster-sharing-policy.js";
import { openNodeDatabase } from "../src/node-database.js";

/* The sharing lookups keep their answers until the next write. These tests hold them to that: an
   answer follows every change at once, whichever connection made it; nothing is asked of the
   database in between; and nothing a rolled back transaction showed is served afterwards. */

const OWNER = "00000000-0000-4000-8000-000000000001";
const TWIN = "00000000-0000-4000-8000-000000000002";
const RECEIVER = "00000000-0000-4000-8000-000000000003";
const RELAY = "00000000-0000-4000-8000-000000000009";
const CLUSTER = "10000000-0000-4000-8000-000000000001";

interface Fixture { db: DatabaseSync; other: DatabaseSync }

/** Two connections to one database file, with the owner and a receiver in one cluster and an unshared project "p". */
function fixture(t: TestContext): Fixture {
  const directory = mkdtempSync(path.join(os.tmpdir(), "jb-perf-access-policy-"));
  const file = path.join(directory, "node.db");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON");
  ensureClusterSharingPolicySchema(db);
  createSharingCluster(db, { id: CLUSTER, name: "Cluster" }, OWNER);
  addSharingMember(db, CLUSTER, OWNER, RECEIVER, 1);
  registerOwnedResource(db, { kind: "project", id: "p", ownerNodeId: OWNER }, OWNER);
  const other = new DatabaseSync(file);
  other.exec("PRAGMA foreign_keys = ON");
  t.after(() => { for (const connection of [db, other]) { try { connection.close(); } catch { /* closed by the test */ } } rmSync(directory, { recursive: true, force: true }); });
  return { db, other };
}

/** Counts the queries code runs: every query here is prepared where it runs. */
function queries(t: TestContext, match: (sql: string) => boolean = () => true): { count: () => number; reset: () => void } {
  const prepare = DatabaseSync.prototype.prepare;
  let count = 0;
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) { if (match(sql)) count++; return prepare.call(this, sql); });
  return { count: () => count, reset: () => { count = 0; } };
}

/** Counts how often the write counters are read: one reading asks SQLite for its data version once. */
function counterReadings(t: TestContext): { count: () => number; reset: () => void } {
  const get = StatementSync.prototype.get;
  let count = 0;
  t.mock.method(StatementSync.prototype, "get", function (this: StatementSync, ...parameters: unknown[]) {
    if (this.sourceSQL === "PRAGMA data_version") count++;
    return Reflect.apply(get, this, parameters);
  });
  return { count: () => count, reset: () => { count = 0; } };
}

const share = (db: DatabaseSync, shared: boolean): void => setResourceShares(db, OWNER, "project", "p", shared ? [{ clusterId: CLUSTER, projectId: null }] : []);
const receives = (db: DatabaseSync, node = RECEIVER): boolean => mayReceiveResource(db, node, "project", "p");

test("mayReceiveResource asks the database once between writes", (t) => {
  const { db } = fixture(t);
  assert.equal(receives(db), false);
  const asked = queries(t);
  for (let i = 0; i < 50; i++) assert.equal(receives(db), false);
  assert.equal(asked.count(), 0, "a kept answer runs no query");
  share(db, true);
  asked.reset();
  assert.equal(receives(db), true);
  assert.ok(asked.count() > 0, "the first call after a write asks again");
  asked.reset();
  for (let i = 0; i < 50; i++) assert.equal(receives(db), true);
  assert.equal(asked.count(), 0);
});

test("mayReceiveResource follows a change at once, on this connection and on another", (t) => {
  const { db, other } = fixture(t);
  assert.equal(receives(db), false);
  share(db, true);
  assert.equal(receives(db), true, "shared through the same connection");
  share(other, false);
  assert.equal(receives(db), false, "unshared through another connection");
  share(other, true);
  assert.equal(receives(db), true);
  removeSharingMember(other, CLUSTER, OWNER, RECEIVER);
  assert.equal(receives(db), false, "the receiver left the cluster");
  assert.equal(receives(db, OWNER), true, "the owner always holds its own project");

  assert.equal(receives(db, TWIN), false);
  setTrustedTwin(other, OWNER, TWIN, true);
  assert.equal(receives(db, TWIN), true, "a twin made through another connection");
  setTrustedTwin(db, OWNER, TWIN, false);
  assert.equal(receives(db, TWIN), false, "and unmade through this one");
});

test("mayReceiveResource still validates its arguments and never keeps a failure", (t) => {
  const { db, other } = fixture(t);
  assert.throws(() => mayReceiveResource(db, "not-a-node", "project", "p"), /Recipient node ID must be a valid UUID/);
  assert.throws(() => mayReceiveResource(db, RECEIVER, "project", " p"), /Resource ID must be nonblank/);
  assert.throws(() => mayReceiveResource(db, RECEIVER, "project", "p", ""), /Resource ID must be nonblank/);
  assert.throws(() => mayReceiveResource(db, RECEIVER, "project", "unknown"), /Unknown project resource: unknown/);
  assert.throws(() => mayReceiveResource(db, RECEIVER, "project", "unknown"), /Unknown project resource: unknown/, "asked again, it fails again");
  registerOwnedResource(other, { kind: "project", id: "unknown", ownerNodeId: OWNER }, OWNER);
  assert.equal(mayReceiveResource(db, RECEIVER, "project", "unknown"), false, "known now");
  // A secret's answer depends on the project it is asked for, so that is part of what the answer is kept under.
  const secret = "20000000-0000-4000-8000-000000000001";
  registerOwnedResource(db, { kind: "secret", id: secret, ownerNodeId: OWNER }, OWNER);
  share(db, true);
  setResourceShares(db, OWNER, "secret", secret, [{ clusterId: CLUSTER, projectId: "p" }]);
  assert.equal(mayReceiveResource(db, RECEIVER, "secret", secret, "p"), true);
  assert.equal(mayReceiveResource(db, RECEIVER, "secret", secret), false, "without the project the scoped share does not apply");
  assert.equal(mayReceiveResource(db, RECEIVER, "secret", secret, "q"), false);
  assert.equal(mayReceiveResource(db, RECEIVER, "secret", secret, "p"), true);
});

test("what a transaction showed is not served after it is rolled back", (t) => {
  const { db } = fixture(t);
  assert.equal(receives(db), false);
  db.exec("BEGIN");
  assert.equal(receives(db), false, "kept before the transaction, and nothing was written yet");
  share(db, true);
  assert.equal(receives(db), true, "a transaction reads its own writes");
  assert.equal(receives(db), true);
  db.exec("ROLLBACK");
  assert.equal(receives(db), false, "the rolled back share is not served");
  assert.equal(receives(db), false);

  // The same for a committed transaction, and for one that only read.
  db.exec("BEGIN"); share(db, true); assert.equal(receives(db), true); db.exec("COMMIT");
  assert.equal(receives(db), true);
  db.exec("BEGIN"); assert.equal(receives(db), true); db.exec("ROLLBACK");
  assert.equal(receives(db), true);
});

test("a table made inside a rolled back transaction is not remembered", (t) => {
  const { db } = fixture(t);
  setTrustedTwin(db, OWNER, TWIN, true);
  assert.equal(receives(db, TWIN), true, "no accounts on this node: the twin receives everything of the owner");
  db.exec("BEGIN");
  db.exec("CREATE TABLE cluster_node(singleton INTEGER PRIMARY KEY, id TEXT NOT NULL); CREATE TABLE resource_account_owners(kind TEXT NOT NULL, resource_id TEXT NOT NULL, account_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(kind, resource_id))");
  db.prepare("INSERT INTO cluster_node VALUES(1, ?)").run(OWNER);
  db.prepare("INSERT INTO resource_account_owners VALUES('project', 'p', 'a-member', 'now')").run();
  assert.equal(receives(db, TWIN), false, "a member's project does not go to the admin's twin");
  db.exec("ROLLBACK");
  assert.equal(receives(db, TWIN), true, "the tables are gone again, and so is the answer read from them");
  // Made for good, the tables are found, and a row changes the answer at once.
  db.exec("CREATE TABLE cluster_node(singleton INTEGER PRIMARY KEY, id TEXT NOT NULL); CREATE TABLE resource_account_owners(kind TEXT NOT NULL, resource_id TEXT NOT NULL, account_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(kind, resource_id))");
  db.prepare("INSERT INTO cluster_node VALUES(1, ?)").run(OWNER);
  assert.equal(receives(db, TWIN), true);
  db.prepare("INSERT INTO resource_account_owners VALUES('project', 'p', 'a-member', 'now')").run();
  assert.equal(receives(db, TWIN), false);
  db.prepare("DELETE FROM resource_account_owners").run();
  const lookedFor = queries(t, (sql) => sql.includes("sqlite_master"));
  assert.equal(receives(db, TWIN), true);
  assert.equal(lookedFor.count(), 0, "tables that were found are not looked for again");
});

/** Makes the cluster a relay's sharing group: shares in it count only while this process holds the relay's lease. */
function behindRelay(db: DatabaseSync): void {
  db.exec("CREATE TABLE cluster_v2_identity(singleton INTEGER PRIMARY KEY, node_id TEXT NOT NULL); CREATE TABLE relay_memberships(relay_node_id TEXT, status TEXT NOT NULL)");
  db.prepare("INSERT INTO cluster_v2_identity VALUES(1, ?)").run(OWNER);
  db.prepare("INSERT INTO relay_memberships VALUES(?, 'admitted')").run(RELAY);
  db.prepare("INSERT INTO relay_sharing_groups VALUES(?, ?)").run(RELAY, CLUSTER);
  share(db, true);
}

test("an answer that rests on a relay lease ends with the lease, with no write", (t) => {
  const { db } = fixture(t);
  behindRelay(db);
  const start = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ["Date"], now: start });
  assert.equal(receives(db), false, "no lease yet");
  recordRelaySharingHeartbeat(db, RELAY, true);
  assert.equal(receives(db), true, "the heartbeat is a write");
  const asked = queries(t);
  t.mock.timers.tick(89_999);
  for (let i = 0; i < 20; i++) assert.equal(receives(db), true);
  assert.equal(asked.count(), 0, "kept while the lease lasts");
  t.mock.timers.tick(1);
  assert.equal(receives(db), false, "the lease ran out; nothing was written");
  assert.equal(receives(db), false);
  t.mock.timers.setTime(start + 10);
  assert.equal(receives(db), true, "the clock was set back to when the lease was live");
  t.mock.timers.setTime(start + 200_000);
  assert.equal(receives(db), false);
  recordRelaySharingHeartbeat(db, RELAY, true);
  assert.equal(receives(db), true, "a new heartbeat renews it");
  recordRelaySharingHeartbeat(db, RELAY, false);
  assert.equal(receives(db), false, "a disconnect ends it at once");
});

test("a lookup built on another ends with the lease the other read", (t) => {
  const { db } = fixture(t);
  behindRelay(db);
  const start = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ["Date"], now: start });
  recordRelaySharingHeartbeat(db, RELAY, true);
  let computed = 0;
  const both = (): boolean => untilWriteOrLeaseEnd(db, "test.both", ["p"], () => { computed++; return receives(db, OWNER) && receives(db); });
  assert.equal(receives(db), true, "the inner answer is kept first");
  assert.equal(both(), true, "the outer one is built on the kept inner answer");
  assert.equal(both(), true);
  assert.equal(computed, 1);
  t.mock.timers.tick(90_000);
  assert.equal(both(), false, "the outer answer does not outlive the lease its inner answer read");
  assert.equal(computed, 2);
  // The same when the inner answer is worked out while the outer one is: the heartbeat's write ended both.
  recordRelaySharingHeartbeat(db, RELAY, true);
  assert.equal(both(), true);
  assert.equal(computed, 3);
  t.mock.timers.tick(90_000);
  assert.equal(both(), false, "the outer answer took over the span of the lease read beneath it");
  // Grouped lookups keep nothing of their own, and what they ask still follows the clock.
  recordRelaySharingHeartbeat(db, RELAY, true);
  assert.equal(asOneLookup(db, () => receives(db)), true);
  t.mock.timers.tick(90_000);
  assert.equal(asOneLookup(db, () => receives(db)), false);
});

test("a caller that names its own time is answered for that time only", (t) => {
  const { db } = fixture(t);
  behindRelay(db);
  const start = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ["Date"], now: start });
  recordRelaySharingHeartbeat(db, RELAY, true);
  // The wall clock stands in the middle of the lease; the caller asks about a moment before it and one after.
  t.mock.timers.tick(50_000);
  let computed = 0;
  const at = (now: number): boolean => untilWriteOrLeaseEnd(db, "test.at", [CLUSTER], () => { computed++; return relaySharingGroupActive(db, CLUSTER, now); });
  assert.equal(at(start + 1), true);
  assert.equal(at(start + 95_000), false, "not the answer kept for another time");
  assert.equal(at(start + 1), true);
  assert.equal(computed, 3);
  assert.equal(relaySharingGroupActive(db, CLUSTER), true);
  assert.equal(relaySharingGroupActive(db, CLUSTER, start + 95_000), false);
});

test("kept answers: what they are kept under, and what is never kept", (t) => {
  const { db, other } = fixture(t);
  let computed = 0;
  const ask = (name: string, ids: readonly unknown[], answer?: unknown): unknown => untilWriteOrLeaseEnd(db, name, ids, () => { computed++; return answer; });
  assert.equal(ask("test.keys", ["a", "bc"], 1), 1);
  assert.equal(ask("test.keys", ["ab", "c"], 2), 2, "ids are kept apart whatever they hold");
  assert.equal(ask("test.keys", ["a\x002\x00bc"], 3), 3, "even when one holds what stands between ids");
  assert.equal(ask("test.keys", ["a", "bc"], 4), 1);
  assert.equal(ask("test.other", ["a", "bc"], 5), 5, "and so are functions");
  assert.equal(ask("test.keys", [], undefined), undefined, "undefined is an answer");
  assert.equal(ask("test.keys", [], "not asked again"), undefined);
  assert.equal(computed, 5);

  computed = 0;
  for (const ids of [[undefined], [null], [7], ["a", undefined]]) { ask("test.not-text", ids); ask("test.not-text", ids); }
  assert.equal(computed, 8, "an id that is not text is answered as before, by computing");
  const long = "x".repeat(2000);
  ask("test.long", [long]); ask("test.long", [long]);
  assert.equal(computed, 10, "an id far longer than any real one is not kept");

  computed = 0;
  const failing = (): unknown => untilWriteOrLeaseEnd(db, "test.fails", [], () => { computed++; throw new Error("no"); });
  assert.throws(failing, /no/);
  assert.throws(failing, /no/);
  assert.equal(computed, 2, "a failure is not kept");

  computed = 0;
  const elsewhere = (): unknown => untilWriteOrLeaseEnd(db, "test.elsewhere", [], () => { computed++; answerIsNotKept(); return 1; });
  const onElsewhere = (): unknown => untilWriteOrLeaseEnd(db, "test.on-elsewhere", [], () => { computed++; return elsewhere(); });
  onElsewhere(); onElsewhere();
  assert.equal(computed, 4, "an answer read from outside the database is computed every time, and so is one built on it");

  computed = 0;
  const onOther = (): unknown => untilWriteOrLeaseEnd(db, "test.on-other-connection", [], () => { computed++; return untilWriteOrLeaseEnd(other, "test.inner", [], () => 1); });
  onOther(); onOther();
  assert.equal(computed, 2, "an answer built on another connection's is not kept: this connection's counters do not see that one's open transaction");

  computed = 0;
  db.exec("CREATE TABLE notes(id INTEGER PRIMARY KEY, text TEXT)");
  const writing = (): unknown => untilWriteOrLeaseEnd(db, "test.writes", [], () => { computed++; db.prepare("INSERT INTO notes(text) VALUES('x')").run(); return computed; });
  assert.equal(writing(), 1);
  assert.equal(writing(), 2, "an answer computed while the counters moved is gone with the next reading of them");

  // A rollback puts the schema counter back where it was. An answer read from a table that the rollback takes away must not stay.
  let make = true;
  const madeInside = (): boolean => untilWriteOrLeaseEnd(db, "test.made-inside", [], () => {
    if (make) db.exec("CREATE TABLE made_inside(id TEXT)");
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name='made_inside'").get());
  });
  untilWriteOrLeaseEnd(db, "test.before", [], () => "kept before the transaction");
  db.exec("BEGIN");
  assert.equal(madeInside(), true);
  db.exec("ROLLBACK");
  make = false;
  assert.equal(madeInside(), false, "nothing is kept inside a transaction");
});

test("grouped lookups read the write counters once and still follow every write", (t) => {
  const { db, other } = fixture(t);
  const readings = counterReadings(t);
  let computed = 0;
  const ask = (id: string): string => untilWriteOrLeaseEnd(db, "test.grouped", [id], () => { computed++; return id; });
  ask("first");
  readings.reset();
  ask("a"); ask("b"); ask("c");
  assert.equal(readings.count(), 3, "asked one by one, each reads the counters");
  readings.reset();
  assert.deepEqual(asOneLookup(db, () => [ask("a"), ask("b"), ask("c"), ask("d")]), ["a", "b", "c", "d"]);
  assert.equal(readings.count(), 1, "asked as one lookup, they read them once");
  assert.equal(computed, 5, "and are answered from what was kept");
  readings.reset();
  const nested = (): string => untilWriteOrLeaseEnd(db, "test.outer", [], () => ["a", "b", "c", "d"].map(ask).join(""));
  assert.equal(nested(), "abcd");
  assert.equal(readings.count(), 1, "a lookup that asks others reads them once for all");
  assert.equal(computed, 5);
  other.exec("CREATE TABLE made_elsewhere(id TEXT)");
  assert.equal(nested(), "abcd");
  assert.equal(computed, 9, "a write ends every kept answer, the inner ones too");

  // Inside a transaction nothing new is kept, grouped or not.
  db.exec("CREATE TABLE notes(id INTEGER PRIMARY KEY, text TEXT)");
  const noted = (): number => untilWriteOrLeaseEnd(db, "test.noted", [], () => (db.prepare("SELECT COUNT(*) total FROM notes").get() as { total: number }).total);
  assert.equal(noted(), 0);
  db.exec("BEGIN");
  db.prepare("INSERT INTO notes(text) VALUES('x')").run();
  assert.equal(asOneLookup(db, () => noted() + noted()), 2);
  assert.equal(noted(), 1);
  db.exec("ROLLBACK");
  assert.equal(noted(), 0, "the rolled back row is not counted");
  assert.equal(asOneLookup(db, () => noted()), 0);
});

test("the policy schema is made sure of once per connection, and again after a rollback took it away", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "jb-perf-access-schema-"));
  const db = openNodeDatabase(path.join(directory, "node.db"));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const tables = (): number => (db.prepare("SELECT COUNT(*) total FROM sqlite_master WHERE type='table' AND name LIKE 'sharing_%'").get() as { total: number }).total;
  // A table from before shares could name their nodes gains the column on the first call.
  db.exec("CREATE TABLE sharing_clusters(id TEXT PRIMARY KEY, name TEXT NOT NULL, original_node_id TEXT NOT NULL, manager_node_id TEXT, manager_epoch INTEGER NOT NULL, next_join_sequence INTEGER NOT NULL, closed INTEGER NOT NULL)");
  db.exec("CREATE TABLE sharing_resource_owners(kind TEXT NOT NULL, resource_id TEXT NOT NULL, owner_node_id TEXT NOT NULL, project_id TEXT, PRIMARY KEY(kind,resource_id))");
  db.exec("CREATE TABLE sharing_resource_shares(kind TEXT NOT NULL, resource_id TEXT NOT NULL, cluster_id TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT '', PRIMARY KEY(kind,resource_id,cluster_id,project_id))");
  db.exec("BEGIN");
  ensureClusterSharingPolicySchema(db);
  assert.ok(tables() >= 7);
  db.exec("ROLLBACK");
  assert.equal(tables(), 3, "the rollback took the new tables away");
  ensureClusterSharingPolicySchema(db);
  assert.ok(tables() >= 7, "made sure of again: a call inside a transaction is not remembered");
  assert.ok((db.prepare("PRAGMA table_info(sharing_resource_shares)").all() as Array<{ name: string }>).some((column) => column.name === "node_ids"));
  const asked = queries(t);
  const exec = t.mock.method(DatabaseSync.prototype, "exec");
  for (let i = 0; i < 20; i++) ensureClusterSharingPolicySchema(db);
  assert.equal(asked.count() + exec.mock.callCount(), 0, "once made sure of, the connection is not asked again");
});
