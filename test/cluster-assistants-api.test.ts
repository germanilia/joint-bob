import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
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
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** A stand-in decision model for the member's Bob: the message is a question, and it needs every assistant it is asked about. */
async function decisionModel(): Promise<{ server: Server; url: string; asked: string[] }> {
  const asked: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { questions: Record<string, { instructions: string; criteria: Record<string, string> }> };
      const answers: Record<string, unknown> = {};
      for (const [id, question] of Object.entries(parsed.questions)) {
        if (id.startsWith("assistant_")) asked.push(question.instructions);
        const choice = id === "kind" ? "question" : id.startsWith("assistant_") ? "yes" : "no" in question.criteria ? "no" : "none" in question.criteria ? "none" : Object.keys(question.criteria)[0];
        answers[id] = { type: "choice", choice, confidence: 0.97 };
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ answers }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/systemone`, asked };
}

const RESPONDER = `export default async function responder() { return "DECISION: STOP\\nREASON: Ready for review: it is set up."; }\n`;

interface Shared { id: string; name: string; clusterId: string; clusterName: string; machineName: string; local: boolean; canManage: boolean; instructions: string | null }
interface Event { eventType: string; actorId: string | null; details: Record<string, string | number | boolean | null> }

test("a cluster assistant is hosted on one machine, asked by another member through their own Bob, changed by those who manage it, and audited", { timeout: 300_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cluster-assistants-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  const classifier = await decisionModel();
  try {
    const alex = await seedDevEnvironment(path.join(root, "alex"), 1);
    const team = await seedDevEnvironment(path.join(root, "maya"), 1, { username: "maya" });
    await rm(path.join(team.home, ".pi", "sessions"), { recursive: true, force: true });
    await rm(path.join(team.home, ".claude", "projects"), { recursive: true, force: true });
    const host = alex.nodes[0], member = team.nodes[0];
    const stubs = path.join(root, "stubs"), askLog = path.join(root, "asks.log"), responder = path.join(root, "responder.mjs"), engineLog = path.join(root, "engine.log");
    await mkdir(stubs, { recursive: true });
    await writeFile(responder, RESPONDER);
    await writeFile(engineLog, "");
    children.push(await startDevNode(alex, host, { JOINT_BOB_TEST_ENGINE_LOG: engineLog, JOINT_BOB_TEST_AUTOMATION_DIR: stubs, JOINT_BOB_AUTO_RESPONDER: responder, JOINT_BOB_TEST_ASK_LOG: askLog, JOINT_BOB_TEST_ASK_ANSWER: "The draft is ready: Hello team." }));
    children.push(await startDevNode(team, member, { JOINT_BOB_TEST_ENGINE_LOG: engineLog, JOINT_BOB_TYPESAFE_ENDPOINT: classifier.url }));
    const [onHost, onMember] = await Promise.all([signIn(alex, host), signIn(team, member)]);

    // The two people share a cluster.
    const created = await api<{ snapshot: { body: { clusterId: string } } }>(host, onHost, "POST", "/clusters", { name: "Team" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const clusterId = created.body.snapshot.body.clusterId;
    const invitation = await api<{ link: string }>(host, onHost, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
    assert.equal((await api(member, onMember, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() })).status, 201);

    // Asked for the cluster, Bob says what that means and waits for the button.
    await writeFile(path.join(stubs, "organize.json"), JSON.stringify({ intent: "create-assistant", name: "Poster", purpose: "draft posts for the team account", cluster: clusterId }));
    const offer = (await api<{ reply: BobMessage }>(host, onHost, "POST", "/control-center/bob/message", { message: "create an assistant for the Team cluster that drafts posts for the team account" })).body.reply;
    assert.match(offer.text, /^Create the assistant "Poster" for the cluster "Team", hosted on this machine\? Everyone in the cluster can ask it through their own Bob/);
    assert.match(offer.text, /runs on the cluster's subscriptions, and every ask and change is written to its audit log/);
    assert.deepEqual(offer.actions.map((action) => action.label), ["Create for the cluster", "Cancel"]);
    const pressed = await api<{ messages: BobMessage[] }>(host, onHost, "POST", "/control-center/bob/action", { messageId: offer.id, actionId: "organize.run" });
    assert.equal(pressed.status, 200, JSON.stringify(pressed.body));
    assert.match(pressed.body.messages[0].text, /^Created "Poster" for the cluster "Team" and started its setup in Assistants · Team\./);

    // It lives in the cluster's own project, shared with the cluster (which is what puts it on the cluster's subscriptions).
    const projects = (await api<{ projects: Array<{ id: string; name: string }> }>(host, onHost, "GET", "/projects")).body.projects;
    const project = projects.find((candidate) => candidate.name === "Assistants · Team")!;
    assert.ok(project, "the cluster's assistants project");
    assert.equal(projects.some((candidate) => candidate.name === "Assistants"), false, "the person's private Assistants project is not used");
    const sharing = await api<{ projectIds: string[] }>(host, onHost, "GET", `/clusters/${clusterId}/sharing`);
    assert.ok(sharing.body.projectIds.includes(project.id), "shared with the cluster");

    // The host's creator sees it and may manage it; the member sees it on the other machine and may not.
    const hosted = async () => (await api<{ assistants: Shared[] }>(host, onHost, "GET", "/control-center/cluster-assistants")).body.assistants;
    const [mine] = await hosted();
    assert.deepEqual([mine.name, mine.clusterName, mine.local, mine.canManage, mine.instructions], ["Poster", "Team", true, true, ""]);
    const theirs = await until("the member to see the cluster assistant", async () => (await api<{ assistants: Shared[] }>(member, onMember, "GET", "/control-center/cluster-assistants")).body.assistants.find((entry) => entry.id === mine.id));
    assert.deepEqual([theirs.name, theirs.clusterName, theirs.local, theirs.canManage, theirs.instructions], ["Poster", "Team", false, false, null]);
    assert.equal(theirs.machineName, mine.machineName);
    for (const [method, route, body] of [["PUT", `/control-center/cluster-assistants/${mine.id}`, { name: "Mine now", instructions: "x" }], ["DELETE", `/control-center/cluster-assistants/${mine.id}`, undefined], ["GET", `/control-center/cluster-assistants/${mine.id}/audit`, undefined]] as const) {
      assert.equal((await api(member, onMember, method, route, body)).status, 404, `${method} from a machine that does not host it`);
    }

    // The member asks their own Bob; Bob asks the assistant on its host, which answers as itself.
    const key = await api<{ account: { id: string } }>(member, onMember, "POST", "/secrets/accounts", { label: "decision", provider: "custom", variables: [{ name: "TYPESAFE_AI_API_KEY", kind: "value", value: "test-key" }] });
    assert.equal((await api(member, onMember, "PUT", `/secrets/scopes/project/${member.projects[0].id}`, { accountIds: [key.body.account.id] })).status, 200);
    // (A dev node has no model for Bob's own words, so his reply fails after the assistant has answered; the ask is what is checked.)
    await api(member, onMember, "POST", "/control-center/bob/message", { message: "ask the poster to draft this week's post" });
    assert.ok(classifier.asked.some((question) => question.includes('"Poster"') && question.includes('assistant of the cluster \'Team\'')), "the member's Bob knew it as the cluster's assistant");
    assert.equal((await readFile(askLog, "utf8")).split("\n").filter(Boolean).length, 1, "the assistant ran once, on its host");

    // A manager changes it; then the audit log says who created it, who asked it and who changed it.
    assert.equal((await api(host, onHost, "PUT", `/control-center/cluster-assistants/${mine.id}`, { name: "Team poster", instructions: "Draft only; never publish." })).status, 200);
    assert.deepEqual((await hosted()).map((entry) => [entry.name, entry.instructions]), [["Team poster", "Draft only; never publish."]]);
    const events = (await api<{ events: Event[] }>(host, onHost, "GET", `/control-center/cluster-assistants/${mine.id}/audit`)).body.events;
    assert.deepEqual(events.map((event) => event.eventType), ["cluster-assistant.changed", "cluster-assistant.asked", "cluster-assistant.created"]);
    const asked = events[1];
    assert.equal(asked.details.askerName, "maya");
    assert.match(String(asked.details.askerNodeId), /^[0-9a-f-]{36}$/, "the asking machine, proven by its signature");
    assert.notEqual(asked.actorId, events[2].actorId, "asked by another person than the one who created it");
    assert.deepEqual([events[0].details.renamed, events[0].details.instructionsChanged], [true, true]);
    assert.equal(JSON.stringify(events).includes("draft this week's post"), false, "the log says who asked and why, not what was said");

    // Deleted by a manager, it is gone for the member too.
    assert.equal((await api(host, onHost, "DELETE", `/control-center/cluster-assistants/${mine.id}`)).status, 200);
    assert.deepEqual(await hosted(), []);
  } finally {
    for (const child of children) await stopDevNode(child);
    await new Promise<void>((resolve) => classifier.server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
