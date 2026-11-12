import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type WebSocket from "ws";
import type { BobMessage } from "../src/control-center/bob-store.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import { openChat, waitFor } from "./queued-prompt-harness.js";

/** Bob's responder stood in: it records what it was given, pushes once, then finds the work ready for review. */
const responderSource = (log: string) => `import { appendFileSync } from "node:fs";
let calls = 0;
export default async function responder(input) {
  calls += 1;
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ conversationId: input.conversationId, prompt: input.prompt, config: input.config }) + "\\n");
  if (calls % 2 === 1) return "DECISION: RESPOND\\nREASON: not verified yet\\n---\\nKeep going and verify it.";
  return "DECISION: STOP\\nREASON: Ready for review: I ran the tests and they pass.";
}
`;

type Frame = Record<string, unknown>;
type State = { status: string; systemControl?: { instructions: string }; harnessId: string; provider: string; modelId: string; maxResponses: number | null; stopInstructions: string };
const states = (messages: Frame[]) => messages.filter((message) => message.type === "autoRespond").map((message) => message.state as State | null);

test("system control drives a conversation with the person's instructions, on the conversation's own model, until it is ready for review", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "system-control-"));
  let child: ChildProcess | undefined;
  const sockets: WebSocket[] = [];
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const [project] = node.projects;
    const responder = path.join(root, "responder.mjs"), decisions = path.join(root, "responder.log"), prompts = path.join(root, "prompts.log");
    await writeFile(responder, responderSource(decisions));
    child = await startDevNode(environment, node, { JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log"), JOINT_BOB_TEST_ENGINE_DETAIL_LOG: prompts, JOINT_BOB_AUTO_RESPONDER: responder });
    const auth = await signIn(environment, node);
    const read = async () => (await readFile(decisions, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { conversationId: string; prompt: string; config: State });
    const agentRan = async () => (await readFile(prompts, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { prompt: string; settings: { provider: string; modelId: string } });
    const chat = async () => (await api<{ messages: BobMessage[] }>(node, auth, "GET", "/control-center/bob/messages")).body.messages;

    // Off until the person says so: a new conversation is left to them.
    const plain = openChat(node.url, auth.cookie, project.id, "new");
    sockets.push(plain.socket);
    await waitFor(plain.messages, () => plain.messages.some((message) => message.type === "ready"));
    plain.socket.send(JSON.stringify({ type: "prompt", message: "just a question" }));
    await waitFor(plain.messages, () => plain.messages.some((message) => message.type === "agent_end"));
    assert.equal(states(plain.messages).some((state) => state?.status === "active"), false, "the default is off");

    // With the default on and standing instructions, a person's new conversation comes under system control at its first message.
    const saved = await api(node, auth, "PUT", "/control-center/bob/settings", { systemControl: true, systemInstructions: "Always write the tests first." });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const driven = openChat(node.url, auth.cookie, project.id, "new");
    sockets.push(driven.socket);
    await waitFor(driven.messages, () => driven.messages.some((message) => message.type === "ready"));
    driven.socket.send(JSON.stringify({ type: "prompt", message: "build the dessert menu" }));
    await waitFor(driven.messages, () => states(driven.messages).some((state) => state?.status === "active" && Boolean(state.systemControl)));
    const ready = await (async () => {
      for (const deadline = Date.now() + 90_000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 200))) {
        const found = (await chat()).find((message) => message.via === "Delegated to Bob · ready for review");
        if (found) return found;
      }
      throw new Error("The work never came back ready for review");
    })();
    assert.match(ready.text, /is ready for review\.\n\nWhat I checked: I ran the tests and they pass\./);
    assert.ok((await agentRan()).some((entry) => entry.prompt === "Keep going and verify it."), "the responder pushed the agent on");
    const [first] = await read();
    const agent = (await agentRan()).find((entry) => entry.prompt === "build the dessert menu")!;
    assert.deepEqual([first.config.harnessId, first.config.provider, first.config.modelId], ["pi", agent.settings.provider, agent.settings.modelId], "it runs on the conversation's own model, so on its subscription pool");
    assert.equal(first.config.maxResponses, null, "no limit on answers in a row");
    assert.match(first.prompt, /The user's standing instructions:\nAlways write the tests first\./);
    assert.match(first.prompt, /Decide for the user/);
    assert.equal(first.config.stopInstructions.split("\n").length, 3, "it stops only when ready for review, for credentials, or for an irreversible step");

    // Turned on in a conversation the person already has, with what they add for it; turning it off leaves it to them.
    plain.socket.send(JSON.stringify({ type: "autoRespond", autoRespond: { enabled: true, systemControl: { instructions: "Use the blue theme." } } }));
    await waitFor(plain.messages, () => states(plain.messages).some((state) => state?.systemControl?.instructions === "Use the blue theme."));
    const added = await (async () => {
      for (const deadline = Date.now() + 60_000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 200))) {
        const found = (await read()).find((entry) => entry.prompt.includes("Use the blue theme."));
        if (found) return found;
      }
      throw new Error("The responder never judged the conversation");
    })();
    assert.match(added.prompt, /Always write the tests first\.[\s\S]*The user's instructions for this conversation:\nUse the blue theme\./);
    plain.socket.send(JSON.stringify({ type: "autoRespond", autoRespond: { enabled: false } }));
    await waitFor(plain.messages, () => states(plain.messages).at(-1)?.status === "off");
  } finally {
    for (const socket of sockets) socket.close();
    if (child) await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});
