import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, pairTwinNodes, projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";
import type { QuickNote } from "../src/quick-notes.js";
import type { SessionSummary } from "../src/types.js";

async function eventually(check: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 45_000;
  for (;;) {
    try { await check(); return; } catch (error) { if (Date.now() >= deadline) throw error; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

test("private conversations never inherit ordinary project grants", { timeout: 150_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "private-conversation-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const home = await seedDevEnvironment(path.join(root, "home"), 2);
    const team = await seedDevEnvironment(path.join(root, "team"), 1);
    const [a, twin] = home.nodes, [peer] = team.nodes;
    for (const [env, node] of [[home, a], [home, twin], [team, peer]] as const) children.push(await startDevNode(env, node));
    await pairTwinNodes(home);
    const sa = await signIn(home, a), st = await signIn(home, twin), sp = await signIn(team, peer);
    const cluster = await api<{ snapshot: { body: { clusterId: string } } }>(a, sa, "POST", "/clusters", { name: "Shared results" });
    const clusterId = cluster.body.snapshot.body.clusterId;
    const invite = await api<{ link: string }>(a, sa, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
    assert.equal((await api(peer, sp, "POST", "/clusters/join", { link: invite.body.link, requestId: randomUUID() })).status, 201);
    const projectId = projectNamed(a, "Internal Assistant").id;
    assert.equal((await api(a, sa, "PUT", `/clusters/${clusterId}/sharing`, { projectIds: [projectId], workspaceIds: [], confirmOwnedData: true })).status, 200);
    const input = { projectId, title: "Private title canary", content: "Private prompt canary", harnessId: "pi" };
    const attached = Buffer.from("attachment canary");
    const create = await api<{ note: QuickNote }>(a, sa, "POST", "/quick-notes", { ...input, visibility: "private", images: [{ kind: "image", name: "private.png", mimeType: "image/png", data: attached.toString("base64") }] });
    assert.equal(create.status, 201, JSON.stringify(create.body));
    const id = create.body.note.id;
    const offered = await signedNodeRequest(team, peer, a, "POST", "/api/cluster/v2/quick-notes/list", { projectId });
    assert.equal(offered.status, 200);
    assert.doesNotMatch(await offered.text(), /Private (title|prompt) canary/);
    assert.equal((await signedNodeRequest(team, peer, a, "POST", "/api/cluster/v2/quick-notes/action", { id, action: "start" })).status, 404);
    const launch = await api<{ sessionId: string }>(a, sa, "POST", `/quick-notes/${id}/start`, {});
    assert.equal(launch.status, 200, JSON.stringify(launch.body));
    const sid = launch.body.sessionId;
    const privateFolder = (dataDir: string) => path.join(dataDir, "private-conversation-attachments", sid, ".joint-bob-attachments");
    const [attachment] = await readdir(privateFolder(a.dataDir));
    assert.deepEqual(await readFile(path.join(privateFolder(a.dataDir), attachment)), attached);
    const publicNote = await api<{ note: QuickNote }>(a, sa, "POST", "/quick-notes", { ...input, title: "Public by default", content: "Public" });
    assert.equal(publicNote.status, 201);
    const publicRun = await api<{ sessionId: string }>(a, sa, "POST", `/quick-notes/${publicNote.body.note.id}/start`, {});
    assert.equal(publicRun.status, 200);
    // The fixture harness accepts prompts but does not persist its own transcript.
    const sessions = path.join(home.home, ".pi", "sessions");
    await mkdir(sessions, { recursive: true });
    const timestamp = new Date().toISOString();
    await writeFile(path.join(sessions, `${sid}.jsonl`), [
      { type: "session", version: 3, id: sid, cwd: projectNamed(a, "Internal Assistant").path, timestamp },
      { type: "message", id: "first", parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: input.content }], timestamp: Date.now() } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const list = (node: typeof a, session: typeof sa) => api<{ sessions: SessionSummary[] }>(node, session, "GET", `/projects/${projectId}/sessions?all=1`);
    await eventually(async () => {
      const replica = (await list(twin, st)).body.sessions.find(session => session.id === sid);
      assert.equal(replica?.title, input.title);
      assert.equal(replica?.draft, undefined);
      assert.deepEqual(await readFile(path.join(privateFolder(twin.dataDir), attachment)), attached);
    });
    await eventually(async () => {
      const shared = await list(peer, sp);
      assert.equal(shared.status, 200);
      assert.ok(shared.body.sessions.some(session => session.id === publicRun.body.sessionId), "the public default still shares conversations");
      assert.ok(!shared.body.sessions.some(session => session.id === sid));
    });
    await assert.rejects(readdir(privateFolder(peer.dataDir)), { code: "ENOENT" });
    const query = new URLSearchParams({ projectId, engine: "pi", sessionId: sid });
    const inventory = await signedNodeRequest(team, peer, a, "GET", `/api/cluster/v2/transcripts?${query}`);
    assert.deepEqual(await inventory.json(), { entries: [] });
    assert.equal((await signedNodeRequest(team, peer, a, "GET", `/api/cluster/v2/transcripts/file?${query}`)).status, 404);
    assert.equal((await signedNodeRequest(home, twin, a, "GET", `/api/cluster/v2/transcripts/file?${query}`)).status, 404, "older clients must not pull private transcripts");
    assert.equal((await signedNodeRequest(team, peer, a, "GET", `/api/cluster/v2/transcripts/private-attachment?${query}&name=${encodeURIComponent(attachment)}`)).status, 404);
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
