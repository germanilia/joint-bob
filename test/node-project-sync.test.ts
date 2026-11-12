import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openNodeDatabase } from "../src/node-database.js";

async function withStore(run: (root: string, store: typeof import("../src/store.js")) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "master-bob-node-sync-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  try {
    const moduleUrl = new URL(`../src/store.ts?node-sync=${Date.now()}-${Math.random()}`, import.meta.url);
    await run(root, await import(moduleUrl.href));
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("project records migrate from JSON into machine-local SQLite", async () => {
  await withStore(async (root, store) => {
    const dataDir = path.join(root, "data");
    const localPath = path.join(root, "projects", "julian");
    await mkdir(dataDir, { recursive: true });
    await mkdir(localPath, { recursive: true });
    const legacy = { projects: [{ id: "shared-julian", name: "julian", path: localPath, macPath: "/remote/julian", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }] };
    await writeFile(path.join(dataDir, "projects.json"), JSON.stringify(legacy));

    const projects = await store.listProjects();

    assert.equal(projects[0].path, localPath);
    assert.equal(projects[0].id, "shared-julian");
    assert.equal((await readFile(path.join(dataDir, "projects.json"), "utf8")), JSON.stringify(legacy));
    assert.equal((await readFile(path.join(dataDir, "node.db"))).subarray(0, 15).toString(), "SQLite format 3");
  });
});

test("explicit import mapping preserves shared identity and local path", async () => {
  await withStore(async (root, store) => {
    const localPath = path.join(root, "mapped", "julian");
    await mkdir(localPath, { recursive: true });
    const remote = {
      id: "shared-julian",
      name: "julian",
      path: "/srv/projects/sample",
      syncFolderId: "julian",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    };

    const imported = await store.importProject(remote, localPath);
    const originalSourcePath = "/Users/example/Work/sample";
    const reimported = await store.importProject({ ...remote, macPath: originalSourcePath });

    assert.equal(imported.id, remote.id);
    assert.equal(imported.path, localPath);
    assert.equal(imported.macPath, remote.path);
    assert.equal(imported.syncFolderId, "julian");
    assert.equal(reimported.path, localPath);
    assert.equal(reimported.macPath, originalSourcePath);
    assert.equal((await store.listProjects()).length, 1);
  });
});

test("importing a legacy project matched by sync folder keeps the local ID and records its source", async () => {
  await withStore(async (root, store) => {
    const localPath = path.join(root, "node-local", "demo");
    await mkdir(localPath, { recursive: true });
    await store.importProject({
      id: "local-id",
      name: "demo",
      path: "/node-local/demo",
      syncFolderId: "shared-folder",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }, localPath);

    const imported = await store.importProject({
      id: "remote-id",
      name: "demo",
      path: "/node-remote/demo",
      syncFolderId: "shared-folder",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    }, undefined, "node-remote");

    assert.equal(imported.id, "local-id");
    assert.equal(imported.path, localPath);
    assert.deepEqual(imported.locations, [{ nodeId: "node-remote", path: "/node-remote/demo" }]);
    assert.equal((await store.getProject("remote-id"))?.id, "local-id");
    assert.equal(await store.canonicalProjectId("remote-id"), "local-id");

    const reloaded = await import(new URL(`../src/store.ts?node-sync-reload=${Date.now()}-${Math.random()}`, import.meta.url).href);
    assert.equal((await reloaded.getProject("remote-id"))?.id, "local-id");
    await reloaded.removeProject("remote-id");
    assert.equal((await reloaded.getProject("local-id")), undefined);
    assert.equal(await reloaded.canonicalProjectId("remote-id"), undefined);
  });
});

test("legacy owner orphan retires once on startup; missing remote metadata stays live", async () => {
  await withStore(async (root, store) => {
    const owner = await store.addProject("legacy owner", path.join(root, "owner"));
    const remote = await store.addProject("awaiting metadata", path.join(root, "remote"));
    const db = openNodeDatabase(path.join(root, "data", "node.db"));
    const remoteId = randomUUID();
    db.prepare("UPDATE sharing_resource_owners SET owner_node_id=? WHERE kind='project' AND resource_id=?").run(remoteId, remote.id);
    db.prepare("UPDATE cluster_v2_resource_policy SET owner_node_id=? WHERE kind='project' AND resource_id=?").run(remoteId, remote.id);
    db.prepare("DELETE FROM projects WHERE id IN (?,?)").run(owner.id, remote.id);
    db.close();
    const reload = () => import(new URL(`../src/store.ts?orphan=${Math.random()}`, import.meta.url).href);
    await (await reload()).listProjects();
    const inspect = openNodeDatabase(path.join(root, "data", "node.db"));
    const state = (id: string) => inspect.prepare("SELECT generation,deleted FROM cluster_v2_resource_policy WHERE kind='project' AND resource_id=?").get(id) as {generation:number;deleted:number};
    assert.deepEqual({ ...state(owner.id) }, { generation: 2, deleted: 1 });
    assert.deepEqual({ ...state(remote.id) }, { generation: 1, deleted: 0 });
    await (await reload()).listProjects();
    assert.deepEqual({ ...state(owner.id) }, { generation: 2, deleted: 1 });
    inspect.close();
  });
});

test("delivery failure rolls back owner deletion; replica removal cannot sign owner deletion", async () => {
  await withStore(async (root, store) => {
    const { getClusterNode } = await import("../src/cluster.js");
    const { applyTwinCertificate, confirmTwinAcceptance, createTwinInvitation, prepareTwinAcceptance } = await import("../src/cluster-twins.js");
    const local = await getClusterNode();
    await store.listProjects();
    const db = openNodeDatabase(path.join(root, "data", "node.db"));
    const peer = randomUUID(), peerDb = new DatabaseSync(":memory:");
    const invite = createTwinInvitation(db, local.id);
    const acceptance = prepareTwinAcceptance(peerDb, peer, invite, invite.body.inviter.fingerprint);
    applyTwinCertificate(peerDb, peer, confirmTwinAcceptance(db, local.id, acceptance, invite.secret));
    const owner = await store.addProject("owner", path.join(root, "owner"));
    db.exec("CREATE TRIGGER fail_delete_delivery BEFORE INSERT ON cluster_v2_resource_deliveries BEGIN SELECT RAISE(ABORT,'delivery failed'); END");
    await assert.rejects(store.removeProject(owner.id), /delivery failed/);
    assert.ok(await store.getProject(owner.id));
    assert.deepEqual({ ...db.prepare("SELECT generation,deleted FROM cluster_v2_resource_policy WHERE resource_id=?").get(owner.id) }, { generation: 1, deleted: 0 });
    db.exec("DROP TRIGGER fail_delete_delivery");
    const replica = await store.addProject("replica", path.join(root, "replica"));
    const remote = randomUUID();
    db.prepare("UPDATE sharing_resource_owners SET owner_node_id=? WHERE kind='project' AND resource_id=?").run(remote, replica.id);
    db.prepare("UPDATE cluster_v2_resource_policy SET owner_node_id=? WHERE kind='project' AND resource_id=?").run(remote, replica.id);
    await store.removeProject(replica.id);
    assert.equal(await store.getProject(replica.id), undefined);
    assert.deepEqual({ ...db.prepare("SELECT generation,deleted FROM cluster_v2_resource_policy WHERE resource_id=?").get(replica.id) }, { generation: 1, deleted: 0 });
    assert.equal(db.prepare("SELECT 1 FROM cluster_v2_resource_deletions WHERE resource_id=?").get(replica.id), undefined);
    db.close(); peerDb.close();
  });
});

test("project keeps paths from three nodes without changing its local path", async () => {
  await withStore(async (root, store) => {
    const localPath = path.join(root, "node-b", "demo");
    await mkdir(localPath, { recursive: true });
    const base = {
      id: "shared-demo",
      name: "demo",
      syncFolderId: "demo-folder",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    };

    await store.importProject({ ...base, path: "/node-a/demo" }, localPath, "node-a");
    await store.importProject({ ...base, path: "/node-c/demo", locations: [{ nodeId: "node-a", path: "/node-a/demo" }] }, undefined, "node-c");

    const project = (await store.listProjects())[0];
    assert.equal(project.path, localPath);
    assert.deepEqual(project.locations, [
      { nodeId: "node-a", path: "/node-a/demo" },
      { nodeId: "node-c", path: "/node-c/demo" },
    ]);
  });
});

test("an unmapped project cannot be imported without an explicit local path", async () => {
  await withStore(async (_root, store) => {
    await assert.rejects(
      store.importProject({ id: "shared", name: "demo", path: "/remote/demo", syncFolderId: "demo", createdAt: "now", updatedAt: "now" }),
      /local folder mapping/i,
    );
  });
});

test("removing a project deletes the secret accounts it owns along with their files", async () => {
  await withStore(async (root, store) => {
    const tag = `${Date.now()}-${Math.random()}`;
    const secrets = await import(new URL(`../src/secrets.ts?owned-delete=${tag}`, import.meta.url).href) as typeof import("../src/secrets.js");
    const project = await store.addProject("owned", path.join(root, "owned"));
    const owned = await secrets.saveSecretAccount({ label: "Owned", provider: "google", projectId: project.id, variables: [{ name: "GOOGLE_APPLICATION_CREDENTIALS", kind: "file", value: "{}" }] });
    const global = await secrets.saveSecretAccount({ label: "Global", provider: "custom", variables: [{ name: "G", kind: "value", value: "g" }] });
    await secrets.setScopeSecretAccounts("project", project.id, [owned.id, global.id]);
    const filePath = secrets.genericSecretEnvironment(project.id).GOOGLE_APPLICATION_CREDENTIALS!;
    await readFile(filePath, "utf8");

    await store.removeProject(project.id);

    assert.deepEqual((await secrets.listSecretAccounts()).map((account) => account.id), [global.id]);
    await assert.rejects(readFile(filePath, "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  });
});
