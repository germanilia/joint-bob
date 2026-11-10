// Several agent sessions run this repository's tests on one machine. Six runs at once took a
// ten-core machine to a load of 200 on 2026-11-10; a run now waits for one of a few slots.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// @ts-expect-error a plain script without types
import { acquireTestSlot, heldSlots, slotCount } from "../scripts/test-slots.mjs";

const folder = () => mkdtempSync(path.join(os.tmpdir(), "jb-test-slots-"));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the number of slots follows the cores, the environment sets it, and CI or a nested run never waits", () => {
  assert.equal(slotCount({}, 10), 2);
  assert.equal(slotCount({}, 4), 1);
  assert.equal(slotCount({}, 2), 1, "one run at least");
  assert.equal(slotCount({ JOINT_BOB_TEST_SLOTS: "3" }, 10), 3);
  assert.equal(slotCount({ JOINT_BOB_TEST_SLOTS: "0" }, 10), 0, "0 turns the wait off");
  assert.equal(slotCount({ JOINT_BOB_TEST_SLOTS: "many" }, 10), 0, "a value that is no number does not block anyone");
  assert.equal(slotCount({ CI: "true" }, 10), 0);
  assert.equal(slotCount({ JOINT_BOB_TEST_SLOT_HELD: "1" }, 10), 0);
});

test("a run waits while the slots are taken, says so once, and starts when one is given back", async () => {
  const directory = folder();
  try {
    const lines: string[] = [];
    const first = await acquireTestSlot({ slots: 1, directory, log: (line: string) => lines.push(line), pollMs: 10 });
    assert.equal(heldSlots(directory), 1);
    let started = false;
    const waiting = acquireTestSlot({ slots: 1, directory, log: (line: string) => lines.push(line), pollMs: 10 }).then((release: () => void) => { started = true; return release; });
    await pause(150);
    assert.equal(started, false, "the second run must not start beside the first");
    assert.equal(lines.filter((line) => line.includes("Waiting for a test slot")).length, 1, "the wait is announced once, not on every look");
    first();
    const second = await waiting;
    assert.equal(started, true);
    assert.ok(lines.some((line) => line.includes("A slot is free")));
    assert.equal(heldSlots(directory), 1);
    second();
    assert.deepEqual(readdirSync(directory), [], "a finished run leaves nothing behind");
    first();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("two slots let two runs go at once and hold the third", async () => {
  const directory = folder();
  try {
    const one = await acquireTestSlot({ slots: 2, directory, log: () => {}, pollMs: 10 });
    const two = await acquireTestSlot({ slots: 2, directory, log: () => {}, pollMs: 10 });
    assert.equal(heldSlots(directory), 2);
    let third = false;
    const waiting = acquireTestSlot({ slots: 2, directory, log: () => {}, pollMs: 10 }).then((release: () => void) => { third = true; return release; });
    await pause(100);
    assert.equal(third, false);
    two();
    (await waiting)();
    one();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a slot left by a run that is gone, or that stopped renewing it, is taken over", async () => {
  const directory = folder();
  try {
    // A process that has exited: its number names nobody now.
    const gone = Number(execFileSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }));
    writeFileSync(path.join(directory, "slot-0"), `${gone}\n/somewhere\n`);
    assert.equal(heldSlots(directory), 0);
    const release = await acquireTestSlot({ slots: 1, directory, log: () => assert.fail("a dead run's slot must not make anyone wait"), pollMs: 10 });
    release();

    // A live process whose slot was not renewed for a long time (its number may have been given to another program).
    const file = path.join(directory, "slot-0");
    writeFileSync(file, `${process.pid}\n/somewhere\n`);
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(file, old, old);
    const again = await acquireTestSlot({ slots: 1, directory, log: () => assert.fail("a stale slot must not make anyone wait"), pollMs: 10 });
    assert.equal(heldSlots(directory), 1);
    again();
    assert.equal(existsSync(file), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a folder that cannot be used never blocks a run, and neither does a wait that is off", async () => {
  const directory = folder();
  try {
    const notAFolder = path.join(directory, "file");
    writeFileSync(notAFolder, "");
    (await acquireTestSlot({ slots: 1, directory: path.join(notAFolder, "slots"), log: () => assert.fail("must not wait") }))();
    (await acquireTestSlot({ slots: 0, directory, log: () => assert.fail("must not wait") }))();
    assert.deepEqual(readdirSync(directory), ["file"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
