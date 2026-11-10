import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

export interface FileCalls<T> {
  result: T;
  /** Files whose content was read. */
  read: string[];
  /** Directories that were listed. */
  listed: string[];
}

/**
 * Runs `work` and reports which files under `root` had their content read and which directories
 * were listed, through node:fs/promises. It counts the calls the application code really makes:
 * the functions are replaced on the module itself and the named imports are pointed at them.
 */
export async function countingFileCalls<T>(root: string, work: () => Promise<T>): Promise<FileCalls<T>> {
  const read: string[] = [], listed: string[] = [];
  const inside = (file: unknown): boolean => typeof file === "string" && (file === root || file.startsWith(root + path.sep));
  const original = { readFile: fsPromises.readFile, readdir: fsPromises.readdir };
  fsPromises.readFile = ((file: unknown, ...rest: unknown[]) => {
    if (inside(file)) read.push(path.relative(root, file as string));
    return (original.readFile as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof fsPromises.readFile;
  fsPromises.readdir = ((directory: unknown, ...rest: unknown[]) => {
    if (inside(directory)) listed.push(path.relative(root, directory as string));
    return (original.readdir as (...args: unknown[]) => unknown)(directory, ...rest);
  }) as typeof fsPromises.readdir;
  syncBuiltinESMExports();
  try { return { result: await work(), read, listed }; }
  finally {
    Object.assign(fsPromises, original);
    syncBuiltinESMExports();
  }
}
