import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { watchTree } from "../src/tree-watch.ts";

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// One watch per folder, as used on Linux, where the system's recursive watch re-reads a folder on every created entry.
test("a per-folder tree watch reports files in the root, in folders there at the start, and in folders made later", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "jb-tree-watch-")));
  await mkdir(path.join(root, "existing", "deep"), { recursive: true });
  await writeFile(path.join(root, "existing", "old.jsonl"), "{}\n");
  const seen = new Set<string>();
  const watcher = watchTree(root, (_event, file) => { if (file) seen.add(file); }, true);
  watcher.on("error", (error) => { throw error; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await writeFile(path.join(root, "top.jsonl"), "{}\n");
    await until(() => seen.has("top.jsonl"), "a file created in the root");

    await appendFile(path.join(root, "existing", "old.jsonl"), "{}\n");
    await until(() => seen.has(path.join("existing", "old.jsonl")), "a write to a file in a folder there at the start");

    await writeFile(path.join(root, "existing", "deep", "new.jsonl"), "{}\n");
    await until(() => seen.has(path.join("existing", "deep", "new.jsonl")), "a file created two folders down");

    await mkdir(path.join(root, "later", "inner"), { recursive: true });
    await writeFile(path.join(root, "later", "inner", "first.jsonl"), "{}\n");
    await until(() => seen.has(path.join("later", "inner", "first.jsonl")), "a file in a folder made after the watch began");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await writeFile(path.join(root, "later", "inner", "second.jsonl"), "{}\n");
    await until(() => seen.has(path.join("later", "inner", "second.jsonl")), "a later file in that folder");

    await rename(path.join(root, "later"), path.join(root, "moved"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    await writeFile(path.join(root, "moved", "inner", "third.jsonl"), "{}\n");
    await until(() => seen.has(path.join("moved", "inner", "third.jsonl")), "a file in a folder after it was renamed");

    await rm(path.join(root, "existing"), { recursive: true });
    await writeFile(path.join(root, "after-removal.jsonl"), "{}\n");
    await until(() => seen.has("after-removal.jsonl"), "a file created after a watched folder was removed");
  } finally { watcher.close(); await rm(root, { recursive: true, force: true }); }
});

test("a per-folder tree watch refuses a root that is not there, like fs.watch", () => {
  assert.throws(() => watchTree(path.join(os.tmpdir(), "jb-tree-watch-missing", "nowhere"), () => undefined, true), /ENOENT/);
});
