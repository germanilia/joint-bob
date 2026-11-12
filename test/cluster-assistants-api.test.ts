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

interface Shared { id: string; name: string; clusterId: string; clusterName: string; machineName: string; local: boolean; canManage: boolean }
interface Event { eventType: string; actorId: string | null; details: Record<string, string | number | boolean | null> }

test("a cluster assistant: made only on its cluster's subscriptions, asked by a member through their Bob, managed from its host and from the cluster's manager machine, and audited", { timeout: 360_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cluster-assistants-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  const classifier = await decisionModel();
  try {
    // Three people, each on their own machine: alex's machine manages the cluster, maya's hosts the assistant, noa is a member.
    const alex = await seedDevEnvironment(path.join(root, "alex"), 1);
    const mayas = await seedDevEnvironment(path.join(root, "maya"), 1, { username: "maya" });
    const noas = await seedDevEnvironment(path.join(root, "noa"), 1, { username: "noa" });
    for (const other of [mayas, noas]) {
      await rm(path.join(other.home, ".pi", "sessions"), { recursive: true, force: true });
      await rm(path.join(other.home, ".claude", "projects"), { recursive: true, force: true });
    }
    const manager = alex.nodes[0], host = mayas.nodes[0], member = noas.nodes[0];
    const stubs = path.join(root, "stubs"), askLog = path.join(root, "asks.log"), responder = path.join(root, "responder.mjs"), engineLog = path.join(root, "engine.log");
    await mkdir(stubs, { recursive: true });
    await writeFile(responder, RESPONDER);
    await writeFile(engineLog, "");
    children.push(await startDevNode(alex, manager, { JOINT_BOB_TEST_ENGINE_LOG: engineLog }));
    children.push(await startDevNode(mayas, host, { JOINT_BOB_TEST_ENGINE_LOG: engineLog, JOINT_BOB_TEST_AUTOMATION_DIR: stubs, JOINT_BOB_AUTO_RESPONDER: responder, JOINT_BOB_TEST_ASK_LOG: askLog, JOINT_BOB_TEST_ASK_ANSWER: "The draft is ready: Hello team." }));
    children.push(await startDevNode(noas, member, { JOINT_BOB_TEST_ENGINE_LOG: engineLog, JOINT_BOB_TYPESAFE_ENDPOINT: classifier.url }));
    const [onManager, onHost, onMember] = await Promise.all([signIn(alex, manager), signIn(mayas, host), signIn(noas, member)]);

    const created = await api<{ snapshot: { body: { clusterId: string } } }>(manager, onManager, "POST", "/clusters", { name: "Team" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const clusterId = created.body.snapshot.body.clusterId;
    for (const [node, session] of [[host, onHost], [member, onMember]] as const) {
      const invitation = await api<{ link: string }>(manager, onManager, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
      assert.equal((await api(node, session, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() })).status, 201);
    }

    // Maya asks her Bob for an assistant for the cluster. Its agent is Claude here.
    assert.equal((await api(host, onHost, "PUT", "/control-center/bob/settings", { harnessId: "claude" })).status, 200);
    await writeFile(path.join(stubs, "organize.json"), JSON.stringify({ intent: "create-assistant", name: "Poster", purpose: "draft posts for the team account", cluster: clusterId }));
    const ask = async () => (await api<{ reply: BobMessage }>(host, onHost, "POST", "/control-center/bob/message", { message: "create an assistant for the Team cluster that drafts posts for the team account" })).body.reply;
    const press = (offer: BobMessage) => api<{ messages?: BobMessage[]; error?: string }>(host, onHost, "POST", "/control-center/bob/action", { messageId: offer.id, actionId: "organize.run" });
    const offer = await ask();
    assert.match(offer.text, /^Create the assistant "Poster" for the cluster "Team", hosted on this machine\? Everyone in the cluster can ask it through their own Bob/);
    assert.deepEqual(offer.actions.map((action) => action.label), ["Create for the cluster", "Cancel"]);

    // The cluster has no subscription for it yet, so it is not made: it would otherwise run on Maya's own.
    const refused = await press(offer);
    assert.match(JSON.stringify(refused.body), /A cluster assistant runs only on its cluster's subscriptions, and \\"Team\\" has none for this agent\. Choose a profile or pool for the cluster/);
    assert.deepEqual((await api<{ assistants: unknown[] }>(host, onHost, "GET", "/control-center/cluster-assistants")).body.assistants, []);
    assert.equal((await api<{ projects: Array<{ name: string }> }>(host, onHost, "GET", "/projects")).body.projects.some((project) => project.name.startsWith("Assistants")), false, "nothing was made or shared");

    // Maya chooses a profile for the cluster (a Cluster exception); then Bob makes it.
    const profile = await api<{ profile: { id: string } }>(host, onHost, "POST", "/provider-profiles", { provider: "claude", label: "Team Claude" });
    assert.equal(profile.status, 201, JSON.stringify(profile.body));
    const credentials = path.join(host.dataDir, "provider-profile-auth", profile.body.profile.id);
    await mkdir(credentials, { recursive: true });
    await writeFile(path.join(credentials, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 86_400_000 } }));
    const chosen = await api(host, onHost, "PUT", "/provider-profiles/selection", { provider: "claude", scope: "cluster", scopeId: clusterId, profileId: profile.body.profile.id });
    assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
    const pressed = await press(await ask());
    assert.equal(pressed.status, 200, JSON.stringify(pressed.body));
    assert.match(pressed.body.messages![0].text, /^Created "Poster" for the cluster "Team" and started its setup in Assistants · Team\./);

    // It lives in the cluster's own project, shared with the cluster, and its setup turn ran (on the cluster's profile: no other is allowed).
    const projects = (await api<{ projects: Array<{ id: string; name: string }> }>(host, onHost, "GET", "/projects")).body.projects;
    const project = projects.find((candidate) => candidate.name === "Assistants · Team")!;
    assert.ok(project, "the cluster's assistants project");
    assert.equal(projects.some((candidate) => candidate.name === "Assistants"), false, "the person's private Assistants project is not used");
    assert.ok((await api<{ projectIds: string[] }>(host, onHost, "GET", `/clusters/${clusterId}/sharing`)).body.projectIds.includes(project.id), "shared with the cluster");
    await until("its setup turn to run on the host", async () => (await readFile(engineLog, "utf8")).split("\n").some((line) => line.startsWith("claude:")));
    await until("Bob to find it ready", async () => (await api<{ messages: BobMessage[] }>(host, onHost, "GET", "/control-center/bob/messages")).body.messages.find((message) => message.via === "Delegated to Bob · ready for review"));

    // Who may manage it: its creator on the host, the manager machine's admin from there, and not a plain member.
    const list = async (node: typeof host, session: typeof onHost) => (await api<{ assistants: Shared[] }>(node, session, "GET", "/control-center/cluster-assistants")).body.assistants;
    const [mine] = await list(host, onHost);
    assert.deepEqual([mine.name, mine.clusterName, mine.local, mine.canManage], ["Poster", "Team", true, true]);
    const seen = async (node: typeof host, session: typeof onHost) => until("the cluster assistant to be listed", async () => (await list(node, session)).find((entry) => entry.id === mine.id));
    assert.deepEqual([(await seen(manager, onManager)).local, (await seen(manager, onManager)).canManage], [false, true], "the cluster's manager machine");
    const theirs = await seen(member, onMember);
    assert.deepEqual([theirs.local, theirs.canManage, theirs.machineName], [false, false, mine.machineName], "a plain member");
    for (const [method, route, body] of [["GET", "", undefined], ["PUT", "", { name: "Mine now", instructions: "x" }], ["DELETE", "", undefined], ["GET", "/audit", undefined]] as const) {
      assert.equal((await api(member, onMember, method, `/control-center/cluster-assistants/${mine.id}${route}`, body)).status, 404, `${method} ${route} from a plain member`);
    }

    // The member asks their own Bob; Bob asks the assistant on its host, which answers as itself.
    // (A dev node has no model for Bob's own words, so his reply fails after the assistant has answered; the ask is what is checked.)
    const key = await api<{ account: { id: string } }>(member, onMember, "POST", "/secrets/accounts", { label: "decision", provider: "custom", variables: [{ name: "TYPESAFE_AI_API_KEY", kind: "value", value: "test-key" }] });
    assert.equal((await api(member, onMember, "PUT", `/secrets/scopes/project/${member.projects[0].id}`, { accountIds: [key.body.account.id] })).status, 200);
    await api(member, onMember, "POST", "/control-center/bob/message", { message: "ask the poster to draft this week's post" });
    assert.ok(classifier.asked.some((question) => question.includes('"Poster"') && question.includes("assistant of the cluster 'Team'")), "the member's Bob knew it as the cluster's assistant");
    assert.equal((await readFile(askLog, "utf8")).split("\n").filter(Boolean).length, 1, "the assistant ran once, on its host");

    // The manager machine's admin changes it from there; the host shows the change.
    const detail = await api<{ name: string; instructions: string; skills: unknown[] }>(manager, onManager, "GET", `/control-center/cluster-assistants/${mine.id}`);
    assert.deepEqual([detail.status, detail.body.name, detail.body.skills], [200, "Poster", []]);
    assert.equal((await api(manager, onManager, "PUT", `/control-center/cluster-assistants/${mine.id}`, { name: "Team poster", instructions: "Draft only; never publish." })).status, 200);
    const after = await api<{ name: string; instructions: string }>(host, onHost, "GET", `/control-center/cluster-assistants/${mine.id}`);
    assert.deepEqual([after.body.name, after.body.instructions], ["Team poster", "Draft only; never publish."]);

    // The audit log, read from the manager machine: who created it, who asked it and who changed it, never what was said.
    const events = (await api<{ events: Event[] }>(manager, onManager, "GET", `/control-center/cluster-assistants/${mine.id}/audit`)).body.events;
    assert.deepEqual(events.map((event) => event.eventType), ["cluster-assistant.changed", "cluster-assistant.asked", "cluster-assistant.created"]);
    assert.deepEqual([events[0].details.by, events[0].details.renamed, events[0].details.instructionsChanged], ["dev", true, true]);
    assert.match(String(events[0].details.fromNodeId), /^[0-9a-f-]{36}$/, "changed from another machine, which is named");
    assert.equal(events[1].details.askerName, "noa");
    assert.match(String(events[1].details.askerNodeId), /^[0-9a-f-]{36}$/);
    assert.equal(new Set(events.map((event) => event.actorId)).size, 3, "three different people");
    assert.equal(JSON.stringify(events).includes("draft this week's post"), false, "the log says who asked and why, not what was said");

    // Without the cluster's subscription its conversation does not run at all, rather than run on Maya's own; with it back, it runs.
    const runs = async () => (await readFile(engineLog, "utf8")).split("\n").filter((line) => line.startsWith("claude:")).length;
    const ready = (await api<{ messages: BobMessage[] }>(host, onHost, "GET", "/control-center/bob/messages")).body.messages.find((message) => message.via === "Delegated to Bob · ready for review")!;
    const choose = (profileId: string | null) => api(host, onHost, "PUT", "/provider-profiles/selection", { provider: "claude", scope: "cluster", scopeId: clusterId, profileId });
    const before = await runs();
    assert.equal((await choose(null)).status, 200);
    await api(host, onHost, "POST", "/control-center/bob/reply", { messageId: ready.id, text: "one more thing" });
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    assert.equal(await runs(), before, "no turn ran without a cluster subscription");
    assert.equal((await choose(profile.body.profile.id)).status, 200);
    await api(host, onHost, "POST", "/control-center/bob/reply", { messageId: ready.id, text: "and another" });
    await until("a turn to run on the cluster's profile again", async () => await runs() > before);

    // Deleted from the manager machine, it is gone on its host.
    assert.equal((await api(manager, onManager, "DELETE", `/control-center/cluster-assistants/${mine.id}`)).status, 200);
    assert.deepEqual(await list(host, onHost), []);
  } finally {
    for (const child of children) await stopDevNode(child);
    await new Promise<void>((resolve) => classifier.server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
