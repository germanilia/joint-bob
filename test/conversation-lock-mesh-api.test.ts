import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";

/** A signed machine Authorization header, as a node's own runtime would send it. */
function signedAuthorization(environment: DevEnvironment, sender: SeededNode, recipient: SeededNode, target: string): string {
  return execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { openNodeDatabase } from './src/node-database.ts';
    import {signClusterRequest} from './src/cluster-protocol.ts';
    const db=openNodeDatabase(process.env.JOINT_BOB_DATA_DIR+'/node.db');
    process.stdout.write(signClusterRequest(db,${JSON.stringify(sender.nodeId)},${JSON.stringify(recipient.nodeId)},'GET',${JSON.stringify(target)},Buffer.alloc(0)));db.close();
  `], { env: { ...process.env, HOME: environment.home, JOINT_BOB_DATA_DIR: sender.dataDir }, encoding: "utf8" });
}

// Resolves with the `ready` frame so the test can read the ownership the node published.
// The socket is a routed node session, signed by the node that serves it.
function openConversation(environment: DevEnvironment, node: SeededNode, projectId: string, sessionPath: string, sockets: WebSocket[]): Promise<Record<string, unknown>> {
  const url = new URL("/ws", node.url.replace(/^http/, "ws"));
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("sessionPath", sessionPath);
  url.searchParams.set("nodeSession", "1");
  const authorization = signedAuthorization(environment, node, node, url.pathname + url.search);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Authorization: authorization } });
    sockets.push(socket);
    const timeout = setTimeout(() => reject(new Error("WebSocket ready timed out")), 15_000);
    socket.on("message", (raw) => {
      const event = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (event.type !== "ready") return;
      clearTimeout(timeout);
      resolve(event);
    });
    socket.once("error", reject);
    socket.once("close", (code, reason) => { clearTimeout(timeout); reject(new Error(`closed ${code}: ${reason}`)); });
  });
}

// Ownership claims replicate asynchronously, so a peer only reports the lock
// once the claim event reaches it.
async function waitForOwnershipOn(environment: DevEnvironment, asker: SeededNode, node: SeededNode, sessionId: string, ownerNodeId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await signedNodeRequest(environment, asker, node, "GET", `/api/cluster/v2/runtime/sessions/ownership?engine=pi&sessionId=${encodeURIComponent(sessionId)}`);
    const ownership = (await response.json() as { ownership: { ownerNodeId: string } | null }).ownership;
    if (ownership?.ownerNodeId === ownerNodeId) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${node.url} to see the owner ${ownerNodeId}`);
}

function watchNotices(node: SeededNode, projectId: string, account: SignedIn, sockets: WebSocket[]) {
  const url = new URL("/ws", node.url.replace(/^http/, "ws"));
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("sessionPath", "watch");
  const socket = new WebSocket(url, { origin: node.url, headers: { Cookie: account.cookie } });
  sockets.push(socket);
  const events: Array<Record<string, unknown>> = [];
  socket.on("message", raw => events.push(JSON.parse(raw.toString())));
  return (type: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setInterval(() => {
      const index = events.findIndex(event => event.type === type);
      if (index === -1) return;
      clearInterval(timer);
      clearTimeout(timeout);
      resolve(events.splice(index, 1)[0]);
    }, 25);
    const timeout = setTimeout(() => { clearInterval(timer); reject(new Error(`${node.name} did not receive ${type}`)); }, 20_000);
  });
}

test("the owning node and its twin can veto takeback; silence transfers ownership", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-lock-mesh-"));
  const children: ChildProcess[] = [];
  const sockets: WebSocket[] = [];
  try {
    const environment = await seedDevEnvironment(root, 2);
    const third = await seedDevEnvironment(path.join(root, "third"), 1);
    const [homeserver, mac] = environment.nodes;
    const twin = third.nodes[0];
    const project = homeserver.projects[0];
    const transcriptPath = path.join(environment.home, ".pi", "sessions", "lock-session.jsonl");
    await writeFile(transcriptPath, `${JSON.stringify({ type: "session", version: 3, id: "lock-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: project.path })}\n${JSON.stringify({ type: "message", id: "lock-session-message", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Open this conversation" }] } })}\n`);
    for (const node of [...environment.nodes, twin]) children.push(await startDevNode(environment, node));
    await pairTwinNodes(environment);
    await pairTwinNodes({ ...environment, nodes: [homeserver, twin] });

    // The conversation has no owner yet; opening it claims ownership on this node.
    const first = await openConversation(environment, homeserver, project.id, transcriptPath, sockets);
    assert.equal(first.ownership, null, "The node that opens an unowned conversation owns it");

    await waitForOwnershipOn(environment, homeserver, mac, "lock-session", homeserver.nodeId);
    const second = await openConversation(environment, mac, project.id, transcriptPath, sockets);
    assert.deepEqual(second.ownership, { nodeId: homeserver.nodeId, nodeName: homeserver.name, status: "owned" });

    // Reopening on the owner still reports no lock.
    const reopened = await openConversation(environment, homeserver, project.id, transcriptPath, sockets);
    assert.equal(reopened.ownership, null);

    const [ownerAccount, requesterAccount, twinAccount] = await Promise.all([homeserver, mac, twin].map(node => signIn(environment, node)));
    const ownerNext = watchNotices(homeserver, project.id, ownerAccount, sockets);
    const twinNext = watchNotices(twin, project.id, twinAccount, sockets);
    await Promise.all([ownerNext("watchReady"), twinNext("watchReady")]);
    const requestTakeback = () => api<{ error?: string; ownership?: { ownerNodeId: string } }>(mac, requesterAccount, "POST", `/projects/${project.id}/sessions/take-ownership`, {
      peerId: mac.nodeId, force: true, sessionId: "lock-session", sessionPath: transcriptPath, sessionName: "Takeback fixture",
    });
    const offlineAttempt = await api<{ error: string }>(mac, requesterAccount, "POST", `/projects/${project.id}/sessions/take-ownership`, {
      peerId: mac.nodeId, offlineOwnerNodeId: homeserver.nodeId, sessionId: "lock-session", sessionPath: transcriptPath,
    });
    assert.equal(offlineAttempt.status, 409);
    assert.match(offlineAttempt.body.error, /reachable again/);

    const vetoed = requestTakeback();
    const [ownerNotice, twinNotice] = await Promise.all([ownerNext("takebackRequested"), twinNext("takebackRequested")]);
    assert.equal(ownerNotice.id, twinNotice.id);
    assert.equal(twinNotice.title, "Takeback fixture");
    const declined = await api(twin, twinAccount, "POST", `/conversation-takebacks/${twinNotice.id}/decline`);
    assert.equal(declined.status, 200, JSON.stringify(declined.body));
    assert.equal((await ownerNext("takebackClosed")).id, ownerNotice.id);
    const rejected = await vetoed;
    assert.equal(rejected.status, 409);
    assert.match(rejected.body.error!, /declined/);
    await waitForOwnershipOn(environment, homeserver, mac, "lock-session", homeserver.nodeId);

    const unanswered = requestTakeback();
    await Promise.all([ownerNext("takebackRequested"), twinNext("takebackRequested")]);
    const completed = await unanswered;
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.equal(completed.body.ownership?.ownerNodeId, mac.nodeId);
    await waitForOwnershipOn(environment, mac, homeserver, "lock-session", mac.nodeId);
  } finally {
    for (const socket of sockets) socket.terminate();
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
