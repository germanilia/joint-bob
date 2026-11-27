import { readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";

/**
 * A recursive watch that costs one stat per created or removed entry.
 *
 * On Linux, Node builds `watch(dir, { recursive: true })` from one watch per file and folder,
 * and reads a folder's whole listing again each time an entry in it is created, renamed or
 * removed. The Pi sessions folder on the homeserver held 6,639 entries and every transcript
 * written there re-read all of them: 7 of 60 seconds of the server's main thread on
 * 2026-11-27. Here each folder has one watch, which already reports its files, and a created
 * entry is looked at alone to see whether it is a folder to watch too.
 *
 * Elsewhere the system's own recursive watch is used. `file` is relative to `root`, as
 * `fs.watch` reports it.
 */
export interface TreeWatch { close(): void; unref(): void; on(event: "error", listener: (error: Error) => void): void }
export type TreeListener = (event: string, file: string | null) => void;

export function watchTree(root: string, listener: TreeListener, perFolder = process.platform === "linux"): TreeWatch {
  if (!perFolder) return watch(root, { recursive: true }, (event, file) => listener(event, file === null ? null : String(file)));
  return new FolderWatches(root, listener);
}

class FolderWatches implements TreeWatch {
  private readonly folders = new Map<string, FSWatcher>();
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private unreffed = false;
  private closed = false;

  constructor(private readonly root: string, private readonly listener: TreeListener) {
    // A root that cannot be watched throws here, as fs.watch does.
    this.add(path.resolve(root), false, true);
  }

  on(_event: "error", listener: (error: Error) => void): void { this.errorListeners.push(listener); }
  unref(): void { this.unreffed = true; for (const watcher of this.folders.values()) watcher.unref(); }
  close(): void { this.closed = true; for (const watcher of this.folders.values()) watcher.close(); this.folders.clear(); }

  private fail(error: unknown): void {
    for (const listener of this.errorListeners) listener(error instanceof Error ? error : new Error(String(error)));
  }

  private relative(file: string): string { return path.relative(path.resolve(this.root), file); }

  /** Watches a folder and the folders in it. `announce` reports what a folder that appeared already holds. */
  private add(folder: string, announce: boolean, isRoot = false): void {
    if (this.closed || this.folders.has(folder)) return;
    let watcher: FSWatcher;
    try { watcher = watch(folder, (event, name) => this.changed(folder, event, name === null ? null : String(name))); }
    catch (error) {
      if (isRoot) throw error;
      // Gone again already; anything else (no watches left) is the caller's to hear.
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) this.fail(error);
      return;
    }
    if (this.unreffed) watcher.unref();
    watcher.on("error", (error) => {
      if (isRoot) { this.fail(error); return; }
      // A removed folder's watch ends with an error on some systems.
      this.drop(folder);
    });
    this.folders.set(folder, watcher);
    let entries;
    try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (announce) this.listener("rename", this.relative(full));
      if (entry.isDirectory()) this.add(full, announce);
    }
  }

  private drop(folder: string): void {
    const prefix = `${folder}${path.sep}`;
    for (const [watched, watcher] of this.folders) {
      if (watched !== folder && !watched.startsWith(prefix)) continue;
      watcher.close();
      this.folders.delete(watched);
    }
  }

  private changed(folder: string, event: string, name: string | null): void {
    if (this.closed) return;
    if (name === null) { this.listener(event, null); return; }
    const full = path.join(folder, name);
    this.listener(event, this.relative(full));
    if (event !== "rename") return;
    // Created, removed or renamed: only this entry is looked at.
    let info;
    try { info = statSync(full, { throwIfNoEntry: false }); } catch { info = undefined; }
    if (!info) this.drop(full);
    else if (info.isDirectory()) this.add(full, true);
  }
}
