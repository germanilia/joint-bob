import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { supervisorRequest } from "../scripts/supervisor-client.mjs";
import { api, projectNamed, signIn } from "./dev-nodes.js";
import { backgroundFixture, closeBackgroundFixture, startSyntheticTask } from "./background-tasks-fixture.js";
import { openChat, waitFor } from "./queued-prompt-harness.js";

test("Stop terminates supervised tasks belonging to the conversation, not other conversations", { timeout: 60_000 }, async () => {
  const fixture = await backgroundFixture();
  let chat: ReturnType<typeof openChat> | undefined;
  try {
    const login = await signIn(fixture.environment, fixture.node);
    const project = projectNamed(fixture.node, "Internal Assistant");
    const listed = await api<{ sessions: Array<{ id: string; path: string; harnessId: string }> }>(fixture.node, login, "GET", `/projects/${project.id}/sessions`);
    const target = listed.body.sessions.find(session => session.harnessId === "pi")!;
    chat = openChat(fixture.node.url, login.cookie, project.id, target.path);
    const { messages, socket } = chat;
    await waitFor(messages, () => messages.some(message => message.type === "ready"));
    const conversationId = String(messages.find(message => message.type === "ready")!.conversationId);
    const taskId = randomUUID();
    const otherTaskId = randomUUID();
    await startSyntheticTask(fixture, project.id, conversationId, taskId, true);
    await startSyntheticTask(fixture, project.id, randomUUID(), otherTaskId, true);
    socket.send(JSON.stringify({ type: "stop" }));
    await waitFor(messages, () => messages.some(message => message.type === "stopped"));
    const stopped = await supervisorRequest<{ status: string }>(fixture.node.dataDir, { action: "task", id: taskId });
    const other = await supervisorRequest<{ status: string }>(fixture.node.dataDir, { action: "task", id: otherTaskId });
    assert.ok(!["starting", "running", "stopping"].includes(stopped.status), "Stop must wait for the conversation's processes to exit");
    assert.equal(other.status, "running", "another conversation's work must be untouched");
    assert.deepEqual(messages.filter(message => message.type === "error"), []);
  } finally {
    chat?.socket.terminate();
    await closeBackgroundFixture(fixture);
  }
});
