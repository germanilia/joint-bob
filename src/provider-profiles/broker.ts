import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** A lock without a holder file is older than this before it counts as abandoned: it was left by a build that wrote no
 * holder, and no migration, login or refresh takes this long. */
const UNRECORDED_LOCK_MS = 60_000;

/** Cross-process migration/login/logout gate, separate from the SDK refresh lock.
 * Never steal a live holder's lock on a timer: a suspended writer could otherwise reseed tokens.
 * fix: a holder that died (crash, kill, restart mid-turn) left the lock for good, and every Claude turn on that node
 * failed with "Profile authority busy" until someone removed it by hand (Mac, 2026-11-13). The lock now names its
 * holder process; a lock whose holder no longer exists is cleared by the next process that wants it.
 */
export async function withProfileAuthority<T>(authPath: string, work: () => Promise<T>): Promise<T> {
  const directory = path.dirname(authPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const lock = path.join(directory, ".authority-lock");
  const holder = `${process.pid} ${randomUUID()}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      await writeFile(path.join(lock, "holder"), holder, { mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("Profile authority unavailable");
      if (await clearAbandonedLock(lock)) continue;
      if (Date.now() >= deadline) throw new Error("Profile authority busy; retry or contact the node administrator");
      await delay(25);
    }
  }
  try { return await work(); }
  finally { await rm(lock, { recursive: true }); }
}

/** Clears the lock when its holder process is gone; true when it did. */
async function clearAbandonedLock(lock: string): Promise<boolean> {
  const seen = await lockHolder(lock);
  if (seen === undefined || !abandoned(seen)) return false;
  // Moved aside first: of two processes clearing the same lock, one moves it; the other finds it gone and retries.
  const aside = `${lock}.abandoned-${randomUUID()}`;
  try { await rename(lock, aside); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
  const moved = await lockHolder(aside);
  if (moved !== undefined && (moved.holder !== seen.holder || (!moved.holder && moved.ageMs <= UNRECORDED_LOCK_MS))) {
    // Another process cleared it and took it in between: give it back.
    await rename(aside, lock);
    return false;
  }
  await rm(aside, { recursive: true, force: true });
  console.warn(`Cleared an abandoned profile authority lock ${lock}${seen.holder ? ` (holder process ${seen.holder.split(" ")[0]} is gone)` : ""}`);
  return true;
}

type LockState = { holder: string | null; ageMs: number };

/** The lock's holder line, or null for a lock without one; undefined when the lock is gone. */
async function lockHolder(lock: string): Promise<LockState | undefined> {
  try {
    const ageMs = Date.now() - (await stat(lock)).mtimeMs;
    try { return { holder: (await readFile(path.join(lock, "holder"), "utf8")).trim(), ageMs }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { holder: null, ageMs }; throw error; }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function abandoned(state: LockState): boolean {
  // No holder line: just created and not yet named, or left by an older build.
  if (!state.holder) return state.ageMs > UNRECORDED_LOCK_MS;
  const pid = Number(state.holder.split(" ")[0]);
  if (!Number.isInteger(pid) || pid <= 0) return state.ageMs > UNRECORDED_LOCK_MS;
  if (pid === process.pid) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
