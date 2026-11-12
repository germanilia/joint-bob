import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildBoard, type BoardProject, type BoardSources } from "../src/control-center/board.js";
import { applySnoozeEvent, publishSnooze } from "../src/control-center/bob-sync.js";
import { appendBobMessage, countBobMessages, ensureBobSchema } from "../src/control-center/bob-store.js";
import { aboutSnoozedOnly, conversationsOfMessage, readSnooze, snoozeHolds, writeSnooze, type Snooze } from "../src/control-center/snoozes.js";
import { ensureReplicationSchema, type ReplicationEvent } from "../src/replication.js";
import type { SessionSummary } from "../src/types.js";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const NOW = Date.parse("2026-11-12T10:00:00.000Z");

const snooze = (overrides: Partial<Snooze> = {}): Snooze => ({
  accountId: ACCOUNT, projectId: "p", conversationId: "c1", until: "2026-11-12T11:00:00.000Z",
  snoozedAt: "2026-11-12T09:30:00.000Z", reviewIds: [], updatedAt: "2026-11-12T09:30:00.000Z", ...overrides,
});

function machine(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureReplicationSchema(db);
  ensureBobSchema(db);
  return db;
}

test("a snooze holds until its time, a Guardian review it did not see, or activity after it", () => {
  const quiet = { running: false, updatedAt: "2026-11-12T09:00:00.000Z", reviewIds: [] };
  assert.equal(snoozeHolds(snooze(), quiet, NOW), true);
  assert.equal(snoozeHolds(snooze({ until: null }), quiet, NOW), true, "until something changes has no end time");
  assert.equal(snoozeHolds(snooze({ until: "2026-11-12T09:59:00.000Z" }), quiet, NOW), false, "its time has come");
  assert.equal(snoozeHolds(snooze(), { ...quiet, updatedAt: "2026-11-12T09:45:00.000Z" }, NOW), false, "the agent wrote again");
  assert.equal(snoozeHolds(snooze({ reviewIds: ["r1"] }), { ...quiet, reviewIds: ["r1"] }, NOW), true, "the review it was put aside with");
  assert.equal(snoozeHolds(snooze({ reviewIds: ["r1"] }), { ...quiet, reviewIds: ["r1", "r2"] }, NOW), false, "a new review");
  assert.equal(snoozeHolds(snooze(), { running: true, updatedAt: "2026-11-12T09:45:00.000Z", reviewIds: [] }, NOW), true,
    "a running one waiting on a review writes as it waits");
});

test("a snoozed Needs you card moves to Snoozed and says until when; one that moved on is back under Needs you", () => {
  const session = (id: string, updatedAt: string) => ({ id, conversationId: id, path: `/p/${id}`, harnessId: "claude", agentId: "claude", agentLabel: "Claude", title: id, running: false, reviewState: "needs_review", updatedAt }) as SessionSummary;
  const projects: BoardProject[] = [{ projectId: "p", projectName: "P", sessions: [session("c1", "2026-11-12T09:00:00.000Z"), session("c2", "2026-11-12T09:50:00.000Z"), session("c3", "2026-11-12T09:00:00.000Z")] }];
  const sources: BoardSources = {
    summaryOf: () => null, autoRespondActive: () => false, startedByBob: () => false, pendingReviews: () => [],
    autoRespondStop: (_projectId, conversationId) => conversationId === "c3" ? null : { kind: "question", reason: "It asks which bucket." },
    controlledBy: () => null, reviewCheck: () => null, activityOf: () => null,
    snoozeOf: (_projectId, conversationId) => snooze({ conversationId }),
  };
  const cards = new Map(buildBoard(projects, sources, NOW).map((card) => [card.conversationId, card]));
  assert.equal(cards.get("c1")!.column, "snoozed");
  assert.deepEqual(cards.get("c1")!.snooze, { until: "2026-11-12T11:00:00.000Z", snoozedAt: "2026-11-12T09:30:00.000Z" });
  assert.equal(cards.get("c2")!.column, "needs-you", "it wrote after it was put aside");
  assert.equal(cards.get("c2")!.snooze, null);
  assert.equal(cards.get("c3")!.column, "review", "only a Needs you card can be snoozed");
});

test("a snooze reaches the person's other machine, and an older one does not replace a waking", () => {
  const mac = machine();
  const server = machine();
  publishSnooze(mac, "mac", snooze());
  const events = mac.prepare("SELECT * FROM replication_outbox").all() as Array<Record<string, string>>;
  const [event] = events.map((row): ReplicationEvent => ({ id: row.event_id, originNodeId: row.origin_node_id, entityType: row.entity_type, entityKey: row.entity_key, operation: row.operation as "upsert", payload: JSON.parse(row.payload), createdAt: row.created_at }));
  writeSnooze(server, snooze({ until: "2026-11-12T09:40:00.000Z", updatedAt: "2026-11-12T09:40:00.000Z" }));
  applySnoozeEvent(server, event);
  assert.equal(readSnooze(server, ACCOUNT, "p", "c1")!.until, "2026-11-12T09:40:00.000Z", "woken later on the server");
  const fresh = machine();
  applySnoozeEvent(fresh, event);
  assert.equal(readSnooze(fresh, ACCOUNT, "p", "c1")!.until, "2026-11-12T11:00:00.000Z");
  assert.throws(() => applySnoozeEvent(fresh, { ...event, entityKey: "someone:else" }), /Malformed/);
});

test("Telegram stays quiet about a conversation snoozed for a while, not one snoozed until something changes", () => {
  const db = machine();
  const about = (conversationId: string) => ({ actions: [{ id: "open", label: "Open", data: { open: { projectId: "p", conversationId } } }] });
  assert.deepEqual(conversationsOfMessage({ actions: [{ id: "review.leave", label: "Leave it", data: { projectId: "p", conversationId: "c1" } }, ...about("c1").actions] }), ["p:c1"]);
  writeSnooze(db, snooze());
  writeSnooze(db, snooze({ conversationId: "c2", until: null }));
  assert.equal(aboutSnoozedOnly(db, ACCOUNT, about("c1"), NOW), true);
  assert.equal(aboutSnoozedOnly(db, ACCOUNT, about("c2"), NOW), false, "a new message is the change it waits for");
  assert.equal(aboutSnoozedOnly(db, ACCOUNT, about("c3"), NOW), false);
  assert.equal(aboutSnoozedOnly(db, ACCOUNT, { actions: [] }, NOW), false, "a message about no conversation");
  assert.equal(aboutSnoozedOnly(db, ACCOUNT, about("c1"), Date.parse("2026-11-12T12:00:00.000Z")), false, "its time came");
});

test("the waiting count can leave out Bob's items about snoozed conversations", () => {
  const db = machine();
  appendBobMessage(db, ACCOUNT, { role: "bob", importance: "needs-you", text: "c1 stopped", actions: [{ id: "review.leave", label: "Leave it", data: { projectId: "p", conversationId: "c1" } }] });
  appendBobMessage(db, ACCOUNT, { role: "bob", importance: "needs-you", text: "c2 stopped", actions: [{ id: "review.leave", label: "Leave it", data: { projectId: "p", conversationId: "c2" } }] });
  assert.equal(countBobMessages(db, ACCOUNT, "important"), 2);
  assert.equal(countBobMessages(db, ACCOUNT, "important", (message) => conversationsOfMessage(message).includes("p:c1")), 1);
});
