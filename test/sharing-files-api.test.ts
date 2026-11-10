import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setPhase } from "../src/file-sync/control.js";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";

/* What two machines that share projects tell each other besides the files: where each project lies on
   the other machine (POST /api/cluster/v2/files/enroll). A machine on an older release also sends the
   device ID of its external sync tool; it is accepted and ignored. */

const ENROLL = "/api/cluster/v2/files/enroll";

function peerLocation(node: SeededNode, projectId: string, peerId: string): string | undefined {
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return (db.prepare("SELECT path FROM project_locations WHERE project_id = ? AND node_id = ?").get(projectId, peerId) as { path: string } | undefined)?.path;
  } finally { db.close(); }
}

async function until(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; !(await check());) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test("twins exchange project locations, with or without an old machine's device ID, and only for shared projects", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sharing-files-api-"));
  const children: ChildProcess[] = [];
  try {
    const environment = await seedDevEnvironment(root, 2);
    const [a, b] = environment.nodes;
    children.push(...await Promise.all([startDevNode(environment, a), startDevNode(environment, b)]));
    const relationshipId = await pairTwinNodes(environment);
    const session = await signIn(environment, a);
    const project = a.projects[0];
    const own = (await api<{ projects: Array<{ id: string; path: string }> }>(a, session, "GET", "/projects?syncStatus=false")).body.projects.find((candidate) => candidate.id === project.id)!;
    await until("the twins' own exchange of locations", () => Boolean(peerLocation(a, project.id, b.nodeId)));
    // Each twin tells the other its real location once, in its own time. One of those can still land right after a
    // request below and store the real path over the one just sent, so a request is repeated until what it sent is what
    // is stored: once the twins' own exchanges are over, nothing else writes the row.
    const sendUntilStored = async (body: Record<string, unknown>, sent: string, why?: string) => {
      for (let attempt = 1; ; attempt++) {
        const answer = await signedNodeRequest(environment, b, a, "POST", ENROLL, body);
        assert.equal(answer.status, 200, await answer.clone().text());
        assert.deepEqual(await answer.json(), { projects: [project.id], locations: [{ projectId: project.id, path: own.path }] }, why);
        if (peerLocation(a, project.id, b.nodeId) === sent) return;
        assert.ok(attempt < 10, `the location ${sent} sent by the peer was never the one stored`);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    };

    // A machine on this release sends no device ID.
    await sendUntilStored({ projects: [project.id], locations: [{ projectId: project.id, path: "/on-b/current" }] }, "/on-b/current", "the answer names this machine's location and no device");

    // One on an older release still does: the body is accepted and the device ID is not stored anywhere.
    const device = Array(8).fill("OLDPEER").join("-");
    await sendUntilStored({ deviceId: device, projects: [project.id], locations: [{ projectId: project.id, path: "/on-b/older-release" }] }, "/on-b/older-release");
    const db = new DatabaseSync(path.join(a.dataDir, "node.db"));
    try {
      assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'cluster_v2_file_enrollments'").get(), undefined, "no enrollment table is made");
    } finally { db.close(); }

    // A project this machine does not share with the sender is refused, as a project and as a location, and nothing is stored.
    const unshared = "not-shared-with-b";
    const refusedProject = await signedNodeRequest(environment, b, a, "POST", ENROLL, { projects: [project.id, unshared], locations: [] });
    assert.equal(refusedProject.status, 403);
    assert.deepEqual(await refusedProject.json(), { error: "Project is not shared with this node" });
    const refusedLocation = await signedNodeRequest(environment, b, a, "POST", ENROLL, { projects: [], locations: [{ projectId: unshared, path: "/on-b/private" }] });
    assert.equal(refusedLocation.status, 403);
    assert.equal(peerLocation(a, unshared, b.nodeId), undefined);
    assert.equal((await signedNodeRequest(environment, b, a, "POST", ENROLL, { projects: [], locations: [], folders: [] })).status, 400, "unknown fields are rejected");

    // An exchange that failed is shown on the sharing panel until the peer answers again.
    const sharing = `/twins/${relationshipId}/sharing`;
    await until("sharing to settle", async () => (await api<{ state: string }>(a, session, "GET", sharing)).body.state === "ready");
    const errors = new DatabaseSync(path.join(a.dataDir, "node.db"));
    try {
      errors.exec("PRAGMA busy_timeout = 5000");
      errors.prepare("INSERT OR REPLACE INTO cluster_v2_file_errors VALUES(?,?)").run(b.nodeId, "Project locations were not accepted (503)");
    } finally { errors.close(); }
    const failed = await api<{ state: string; error?: string }>(a, session, "GET", sharing);
    assert.deepEqual([failed.body.state, failed.body.error], ["error", "Project locations were not accepted (503)"]);
    assert.equal((await signedNodeRequest(environment, b, a, "POST", ENROLL, { projects: [project.id], locations: [] })).status, 200);
    await until("the stored error to clear", async () => (await api<{ state: string }>(a, session, "GET", sharing)).body.state === "ready");

    // A shared project whose folder is not on this machine yet gets it with the exchange, so file sync can take the
    // project over. Once this machine has taken it over, a folder that goes missing is never made again: an empty
    // one would read as every file deleted.
    const fresh = (await api<{ projects: Array<{ id: string; path: string }> }>(a, session, "GET", "/projects?syncStatus=false")).body.projects.find((candidate) => candidate.id === a.projects[1].id)!;
    await rm(fresh.path, { recursive: true, force: true });
    assert.equal((await signedNodeRequest(environment, b, a, "POST", ENROLL, { projects: [fresh.id], locations: [] })).status, 200);
    assert.equal((await stat(fresh.path)).isDirectory(), true, "the folder of a newly shared project is made");
    const phases = new DatabaseSync(path.join(a.dataDir, "node.db"));
    try {
      phases.exec("PRAGMA busy_timeout = 5000");
      setPhase(phases, fresh.id, "builtin");
    } finally { phases.close(); }
    await rm(fresh.path, { recursive: true, force: true });
    assert.equal((await signedNodeRequest(environment, b, a, "POST", ENROLL, { projects: [fresh.id], locations: [] })).status, 200);
    await assert.rejects(stat(fresh.path), { code: "ENOENT" }, "a project already on file sync keeps its missing folder missing");
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});

test("file status for a peer is ready with nothing shared and reports a stored error", async () => {
  const { sharingFilesStatus } = await import("../src/server/sharing-files.js");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE cluster_v2_resource_policy(kind TEXT NOT NULL, resource_id TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)");
    assert.deepEqual(await sharingFilesStatus(db, "local-node", "peer-node"), { ready: true });
    db.prepare("INSERT INTO cluster_v2_file_errors VALUES(?,?)").run("peer-node", "Project locations were not accepted (500)");
    assert.deepEqual(await sharingFilesStatus(db, "local-node", "peer-node"), { ready: false, error: "Project locations were not accepted (500)" });
    assert.deepEqual(await sharingFilesStatus(db, "local-node", "another-peer"), { ready: true }, "one peer's error is not another's");
  } finally { db.close(); }
});
