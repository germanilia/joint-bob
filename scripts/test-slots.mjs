import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, utimesSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/* How many test runs go on at once on one machine.

   A test run starts several test files at a time, and many of those start whole Joint Bob nodes.
   One run can keep eight cores busy. Several agent sessions work on this repository at the same
   time and each runs tests when it likes: on 2026-11-10 six runs at once took a ten-core machine
   to a load of 200 and a four-core one to 20, every run timed out, and the app that the machines
   are for stopped answering. A run that waits its turn finishes sooner than one that fights five
   others for the CPU.

   So a run takes a slot first: a file in a folder every session of this user shares. When the slots
   are taken it waits and says so. A slot whose owner is gone (killed, or it stopped renewing the
   file) is taken over. Nothing here can fail a run: if the folder cannot be used, the run starts. */

const RENEW_MS = 30_000;
/** A slot not renewed for this long belongs to nobody, whatever process now has its number. */
const STALE_MS = 5 * 60_000;

/** Runs allowed at once: a quarter of the cores, one at least. JOINT_BOB_TEST_SLOTS sets it; 0 turns the wait off. */
export function slotCount(env = process.env, cores = os.availableParallelism()) {
  // CI machines run one job each, and a run started by a test of another run already holds a slot.
  if (env.CI || env.JOINT_BOB_TEST_SLOT_HELD) return 0;
  const set = env.JOINT_BOB_TEST_SLOTS;
  if (set !== undefined && set !== "") {
    const count = Number(set);
    return Number.isInteger(count) && count >= 0 ? count : 0;
  }
  return Math.max(1, Math.floor(cores / 4));
}

export function slotDirectory(env = process.env) {
  return env.JOINT_BOB_TEST_SLOT_DIR || path.join(os.homedir(), ".cache", "joint-bob", "test-slots");
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

/** Whether the slot file is held by a process that is still there and still renewing it. */
function held(file, now) {
  try {
    const owner = Number(readFileSync(file, "utf8").split("\n")[0]);
    if (!Number.isInteger(owner) || owner <= 0 || !alive(owner)) return false;
    return now - statSync(file).mtimeMs < STALE_MS;
  } catch { return false; }
}

/** Takes slot `index` if it is free, or left by a process that is gone. */
function take(directory, index, now) {
  const file = path.join(directory, `slot-${index}`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const descriptor = openSync(file, "wx", 0o600);
      try { writeSync(descriptor, `${process.pid}\n${process.cwd()}\n`); } finally { closeSync(descriptor); }
      return file;
    } catch (error) {
      if (error.code !== "EEXIST" || held(file, now)) return undefined;
      // Left behind: removed, and tried once more. Two waiting runs may both remove it; only one creates it.
      try { unlinkSync(file); } catch { /* another run was quicker */ }
    }
  }
  return undefined;
}

/** How many slots are held now, for the waiting line. */
export function heldSlots(directory = slotDirectory(), now = Date.now()) {
  try { return readdirSync(directory).filter((name) => /^slot-\d+$/.test(name) && held(path.join(directory, name), now)).length; }
  catch { return 0; }
}

/**
 * Waits for one of `slots` slots and returns a function that gives it back. Resolves at once, with
 * nothing to give back, when the wait is off or the folder cannot be used.
 */
export async function acquireTestSlot({ slots = slotCount(), directory = slotDirectory(), log = (line) => process.stderr.write(`${line}\n`), pollMs = 2_000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (!slots) return () => {};
  try { mkdirSync(directory, { recursive: true, mode: 0o700 }); } catch { return () => {}; }
  const started = Date.now();
  let said = 0;
  for (;;) {
    const now = Date.now();
    let file;
    try {
      for (let index = 0; index < slots && !file; index++) file = take(directory, index, now);
    } catch { return () => {}; }
    if (file) {
      if (said) log(`[tests] A slot is free after ${Math.round((now - started) / 1000)} s; starting.`);
      const renew = setInterval(() => { try { const at = new Date(); utimesSync(file, at, at); } catch { /* released, or taken over as stale */ } }, RENEW_MS);
      renew.unref();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        clearInterval(renew);
        try { if (Number(readFileSync(file, "utf8").split("\n")[0]) === process.pid) unlinkSync(file); } catch { /* gone already */ }
      };
    }
    if (now - said >= 60_000) {
      log(said
        ? `[tests] Still waiting for a test slot (${Math.round((now - started) / 1000)} s).`
        : `[tests] Waiting for a test slot: ${heldSlots(directory, now)} test run(s) are going on this machine and ${slots} may run at once. This run starts when one ends. JOINT_BOB_TEST_SLOTS sets the number (0: do not wait).`);
      said = now;
    }
    await sleep(pollMs + Math.floor(Math.random() * 500));
  }
}
