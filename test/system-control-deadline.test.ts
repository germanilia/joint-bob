import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type WebSocket from "ws";
import { seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import { openChat, waitFor } from "./queued-prompt-harness.js";

test("system control enforces iterations and interrupts a busy responder at its persisted deadline", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "system-control-deadline-"));
  let child: ChildProcess | undefined;
  const sockets: WebSocket[] = [];
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const responder = path.join(root, "responder.mjs");
    await writeFile(responder, `export default async function(input) {
      if (input.config.systemControl.instructions === "Wait for deadline") {
        await new Promise(resolve => input.signal.addEventListener("abort", resolve, { once: true }));
      }
      return "DECISION: RESPOND\\nREASON: unfinished\\n---\\nContinue verifying.";
    }`);
    child = await startDevNode(environment, node, { JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log"), JOINT_BOB_AUTO_RESPONDER: responder });
    const auth = await signIn(environment, node);
    const chat = openChat(node.url, auth.cookie, node.projects[0].id, "new");
    sockets.push(chat.socket);
    await waitFor(chat.messages, () => chat.messages.some(m => m.type === "ready"));
    chat.socket.send(JSON.stringify({ type: "prompt", message: "Build a tested feature" }));
    await waitFor(chat.messages, () => chat.messages.some(m => m.type === "agent_end"));
    const states = () => chat.messages.filter(m => m.type === "autoRespond").map(m => m.state as { status: string; responses: number; stopKind: string; stopReason: string; systemControl: { deadline: string } });
    chat.socket.send(JSON.stringify({ type: "autoRespond", autoRespond: { enabled: true, systemControl: { instructions: "Finish it", maxResponses: 1 } } }));
    await waitFor(chat.messages, () => states().some(s => s?.status === "stopped" && s.stopKind === "limit"));
    assert.equal(states().at(-1)!.responses, 1);
    assert.match(states().at(-1)!.stopReason, /1 responses/);
    chat.messages.length = 0;
    chat.socket.send(JSON.stringify({ type: "autoRespond", autoRespond: { enabled: true, systemControl: { instructions: "Wait for deadline", maxMinutes: 0.03 } } }));
    await waitFor(chat.messages, () => chat.messages.some(m => m.type === "autoRespond" && m.decision));
    const deadline = states().find(s => s?.status === "active")!.systemControl.deadline;
    assert.ok(Date.parse(deadline) > Date.now());
    await waitFor(chat.messages, () => chat.messages.some(m => m.type === "stopped"));
    const stopped = states().at(-1)!;
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.stopKind, "limit");
    assert.match(stopped.stopReason, /time limit/);
    assert.equal(stopped.responses, 0, "no reply is sent after the deadline");
  } finally {
    for (const socket of sockets) socket.close();
    if (child) await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});
