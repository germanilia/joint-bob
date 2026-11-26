import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { ProjectRecord } from "../types.js";

export interface SessionProjectPaths extends Pick<ProjectRecord, "path" | "macPath" | "locations"> {
  additionalPaths?: string[];
  includedSessionIds?: string[];
  recordSessionIds?: string[];
  includeUnstarted?: boolean;
}

/* A project's folders are asked for once per transcript while its conversations are listed, and a
   project with many worktrees has hundreds of them (370 on a node with 165 worktrees): resolving
   them again for each of a few thousand transcripts was 5% of a busy server's time. The answer is
   kept with the project object it was made for, and made again if any of the four fields it reads
   was replaced since. Nothing in the application changes those lists in place. */
interface KeptCwds { path: string; macPath: string | undefined; locations: unknown; additionalPaths: unknown; list: string[]; set?: ReadonlySet<string> }
const keptCwds = new WeakMap<object, KeptCwds>();
function cwdsOf(project: SessionProjectPaths): KeptCwds {
  const kept = keptCwds.get(project);
  if (kept && kept.path === project.path && kept.macPath === project.macPath && kept.locations === project.locations && kept.additionalPaths === project.additionalPaths) return kept;
  const paths = [
    project.path,
    ...(project.macPath ? [project.macPath] : []),
    ...(project.locations ?? []).map((location) => location.path),
    ...(project.additionalPaths ?? []),
  ];
  const made: KeptCwds = { path: project.path, macPath: project.macPath, locations: project.locations, additionalPaths: project.additionalPaths, list: [...new Set(paths.map((cwd) => path.resolve(cwd)))] };
  keptCwds.set(project, made);
  return made;
}

/** Every folder whose conversations belong to the project. Callers get their own list. */
export function sessionCwds(project: SessionProjectPaths): string[] {
  return cwdsOf(project).list.slice();
}

/** The same folders for asking "is this one of them", without a new set per question. */
export function sessionCwdSet(project: SessionProjectPaths): ReadonlySet<string> {
  const kept = cwdsOf(project);
  return kept.set ??= new Set(kept.list);
}

const SYNC_CONFLICT = /\.sync-conflict-[^.]+(?=\.jsonl$)/;

export function isSyncConflictPath(filePath: string): boolean {
  return SYNC_CONFLICT.test(path.basename(filePath));
}

export function canonicalTranscriptName(fileName: string): string {
  return fileName.replace(SYNC_CONFLICT, "");
}

export async function readTranscriptCwd(filePath: string, headerType: string): Promise<string | null> {
  let file: FileHandle | undefined;
  try {
    file = await open(filePath, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const lineEnd = buffer.subarray(0, bytesRead).indexOf(10);
    if (lineEnd < 0) return null;
    const header: unknown = JSON.parse(buffer.toString("utf8", 0, lineEnd));
    if (!header || typeof header !== "object" || Array.isArray(header)) return null;
    const value = header as Record<string, unknown>;
    return value.type === headerType && typeof value.cwd === "string" && path.isAbsolute(value.cwd)
      ? path.resolve(value.cwd)
      : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (error instanceof SyntaxError || code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  } finally {
    await file?.close();
  }
}
