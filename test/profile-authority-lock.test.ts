// A profile's authority lock must not outlive the process that took it, and must never be taken from a live holder.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withProfileAuthority } from "../src/provider-profiles/broker.js";

async function profileDir(): Promise<{ root: string; authPath: string; lock: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-authority-"));
  const authPath = path.join(root, "profile", "auth.json");
  return { root, authPath, lock: path.join(root, "profile", ".authority-lock") };
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => child.on("exit", resolve));
  return child.pid!;
}

test("a lock whose holder process is gone is cleared and taken", async () => {
  const { root, authPath, lock } = await profileDir();
  try {
    await mkdir(lock, { recursive: true });
    await writeFile(path.join(lock, "holder"), `${await deadPid()} crashed`);
    assert.equal(await withProfileAuthority(authPath, async () => "ran"), "ran");
    assert.deepEqual(await readdir(path.dirname(lock)), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an old lock without a holder, left by an earlier build, is cleared", async () => {
  const { root, authPath, lock } = await profileDir();
  try {
    await mkdir(lock, { recursive: true });
    const old = new Date(Date.now() - 5 * 60_000);
    await utimes(lock, old, old);
    assert.equal(await withProfileAuthority(authPath, async () => "ran"), "ran");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a live holder keeps its lock: others wait for it", async () => {
  const { root, authPath } = await profileDir();
  try {
    const order: string[] = [];
    let release!: () => void;
    const first = withProfileAuthority(authPath, async () => { order.push("first in"); await new Promise<void>((resolve) => { release = resolve; }); order.push("first out"); });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = withProfileAuthority(authPath, async () => { order.push("second"); });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(order, ["first in"]);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first in", "first out", "second"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a lock held by another live process is not taken", async () => {
  const { root, authPath, lock } = await profileDir();
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
  try {
    await mkdir(lock, { recursive: true });
    await writeFile(path.join(lock, "holder"), `${holder.pid} live`);
    const attempt = withProfileAuthority(authPath, async () => "ran");
    const outcome = await Promise.race([attempt.then(() => "taken"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 300))]);
    assert.equal(outcome, "waiting");
    holder.kill();
    await new Promise((resolve) => holder.on("exit", resolve));
    assert.equal(await attempt, "ran");
  } finally { holder.kill(); await rm(root, { recursive: true, force: true }); }
});
