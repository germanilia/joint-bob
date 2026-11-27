import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";

import { freePort } from "./dev-nodes.js";
import { configure, environment, gatedClaude, killNode, login, openChat, queuedTexts, spawnNode, temporaryRoot, waitFor, waitForInvocations } from "./queued-prompt-harness.js";
import { openNodeDatabase } from "../src/node-database.js";

for (const state of ["pending", "paused", "uncertain"] as const) test(`a queued prompt in the ${state} state can recover after a node crash`, async () => {
  const root = await temporaryRoot("joint-bob-queue-restart-");
  const previous = { ...process.env };
  Object.assign(process.env, environment(root));
  let node: ChildProcess | undefined;
  let socket: WebSocket | undefined;
  try {
    const executable = await gatedClaude(root);
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    node = await spawnNode(root, port);
    const fixture = await configure(baseUrl, root, executable);

    const opened = openChat(baseUrl, fixture.cookie, fixture.projectId, "claude:new");
    socket = opened.socket;
    await waitFor(opened.messages, () => opened.messages.some((message) => message.type === "ready"));
    socket.send(JSON.stringify({ type: "prompt", message: "first" }));
    await waitFor(opened.messages, () => opened.messages.some((message) => message.type === "sessionFile") && opened.messages.some((message) => message.type === "promptStarted"));
    const sessionFile = String(opened.messages.find((message) => message.type === "sessionFile")!.sessionFile);
    socket.send(JSON.stringify({ type: "prompt", message: "second" }));
    await waitFor(opened.messages, () => opened.messages.some((message) => message.type === "userMessage" && message.queued === true && message.text === "second"));

    if (state === "paused") {
      socket.send(JSON.stringify({ type: "stop" }));
      await waitFor(opened.messages, () => opened.messages.some((message) => message.type === "stopped"));
    }
    // Kill the node with the prompt still pending, exactly as a crash would.
    socket.terminate();
    await killNode(node);
    node = undefined;
    if (state === "uncertain") {
      // This is what remains if the node dies between beginQueuedPrompt and onStarted.
      const db = openNodeDatabase(path.join(root, "data", "node.db"));
      try { assert.equal(db.prepare("UPDATE queued_prompts SET revision = revision + 1, prompt = json_set(prompt, '$.revision', revision + 1, '$.dispatchState', 'starting')").run().changes, 1); }
      finally { db.close(); }
    }

    const restartPort = await freePort();
    const restartUrl = `http://127.0.0.1:${restartPort}`;
    node = await spawnNode(root, restartPort);
    const { cookie } = await login(restartUrl, "replacement-password");
    const reopened = openChat(restartUrl, cookie, fixture.projectId, sessionFile);
    socket = reopened.socket;
    await waitFor(reopened.messages, () => reopened.messages.some((message) => message.type === "queuedPrompts"));
    assert.deepEqual(queuedTexts(reopened.messages), ["second"]);
    if (state === "paused") {
      const db = openNodeDatabase(path.join(root, "data", "node.db"), { readOnly: true });
      try { assert.equal(db.prepare("SELECT paused FROM queued_prompt_control WHERE queue_key = ?").get(`${fixture.projectId}:${opened.messages.find(message => message.type === "ready")!.sessionId}`)?.paused, 1); }
      finally { db.close(); }
      const queued = (reopened.messages.find(message => message.type === "queuedPrompts")!.prompts as Array<{ id: string; revision: number }>)[0];
      socket.send(JSON.stringify({ type: "forceStartQueuedPrompt", queueId: queued.id, queueRevision: queued.revision }));
    }

    let expected = "second";
    if (state === "uncertain") {
      const [queued] = reopened.messages.find(message => message.type === "queuedPrompts")!.prompts as Array<{ id: string; revision: number; starting: boolean; uncertain: boolean }>;
      assert.equal(queued.starting, false);
      assert.equal(queued.uncertain, true, "the reconnect distinguishes an interrupted start from ordinary waiting");
      expected = "inspect the previous start without replaying it";
      socket.send(JSON.stringify({ type: "editQueuedPrompt", queueId: queued.id, queueRevision: queued.revision, message: expected }));
      await waitFor(reopened.messages, () => reopened.messages.some(message => message.type === "queuedPromptEdited" && message.text === expected));
    }
    await writeFile(`${process.env.JOINT_BOB_FAKE_GATE}.${expected}`, "");
    await waitForInvocations(["first", expected]);
    await waitFor(reopened.messages, () => reopened.messages.some((message) => message.type === "promptCompleted"));
    assert.ok(reopened.messages.filter((message) => message.type === "textDelta").map((message) => message.text).join("").includes(expected));
  } finally {
    socket?.terminate();
    await killNode(node);
    process.env = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("a prompt queued before native initialization survives a crash under its ready id", async () => {
  const root = await temporaryRoot("joint-bob-queue-pre-init-");
  const previous = { ...process.env };
  const initEnv = { JOINT_BOB_FAKE_INIT_GATE: path.join(root, "init-gate") };
  Object.assign(process.env, environment(root), initEnv);
  let node: ChildProcess | undefined;
  let socket: WebSocket | undefined;
  try {
    const executable = await gatedClaude(root);
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    node = await spawnNode(root, port, initEnv);
    const fixture = await configure(baseUrl, root, executable);

    const opened = openChat(baseUrl, fixture.cookie, fixture.projectId, "claude:new");
    socket = opened.socket;
    await waitFor(opened.messages, () => opened.messages.some((message) => message.type === "ready"));
    const readyId = opened.messages.find((message) => message.type === "ready")!.sessionId;
    assert.equal(typeof readyId, "string");
    assert.notEqual(readyId, "", "ready provides the conversation identity before native init");
    assert.equal(opened.messages.some((message) => message.type === "sessionFile"), false, "native init has not reported a session file");
    socket.send(JSON.stringify({ type: "prompt", message: "first" }));
    await waitFor(opened.messages, () => opened.messages.some((message) => message.type === "agent_start"));

    socket.send(JSON.stringify({ type: "prompt", message: "second" }));
    await waitFor(opened.messages, () => opened.messages.some((message) => message.type === "userMessage" && message.queued === true && message.text === "second"));
    assert.equal(opened.messages.some((message) => message.type === "sessionFile"), false, "native init has not reported a session file");

    const database = openNodeDatabase(path.join(root, "data", "node.db"));
    const queueRows = database.prepare("SELECT queue_key FROM queued_prompts ORDER BY sequence").all() as Array<{ queue_key: string }>;
    database.close();
    assert.deepEqual(queueRows.map(({ queue_key }) => queue_key), [
      `${fixture.projectId}:${readyId}`,
      `${fixture.projectId}:${readyId}`,
    ]);

    await writeFile(path.join(root, "init-gate"), "");
    await waitFor(opened.messages, () => opened.messages.some((message) => message.type === "sessionFile") && opened.messages.some((message) => message.type === "promptStarted"));
    const sessionFile = String(opened.messages.find((message) => message.type === "sessionFile")!.sessionFile);
    assert.ok(sessionFile.includes(String(readyId)), "native init retains the ready conversation id");

    socket.terminate();
    await killNode(node);
    node = undefined;

    const restartPort = await freePort();
    node = await spawnNode(root, restartPort, initEnv);
    const { cookie } = await login(`http://127.0.0.1:${restartPort}`, "replacement-password");
    const reopened = openChat(`http://127.0.0.1:${restartPort}`, cookie, fixture.projectId, sessionFile);
    socket = reopened.socket;
    await waitFor(reopened.messages, () => reopened.messages.some((message) => message.type === "ready") && reopened.messages.some((message) => message.type === "queuedPrompts"));
    assert.equal(reopened.messages.find((message) => message.type === "ready")!.sessionId, readyId);
    assert.deepEqual(queuedTexts(reopened.messages), ["second"]);

    await writeFile(`${process.env.JOINT_BOB_FAKE_GATE}.second`, "");
    await waitForInvocations(["first", "second"]);
    await waitFor(reopened.messages, () => reopened.messages.some((message) => message.type === "promptCompleted"));
    assert.ok(reopened.messages.filter((message) => message.type === "textDelta").map((message) => message.text).join("").includes("second"));
  } finally {
    socket?.terminate();
    await killNode(node);
    process.env = previous;
    await rm(root, { recursive: true, force: true });
  }
});
