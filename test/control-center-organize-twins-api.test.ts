import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { BobMessage } from "../src/control-center/bob-store.js";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "./dev-nodes.js";

async function until<T>(what: string, read: () => Promise<T | undefined | false>, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** The account a node signs the person in as; twins come to agree on it once they have exchanged accounts. */
async function accountIdOn(environment: DevEnvironment, node: SeededNode): Promise<string> {
  const response = await fetch(`${node.url}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: environment.username, password: environment.password }) });
  return (await response.json() as { accountId: string }).accountId;
}

/** Whether `from` has delivered its accounts to `to`, after which the person's newer events (Bob's chat) are sent to it. */
function accountsDelivered(from: SeededNode, to: SeededNode): boolean {
  const db = new DatabaseSync(path.join(from.dataDir, "node.db"), { readOnly: true });
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'account_replication_deliveries'").get())
      && Boolean(db.prepare("SELECT 1 FROM account_replication_deliveries WHERE peer_id = ?").get(to.nodeId));
  } finally { db.close(); }
}

test("asked on the Mac, Bob sends a message and its screenshot to a conversation the server runs, and brings its answer back", { timeout: 300_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "control-organize-twins-"));
  const children: ChildProcess[] = [];
  try {
    const environment = await seedDevEnvironment(root, 2);
    const [mac, server] = environment.nodes;
    const project = mac.projects[0];
    const sessionRoot = path.join(environment.home, ".pi", "sessions");
    const transcript = path.join(sessionRoot, "organize-twins.jsonl");
    const log = path.join(root, "invocations.log"), stubs = path.join(root, "stubs");
    // Each machine logs the prompts its agent got, so where the message ran shows.
    const detail = (node: typeof mac) => path.join(root, `prompts-${node.key}.log`);
    await Promise.all([mkdir(sessionRoot, { recursive: true }), mkdir(stubs, { recursive: true })]);
    // Recent, so it is among the conversations Bob names (each project's latest and those on the board).
    const now = new Date().toISOString();
    await writeFile(transcript, `${JSON.stringify({ type: "session", version: 3, id: "organize-twins", timestamp: now, cwd: project.path })}\n${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: now, message: { role: "user", content: [{ type: "text", text: "Internal Assistant" }] } })}\n`);
    for (const node of [mac, server]) children.push(await startDevNode(environment, node, { JOINT_BOB_TEST_ENGINE_LOG: log, JOINT_BOB_TEST_ENGINE_DETAIL_LOG: detail(node), JOINT_BOB_TEST_AUTOMATION_DIR: stubs }));
    const prompts = async (node: typeof mac) => (await readFile(detail(node), "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { prompt: string; images: number });
    await pairTwinNodes(environment);
    await until("both machines know the person as one account", async () => (await accountIdOn(environment, mac)) === (await accountIdOn(environment, server)), 150_000);
    await until("the machines exchanged accounts", async () => accountsDelivered(mac, server) && accountsDelivered(server, mac), 150_000);
    const [onMac, onServer] = await Promise.all([signIn(environment, mac), signIn(environment, server)]);

    // The server runs the conversation; the Mac lists it as running there.
    const claimed = await api<{ ownership: { ownerNodeId: string } }>(server, onServer, "POST", `/projects/${project.id}/sessions/take-ownership`, { peerId: server.nodeId, sessionId: "organize-twins", sessionPath: transcript });
    assert.equal(claimed.body.ownership?.ownerNodeId, server.nodeId, JSON.stringify(claimed.body));
    const listed = await until("the Mac to list the conversation as the server's", async () => (await api<{ sessions: Array<{ id: string; title: string; executionNodeId?: string }> }>(mac, onMac, "GET", `/projects/${project.id}/sessions`))
      .body.sessions.find((session) => session.id === "organize-twins" && session.executionNodeId === server.nodeId));

    // Typed as fast as the person types, with no decision model to be sure of it: Bob's agent decides, and offers to send it.
    await writeFile(path.join(stubs, "organize.json"), JSON.stringify({ intent: "message-conversation", conversation: `conversation-titled:${listed.title}`, message: "fix this, the display is wrong" }));
    const image = { name: "screen.png", mimeType: "image/png", data: Buffer.from("not really a png").toString("base64") };
    const asked = await api<{ reply: BobMessage }>(mac, onMac, "POST", "/control-center/bob/message", { message: `I want the ${listed.title} conversatoin to fix this, the dispay is wrong`, images: [image] });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    const offer = asked.body.reply;
    assert.equal(offer.text, `Send this to "${listed.title}" in ${project.name}? I'll bring you its answer here.\nfix this, the display is wrong\nWith screen.png.`);
    assert.deepEqual(offer.actions.map((action) => action.label), ["Send it", "Cancel"]);
    const kept = path.join(mac.dataDir, "bob-attachments", ".joint-bob-attachments");
    assert.match((await readdir(kept)).join(", "), /^[\w-]+-screen\.png$/, "the screenshot waits on the Mac for the press");

    // Pressed on the Mac, it is sent on the server, as the person, with the screenshot; its answer comes back to the Mac's chat.
    const pressed = await api<{ messages: BobMessage[] }>(mac, onMac, "POST", "/control-center/bob/action", { messageId: offer.id, actionId: "organize.run" });
    assert.equal(pressed.status, 200, JSON.stringify(pressed.body));
    assert.equal(pressed.body.messages[0].text, `Sent to "${listed.title}". I'll bring you its answer here when it is done.`);
    const turn = await until("the server's conversation to get it", async () => (await prompts(server)).find((entry) => entry.prompt.includes("fix this, the display is wrong")));
    assert.equal(turn.images, 1, "the screenshot goes with it");
    assert.ok(!(await prompts(mac)).some((entry) => entry.prompt.includes("fix this")), "it ran on the server, not on the Mac");
    assert.deepEqual(await readdir(kept), [], "sent, so the Mac no longer keeps it");
    const answer = await until("its answer to reach the Mac", async () => (await api<{ messages: BobMessage[] }>(mac, onMac, "GET", "/control-center/bob/messages")).body.messages
      .find((message) => message.text.startsWith(`"${listed.title}" answered:`)), 150_000);
    assert.equal(answer.importance, "report");
  } finally {
    for (const child of children) await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});
