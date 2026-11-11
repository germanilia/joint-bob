// A delete made on one machine cleans the other the same way. The second machine finds its copy
// by session id anywhere under the harness folder, not only in the folders its project lists,
// and removes it with the session folder, the transfer leftover and its rows. It never removes
// the transcript of a conversation that is on record.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { signedNodeRequest } from "./signed-node-request.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

// Twin sync on a loaded CI runner can take longer than 30 seconds to converge.
async function eventually(check: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (true) {
    try { await check(); return; }
    catch (error) { if (Date.now() >= deadline) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
const exists = (file: string) => access(file).then(() => true, () => false);
const claudeLine = (sessionId: string, cwd: string): string =>
  `${JSON.stringify({ type: "user", uuid: randomUUID(), sessionId, cwd, timestamp: new Date().toISOString(), message: { role: "user", content: "Synthetic turn" } })}\n`;

function conversationEvent(dataDir: string, sessionId: string, operation: "upsert" | "delete") {
  const database = new DatabaseSync(path.join(dataDir, "node.db"));
  try {
    const row = database.prepare(`SELECT event_id, origin_node_id, entity_type, entity_key, operation, payload, created_at
      FROM replication_outbox WHERE entity_type = 'conversation.record' AND operation = ? AND entity_key LIKE ? ORDER BY rowid DESC LIMIT 1`)
      .get(operation, `%:${sessionId}`) as { event_id: string; origin_node_id: string; entity_type: string; entity_key: string; operation: string; payload: string; created_at: string } | undefined;
    assert.ok(row, `${operation} event exists`);
    return { id: row.event_id, originNodeId: row.origin_node_id, entityType: row.entity_type, entityKey: row.entity_key,
      operation: row.operation, payload: JSON.parse(row.payload), createdAt: row.created_at };
  } finally { database.close(); }
}

test("a tombstone from the owner removes the other machine's copy wherever it lies, with its folder, leftovers and rows", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "delete-twin-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const a = await seedDevEnvironment(path.join(root, "a"), 1);
    const b = await seedDevEnvironment(path.join(root, "b"), 1);
    const left = a.nodes[0], right = b.nodes[0];
    children.push(await startDevNode(a, left), await startDevNode(b, right));
    const sa = await signIn(a, left), sb = await signIn(b, right);
    const invitation = await api<{ link: string; relationshipId: string }>(left, sa, "POST", "/twins/invitations", { confirmOwnedData: true });
    assert.equal(invitation.status, 201);
    assert.equal((await api(right, sb, "POST", "/twins/accept", { link: invitation.body.link, confirmOwnedData: true })).status, 201);
    assert.equal((await api(left, sa, "POST", `/twins/${invitation.body.relationshipId}/sharing`, { ownerNodeId: left.nodeId, confirmOwnedData: true })).status, 200);

    const directory = path.join(root, "project");
    await mkdir(directory);
    const created = await api<{ project: { id: string } }>(left, sa, "POST", "/projects", { name: "Deleted on a twin", type: "personal", path: directory, synced: false });
    assert.equal(created.status, 201);
    const projectId = created.body.project.id;
    await eventually(async () => {
      const projects = await api<{ projects: Array<{ id: string }> }>(right, sb, "GET", "/projects");
      assert.ok(projects.body.projects.some((project) => project.id === projectId), "twin project metadata must arrive");
    });

    const gone = randomUUID(), kept = randomUUID(), early = randomUUID();
    // The owner holds both conversations in the project's own Claude folder.
    const ownerDir = path.join(a.home, ".claude", "projects", directory.replace(/^\//, "-").replace(/[\s_.\/]+/g, "-"));
    // The other machine holds its copies in a folder its project does not list, as after the project moved there.
    const copyDir = path.join(b.home, ".claude", "projects", "-where-the-project-was");
    const files = (folder: string, id: string): string[] => [path.join(folder, `${id}.jsonl`), path.join(folder, id, "subagents", "agent-worker.jsonl"), path.join(folder, id, "tool-results", "output.txt")];
    for (const folder of [ownerDir, copyDir]) {
      for (const id of [gone, kept, early]) {
        for (const file of files(folder, id)) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, claudeLine(id, directory)); }
      }
    }
    const leftovers = (id: string): string[] => [path.join(copyDir, `${id}.jsonl.${left.nodeId}.part`), path.join(copyDir, `${id}.jsonl.force-transfer-${randomUUID()}.bak`)];
    const goneLeftovers = leftovers(gone), keptLeftovers = leftovers(kept);
    for (const file of [...goneLeftovers, ...keptLeftovers]) await writeFile(file, "partial\n");

    // The owner discovers both, and the inventory exchange gives them records; the records reach the other machine.
    await eventually(async () => {
      const sessions = await api<{ sessions: Array<{ id: string }> }>(left, sa, "GET", `/projects/${projectId}/sessions`);
      for (const id of [gone, kept, early]) assert.ok(sessions.body.sessions.some((session) => session.id === id), "the owner discovers the conversation");
    });
    const offered = await signedNodeRequest(b, right, left, "GET", `/api/cluster/v2/transcripts?${new URLSearchParams({ projectId })}`);
    assert.equal(offered.status, 200, await offered.text());
    const records = await signedNodeRequest(a, left, right, "POST", "/api/cluster/v2/events", { events: [conversationEvent(left.dataDir, gone, "upsert"), conversationEvent(left.dataDir, kept, "upsert"), conversationEvent(left.dataDir, early, "upsert")] });
    assert.equal(records.status, 200, await records.text());

    // Rows the other machine holds about both conversations.
    const rows = (id: string): number => {
      const database = new DatabaseSync(path.join(right.dataDir, "node.db"));
      try {
        database.exec("PRAGMA busy_timeout = 5000");
        return Number((database.prepare("SELECT count(*) AS n FROM name_overrides WHERE scope IN ('sessions', 'session_colors') AND key = ?").get(id) as { n: number }).n)
          + Number((database.prepare("SELECT count(*) AS n FROM transcript_summaries WHERE file LIKE ?").get(`%${id}%`) as { n: number }).n);
      } finally { database.close(); }
    };
    const seeded = new DatabaseSync(path.join(right.dataDir, "node.db"));
    try {
      seeded.exec("PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS transcript_summaries (kind TEXT NOT NULL, file TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (kind, file))");
      const at = new Date().toISOString();
      for (const id of [gone, kept, early]) {
        seeded.prepare("INSERT OR REPLACE INTO name_overrides (scope, key, name, updated_at, origin_node_id) VALUES ('sessions', ?, 'A title', ?, ?)").run(id, at, right.nodeId);
        seeded.prepare("INSERT OR REPLACE INTO name_overrides (scope, key, name, updated_at, origin_node_id) VALUES ('session_colors', ?, 'blue', ?, ?)").run(id, at, right.nodeId);
        seeded.prepare("INSERT OR REPLACE INTO transcript_summaries (kind, file, payload) VALUES ('conversation-digest', ?, '{}')").run(`${projectId}:${id}`);
      }
    } finally { seeded.close(); }
    assert.ok(rows(gone) >= 3);

    // The owner deletes one. Its own files go at once.
    const removal = await fetch(`${left.url}/api/projects/${projectId}/sessions?${new URLSearchParams({ engine: "claude", sessionId: gone })}`, {
      method: "DELETE", headers: { Cookie: sa.cookie, "x-csrf-token": sa.csrfToken },
    });
    assert.equal(removal.status, 204, await removal.text());
    for (const file of [...files(ownerDir, gone), path.join(ownerDir, gone)]) assert.equal(await exists(file), false, `the owner still has ${file}`);
    for (const file of files(ownerDir, kept)) assert.equal(await exists(file), true);

    // The tombstone arrives on the other machine.
    const deletion = await signedNodeRequest(a, left, right, "POST", "/api/cluster/v2/events", { events: [conversationEvent(left.dataDir, gone, "delete")] });
    assert.equal(deletion.status, 200, await deletion.text());
    await eventually(async () => {
      for (const file of [...files(copyDir, gone), path.join(copyDir, gone), ...goneLeftovers]) assert.equal(await exists(file), false, `the other machine still has ${file}`);
      assert.equal(rows(gone), 0, "the other machine's rows about the conversation went with it");
    });
    for (const file of [...files(copyDir, kept), ...keptLeftovers]) assert.equal(await exists(file), true, `${file} of the other conversation went`);
    assert.ok(rows(kept) >= 3, "the other conversation keeps its rows");

    // A delete the owner made long ago that reaches this machine only now. Its date is before this machine ever ran the
    // complete delete, and it is carried out all the same: the date says when the owner deleted, not when this machine heard.
    const longAgo = new DatabaseSync(path.join(right.dataDir, "node.db"));
    try {
      longAgo.exec("PRAGMA busy_timeout = 5000");
      longAgo.prepare("UPDATE conversation_records SET updated_at = '2025-12-01T00:00:00.000Z' WHERE session_id = ?").run(early);
    } finally { longAgo.close(); }
    assert.ok(rows(early) >= 3);
    const before = "2026-01-01T00:00:00.000Z";
    const arrived = await signedNodeRequest(a, left, right, "POST", "/api/cluster/v2/events", { events: [{
      id: randomUUID(), originNodeId: left.nodeId, entityType: "conversation.record", entityKey: `${projectId}:claude:${early}`, operation: "delete",
      payload: { projectId, engine: "claude", sessionId: early, record: null, updatedAt: before, originNodeId: left.nodeId }, createdAt: before,
    }] });
    assert.equal(arrived.status, 200, await arrived.text());
    await eventually(async () => {
      for (const file of [...files(copyDir, early), path.join(copyDir, early)]) assert.equal(await exists(file), false, `the other machine still has ${file} of a delete that arrived late`);
      assert.equal(rows(early), 0, "its rows went with it");
    });
    const queue = new DatabaseSync(path.join(right.dataDir, "node.db"), { readOnly: true });
    try { assert.deepEqual(queue.prepare("SELECT session_id FROM conversation_deletes_pending").all(), [], "nothing is left in the queue of unfinished deletes"); }
    finally { queue.close(); }

    // A delete older than the record loses to it: the record stays, and so must the transcript.
    const stale = "2020-01-01T00:00:00.000Z";
    const late = await signedNodeRequest(a, left, right, "POST", "/api/cluster/v2/events", { events: [{
      id: randomUUID(), originNodeId: left.nodeId, entityType: "conversation.record", entityKey: `${projectId}:claude:${kept}`, operation: "delete",
      payload: { projectId, engine: "claude", sessionId: kept, record: null, updatedAt: stale, originNodeId: left.nodeId }, createdAt: stale,
    }] });
    assert.equal(late.status, 200, await late.text());
    const recorded = new DatabaseSync(path.join(right.dataDir, "node.db"), { readOnly: true });
    try { assert.ok(recorded.prepare("SELECT 1 FROM conversation_records WHERE session_id = ?").get(kept), "the record outlives the older delete"); }
    finally { recorded.close(); }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    for (const file of [...files(copyDir, kept), ...keptLeftovers]) assert.equal(await exists(file), true, `${file} of a conversation on record was removed`);
    assert.ok(rows(kept) >= 3, "the other conversation keeps its rows");
  } finally {
    await Promise.all(children.map((child) => stopDevNode(child)));
    await rm(root, { recursive: true, force: true });
  }
});
