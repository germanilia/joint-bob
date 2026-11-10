import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import test from "node:test";
import { claimReviewNotifications, ensureConversationReviewReplicaSchema, markConversationReviewed, setConversationReviewNotifications, syncConversationReviewDetails } from "../src/conversation-reviews.js";
import { resolveDataDirectory } from "../src/data-directory.js";
import { counting } from "./perf-statement-counter.js";

/* syncConversationReviewDetails runs for every listing. It used to take the write lock and write
   every listed row again, changed or not. It now reads first and opens a write transaction only
   when a row would change. These tests hold it to both halves: nothing is written, and no write
   lock is taken, when nothing differs; and what it writes and returns is exactly what the old
   version wrote and returned. */

const databaseFile = path.join(resolveDataDirectory(), "node.db");
type Session = Parameters<typeof syncConversationReviewDetails>[3][number];
const session = (name: string, updatedAt: string | undefined, running = false): Session => ({ path: `pi:${name}`, engine: "pi", sessionId: name, updatedAt, running });

/** Runs `work` and reports each script the review connection was given (BEGIN, COMMIT, …), with the connection itself. */
function watchingTransactions<T>(work: () => T): { result: T; scripts: string[]; connection: DatabaseSync | undefined } {
  const original = DatabaseSync.prototype.exec;
  const scripts: string[] = [];
  let connection: DatabaseSync | undefined;
  DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string): void {
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) { scripts.push(sql); connection = this; }
    original.call(this, sql);
  };
  try {
    const result = work();
    return { result, scripts, connection };
  } finally { DatabaseSync.prototype.exec = original; }
}

const writes = (statements: string[]): string[] => statements.filter((sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)).map((sql) => sql.trim().split(/\s+/).slice(0, 3).join(" "));

// Opens every connection a listing uses, so that the tests below see only what a listing itself does.
syncConversationReviewDetails("perf-review-warm", "warm", "perf-review-warm-project", [session("warm", "2026-01-01T00:00:00.000Z")]);

test("a listing that changes nothing writes nothing and takes no write lock", (t) => {
  const user = "perf-review-quiet", project = "perf-review-quiet-project";
  const listed = [session("a", "2026-01-01T00:00:00.000Z"), session("b", "2026-01-02T00:00:00.000Z"), session("c", "2026-01-03T00:00:00.000Z", true)];
  const first = watchingTransactions(() => syncConversationReviewDetails(user, "quiet", project, listed));
  assert.deepEqual(first.scripts, ["BEGIN", "COMMIT", "BEGIN IMMEDIATE", "COMMIT"], "the first listing has rows to write");
  const reviews = first.connection!;
  const totalChanges = (): number => Number((reviews.prepare("SELECT total_changes() AS changes").get() as { changes: number }).changes);
  const other = new DatabaseSync(databaseFile);
  t.after(() => other.close());
  const dataVersion = (): number => Number((other.prepare("PRAGMA data_version").get() as { data_version: number }).data_version);

  const changesBefore = totalChanges(), versionBefore = dataVersion();
  const again = watchingTransactions(() => counting(() => syncConversationReviewDetails(user, "quiet", project, listed)));
  assert.deepEqual(again.scripts, ["BEGIN", "COMMIT"], "a read transaction and no write transaction");
  assert.deepEqual(writes(again.result.statements), []);
  assert.deepEqual([...again.result.result], [...first.result], "and the listing gets the same answer");
  assert.equal(totalChanges(), changesBefore, "total_changes() stands still");
  assert.equal(dataVersion(), versionBefore, "another connection sees no commit");

  // Someone else holds the write lock. A listing that has nothing to write does not wait for it.
  other.exec("BEGIN IMMEDIATE");
  try {
    reviews.exec("PRAGMA busy_timeout = 0");
    assert.deepEqual([...syncConversationReviewDetails(user, "quiet", project, listed)], [...first.result]);
    assert.throws(() => syncConversationReviewDetails(user, "quiet", project, [...listed, session("new", "2026-01-04T00:00:00.000Z")]), /database is locked/, "one that has something to write still needs it");
  } finally {
    reviews.exec("PRAGMA busy_timeout = 5000");
    other.exec("ROLLBACK");
  }
  assert.equal(totalChanges(), changesBefore);
});

test("a changed value is written once, and the same listing again writes nothing", (t) => {
  const user = "perf-review-changes", project = "perf-review-changes-project";
  const other = new DatabaseSync(databaseFile);
  t.after(() => other.close());
  const row = (name: string) => ({ ...other.prepare("SELECT last_activity_at, reviewed_at, was_running, notified FROM conversation_review_states WHERE user_id = ? AND project_id = ? AND session_path = ?").get(user, project, `pi:${name}`) });
  const run = (listed: Session[]) => {
    const watched = watchingTransactions(() => counting(() => syncConversationReviewDetails(user, "changes", project, listed)));
    return { states: Object.fromEntries([...watched.result.result].map(([sessionPath, details]) => [sessionPath, details.state])), written: writes(watched.result.statements), scripts: watched.scripts };
  };
  const quiet = { written: [], scripts: ["BEGIN", "COMMIT"] };
  const three = (b: Session) => [session("a", "2026-01-01T00:00:00.000Z"), b, session("c", "2026-01-03T00:00:00.000Z")];

  assert.deepEqual(run(three(session("b", "2026-01-02T00:00:00.000Z"))).written, ["INSERT INTO conversation_review_tracking", "INSERT INTO conversation_review_states", "INSERT INTO conversation_review_states", "INSERT INTO conversation_review_states"]);

  // New activity in one conversation: its row and no other.
  const moved = run(three(session("b", "2026-01-05T00:00:00.000Z")));
  assert.deepEqual(moved.written, ["UPDATE conversation_review_states SET"]);
  assert.deepEqual(moved.scripts, ["BEGIN", "COMMIT", "BEGIN IMMEDIATE", "COMMIT"]);
  assert.deepEqual(moved.states, { "pi:a": "reviewed", "pi:b": "needs_review", "pi:c": "reviewed" });
  assert.equal(row("b").last_activity_at, "2026-01-05T00:00:00.000Z");
  const same = run(three(session("b", "2026-01-05T00:00:00.000Z")));
  assert.deepEqual({ written: same.written, scripts: same.scripts }, quiet);
  assert.deepEqual(same.states, moved.states);

  // It starts running, keeps running, stops.
  assert.deepEqual(run(three(session("b", "2026-01-05T00:00:00.000Z", true))).written, ["UPDATE conversation_review_states SET"]);
  assert.equal(row("b").was_running, 1);
  const running = run(three(session("b", "2026-01-05T00:00:00.000Z", true)));
  assert.deepEqual({ written: running.written, scripts: running.scripts }, quiet);
  assert.equal(running.states["pi:b"], "running");
  assert.deepEqual(run(three(session("b", "2026-01-05T00:00:00.000Z"))).written, ["UPDATE conversation_review_states SET"]);
  assert.equal(row("b").was_running, 0);

  // A notification was sent for it. While it is not running the mark stays.
  setConversationReviewNotifications(user, project, "pi:b", true);
  assert.deepEqual(claimReviewNotifications(user, project, ["pi:b"]), ["pi:b"]);
  assert.equal(row("b").notified, 1);
  assert.deepEqual(run(three(session("b", "2026-01-05T00:00:00.000Z"))).written, [], "the mark is left alone");
  assert.equal(row("b").notified, 1);
  // Once it runs again the mark is cleared.
  assert.deepEqual(run(three(session("b", "2026-01-05T00:00:00.000Z", true))).written, ["UPDATE conversation_review_states SET"]);
  assert.equal(row("b").notified, 0);
  // Marked again while it keeps running: nothing else differs, and the mark alone is written away, once.
  assert.deepEqual(claimReviewNotifications(user, project, ["pi:b"]), ["pi:b"]);
  assert.equal(row("b").notified, 1);
  assert.deepEqual(run(three(session("b", "2026-01-05T00:00:00.000Z", true))).written, ["UPDATE conversation_review_states SET"]);
  assert.deepEqual([row("b").was_running, row("b").notified], [1, 0]);
  assert.deepEqual(run(three(session("b", "2026-01-05T00:00:00.000Z", true))).written, []);
  assert.deepEqual(run(three(session("b", "2026-01-05T00:00:00.000Z"))).written, ["UPDATE conversation_review_states SET"]);
  assert.deepEqual(claimReviewNotifications(user, project, ["pi:b"]), ["pi:b"], "so the next cycle notifies again");

  // Reviewed on another node: the watermark moves this row once.
  ensureConversationReviewReplicaSchema(other);
  other.prepare("INSERT INTO replicated_review_watermarks (username, project_id, engine, session_id, reviewed_at, origin_node_id) VALUES ('changes', ?, 'pi', 'b', '2026-01-06T00:00:00.000Z', 'elsewhere')").run(project);
  const reviewed = run(three(session("b", "2026-01-05T00:00:00.000Z")));
  assert.deepEqual(reviewed.written, ["UPDATE conversation_review_states SET"]);
  assert.equal(reviewed.states["pi:b"], "reviewed");
  assert.deepEqual({ ...row("b") }, { last_activity_at: "2026-01-05T00:00:00.000Z", reviewed_at: "2026-01-06T00:00:00.000Z", was_running: 0, notified: 0 });
  assert.deepEqual(run(three(session("b", "2026-01-05T00:00:00.000Z"))).written, []);

  // A conversation appears: one row is added, the others are not touched.
  assert.deepEqual(run([...three(session("b", "2026-01-05T00:00:00.000Z")), session("d", "2026-01-07T00:00:00.000Z")]).written, ["INSERT INTO conversation_review_states"]);
});

test("a project whose rows exist but which was never listed is still set up on its first listing", (t) => {
  const user = "perf-review-marked", project = "perf-review-marked-project";
  const other = new DatabaseSync(databaseFile);
  t.after(() => other.close());
  const tracked = () => other.prepare("SELECT 1 FROM conversation_review_tracking WHERE user_id = ? AND project_id = ?").get(user, project) !== undefined;
  // Marked reviewed before any listing: the row exists and already holds what the listing would write.
  markConversationReviewed(user, "marked", project, { path: "pi:a", engine: "pi", sessionId: "a", updatedAt: "2026-01-01T00:00:00.000Z" }, "node-a");
  assert.equal(tracked(), false);
  const first = counting(() => syncConversationReviewDetails(user, "marked", project, [session("a", "2026-01-01T00:00:00.000Z")]));
  assert.deepEqual(writes(first.statements), ["INSERT INTO conversation_review_tracking"]);
  assert.equal(tracked(), true);
  assert.deepEqual(writes(counting(() => syncConversationReviewDetails(user, "marked", project, [session("a", "2026-01-01T00:00:00.000Z")])).statements), []);
  // An empty listing of a project nobody listed before does the same, once.
  assert.deepEqual(writes(counting(() => syncConversationReviewDetails(user, "marked", "perf-review-empty-project", [])).statements), ["INSERT INTO conversation_review_tracking"]);
  assert.deepEqual(writes(counting(() => syncConversationReviewDetails(user, "marked", "perf-review-empty-project", [])).statements), []);
});

test("another connection writing while a listing reads does not fail the listing, and what it wrote counts", (t) => {
  const user = "perf-review-race", project = "perf-review-race-project";
  const listed = (updatedAt: string) => [session("a", updatedAt)];
  syncConversationReviewDetails(user, "race", project, listed("2026-01-01T00:00:00.000Z"));
  const other = new DatabaseSync(databaseFile);
  t.after(() => other.close());
  other.exec("PRAGMA busy_timeout = 0");
  const statementPrototype = Object.getPrototypeOf(other.prepare("SELECT 1")) as object;
  const original = (statementPrototype as { get: StatementSync["get"] }).get;
  let interfered = 0;
  t.mock.method(statementPrototype, "get", function (this: StatementSync, ...args: SQLInputValue[]) {
    const result = original.apply(this, args);
    // Right after the listing's first look at the row, and before it has any lock: the conversation is reviewed elsewhere.
    if (!interfered && this.sourceSQL.includes("FROM conversation_review_states") && this.sourceSQL.includes("was_running")) {
      interfered++;
      other.prepare("UPDATE conversation_review_states SET reviewed_at = '2026-02-01T00:00:00.000Z' WHERE user_id = ? AND project_id = ?").run(user, project);
    }
    return result;
  });
  const states = syncConversationReviewDetails(user, "race", project, listed("2026-01-15T00:00:00.000Z"));
  assert.equal(interfered, 1);
  // The row was read again under the write lock, so the review made meanwhile is kept and decides the state.
  assert.deepEqual(states.get("pi:a"), { state: "reviewed", reviewedAt: "2026-02-01T00:00:00.000Z" });
  assert.deepEqual({ ...other.prepare("SELECT last_activity_at, reviewed_at FROM conversation_review_states WHERE user_id = ? AND project_id = ?").get(user, project) },
    { last_activity_at: "2026-01-15T00:00:00.000Z", reviewed_at: "2026-02-01T00:00:00.000Z" });
});

/* The old version, kept here to compare against: it wrote every listed row inside one write transaction.
   `changes` counts the writes that changed what was stored: a new row, or an update that left a row different. */
function oldSync(db: DatabaseSync, userId: string, username: string, projectId: string, sessions: Session[], now: string): { states: Array<[string, { state: string; reviewedAt: string }]>; changes: number } {
  let changes = 0;
  const stored = (sessionPath: string): string => JSON.stringify(db.prepare("SELECT * FROM conversation_review_states WHERE user_id = ? AND project_id = ? AND session_path = ?").get(userId, projectId, sessionPath));
  const remote = new Map((db.prepare("SELECT engine, session_id, reviewed_at FROM replicated_review_watermarks WHERE username = ? AND project_id = ?").all(username, projectId) as Array<{ engine: string; session_id: string; reviewed_at: string }>)
    .map((row) => [`${row.engine}\n${row.session_id}`, row.reviewed_at]));
  const activityTime = (value: string | undefined): string => { if (!value) return now; const time = new Date(value); return Number.isNaN(time.getTime()) ? now : time.toISOString(); };
  const covered = (observedAt: string, reviewedAt: string, remoteReviewedAt: string | undefined): boolean => observedAt <= reviewedAt || Boolean(remoteReviewedAt && Date.parse(observedAt) - Date.parse(remoteReviewedAt) <= 250);
  const states = new Map<string, { state: string; reviewedAt: string }>();
  db.exec("BEGIN IMMEDIATE");
  const tracking = db.prepare("SELECT initialized_at FROM conversation_review_tracking WHERE user_id = ? AND project_id = ?").get(userId, projectId) as { initialized_at: string } | undefined;
  const initializedAt = tracking?.initialized_at ?? now;
  if (!tracking) { db.prepare("INSERT INTO conversation_review_tracking (user_id, project_id, initialized_at) VALUES (?, ?, ?)").run(userId, projectId, initializedAt); changes++; }
  for (const listed of sessions) {
    const latestAt = activityTime(listed.updatedAt);
    const observedAt = listed.silentReviewFrom && listed.silentReviewUntil && latestAt > listed.silentReviewFrom && latestAt <= listed.silentReviewUntil ? listed.silentReviewFrom : latestAt;
    const remoteReviewedAt = remote.get(`${listed.engine}\n${listed.sessionId}`);
    const row = db.prepare("SELECT last_activity_at, reviewed_at, was_running FROM conversation_review_states WHERE user_id = ? AND project_id = ? AND session_path = ?").get(userId, projectId, listed.path) as { reviewed_at: string } | undefined;
    if (!row) {
      const baseline = tracking ? initializedAt : observedAt;
      const reviewedAt = remoteReviewedAt && remoteReviewedAt > baseline ? remoteReviewedAt : baseline;
      db.prepare("INSERT INTO conversation_review_states (user_id, project_id, session_path, last_activity_at, reviewed_at, was_running, notified) VALUES (?, ?, ?, ?, ?, ?, 0)").run(userId, projectId, listed.path, observedAt, reviewedAt, listed.running ? 1 : 0);
      changes++;
      states.set(listed.path, { state: listed.running ? "running" : covered(observedAt, reviewedAt, remoteReviewedAt) ? "reviewed" : "needs_review", reviewedAt });
      continue;
    }
    const reviewedAt = remoteReviewedAt && remoteReviewedAt > row.reviewed_at ? remoteReviewedAt : row.reviewed_at;
    const remoteAdvanced = Boolean(remoteReviewedAt && remoteReviewedAt > row.reviewed_at);
    const before = stored(listed.path);
    db.prepare("UPDATE conversation_review_states SET last_activity_at = ?, reviewed_at = ?, was_running = ?, notified = CASE WHEN ? = 1 OR ? = 1 THEN 0 ELSE notified END WHERE user_id = ? AND project_id = ? AND session_path = ?")
      .run(observedAt, reviewedAt, listed.running ? 1 : 0, listed.running ? 1 : 0, remoteAdvanced ? 1 : 0, userId, projectId, listed.path);
    if (stored(listed.path) !== before) changes++;
    states.set(listed.path, { state: listed.running ? "running" : covered(observedAt, reviewedAt, remoteReviewedAt) ? "reviewed" : "needs_review", reviewedAt });
  }
  db.exec("COMMIT");
  return { states: [...states], changes };
}

test("over a long run of listings and changes the rows and the answers are the old version's", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "jb-perf-review-"));
  const old = new DatabaseSync(path.join(directory, "old.db"));
  const live = new DatabaseSync(databaseFile);
  t.after(() => { old.close(); live.close(); rmSync(directory, { recursive: true, force: true }); });
  ensureConversationReviewReplicaSchema(old);
  ensureConversationReviewReplicaSchema(live);
  old.exec(`CREATE TABLE conversation_review_tracking (user_id TEXT NOT NULL, project_id TEXT NOT NULL, initialized_at TEXT NOT NULL, PRIMARY KEY (user_id, project_id));
    CREATE TABLE conversation_review_states (user_id TEXT NOT NULL, project_id TEXT NOT NULL, session_path TEXT NOT NULL, last_activity_at TEXT NOT NULL, reviewed_at TEXT NOT NULL,
      was_running INTEGER NOT NULL DEFAULT 0, notified INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, project_id, session_path));`);

  // A small world, so that the same rows are met again and again in every state.
  let seed = 20261110;
  const random = (limit: number): number => {
    seed = seed + 0x6D2B79F5 | 0;
    let mixed = Math.imul(seed ^ seed >>> 15, 1 | seed);
    mixed = mixed + Math.imul(mixed ^ mixed >>> 7, 61 | mixed) ^ mixed;
    return Math.floor(((mixed ^ mixed >>> 14) >>> 0) / 4294967296 * limit);
  };
  const pick = <T>(items: readonly T[]): T => items[random(items.length)];
  const users = [["perf-review-old-u1", "old-one"], ["perf-review-old-u2", "old-two"]] as const;
  const projects = ["perf-review-old-p1", "perf-review-old-p2"] as const;
  const names = ["a", "b", "c", "d", "e"] as const;
  const times = [undefined, "not a time", "2026-03-01T00:00:00.000Z", "2026-03-01T00:00:00.100Z", "2026-03-02T00:00:00.000Z", "2026-03-03T00:00:00Z", "2026-03-04T00:00:00.000Z", "2026-03-05T12:00:00.000Z"] as const;
  const stamps = times.filter((time): time is Exclude<(typeof times)[number], undefined | "not a time"> => Boolean(time) && time !== "not a time");
  const both = (sql: string, ...values: SQLInputValue[]): void => { for (const db of [old, live]) db.prepare(sql).run(...values); };
  const tables = (db: DatabaseSync) => ({
    tracking: db.prepare("SELECT user_id, project_id, initialized_at FROM conversation_review_tracking WHERE user_id LIKE 'perf-review-old-%' ORDER BY user_id, project_id").all().map((row) => ({ ...row })),
    states: db.prepare("SELECT * FROM conversation_review_states WHERE user_id LIKE 'perf-review-old-%' ORDER BY user_id, project_id, session_path").all().map((row) => ({ ...row })),
  });

  let clock = Date.parse("2026-03-10T00:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: clock });
  let listings = 0, quiet = 0, wrote = 0;
  for (let step = 0; step < 1500; step++) {
    clock += random(3) * 1000;
    t.mock.timers.setTime(clock);
    const [userId, username] = pick(users), projectId = pick(projects), name = pick(names);
    const kind = random(10);
    if (kind === 0) both("UPDATE conversation_review_states SET notified = 1 WHERE user_id = ? AND project_id = ? AND session_path = ?", userId, projectId, `pi:${name}`);
    else if (kind === 1) both(`INSERT INTO replicated_review_watermarks (username, project_id, engine, session_id, reviewed_at, origin_node_id) VALUES (?, ?, 'pi', ?, ?, 'elsewhere')
      ON CONFLICT(username, project_id, engine, session_id) DO UPDATE SET reviewed_at = MAX(replicated_review_watermarks.reviewed_at, excluded.reviewed_at)`, username, projectId, name, pick(stamps));
    else if (kind === 2 && random(4) === 0) both("DELETE FROM conversation_review_states WHERE user_id = ? AND project_id = ? AND session_path = ?", userId, projectId, `pi:${name}`);
    else if (kind === 2 && random(6) === 0) both("DELETE FROM conversation_review_tracking WHERE user_id = ? AND project_id = ?", userId, projectId);
    else if (kind === 3) both("UPDATE conversation_review_states SET reviewed_at = MAX(reviewed_at, ?), notified = 0 WHERE user_id = ? AND project_id = ? AND session_path = ?", pick(stamps), userId, projectId, `pi:${name}`);
    else {
      // A listing. Some conversations come twice, as a caller's mistake would have them.
      const listed: Session[] = Array.from({ length: random(6) }, () => {
        const from = pick(stamps), until = pick(stamps);
        return { ...session(pick(names), pick(times), random(4) === 0), ...(random(5) === 0 ? { silentReviewFrom: from < until ? from : until, silentReviewUntil: from < until ? until : from } : {}) };
      });
      const expected = oldSync(old, userId, username, projectId, listed, new Date(clock).toISOString());
      const actual = watchingTransactions(() => counting(() => syncConversationReviewDetails(userId, username, projectId, listed)));
      assert.deepEqual([...actual.result.result], expected.states, `step ${step}: the listing's answer`);
      // One write for each write of the old version that changed what was stored, and none for the others.
      const written = writes(actual.result.statements).length;
      assert.equal(written, expected.changes, `step ${step}: rows written`);
      assert.deepEqual(actual.scripts, written ? ["BEGIN", "COMMIT", "BEGIN IMMEDIATE", "COMMIT"] : ["BEGIN", "COMMIT"], `step ${step}: transactions`);
      listings++; if (written) wrote++; else quiet++;
    }
    assert.deepEqual(tables(live), tables(old), `step ${step}: the stored rows`);
  }
  assert.ok(listings > 800 && quiet > 150 && wrote > 150, `not enough of both kinds: ${listings} listings, ${quiet} wrote nothing, ${wrote} wrote`);
});
