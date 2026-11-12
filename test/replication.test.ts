import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openNodeDatabase } from "../src/node-database.js";

test("SQLite name replication is atomic, idempotent, ordered, and retryable", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-replication-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    const suffix = Date.now();
    const cluster = await import(new URL(`../src/cluster.ts?replication=${suffix}`, import.meta.url).href);
    const store = await import(new URL(`../src/store.ts?replication=${suffix}`, import.meta.url).href);
    const names = await import(new URL(`../src/names.ts?replication=${suffix}`, import.meta.url).href);
    const replication = await import("../src/replication.ts");
    const node = await cluster.getClusterNode();
    const projectIds = ["project-atomic", "project-duplicate", "project-conflict"];
    for (const id of projectIds) {
      await store.importProject({ id, name: id, path: `/remote/${id}`, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, path.join(dataDir, id));
    }
    const canonicalProjectId = "project-conversation-canonical";
    const aliasProjectId = "project-conversation-alias";
    await store.importProject({ id: canonicalProjectId, name: canonicalProjectId, path: `/remote/${canonicalProjectId}`, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, path.join(dataDir, canonicalProjectId));
    await store.registerProjectAliases(canonicalProjectId, [aliasProjectId]);

    await names.setProjectName("project-atomic", "Atomic name");
    const db = openNodeDatabase(path.join(dataDir, "node.db"));
    const outbox = db.prepare("SELECT event_id, origin_node_id, payload FROM replication_outbox").all() as Array<{ event_id: string; origin_node_id: string; payload: string }>;
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].origin_node_id, node.id);
    assert.deepEqual(JSON.parse(outbox[0].payload), {
      scope: "projects", key: "project-atomic", name: "Atomic name", updatedAt: JSON.parse(outbox[0].payload).updatedAt, originNodeId: node.id,
    });
    await assert.rejects(access(path.join(dataDir, "names.json")));

    const duplicate = {
      id: randomUUID(), originNodeId: randomUUID(), entityType: "name.override", entityKey: "projects:project-duplicate", operation: "upsert" as const,
      payload: { scope: "projects" as const, key: "project-duplicate", name: "First", updatedAt: "2026-01-01T00:00:00.000Z", originNodeId: randomUUID() },
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const duplicateBatch = { events: [duplicate] };
    assert.deepEqual(await replication.receiveReplicationBatch(duplicateBatch), [duplicate.id]);
    assert.deepEqual(await replication.receiveReplicationBatch(duplicateBatch), [duplicate.id]);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM replication_inbox WHERE event_id = ?").get(duplicate.id) as { count: number }).count, 1);
    assert.equal((await names.projectNameOverrides())["project-duplicate"], "First");

    const origin = randomUUID();
    const event = (id: string, name: string | null, updatedAt: string) => ({
      id, originNodeId: origin, entityType: "name.override", entityKey: "projects:project-conflict", operation: name === null ? "delete" as const : "upsert" as const,
      payload: { scope: "projects" as const, key: "project-conflict", name, updatedAt, originNodeId: origin }, createdAt: updatedAt,
    });
    const deleted = event(randomUUID(), null, "2026-02-02T00:00:00.000Z");
    await replication.receiveReplicationBatch({ events: [deleted] });
    await replication.receiveReplicationBatch({ events: [event(randomUUID(), "Older", "2026-02-01T00:00:00.000Z")] });
    assert.equal((await names.projectNameOverrides())["project-conflict"], undefined);
    await replication.receiveReplicationBatch({ events: [event(randomUUID(), "Newer", "2026-02-03T00:00:00.000Z")] });
    assert.equal((await names.projectNameOverrides())["project-conflict"], "Newer");

    const conversationOrigin = randomUUID();
    const conversationId = randomUUID();
    const conversationEvent = (operation: "upsert" | "delete", updatedAt: string) => ({
      id: randomUUID(), originNodeId: conversationOrigin, entityType: "conversation.record", entityKey: `${aliasProjectId}:pi:${conversationId}`, operation,
      payload: { projectId: aliasProjectId, engine: "pi", sessionId: conversationId, record: operation === "upsert" ? { projectId: aliasProjectId, engine: "pi", sessionId: conversationId, createdAt: "2026-02-01T00:00:00.000Z", updatedAt, originNodeId: conversationOrigin } : null, updatedAt, originNodeId: conversationOrigin }, createdAt: updatedAt,
    });
    const upsert = conversationEvent("upsert", "2026-02-02T00:00:00.000Z");
    await replication.receiveReplicationBatch({ events: [upsert] });
    await replication.receiveReplicationBatch({ events: [upsert] });
    const replicatedConversation = db.prepare("SELECT project_id, engine, session_id, origin_node_id FROM conversation_records WHERE session_id = ?").get(conversationId) as { project_id: string; engine: string; session_id: string; origin_node_id: string };
    assert.equal(replicatedConversation.project_id, canonicalProjectId);
    assert.equal(replicatedConversation.engine, "pi");
    assert.equal(replicatedConversation.session_id, conversationId);
    assert.equal(replicatedConversation.origin_node_id, conversationOrigin);
    await replication.receiveReplicationBatch({ events: [conversationEvent("delete", "2026-02-01T00:00:00.000Z")] });
    assert.ok(db.prepare("SELECT 1 FROM conversation_records WHERE session_id = ?").get(conversationId));
    await replication.receiveReplicationBatch({ events: [conversationEvent("delete", "2026-02-03T00:00:00.000Z")] });
    assert.equal(db.prepare("SELECT 1 FROM conversation_records WHERE session_id = ?").get(conversationId), undefined);
    const conversationTombstone = db.prepare("SELECT project_id, origin_node_id FROM conversation_record_tombstones WHERE session_id = ?").get(conversationId) as { project_id: string; origin_node_id: string };
    assert.equal(conversationTombstone.project_id, canonicalProjectId);
    assert.equal(conversationTombstone.origin_node_id, conversationOrigin);
    await replication.receiveReplicationBatch({ events: [conversationEvent("upsert", "2026-02-02T00:00:00.000Z")] });
    assert.equal(db.prepare("SELECT 1 FROM conversation_records WHERE session_id = ?").get(conversationId), undefined);

    const peerId = randomUUID();
    // The sharing filter decides what a peer may receive: a refusing filter queues nothing.
    // A later grant reaches the peer at the next full search, a few minutes on.
    assert.deepEqual(await replication.eventsForPeer(peerId, new Date("2026-03-01T00:00:00.000Z"), () => false), []);
    const due = await replication.eventsForPeer(peerId, new Date("2026-03-01T00:06:00.000Z"), () => true);
    assert.ok(due.length > 0);
    await replication.recordPeerFailure(peerId, [due[0].id], "offline", new Date("2026-03-01T00:00:00.000Z"));
    const failed = db.prepare("SELECT attempts, next_attempt_at, delivered_at, last_error FROM replication_deliveries WHERE event_id = ? AND peer_id = ?").get(due[0].id, peerId) as { attempts: number; next_attempt_at: string; delivered_at: string | null; last_error: string | null };
    assert.equal(failed.attempts, 1);
    assert(Date.parse(failed.next_attempt_at) > Date.parse("2026-03-01T00:00:00.000Z"));
    assert.equal(failed.last_error, "offline");
    await replication.recordPeerReceipt(peerId, [due[0].id]);
    const delivered = db.prepare("SELECT delivered_at, last_error FROM replication_deliveries WHERE event_id = ? AND peer_id = ?").get(due[0].id, peerId) as { delivered_at: string | null; last_error: string | null };
    assert(delivered.delivered_at);
    assert.equal(delivered.last_error, null);

    // The project board is gone: a task event from a machine on an older version is taken and dropped.
    const taskOrigin = randomUUID();
    const oldTaskEvent = { id: randomUUID(), originNodeId: taskOrigin, entityType: "task", entityKey: "project-atomic:old-ticket", operation: "upsert" as const, payload: { projectId: "project-atomic", task: { id: "old-ticket" }, originNodeId: taskOrigin }, createdAt: "2026-04-01T00:00:00.000Z" };
    assert.deepEqual(await replication.receiveReplicationBatch({ events: [oldTaskEvent] }), [oldTaskEvent.id]);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});
