import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listProjectWorktrees, WORKTREE_META_DIR, worktreeConversations, worktreeScanUse, worktreeSessionPaths } from "../src/project-worktrees.ts";

/* A project's worktree folders are read once for the list, the conversation index and the paths,
   and kept while the folders stand still. These tests hold the two halves of that: nothing is read
   again while nothing changed, and every change is seen by the very next call. */

const PROJECT = "scan-project";

async function worktree(root: string, name: string, createdAt: string, node = "node-a"): Promise<{ id: string; folder: string; meta: string }> {
  const id = randomUUID(), folder = path.join(root, PROJECT, id), meta = path.join(folder, WORKTREE_META_DIR);
  await mkdir(path.join(meta, "nodes"), { recursive: true });
  await mkdir(path.join(meta, "conversations"), { recursive: true });
  await writeFile(path.join(meta, "worktree.json"), JSON.stringify({ version: 1, id, name, color: "teal", createdAt, createdByNodeId: node, baselineDigest: "digest", lastMergedAt: null }));
  await writeFile(path.join(meta, "nodes", `${node}.json`), JSON.stringify({ path: folder }));
  return { id, folder, meta };
}

/** Everything under the project's folder last changed a minute ago: nothing was written "in the same moment" as a reading. */
async function settle(root: string): Promise<void> {
  const past = new Date(Date.now() - 60_000);
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(file);
      await utimes(file, past, past);
    }
    await utimes(folder, past, past);
  };
  await walk(path.join(root, PROJECT));
}

async function fixture(context: { after: (cleanup: () => Promise<void>) => void }): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-worktree-scan-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("worktree folders that did not change are read once, however many lists, indexes and paths are asked for", async (context) => {
  const root = await fixture(context);
  const first = await worktree(root, "First", "2026-01-01T00:00:00.000Z"), second = await worktree(root, "Second", "2026-01-02T00:00:00.000Z");
  await writeFile(path.join(first.meta, "conversations", "claude--abc.json"), "{}");
  await settle(root);

  const before = worktreeScanUse();
  const listed = await listProjectWorktrees(PROJECT, root);
  assert.deepEqual(listed.map((entry) => entry.name), ["First", "Second"]);
  for (let round = 0; round < 5; round++) {
    assert.deepEqual((await listProjectWorktrees(PROJECT, root)).map((entry) => entry.id), [first.id, second.id]);
    const { worktrees, index } = await worktreeConversations(PROJECT, root);
    assert.equal(index.get("claude:abc")?.id, first.id);
    assert.equal(index.get("claude:abc"), worktrees[0], "the index names the same objects the list holds");
    assert.deepEqual((await worktreeSessionPaths(PROJECT, root)).sort(), [first.folder, second.folder].sort());
  }
  const use = worktreeScanUse();
  assert.equal(use.read - before.read, 1, "the folders are read once");
  assert.equal(use.looked - before.looked, 16, "and looked at on every call");
});

test("a change to a worktree is seen by the next call, whichever file it was", async (context) => {
  const root = await fixture(context);
  const first = await worktree(root, "First", "2026-01-01T00:00:00.000Z");
  await settle(root);
  assert.equal((await listProjectWorktrees(PROJECT, root)).length, 1);

  // A conversation started inside it.
  await writeFile(path.join(first.meta, "conversations", "pi--new-one.json"), "{}");
  assert.equal((await worktreeConversations(PROJECT, root)).index.get("pi:new-one")?.id, first.id);

  // Another node registered where it keeps the worktree.
  await writeFile(path.join(first.meta, "nodes", "node-b.json"), JSON.stringify({ path: `/other/worktrees/${PROJECT}/${first.id}` }));
  assert.ok((await worktreeSessionPaths(PROJECT, root)).includes(`/other/worktrees/${PROJECT}/${first.id}`));

  // It was renamed, written in place as file sync may do.
  await writeFile(path.join(first.meta, "worktree.json"), JSON.stringify({ version: 1, id: first.id, name: "Renamed", color: "violet", createdAt: "2026-01-01T00:00:00.000Z", createdByNodeId: "node-a", baselineDigest: "digest", lastMergedAt: null }));
  assert.deepEqual((await listProjectWorktrees(PROJECT, root)).map((entry) => [entry.name, entry.color]), [["Renamed", "violet"]]);

  // A new worktree arrived, and one was retired.
  const second = await worktree(root, "Second", "2026-01-02T00:00:00.000Z");
  assert.deepEqual((await listProjectWorktrees(PROJECT, root)).map((entry) => entry.name), ["Renamed", "Second"]);
  const retired = randomUUID();
  await mkdir(path.join(root, PROJECT, ".retired"), { recursive: true });
  await writeFile(path.join(root, PROJECT, ".retired", `${retired}.json`), JSON.stringify([`/gone/${retired}`]));
  const paths = await worktreeSessionPaths(PROJECT, root);
  assert.ok(paths.includes(`/gone/${retired}`) && paths.includes(path.join(root, PROJECT, retired)));

  // It was deleted.
  await rm(second.folder, { recursive: true, force: true });
  assert.deepEqual((await listProjectWorktrees(PROJECT, root)).map((entry) => entry.name), ["Renamed"]);
  assert.ok(!(await worktreeSessionPaths(PROJECT, root)).includes(second.folder));
});

test("a change made while the folders are being read is seen by the call that follows it", async (context) => {
  const root = await fixture(context);
  for (let index = 0; index < 40; index++) await worktree(root, `Worktree ${index}`, new Date(1_767_225_600_000 + index * 1000).toISOString());
  await settle(root);
  const inFlight = listProjectWorktrees(PROJECT, root);
  const late = await worktree(root, "Late", "2027-01-01T00:00:00.000Z");
  // Asked while the first reading runs: it must not be handed that reading, which may have passed the new folder.
  const after = await listProjectWorktrees(PROJECT, root);
  assert.ok(after.some((entry) => entry.id === late.id));
  assert.ok((await inFlight).length >= 40);
});

test("what a caller does to its list never reaches the next caller, and a broken retired record fails only the paths", async (context) => {
  const root = await fixture(context);
  const first = await worktree(root, "First", "2026-01-01T00:00:00.000Z");
  await settle(root);
  const mine = await listProjectWorktrees(PROJECT, root);
  mine[0].name = "Changed by the caller"; mine.length = 0;
  assert.deepEqual((await listProjectWorktrees(PROJECT, root)).map((entry) => entry.name), ["First"]);

  await mkdir(path.join(root, PROJECT, ".retired"), { recursive: true });
  await writeFile(path.join(root, PROJECT, ".retired", `${randomUUID()}.json`), JSON.stringify(["relative/path"]));
  await assert.rejects(worktreeSessionPaths(PROJECT, root), /Invalid retired worktree paths/);
  assert.equal((await listProjectWorktrees(PROJECT, root))[0].id, first.id, "the list does not read retired records");
  assert.deepEqual(await listProjectWorktrees("no-such-project", root), []);
  assert.deepEqual(await worktreeSessionPaths("no-such-project", root), []);
});
