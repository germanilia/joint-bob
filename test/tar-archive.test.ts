import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { readTarGzEntries, writeTarGz } from "../src/tar-archive.js";

const run = promisify(execFile);

async function scratch(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "joint-bob-tar-"));
}

test("the system's tar reads back every entry, long and non-ASCII names included", async () => {
  const root = await scratch();
  try {
    const source = path.join(root, "source"), out = path.join(root, "out");
    await mkdir(source); await mkdir(out);
    const big = Buffer.alloc(3 * 1024 * 1024 + 123);
    for (let index = 0; index < big.length; index++) big[index] = (index * 31 + (index >> 8)) & 0xff;
    await writeFile(path.join(source, "big.bin"), big);
    await writeFile(path.join(source, "empty.jsonl"), "");
    await writeFile(path.join(source, "block.txt"), "x".repeat(512));
    const long = `files/claude/${"-Users-someone-JointBob-worktrees-Mt8wA3IX3Q-".repeat(3)}/123e4567-e89b-42d3-a456-426614174000/subagents/agent-a1b2c3.jsonl`;
    assert.ok(Buffer.byteLength(long) > 155, "longer than a ustar name and prefix together");
    const unicode = "files/pi/שיחה-ארוכה-מאוד/".concat("א".repeat(60), ".jsonl");
    const entries = [
      { name: "conversation.json", data: Buffer.from(JSON.stringify({ title: "A conversation" })) },
      { name: "files/claude/big.bin", file: path.join(source, "big.bin") },
      { name: "files/claude/empty.jsonl", file: path.join(source, "empty.jsonl") },
      { name: "files/claude/block.txt", file: path.join(source, "block.txt") },
      { name: long, file: path.join(source, "block.txt") },
      { name: unicode, data: Buffer.from("שלום") },
    ];
    const archive = path.join(root, "one.tar.gz");
    const written = await writeTarGz(archive, entries);
    assert.equal(written.entries, entries.length);
    assert.ok(written.bytes > 0 && written.bytes < big.length * 2);

    assert.deepEqual(await readTarGzEntries(archive), [
      { name: "conversation.json", bytes: entries[0].data!.length }, { name: "files/claude/big.bin", bytes: big.length }, { name: "files/claude/empty.jsonl", bytes: 0 },
      { name: "files/claude/block.txt", bytes: 512 }, { name: long, bytes: 512 }, { name: unicode, bytes: 8 },
    ]);

    // GNU tar lists a name outside ASCII with its bytes escaped (\327\251…) unless the locale says otherwise; bsdtar prints it as it is.
    const asListed = (line: string): string => /\\\d{3}/.test(line) ? Buffer.from(line.replace(/\\(\d{3})/g, (_match, byte: string) => String.fromCharCode(Number.parseInt(byte, 8))), "latin1").toString("utf8") : line;
    const listed = (await run("tar", ["-tzf", archive])).stdout.trim().split("\n").map(asListed).sort();
    assert.deepEqual(listed, entries.map((entry) => entry.name).sort());

    await run("tar", ["-xzf", archive, "-C", out]);
    assert.deepEqual(await readFile(path.join(out, "files/claude/big.bin")), big);
    assert.equal((await readFile(path.join(out, "files/claude/empty.jsonl"))).length, 0);
    assert.equal(await readFile(path.join(out, long), "utf8"), "x".repeat(512));
    assert.equal(await readFile(path.join(out, unicode), "utf8"), "שלום");
    assert.deepEqual(JSON.parse(await readFile(path.join(out, "conversation.json"), "utf8")), { title: "A conversation" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an archive that cannot be completed leaves no file, and an existing file is never replaced", async () => {
  const root = await scratch();
  try {
    const archive = path.join(root, "failed.tar.gz");
    await assert.rejects(writeTarGz(archive, [{ name: "a.txt", data: Buffer.from("a") }, { name: "missing.txt", file: path.join(root, "not-there") }]), { code: "ENOENT" });
    assert.deepEqual(await readdir(root), []);

    for (const name of ["/absolute", "../up", "a//b", "a/./b", "a\\b", ""]) {
      await assert.rejects(writeTarGz(archive, [{ name, data: Buffer.from("x") }]), /cannot be named/);
    }
    assert.deepEqual(await readdir(root), []);

    await mkdir(path.join(root, "folder"));
    await assert.rejects(writeTarGz(archive, [{ name: "folder", file: path.join(root, "folder") }]), /not a regular file/);

    const kept = path.join(root, "kept.tar.gz");
    await writeFile(kept, "someone else's file");
    await assert.rejects(writeTarGz(kept, [{ name: "a.txt", data: Buffer.from("a") }]), { code: "EEXIST" });
    assert.equal(await readFile(kept, "utf8"), "someone else's file");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reading an archive back notices one that is cut short or damaged", async () => {
  const root = await scratch();
  try {
    const archive = path.join(root, "whole.tar.gz");
    await writeTarGz(archive, [{ name: "a.txt", data: Buffer.alloc(100_000, 1) }, { name: "b.txt", data: Buffer.from("b") }]);
    const whole = await readFile(archive);
    await writeFile(path.join(root, "cut.tar.gz"), whole.subarray(0, whole.length - 40));
    await assert.rejects(readTarGzEntries(path.join(root, "cut.tar.gz")));
    const { gzipSync, gunzipSync } = await import("node:zlib");
    const plain = gunzipSync(whole);
    await writeFile(path.join(root, "short.tar.gz"), gzipSync(plain.subarray(0, 1024)));
    await assert.rejects(readTarGzEntries(path.join(root, "short.tar.gz")), /cut short/);
    const damaged = Buffer.from(plain); damaged[3] ^= 0xff;
    await writeFile(path.join(root, "damaged.tar.gz"), gzipSync(damaged));
    await assert.rejects(readTarGzEntries(path.join(root, "damaged.tar.gz")), /damaged entry/);
    await writeFile(path.join(root, "not-gzip.tar.gz"), "plain text");
    await assert.rejects(readTarGzEntries(path.join(root, "not-gzip.tar.gz")));
    assert.deepEqual(await readTarGzEntries(archive), [{ name: "a.txt", bytes: 100_000 }, { name: "b.txt", bytes: 1 }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
