import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { buildSkillBundle, MAX_SKILL_BYTES, skillDigest } from "../src/skill-sharing.js";
import { countingFileCalls } from "./file-call-counter.js";

const roots: string[] = [];
after(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); });

const manifest = "---\nname: portable\ndescription: A portable test skill\n---\nInstructions\n";

async function skill(files: Record<string, string>): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "skill-digest-")));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), contents);
  }
  return root;
}

/**
 * A digest is kept only for a folder nothing touched in the last two seconds. Tests write their
 * files a moment before asking, so they move the clock a minute ahead instead of waiting.
 */
function aMinuteLater(t: TestContext): void {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 60_000 });
}

/**
 * With the clock moved ahead, the two-second rule no longer separates two writes made in one tick
 * of the file system's clock. A pause longer than any such tick does.
 */
const nextTick = (): Promise<void> => sleep(30);

const fresh = async (root: string, name = "portable"): Promise<string> => (await buildSkillBundle(root, name)).digest;

test("an unchanged skill is hashed once: asking again reads no file", async (t) => {
  const root = await skill({ "SKILL.md": manifest, "scripts/run.sh": "#!/bin/sh\necho ok\n", "docs/deep/note.md": "note" });
  aMinuteLater(t);
  const first = await countingFileCalls(root, () => skillDigest(root, "portable"));
  assert.equal(first.result, await fresh(root));
  assert.deepEqual(first.read.sort(), ["SKILL.md", "docs/deep/note.md", "scripts/run.sh"]);
  for (let round = 0; round < 3; round++) {
    const again = await countingFileCalls(root, () => skillDigest(root, "portable"));
    assert.equal(again.result, first.result);
    assert.deepEqual(again.read, [], "no file content is read while the folder looks the same");
  }
});

test("every kind of change on disk gives the new digest on the very next request", async (t) => {
  const root = await skill({ "SKILL.md": manifest, "notes.txt": "aaaa", "scripts/run.sh": "#!/bin/sh\necho ok\n", "old.txt": "old" });
  aMinuteLater(t);
  const file = (name: string): string => path.join(root, name);
  const anHourAgo = Math.floor(Date.now() / 1000) - 3600;
  const changes: Array<[string, () => Promise<unknown>, boolean?]> = [
    ["same size, other content", () => writeFile(file("notes.txt"), "bbbb")],
    ["other size", () => writeFile(file("notes.txt"), "longer content")],
    ["a file added", () => writeFile(file("added.txt"), "new")],
    ["a file added in a new folder", async () => { await mkdir(file("extra/deep"), { recursive: true }); await writeFile(file("extra/deep/more.md"), "more"); }],
    ["a file removed", () => rm(file("old.txt"))],
    ["a file renamed", () => rename(file("added.txt"), file("renamed.txt"))],
    ["a file made executable", () => chmod(file("scripts/run.sh"), 0o755)],
    // Only the times move: the digest stays, and it is worked out again rather than assumed.
    ["a modification time set back an hour", () => utimes(file("notes.txt"), anHourAgo, anHourAgo), true],
    // What a tool that restores times leaves behind: other content, same size, same modification time.
    ["same size, modification time put back", async () => {
      await writeFile(file("notes.txt"), "LONGER CONTENT");
      await utimes(file("notes.txt"), anHourAgo, anHourAgo);
      const now = await lstat(file("notes.txt"));
      assert.deepEqual([now.size, now.mtimeMs], [14, anHourAgo * 1000]);
    }],
    ["the manifest edited", () => writeFile(file("SKILL.md"), manifest + "More instructions\n")],
    // The same bytes in a new file.
    ["a file replaced by an equal copy", async () => { await writeFile(file("copy.tmp"), "LONGER CONTENT"); await rename(file("copy.tmp"), file("notes.txt")); }, true],
  ];
  let digest = await skillDigest(root, "portable");
  for (const [what, change, sameContent] of changes) {
    await nextTick();
    await change();
    const next = await countingFileCalls(root, () => skillDigest(root, "portable"));
    assert.equal(next.result, await fresh(root), what);
    assert.ok(next.read.length > 0, `${what}: the files are read again`);
    if (sameContent) assert.equal(next.result, digest, what); else assert.notEqual(next.result, digest, what);
    digest = next.result;
    const again = await countingFileCalls(root, () => skillDigest(root, "portable"));
    assert.equal(again.result, digest, what);
    assert.deepEqual(again.read, [], `${what}: kept again once read`);
  }
});

test("a folder changed a moment ago is read on every request until two seconds have passed", async (t) => {
  const root = await skill({ "SKILL.md": manifest, "notes.txt": "aaaa" });
  for (let round = 0; round < 2; round++) {
    const soon = await countingFileCalls(root, () => skillDigest(root, "portable"));
    assert.equal(soon.result, await fresh(root));
    assert.ok(soon.read.length > 0, "a write in the same clock tick could hide behind unchanged times, so nothing is kept yet");
  }
  aMinuteLater(t);
  assert.ok((await countingFileCalls(root, () => skillDigest(root, "portable"))).read.length > 0, "the first request after it settled reads the files");
  assert.deepEqual((await countingFileCalls(root, () => skillDigest(root, "portable"))).read, []);
});

test("a skill that cannot be bundled fails the same way without being read again, until it is repaired", async (t) => {
  const root = await skill({ "SKILL.md": manifest, "big.bin": "x".repeat(MAX_SKILL_BYTES + 1) });
  aMinuteLater(t);
  await assert.rejects(skillDigest(root, "portable"), /Skill bundle exceeds limits/);
  const again = await countingFileCalls(root, () => skillDigest(root, "portable").then(() => "digest", (error: Error) => error.message));
  assert.equal(again.result, "Skill bundle exceeds limits");
  assert.deepEqual(again.read, []);
  await rm(path.join(root, "big.bin"));
  assert.equal(await skillDigest(root, "portable"), await fresh(root));

  await symlink(path.join(root, "SKILL.md"), path.join(root, "link.md"));
  await assert.rejects(skillDigest(root, "portable"), /symbolic links/);
  await assert.rejects(skillDigest(root, "portable"), /symbolic links/);
  await rm(path.join(root, "link.md"));
  assert.equal(await skillDigest(root, "portable"), await fresh(root));

  // The same folder under another name is another question: its SKILL.md names a different skill.
  await assert.rejects(skillDigest(root, "other-name"), /Invalid SKILL\.md metadata/);
  await assert.rejects(skillDigest(root, "other-name"), /Invalid SKILL\.md metadata/);
  assert.equal(await skillDigest(root, "portable"), await fresh(root));
});

test("files a bundle leaves out do not change the digest", async (t) => {
  const root = await skill({ "SKILL.md": manifest, "node_modules/dep/index.js": "one", "run.log": "line\n" });
  aMinuteLater(t);
  const digest = await skillDigest(root, "portable");
  await nextTick();
  await writeFile(path.join(root, "node_modules/dep/index.js"), "two");
  const inside = await countingFileCalls(root, () => skillDigest(root, "portable"));
  assert.equal(inside.result, digest);
  assert.deepEqual(inside.read, [], "a folder that is left out is not even looked into");
  await writeFile(path.join(root, ".env"), "SECRET=1");
  assert.equal(await skillDigest(root, "portable"), digest);
  assert.equal(digest, await fresh(root));
});

test("a folder that cannot be looked at is reported as buildSkillBundle reports it", async (t) => {
  const root = await skill({ "SKILL.md": manifest });
  aMinuteLater(t);
  await assert.rejects(skillDigest(path.join(root, "missing"), "portable"), { code: "ENOENT" });
  const link = path.join(root, "..", `${path.basename(root)}-link`);
  await symlink(root, link, "dir");
  roots.push(link);
  await assert.rejects(skillDigest(link, "portable"), /Skill root must be a real directory, not a symbolic link/);
  await assert.rejects(skillDigest(root, "not a name"), /Invalid skill name/);
  await assert.rejects(skillDigest(path.join(root, "SKILL.md"), "portable"), /Skill root must be a real directory/);
});

test("a folder with more entries than a skill may hold is answered by reading it, and not kept", async (t) => {
  const root = await skill({ "SKILL.md": manifest });
  await Promise.all(Array.from({ length: 2100 }, (_, index) => mkdir(path.join(root, `empty-${index}`))));
  aMinuteLater(t);
  for (let round = 0; round < 2; round++) {
    const answer = await countingFileCalls(root, () => skillDigest(root, "portable"));
    assert.equal(answer.result, await fresh(root));
    assert.deepEqual(answer.read, ["SKILL.md"]);
  }
});

test("many skills asked at once are each read once, one at a time", async (t) => {
  const parent = await skill({});
  const names = Array.from({ length: 12 }, (_, index) => `skill-${index}`);
  for (const name of names) {
    await mkdir(path.join(parent, name));
    await writeFile(path.join(parent, name, "SKILL.md"), `---\nname: ${name}\ndescription: One of many\n---\nBody ${name}\n`);
    await writeFile(path.join(parent, name, "data.txt"), name.repeat(100));
  }
  aMinuteLater(t);
  const all = (): Promise<string[]> => Promise.all(names.map((name) => skillDigest(path.join(parent, name), name)));
  const first = await countingFileCalls(parent, all);
  assert.equal(first.read.length, names.length * 2);
  // Reads of two skills never interleave: each skill's files come together.
  const order = first.read.map((file) => file.split(path.sep)[0]);
  assert.deepEqual(order.filter((name, index) => name !== order[index - 1]).length, names.length);
  for (const [index, name] of names.entries()) assert.equal(first.result[index], await fresh(path.join(parent, name), name));
  const second = await countingFileCalls(parent, all);
  assert.deepEqual(second.result, first.result);
  assert.deepEqual(second.read, []);
});
