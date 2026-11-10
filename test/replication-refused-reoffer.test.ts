// A node used to read its whole outbox again every five minutes for every twin, to offer the
// events that twin had been refused once more. On 2026-11-10 that was 53% of a starved node's
// time, although the twin already had every event. The outbox is now read once after a start;
// what was refused is remembered and only that is offered again.
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { resolveDataDirectory } from "../src/data-directory.js";
import { enqueueReplicationEvent, ensureReplicationSchema, eventsForPeer, forgetOutboxScans, outboxScanState, recordPeerReceipt, type ReplicationEvent } from "../src/replication.js";

const MINUTE = 60_000;

interface Fixture { db: DatabaseSync; peer: string; delivered: string[]; refused: string[]; clock: { now: number }; pass: (filter: (event: ReplicationEvent) => boolean) => Promise<string[]>; untilSearched: (filter: (event: ReplicationEvent) => boolean) => Promise<string[]>; cleanup: () => void }

/** `history` delivered events with `refusedCount` undelivered ones scattered among them, all older than the peer's first pass. */
function fixture(name: string, history: number, refusedCount: number): Fixture {
  const db = new DatabaseSync(path.join(resolveDataDirectory(), "node.db"));
  ensureReplicationSchema(db);
  const peer = `${name}-peer`, delivered: string[] = [], refused: string[] = [];
  const start = new Date("2026-05-01T00:00:00.000Z");
  const every = Math.max(1, Math.floor(history / Math.max(1, refusedCount)));
  db.exec("BEGIN");
  for (let i = 0; i < history; i++) {
    const id = enqueueReplicationEvent(db, { originNodeId: "local", entityType: "project.lock", entityKey: `${name}-kept-${i}`, operation: "upsert", payload: { projectId: name } }).id;
    delivered.push(id);
    db.prepare("INSERT INTO replication_deliveries VALUES(?,?,1,?,?,NULL)").run(id, peer, start.toISOString(), start.toISOString());
    if (i % every === 0 && refused.length < refusedCount) refused.push(enqueueReplicationEvent(db, { originNodeId: "local", entityType: "project.lock", entityKey: `${name}-refused-${refused.length}`, operation: "upsert", payload: { projectId: name, refused: true } }).id);
  }
  db.exec("COMMIT");
  const clock = { now: start.getTime() };
  // What a pass hands out is acknowledged at once, as a peer that is reachable does: it is not due again.
  const pass = async (filter: (event: ReplicationEvent) => boolean) => {
    clock.now += 2_000;
    const ids = (await eventsForPeer(peer, new Date(clock.now), filter)).map((event) => event.id);
    await recordPeerReceipt(peer, ids);
    return ids;
  };
  return {
    db, peer, delivered, refused, clock, pass,
    // The first search of history takes several passes: each has a budget of a few milliseconds.
    untilSearched: async (filter) => {
      const found: string[] = [];
      for (let passes = 0; passes < 2_000; passes++) {
        found.push(...await pass(filter));
        if (outboxScanState(peer)?.searching === false) return found;
      }
      throw new Error("the search of history never finished");
    },
    cleanup: () => {
      db.prepare("DELETE FROM replication_deliveries WHERE peer_id=?").run(peer);
      db.prepare("DELETE FROM replication_outbox WHERE entity_key LIKE ?").run(`${name}-%`);
      db.close();
    },
  };
}

const isRefused = (event: ReplicationEvent) => (event.payload as { refused?: boolean }).refused === true;

test("after the first search, a round offers only the refused events again and never reads the outbox", async () => {
  forgetOutboxScans();
  const held = fixture("reoffer", 6_000, 5);
  try {
    let judged = 0;
    const refuse = (event: ReplicationEvent) => { judged++; return !isRefused(event); };
    assert.deepEqual(await held.untilSearched(refuse), [], "nothing new for a twin that has the history");
    assert.deepEqual(outboxScanState(held.peer), { searching: false, reoffering: false, refused: 5 });
    assert.equal(judged, 5, "the first search judged the five events without a delivery row, once each");

    // Before the round is due nothing is asked at all.
    judged = 0;
    for (let i = 0; i < 20; i++) assert.deepEqual(await held.pass(refuse), []);
    assert.equal(judged, 0);

    // The round: the five are judged again, and the outbox is not searched.
    held.clock.now += 5 * MINUTE;
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(await held.pass(refuse), []);
      assert.equal(outboxScanState(held.peer)?.searching, false, "a round must not read the outbox again");
    }
    assert.equal(judged, 5);
    assert.deepEqual(outboxScanState(held.peer), { searching: false, reoffering: false, refused: 5 });

    // A grant made meanwhile reaches the peer at the next round.
    held.clock.now += 5 * MINUTE;
    const granted: string[] = [];
    for (let i = 0; i < 5; i++) granted.push(...await held.pass(() => true));
    assert.deepEqual(granted.sort(), [...held.refused].sort(), "every refused event is delivered once it is allowed");
    assert.deepEqual(outboxScanState(held.peer), { searching: false, reoffering: false, refused: 0 });

    // With nothing refused, later rounds have nothing to do.
    judged = 0;
    held.clock.now += 5 * MINUTE;
    for (let i = 0; i < 5; i++) assert.deepEqual(await held.pass(refuse), []);
    assert.equal(judged, 0);
    assert.equal(outboxScanState(held.peer)?.searching, false);
  } finally { held.cleanup(); forgetOutboxScans(); }
});

test("a new event that is refused is remembered and offered again, and one that expired is forgotten", async () => {
  forgetOutboxScans();
  const held = fixture("reoffer-new", 500, 2);
  try {
    const refuse = (event: ReplicationEvent) => !isRefused(event);
    await held.untilSearched(refuse);
    assert.equal(outboxScanState(held.peer)?.refused, 2);
    const late = enqueueReplicationEvent(held.db, { originNodeId: "local", entityType: "project.lock", entityKey: "reoffer-new-late", operation: "upsert", payload: { projectId: "reoffer-new", refused: true } }).id;
    const allowed = enqueueReplicationEvent(held.db, { originNodeId: "local", entityType: "project.lock", entityKey: "reoffer-new-allowed", operation: "upsert", payload: { projectId: "reoffer-new" } }).id;
    assert.deepEqual(await held.pass(refuse), [allowed], "a new event the filter accepts goes out at once");
    assert.equal(outboxScanState(held.peer)?.refused, 3, "a new event the filter refuses joins the remembered ones");

    // One of the old refused events expires before the next round.
    held.db.prepare("DELETE FROM replication_outbox WHERE event_id=?").run(held.refused[0]);
    held.clock.now += 5 * MINUTE;
    let judged = 0;
    for (let i = 0; i < 5; i++) assert.deepEqual(await held.pass((event) => { judged++; return refuse(event); }), []);
    assert.equal(judged, 2, "the expired event is not judged");
    assert.equal(outboxScanState(held.peer)?.refused, 2);

    held.clock.now += 5 * MINUTE;
    const granted: string[] = [];
    for (let i = 0; i < 5; i++) granted.push(...await held.pass(() => true));
    assert.deepEqual(granted.sort(), [held.refused[1], late].sort());
  } finally { held.cleanup(); forgetOutboxScans(); }
});

test("more than a hundred refused events are offered again over several passes, each once", async () => {
  forgetOutboxScans();
  const held = fixture("reoffer-many", 400, 250);
  try {
    await held.untilSearched((event) => !isRefused(event));
    assert.equal(outboxScanState(held.peer)?.refused, 250);
    held.clock.now += 5 * MINUTE;
    const granted: string[] = [];
    for (let i = 0; i < 10; i++) granted.push(...await held.pass(() => true));
    assert.equal(granted.length, 250, "each refused event is delivered exactly once");
    assert.deepEqual([...new Set(granted)].sort(), [...held.refused].sort());
    assert.deepEqual(outboxScanState(held.peer), { searching: false, reoffering: false, refused: 0 });
  } finally { held.cleanup(); forgetOutboxScans(); }
});

test("a peer refused more events than are remembered has the outbox searched for them, as before", async () => {
  forgetOutboxScans({ refusedLimit: 3 });
  const held = fixture("reoffer-limit", 300, 6);
  try {
    const refuse = (event: ReplicationEvent) => !isRefused(event);
    await held.untilSearched(refuse);
    assert.equal(outboxScanState(held.peer)?.refused, undefined, "too many to remember");
    held.clock.now += 5 * MINUTE;
    const granted = await held.pass(() => true);
    const rest = await held.untilSearched(() => true);
    assert.deepEqual([...granted, ...rest].sort(), [...held.refused].sort(), "the search of the outbox still finds every one of them");
    // Now that they are delivered, the next search finds few enough to remember again.
    held.clock.now += 5 * MINUTE;
    await held.pass(refuse);
    await held.untilSearched(refuse);
    assert.deepEqual(outboxScanState(held.peer), { searching: false, reoffering: false, refused: 0 });
  } finally { held.cleanup(); forgetOutboxScans(); }
});

test("a restart reads the outbox once more and remembers the refused events again", async () => {
  forgetOutboxScans();
  const held = fixture("reoffer-restart", 300, 4);
  try {
    const refuse = (event: ReplicationEvent) => !isRefused(event);
    await held.untilSearched(refuse);
    assert.equal(outboxScanState(held.peer)?.refused, 4);
    forgetOutboxScans();
    assert.equal(outboxScanState(held.peer), undefined);
    const found = await held.untilSearched(() => true);
    assert.deepEqual(found.sort(), [...held.refused].sort(), "what was refused before the restart is offered again by the first search after it");
    assert.deepEqual(outboxScanState(held.peer), { searching: false, reoffering: false, refused: 0 });
  } finally { held.cleanup(); forgetOutboxScans(); }
});

test("when the accounts a peer takes change, history is searched once more for the events it never judged", async () => {
  forgetOutboxScans();
  const db = new DatabaseSync(path.join(resolveDataDirectory(), "node.db"));
  ensureReplicationSchema(db);
  const peer = "reoffer-scope-peer", first = "11111111111111111111111111111111", second = "22222222222222222222222222222222";
  const own = (account: string, index: number) => enqueueReplicationEvent(db, { originNodeId: "local", entityType: "user.recent", entityKey: `reoffer-scope-${account}-${index}`, operation: "upsert", payload: { username: account, projectId: "scope" } }).id;
  const firstEvents = [own(first, 0), own(first, 1)], secondEvents = [own(second, 0), own(second, 1), own(second, 2)];
  let now = Date.parse("2026-05-01T00:00:00.000Z");
  const pass = async (accounts: string[] | undefined) => {
    now += 2_000;
    const ids = (await eventsForPeer(peer, new Date(now), () => true, accounts)).map((event) => event.id);
    await recordPeerReceipt(peer, ids);
    return ids;
  };
  const untilSearched = async (accounts: string[] | undefined) => {
    const found: string[] = [];
    for (let passes = 0; passes < 500; passes++) { found.push(...await pass(accounts)); if (outboxScanState(peer)?.searching === false) return found; }
    throw new Error("the search of history never finished");
  };
  try {
    assert.deepEqual((await untilSearched([first])).sort(), [...firstEvents].sort(), "the peer takes the first account's events");
    // One of our people signs in on that machine: their older events must follow, although no search ever judged them.
    assert.deepEqual((await untilSearched([first, second])).sort(), [...secondEvents].sort(), "the second account's history is found without a restart");
    assert.deepEqual(await pass([second, first]), [], "the same accounts in another order are the same scope: nothing is searched again");
    assert.equal(outboxScanState(peer)?.searching, false);
    // The visitor's home becomes one of this person's own machines: it takes every event from now on.
    const other = enqueueReplicationEvent(db, { originNodeId: "local", entityType: "project.lock", entityKey: "reoffer-scope-other", operation: "upsert", payload: { projectId: "scope" } }).id;
    const asTwin = await untilSearched(undefined);
    assert.ok(asTwin.includes(other), "an event outside the accounts reaches the peer once it takes everything");
  } finally {
    db.prepare("DELETE FROM replication_deliveries WHERE peer_id=?").run(peer);
    db.prepare("DELETE FROM replication_outbox WHERE entity_key LIKE 'reoffer-scope-%'").run();
    db.close();
    forgetOutboxScans();
  }
});
