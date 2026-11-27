// A delete made on one machine for a conversation another machine runs is sent to that machine.
// When the owner does not answer (stopped, or too busy to reply in time), the delete is refused
// as not confirmed, instead of failing as an unhandled server error.
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

async function until<T>(what: string, read: () => Promise<T | undefined | false>, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test("a delete the owning machine does not answer is refused as not confirmed", { timeout: 300_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "delete-owner-unavailable-"));
  const children: ChildProcess[] = [];
  try {
    const environment = await seedDevEnvironment(root, 2);
    const [mac, server] = environment.nodes;
    const project = mac.projects[0];
    const sessionRoot = path.join(environment.home, ".pi", "sessions");
    const sessionId = randomUUID();
    const transcript = path.join(sessionRoot, `${sessionId}.jsonl`);
    await mkdir(sessionRoot, { recursive: true });
    const now = new Date().toISOString();
    await writeFile(transcript, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: now, cwd: project.path })}\n${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: now, message: { role: "user", content: [{ type: "text", text: "Synthetic turn" }] } })}\n`);
    for (const node of [mac, server]) children.push(await startDevNode(environment, node));
    await pairTwinNodes(environment);
    const [onMac, onServer] = await Promise.all([signIn(environment, mac), signIn(environment, server)]);

    const claimed = await api<{ ownership: { ownerNodeId: string } }>(server, onServer, "POST", `/projects/${project.id}/sessions/take-ownership`, { peerId: server.nodeId, sessionId, sessionPath: transcript });
    assert.equal(claimed.body.ownership?.ownerNodeId, server.nodeId, JSON.stringify(claimed.body));
    const listed = await until("the Mac to list the conversation as the server's", async () => (await api<{ sessions: Array<{ id: string; harnessId: string; executionNodeId?: string }> }>(mac, onMac, "GET", `/projects/${project.id}/sessions`))
      .body.sessions.find((session) => session.id === sessionId && session.executionNodeId === server.nodeId));

    await stopDevNode(children[1]);
    const removal = await api<{ error: string }>(mac, onMac, "DELETE", `/projects/${project.id}/sessions?${new URLSearchParams({ engine: listed.harnessId, sessionId })}`);
    assert.deepEqual(removal, { status: 409, body: { error: "Conversation owner is unavailable; delete was not confirmed" } });
  } finally {
    await Promise.all(children.map((child) => stopDevNode(child)));
    await rm(root, { recursive: true, force: true });
  }
});
