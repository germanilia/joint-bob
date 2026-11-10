import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { BobMessage } from "../src/control-center/bob-store.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

async function until<T>(what: string, read: () => Promise<T | undefined | false>, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Bob's responder stood in: the first time it finds the work unverified and says so, then it finds it ready for review. */
const responderSource = (log: string) => `import { appendFileSync } from "node:fs";
let calls = 0;
export default async function responder(input) {
  calls += 1;
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ call: calls, prompt: input.prompt, maxResponses: input.config.maxResponses }) + "\\n");
  if (calls % 2 === 1) return "DECISION: RESPOND\\nREASON: not verified yet\\n---\\nNow verify it end to end and show me the evidence.";
  return "DECISION: STOP\\nREASON: Ready for review: I ran the tests myself and they pass.";
}
`;

test("work handed to Bob is driven to a verified end and comes back to his chat ready for review, with what he checked and the agent's report", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "control-delegation-"));
  let child: ChildProcess | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const [project] = node.projects;
    const stubs = path.join(root, "stubs"), prompts = path.join(root, "prompts.log"), decisions = path.join(root, "responder.log"), responder = path.join(root, "responder.mjs");
    await mkdir(stubs, { recursive: true });
    await writeFile(responder, responderSource(decisions));
    child = await startDevNode(environment, node, { JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log"), JOINT_BOB_TEST_ENGINE_DETAIL_LOG: prompts, JOINT_BOB_TEST_AUTOMATION_DIR: stubs, JOINT_BOB_AUTO_RESPONDER: responder });
    const auth = await signIn(environment, node);
    const say = async (text: string, intent: unknown) => {
      await writeFile(path.join(stubs, "organize.json"), JSON.stringify(intent));
      const reply = await api<{ reply: BobMessage }>(node, auth, "POST", "/control-center/bob/message", { message: text });
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      return reply.body.reply;
    };
    const press = async (message: BobMessage, actionId = "organize.run") => {
      const pressed = await api<{ messages: BobMessage[] }>(node, auth, "POST", "/control-center/bob/action", { messageId: message.id, actionId });
      assert.equal(pressed.status, 200, JSON.stringify(pressed.body));
      return pressed.body.messages[0];
    };
    const agentGot = async () => (await readFile(prompts, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { prompt: string }).prompt);
    const responderRead = async () => (await readFile(decisions, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { call: number; prompt: string; maxResponses: number });
    const chat = async () => (await api<{ messages: BobMessage[] }>(node, auth, "GET", "/control-center/bob/messages")).body.messages;

    // New work, handed over: Bob says what he will do and waits for the button.
    const offer = await say(`build the dessert menu in ${project.name}, I delegate it to you, bring it back only for review`, { intent: "start-conversation", projectId: project.id, message: "build the dessert menu", delegate: true });
    assert.match(offer.text, new RegExp(`^Start a conversation in "${project.name}" and hand it to me\\? I'll drive it through the work, the fixes and an end-to-end check, and bring it back when it is ready for review, or when it needs something only you can give\\.\\nbuild the dessert menu$`));
    assert.deepEqual(offer.actions.map((action) => action.label), ["Start and delegate", "Cancel"]);
    const started = await press(offer);
    assert.match(started.text, /^Started in .+\. It is on the board now\. I'm driving it: I'll answer it, push it on and check its work end to end, and bring it back when it is ready for review/);

    // The agent is told Bob drives it and what he expects at the end.
    const brief = await until("the agent to get the brief", async () => (await agentGot()).find((prompt) => prompt.startsWith("build the dessert menu")));
    assert.match(brief, /Bob drives this work for me from here/);
    assert.match(brief, /verify it end to end/);
    assert.match(brief, /end with a review report/);

    // Bob's responder drives it: it finds the work unverified and tells the agent, then finds it ready and stops.
    await until("the responder's push to reach the agent", async () => (await agentGot()).includes("Now verify it end to end and show me the evidence."));
    const ready = await until("the work to come back ready for review", async () => (await chat()).find((message) => message.via === "Delegated to Bob · ready for review"));
    assert.equal(ready.text, `"build the dessert menu" is ready for review.\n\nWhat I checked: I ran the tests myself and they pass.\n\nIts report:\nstubbed response`);
    assert.equal(ready.importance, "needs-you");
    assert.deepEqual(ready.actions.map((action) => action.label), ["Open", "Done"]);
    const read = await responderRead();
    assert.equal(read.length, 2, "it stopped once the work was ready, and no more");
    assert.equal(read[0].maxResponses, 40);
    assert.match(read[0].prompt, /- Ready for review: the work is implemented and verified end to end, you checked the evidence yourself/, "it drives toward a verified end");
    assert.match(read[0].prompt, /The user delegated this work to you and will see it only when it is ready for review/);
    assert.equal((await chat()).some((message) => message.via === "Auto respond ended · Bob was told"), false, "ready is not told as a stop that needs the person");

    // The person's reply is their review: it goes into the conversation, and Bob drives the work on until it is ready again.
    const reviewed = await api(node, auth, "POST", "/control-center/bob/reply", { messageId: ready.id, text: "make the prices bold" });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
    await until("the review to reach the agent", async () => (await agentGot()).includes("make the prices bold"));
    await until("it to come back ready after the review", async () => (await chat()).filter((message) => message.via === "Delegated to Bob · ready for review").length === 2);
    assert.equal((await responderRead()).length, 4, "Bob drove it again: a push, then ready");

    // A conversation the person names is handed over too; with nothing new, it is told to carry on until it is ready.
    const handOver = await say("delegate the build the dessert menu conversation to Bob again", { intent: "delegate-conversation", conversation: "conversation-titled:build the dessert menu", message: null });
    assert.match(handOver.text, /^Hand "build the dessert menu" in .+ over to me\? I'll drive it through the work/);
    assert.deepEqual(handOver.actions.map((action) => action.label), ["Delegate it", "Cancel"]);
    assert.equal((await press(handOver)).text, `"build the dessert menu" is mine to drive now. I'll bring it back when it is ready for review, or when it needs something only you can give.`);
    const carryOn = await until("the conversation to be told to carry on", async () => (await agentGot()).find((prompt) => prompt.startsWith("Carry on with this work until it is ready for review.")));
    assert.match(carryOn, /Bob drives this work for me from here/);
    await until("it to come back ready again", async () => (await chat()).filter((message) => message.via === "Delegated to Bob · ready for review").length === 3);
  } finally {
    if (child) await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});
