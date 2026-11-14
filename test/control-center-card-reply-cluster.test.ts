import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type WebSocket from "ws";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import { openChat, waitFor } from "./queued-prompt-harness.js";
import { signedNodeRequest } from "./signed-node-request.js";
import { openNodeDatabase } from "../src/node-database.js";

// Local-only dispatch must fail here: the HTTP request arrives on B, but A owns the chat.
test("card replies and pushes queue on the conversation's owner without moving it", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-card-reply-cluster-"));
  const children: ChildProcess[] = [];
  const sockets: WebSocket[] = [];
  try {
    const environment = await seedDevEnvironment(root, 2);
    const [owner, viewer] = environment.nodes;
    const holds = path.join(root, "holds");
    await mkdir(holds);
    for (const node of environment.nodes) children.push(await startDevNode(environment, node, {
      JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log"), JOINT_BOB_TEST_ENGINE_HOLD_DIR: holds,
    }));
    await pairTwinNodes(environment);
    const onOwner = await signIn(environment, owner);
    const onViewer = await signIn(environment, viewer);
    const project = owner.projects[0];
    const listed = await api<{ sessions: Array<{ id: string; conversationId: string; path: string; harnessId: string }> }>(owner, onOwner, "GET", `/projects/${project.id}/sessions`);
    for (const engine of ["pi", "claude"]) {
      const conversation = listed.body.sessions.find((entry) => entry.harnessId === engine)!;
      assert.ok(conversation, `the fixture has a ${engine} conversation`);
      const claimed = await api(owner, onOwner, "POST", `/projects/${project.id}/sessions/take-ownership`, {
        peerId: owner.nodeId, sessionId: conversation.id, sessionPath: conversation.path,
      });
      assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
      const opened = openChat(owner.url, onOwner.cookie, project.id, conversation.path);
      sockets.push(opened.socket);
      await waitFor(opened.messages, () => opened.messages.some((event) => event.type === "ready"));
      const ref = { projectId: project.id, conversationId: conversation.conversationId ?? conversation.id };
      const message = `You should be able to connect using wifi (${engine})`;
      const replied = await api(viewer, onViewer, "POST", "/control-center/cards/reply", { ...ref, message });
      assert.equal(replied.status, 200, JSON.stringify(replied.body));
      await waitFor(opened.messages, () => opened.messages.some((event) => event.type === "userMessage" && event.text === message));
      const received = opened.messages.filter((event) => event.type === "userMessage" && event.text === message);
      assert.equal(received.length, 1, "the reply is queued exactly once on its owner");
      assert.equal((received[0].author as { username: string }).username, environment.username, "the reply keeps the person's identity");
      await waitFor(opened.messages, () => opened.messages.some((event) => event.type === "promptStarted"));
      // The stub holds that turn open: a push must still acknowledge the queued message immediately.
      const pushed = await api(viewer, onViewer, "POST", "/control-center/cards/push", { ...ref, note: "Keep the existing connection" });
      assert.equal(pushed.status, 200, JSON.stringify(pushed.body));
      await waitFor(opened.messages, () => opened.messages.some((event) => event.type === "userMessage" && String(event.text).startsWith("Keep the existing connection\n\nContinue with the task")));
      const ownership = await signedNodeRequest(environment, viewer, owner, "GET", `/api/cluster/v2/runtime/sessions/ownership?engine=${engine}&sessionId=${conversation.id}`);
      assert.equal((await ownership.json() as { ownership: { ownerNodeId: string } }).ownership.ownerNodeId, owner.nodeId, "sending an answer does not move the conversation");
    }
    // A known-offline owner is not a reason to take over or silently queue locally.
    await stopDevNode(children[0]);
    const db = openNodeDatabase(path.join(viewer.dataDir, "node.db"));
    try {
      db.prepare("UPDATE cluster_v2_peer_activity SET last_seen_at = ? WHERE node_id = ?").run("2020-01-01T00:00:00.000Z", owner.nodeId);
    } finally { db.close(); }
    const conversation = listed.body.sessions.find((entry) => entry.harnessId === "claude")!;
    const offline = await api<{ error: string }>(viewer, onViewer, "POST", "/control-center/cards/reply", {
      projectId: project.id, conversationId: conversation.conversationId ?? conversation.id, message: "Do not run this on another machine",
    });
    assert.equal(offline.status, 409, JSON.stringify(offline.body));
    assert.match(offline.body.error, /owns this conversation is offline/);
  } finally {
    for (const socket of sockets) socket.terminate();
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
