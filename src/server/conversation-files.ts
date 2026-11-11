// The files of a conversation, found by session id wherever they lie under a harness's folder.
//
// A project lists the transcripts in its own folders. A conversation's files can lie elsewhere: a
// project that moved leaves them under its old folder, and a copy made on another machine records
// that machine's folder. A delete has to find them all the same, so this reads the names under the
// whole harness folder once and sorts them by the session they belong to. It reads names only;
// sizes and times are read for the sessions a caller asks about.
import { lstat, readdir, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { resolveDataDirectory } from "../data-directory.js";
import type { HarnessAdapter } from "../harnesses/contract.js";
import { canonicalTranscriptName } from "../harnesses/shared-paths.js";

export interface SessionFiles {
  /** The transcript and the copies a file synchronizer kept beside it. */
  transcripts: string[];
  /** Unfinished transfers and saved copies named after the transcript. */
  leftovers: string[];
  /** Folders that hold only this session's files (Claude: sub-agent transcripts and tool results). */
  folders: string[];
}

export interface HarnessFiles {
  engine: string;
  root: string;
  sessions: Map<string, SessionFiles>;
}

export interface FileMeasure { files: number; bytes: number; modifiedAt: number }

const TEMPORARY = /^(.+)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function missing(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
}

/** The transcript a leftover belongs to, by its name: `<transcript>.<peer>.part`, `<transcript>.force-transfer-<id>.bak`, `.<session>.<id>.tmp`. */
function leftoverOf(name: string): string | undefined {
  const bare = name.startsWith(".") ? name.slice(1) : name;
  const cut = bare.indexOf(".jsonl.");
  if (cut > 0) return bare.slice(0, cut + ".jsonl".length);
  const temporary = name.startsWith(".") ? TEMPORARY.exec(bare) : null;
  return temporary ? `${temporary[1]}.jsonl` : undefined;
}

/** Every session with files under the harness's folder. Symbolic links are not followed. */
export async function harnessFiles(adapter: HarnessAdapter): Promise<HarnessFiles> {
  const root = path.resolve(adapter.sync.transcriptRoot());
  const sessions = new Map<string, SessionFiles>();
  const of = (id: string): SessionFiles => {
    let files = sessions.get(id);
    if (!files) sessions.set(id, files = { transcripts: [], leftovers: [], folders: [] });
    return files;
  };
  // Only a file the harness owns names a session: Kiro's own sessions lie under the same folder and are never touched.
  const sessionOf = (file: string): string | undefined => {
    if (!adapter.paths.ownsTranscript(file)) return undefined;
    const id = adapter.paths.sessionId(file) ?? adapter.paths.sessionId(`${adapter.id}:${file}`);
    // A sub-agent transcript belongs to the session that started it.
    return id?.split("/")[0] || undefined;
  };
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (missing(error) || (error as NodeJS.ErrnoException).code === "EACCES") continue; throw error; }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const owner = adapter.paths.sessionFolder?.(full);
        if (owner) of(owner).folders.push(full); else pending.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".jsonl") && !entry.name.startsWith(".")) {
        const id = sessionOf(path.join(directory, canonicalTranscriptName(entry.name)));
        if (id) of(id).transcripts.push(full);
        continue;
      }
      const transcript = leftoverOf(entry.name);
      const id = transcript ? sessionOf(path.join(directory, canonicalTranscriptName(transcript))) : undefined;
      if (id) of(id).leftovers.push(full);
    }
  }
  return { engine: adapter.id, root, sessions };
}

async function measureFolder(folder: string, total: FileMeasure): Promise<void> {
  let entries;
  try { entries = await readdir(folder, { withFileTypes: true }); }
  catch (error) { if (missing(error)) return; throw error; }
  for (const entry of entries) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) { await measureFolder(full, total); continue; }
    const info = await lstat(full).catch((error) => { if (missing(error)) return undefined; throw error; });
    if (!info) continue;
    total.files += 1; total.bytes += info.size; total.modifiedAt = Math.max(total.modifiedAt, info.mtimeMs);
  }
}

/** How many files a session has, their size, and when the newest was last written (0 when there is none). */
export async function measureSessionFiles(files: SessionFiles | undefined): Promise<FileMeasure> {
  const total: FileMeasure = { files: 0, bytes: 0, modifiedAt: 0 };
  if (!files) return total;
  for (const file of [...files.transcripts, ...files.leftovers]) {
    const info = await lstat(file).catch((error) => { if (missing(error)) return undefined; throw error; });
    if (!info?.isFile()) continue;
    total.files += 1; total.bytes += info.size; total.modifiedAt = Math.max(total.modifiedAt, info.mtimeMs);
  }
  for (const folder of files.folders) await measureFolder(folder, total);
  return total;
}

/**
 * Removes a session's files: the transcript and its copies, transfer leftovers, and its folder.
 * Nothing outside `root` is touched and no link is followed. A file that is already gone is not
 * an error, so this can be repeated. Returns how many entries went.
 */
export async function removeSessionFiles(root: string, files: SessionFiles | undefined): Promise<number> {
  if (!files) return 0;
  let removed = 0;
  for (const file of [...files.transcripts, ...files.leftovers]) {
    if (!inside(root, file)) continue;
    const info = await lstat(file).catch((error) => { if (missing(error)) return undefined; throw error; });
    if (!info?.isFile() || info.isSymbolicLink()) continue;
    await unlink(file).then(() => { removed += 1; }, (error) => { if (!missing(error)) throw error; });
  }
  for (const folder of files.folders) {
    if (!inside(root, folder)) continue;
    const info = await lstat(folder).catch((error) => { if (missing(error)) return undefined; throw error; });
    if (!info?.isDirectory() || info.isSymbolicLink()) continue;
    await rm(folder, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/** The two versions kept for review when both machines continued a conversation; they lie outside every harness folder. */
export async function removeTranscriptConflictCopies(engine: string, sessionId: string): Promise<number> {
  const root = path.join(resolveDataDirectory(), "transcript-conflicts");
  const prefix = `${engine}-${encodeURIComponent(sessionId)}`;
  let removed = 0;
  const peers = await readdir(root, { withFileTypes: true }).catch((error) => { if (missing(error)) return []; throw error; });
  for (const peer of peers) {
    if (!peer.isDirectory() || peer.isSymbolicLink()) continue;
    const names = await readdir(path.join(root, peer.name)).catch((error) => { if (missing(error)) return [] as string[]; throw error; });
    for (const name of names) {
      if (name !== `${prefix}.jsonl` && !(name.startsWith(`${prefix}.local-`) && name.endsWith(".jsonl"))) continue;
      await unlink(path.join(root, peer.name, name)).then(() => { removed += 1; }, (error) => { if (!missing(error)) throw error; });
    }
  }
  return removed;
}
