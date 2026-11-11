// Backups of the conversations the retention sweep deletes.
//
// With the owner's setting on (`conversationBackup`), the sweep writes a conversation to the backup
// destination first and deletes it only once the backup is stored and listed here. The destination
// is a folder on this machine or an S3 bucket. A backup is one .tar.gz per conversation:
//
//   conversation.json      what it was: project, title, dates, its records, the list of files
//   files/<agent>/…        every transcript, sub-agent transcript and tool result, at the path it had
//                          under that agent's folder
//   conflicts/<peer>/…     the versions kept for review when two machines continued it
//
// It is a backup outside the app: the app does not list it or open it. Each one is written down in
// node.db (conversation_backups) so that it can be removed again: after `keepDays` days the backup
// is deleted too, from the folder or the bucket. 0 keeps backups until somebody removes them.
//
// What is backed up: conversations the sweep deletes for their age, and files that earlier deletes
// left behind. Not backed up: a conversation a person deletes, a delete that arrives from the
// machine that owns the conversation (that machine made the backup), Joint Bob's own background
// runs, and empty conversations, which have nothing to keep.
//
// A backup that cannot be made is a reason not to delete: the conversation stays, the sweep stops
// backing up for that pass, and the problem is kept for the settings page (backupProblem).
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getClusterNode } from "../cluster.js";
import { ConversationBackupSettingError, mergedConversationBackup, type ConversationBackupInput, type ConversationBackupSettings } from "../conversation-retention.js";
import { resolveDataDirectory } from "../data-directory.js";
import { listHarnesses } from "../harnesses.js";
import { sessionTitleOverrides } from "../names.js";
import { awsProfileCredentials, deleteS3Object, putS3Bytes, putS3Object, type S3Credentials, type S3Target } from "../s3-client.js";
import { conversationBackupSecretAccessKey, getSettings } from "../settings.js";
import { listProjects } from "../store.js";
import { readTarGzEntries, writeTarGz, type TarEntry } from "../tar-archive.js";
import { retentionDatabase, type ConversationSegment, type FilesByHarness } from "./conversation-delete.js";

const DAY_MS = 86_400_000;
/** A removed backup's row is kept this long, then goes as well. */
const ROW_RETENTION_MS = 90 * DAY_MS;
/** An archive left in a staging folder by a run that stopped is removed when it is this old. */
const STALE_STAGING_MS = 6 * 60 * 60_000;

export type BackupReason = "expired" | "leftover";

export interface BackupRequest {
  reason: BackupReason;
  project: { id: string; name: string; path?: string };
  engine: string;
  sessionId: string;
  conversationId: string;
  segments: ConversationSegment[];
  /** A reading of the harness folders (conversation-files.ts). */
  files: FilesByHarness;
}

export interface SavedBackup {
  id: number;
  location: string;
  bytes: number;
  files: number;
  /** An earlier backup already holds the conversation as it is now; nothing was written. */
  reused: boolean;
}

/** What is needed to delete a stored backup later, whatever the setting says by then. */
type StoredTarget = { kind: "folder"; file: string } | { kind: "s3"; bucket: string; region: string; endpoint?: string; key: string };

export interface BackupStatus {
  destination: ConversationBackupSettings["destination"];
  /** The folder, or s3://bucket/prefix; empty when backups are off. */
  where: string;
  keepDays: number;
  /** Backups that exist now. */
  kept: { backups: number; bytes: number };
  /** When the oldest of them is removed; null when there is none or they are kept for good. */
  nextRemovalAt: string | null;
  /** The last backup, or removal of one, that failed, until one succeeds. */
  problem: { at: string; message: string } | null;
}

const prepared = new WeakSet<DatabaseSync>();

function ledger(): DatabaseSync {
  const db = retentionDatabase();
  if (!prepared.has(db)) {
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_backups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL, project_name TEXT NOT NULL, engine TEXT NOT NULL, session_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
        title TEXT NOT NULL, reason TEXT NOT NULL, destination TEXT NOT NULL, location TEXT NOT NULL, target TEXT NOT NULL,
        bytes INTEGER NOT NULL, files INTEGER NOT NULL, last_activity_at TEXT, backed_up_at TEXT NOT NULL, removed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS conversation_backups_session ON conversation_backups(engine, session_id);
      CREATE INDEX IF NOT EXISTS conversation_backups_kept ON conversation_backups(removed_at, backed_up_at);`);
    prepared.add(db);
  }
  return db;
}

const PROBLEM_KEY = "backupProblem";

/** What a kept problem is about: making a backup, or removing one that is past its days. Each ends when its own kind of work succeeds again. */
type ProblemKind = "backup" | "removal";

/** Keeps a backup problem for the settings page and the log. */
export function noteBackupProblem(message: string, now = Date.now(), about: ProblemKind = "backup"): void {
  retentionDatabase().prepare("INSERT INTO conversation_retention_marks (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(PROBLEM_KEY, JSON.stringify({ at: new Date(now).toISOString(), message, about }));
}

function backupProblem(): (NonNullable<BackupStatus["problem"]> & { about: ProblemKind }) | null {
  const row = retentionDatabase().prepare("SELECT value FROM conversation_retention_marks WHERE key = ?").get(PROBLEM_KEY) as { value: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as { at?: unknown; message?: unknown; about?: unknown };
    return typeof parsed.at === "string" && typeof parsed.message === "string" ? { at: parsed.at, message: parsed.message, about: parsed.about === "removal" ? "removal" : "backup" } : null;
  } catch { return null; }
}

function clearBackupProblem(about: ProblemKind): void {
  if (backupProblem()?.about === about) retentionDatabase().prepare("DELETE FROM conversation_retention_marks WHERE key = ?").run(PROBLEM_KEY);
}

/** A name a file system and a bucket both take: ASCII letters and digits, the rest folded to dashes. */
function slug(value: string, length: number): string {
  return value.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, length).replace(/-+$/, "");
}

const safe = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);

function inside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function missing(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
}

interface Destination {
  kind: "folder" | "s3";
  where: string;
  /** A folder of this machine to write an archive into before it is stored. */
  staging(): Promise<string>;
  /** Stores a finished archive as `folder/name` and takes it out of staging. */
  store(archive: string, folder: string, name: string): Promise<{ location: string; target: StoredTarget }>;
  /** Proves the destination takes a write and a delete, with a small object of its own. */
  check(): Promise<void>;
}

function s3Credentials(settings: ConversationBackupSettings, typedSecret?: string): Promise<S3Credentials> {
  if (settings.s3.credentials === "profile") return awsProfileCredentials(settings.s3.profile);
  const secretAccessKey = typedSecret ?? conversationBackupSecretAccessKey();
  if (!settings.s3.accessKeyId || !secretAccessKey) return Promise.reject(new Error("No S3 access key is saved for conversation backups"));
  return Promise.resolve({ accessKeyId: settings.s3.accessKeyId, secretAccessKey });
}

/** The backup folder in use: the one named in the setting, or the default in the data folder. */
function backupFolder(settings: ConversationBackupSettings): string {
  return path.resolve(settings.folder || path.join(resolveDataDirectory(), "conversation-backups"));
}

/**
 * Refuses a backup folder that something else reads or moves: an agent's transcript folder (a
 * backup there would be listed as a conversation's files) or a project (its files are synchronized
 * to other machines).
 */
async function assertFolderUsable(folder: string): Promise<void> {
  if (folder === path.parse(folder).root) throw new Error("The backup folder cannot be the whole disk");
  for (const adapter of listHarnesses()) {
    const root = path.resolve(adapter.sync.transcriptRoot());
    if (inside(root, folder) || inside(folder, root)) throw new Error(`The backup folder cannot lie in, or hold, ${adapter.label}'s transcript folder (${root})`);
  }
  for (const project of await listProjects()) {
    if (inside(path.resolve(project.path), folder)) throw new Error(`The backup folder cannot lie inside the project ${project.name}: its files are synchronized to other machines`);
  }
}

/**
 * Before a save: the setting as it would be saved is checked, and a backup folder that something
 * else reads or moves is refused with the reason. Without this the folder would be saved and only
 * the next hourly check would say why nothing is backed up. Nothing is written.
 */
export async function assertBackupPlaceAllowed(input: ConversationBackupInput): Promise<void> {
  const { hasSecretAccessKey, defaultFolder: _defaultFolder, ...saved } = getSettings().conversationBackup;
  const candidate = mergedConversationBackup(saved, input, hasSecretAccessKey || Boolean(input.s3?.secretAccessKey), path.isAbsolute);
  if (candidate.destination !== "folder") return;
  try { await assertFolderUsable(backupFolder(candidate)); }
  catch (error) { throw new ConversationBackupSettingError(error instanceof Error ? error.message : String(error)); }
}

async function removeStale(staging: string, now = Date.now()): Promise<void> {
  const names = await readdir(staging).catch((error) => { if (missing(error)) return [] as string[]; throw error; });
  for (const name of names) {
    const file = path.join(staging, name);
    const info = await lstat(file).catch(() => undefined);
    if (info?.isFile() && now - info.mtimeMs > STALE_STAGING_MS) await unlink(file).catch(() => undefined);
  }
}

/** `typedSecret`: a secret key that is not saved yet, for the check a settings page makes before saving. */
async function destinationOf(settings: ConversationBackupSettings, typedSecret?: string): Promise<Destination> {
  if (settings.destination === "folder") {
    const root = backupFolder(settings);
    // Checked and made once for a sweep, not for each of its conversations.
    let ready: Promise<string> | undefined;
    const staging = (): Promise<string> => ready ??= (async () => {
      await assertFolderUsable(root);
      const folder = path.join(root, ".staging");
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await removeStale(folder);
      return folder;
    })();
    return {
      kind: "folder", where: root, staging,
      async store(archive, folder, name) {
        const directory = path.join(root, folder);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        let file = path.join(directory, name);
        // The same conversation backed up twice in a day (a delete that did not go through, then new activity) keeps both.
        if (await lstat(file).then(() => true, () => false)) file = path.join(directory, name.replace(/\.tar\.gz$/, `_${randomUUID().slice(0, 8)}.tar.gz`));
        await rename(archive, file);
        return { location: file, target: { kind: "folder", file } };
      },
      async check() {
        const probe = path.join(await staging(), `check-${randomUUID()}.txt`);
        await writeFile(probe, "Joint Bob can write conversation backups here.\n", { mode: 0o600, flag: "wx" });
        await unlink(probe);
      },
    };
  }
  const local = await getClusterNode();
  const target: S3Target = { bucket: settings.s3.bucket, region: settings.s3.region, ...(settings.s3.endpoint ? { endpoint: settings.s3.endpoint } : {}) };
  // One bucket can take the backups of several machines: each writes under its own name.
  const base = [settings.s3.prefix, slug(local.name, 48) || safe(local.id)].filter(Boolean).join("/");
  let ready: Promise<string> | undefined;
  const staging = (): Promise<string> => ready ??= (async () => {
    const folder = path.join(resolveDataDirectory(), "conversation-backups-staging");
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await removeStale(folder);
    return folder;
  })();
  return {
    kind: "s3", where: `s3://${target.bucket}/${base}`, staging,
    async store(archive, folder, name) {
      const key = `${base}/${folder}/${name}`;
      try { await putS3Object(target, await s3Credentials(settings, typedSecret), key, archive, "application/gzip"); }
      finally { await unlink(archive).catch(() => undefined); }
      return { location: `s3://${target.bucket}/${key}`, target: { kind: "s3", ...target, key } };
    },
    async check() {
      const key = `${base}/joint-bob-backup-check-${randomUUID()}.txt`;
      const credentials = await s3Credentials(settings, typedSecret);
      await putS3Bytes(target, credentials, key, Buffer.from("Joint Bob can write conversation backups here.\n"));
      await deleteS3Object(target, credentials, key);
    },
  };
}

async function removeStored(target: StoredTarget, settings: ConversationBackupSettings): Promise<void> {
  if (target.kind === "s3") {
    await deleteS3Object({ bucket: target.bucket, region: target.region, ...(target.endpoint ? { endpoint: target.endpoint } : {}) }, await s3Credentials(settings), target.key);
    return;
  }
  // Only the archive this machine wrote, at the place it was written to: never a folder, a link, or another kind of file.
  if (!target.file.endsWith(".tar.gz")) throw new Error(`${target.file} is not a backup archive`);
  const info = await lstat(target.file).catch((error) => { if (missing(error)) return undefined; throw error; });
  if (!info) return;
  if (!info.isFile()) throw new Error(`${target.file} is not a regular file`);
  await unlink(target.file);
  // The project's folder goes with its last backup; one that still holds something stays.
  await rmdir(path.dirname(target.file)).catch(() => undefined);
}

async function filesUnder(folder: string): Promise<string[]> {
  const found: string[] = [];
  const pending = [folder];
  while (pending.length) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => { if (missing(error)) return []; throw error; });
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) found.push(full);
    }
  }
  return found.sort();
}

interface Collected { entries: TarEntry[]; listed: Array<{ name: string; bytes: number; modifiedAt: string }>; newest: number; firstTranscript?: string; roots: Record<string, string> }

/** Every file of the conversation that is on this machine, with the name it gets in the archive. */
async function collect(request: BackupRequest): Promise<Collected> {
  const collected: Collected = { entries: [], listed: [], newest: 0, roots: {} };
  const seen = new Set<string>();
  const add = async (name: string, file: string): Promise<void> => {
    if (seen.has(file)) return;
    const info = await lstat(file).catch((error) => { if (missing(error)) return undefined; throw error; });
    if (!info?.isFile()) return;
    seen.add(file);
    collected.entries.push({ name, file });
    collected.listed.push({ name, bytes: info.size, modifiedAt: new Date(info.mtimeMs).toISOString() });
    collected.newest = Math.max(collected.newest, info.mtimeMs);
  };
  for (const segment of request.segments) {
    const harness = request.files.get(segment.engine);
    const found = harness?.sessions.get(segment.sessionId);
    if (!harness || !found) continue;
    collected.roots[segment.engine] = harness.root;
    const place = (file: string): string | undefined => {
      const relative = path.relative(harness.root, file);
      return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? `files/${safe(segment.engine)}/${relative.split(path.sep).join("/")}` : undefined;
    };
    for (const file of [...found.transcripts].sort()) {
      const name = place(file);
      if (!name) continue;
      await add(name, file);
      collected.firstTranscript ??= file;
    }
    for (const folder of found.folders) {
      for (const file of await filesUnder(folder)) { const name = place(file); if (name) await add(name, file); }
    }
    // The versions kept for review when two machines continued the conversation lie outside every harness folder.
    const conflicts = path.join(resolveDataDirectory(), "transcript-conflicts");
    const prefix = `${segment.engine}-${encodeURIComponent(segment.sessionId)}`;
    const peers = await readdir(conflicts, { withFileTypes: true }).catch((error) => { if (missing(error)) return []; throw error; });
    for (const peer of peers) {
      if (!peer.isDirectory() || peer.isSymbolicLink()) continue;
      const names = await readdir(path.join(conflicts, peer.name)).catch((error) => { if (missing(error)) return [] as string[]; throw error; });
      for (const name of names.sort()) {
        if (name !== `${prefix}.jsonl` && !(name.startsWith(`${prefix}.local-`) && name.endsWith(".jsonl"))) continue;
        await add(`conflicts/${safe(peer.name)}/${safe(name)}`, path.join(conflicts, peer.name, name));
      }
    }
  }
  return collected;
}

/** What the person first wrote, for a conversation nobody named: read from the start of the transcript, whatever agent wrote it. */
async function firstUserText(file: string): Promise<string> {
  let text: string;
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    text = buffer.toString("utf8", 0, bytesRead);
  } finally { await handle.close(); }
  for (const line of text.split("\n")) {
    try {
      const entry = JSON.parse(line) as { type?: unknown; message?: { role?: unknown; content?: unknown } };
      if (entry.type !== "user" && entry.message?.role !== "user") continue;
      const content = entry.message?.content;
      const said = typeof content === "string" ? content
        : Array.isArray(content) ? (content.find((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string") as { text: string } | undefined)?.text
        : undefined;
      if (said && said.trim() && !said.trimStart().startsWith("<")) return said.replace(/\s+/g, " ").trim().slice(0, 120);
    } catch { /* a line that is not JSON, or the one the read cut */ }
  }
  return "";
}

function recordsOf(request: BackupRequest): unknown[] {
  const db = retentionDatabase();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_records'").get()) return [];
  const ids = JSON.stringify([...new Set([request.conversationId, request.sessionId, ...request.segments.map((segment) => segment.sessionId)])]);
  return db.prepare("SELECT * FROM conversation_records WHERE session_id IN (SELECT value FROM json_each(?)) OR conversation_id IN (SELECT value FROM json_each(?))").all(ids, ids);
}

/** The backups of this machine, open for one sweep. */
export class ConversationBackups {
  private constructor(private readonly settings: ConversationBackupSettings, private readonly destination: Destination) {}

  /** Undefined when the owner has backups off. */
  static async open(settings: ConversationBackupSettings = getSettings().conversationBackup): Promise<ConversationBackups | undefined> {
    if (settings.destination === "off") return undefined;
    return new ConversationBackups(settings, await destinationOf(settings));
  }

  get where(): string { return this.destination.where; }

  /**
   * Backs the conversation up and returns where it went, or undefined when it has no file on this
   * machine. Throws when the backup could not be made, stored, read back or written down: the caller
   * must then leave the conversation alone.
   */
  async save(request: BackupRequest, now = Date.now()): Promise<SavedBackup | undefined> {
    const db = ledger();
    const collected = await collect(request);
    if (!collected.entries.length) return undefined;
    const lastActivityAt = new Date(collected.newest).toISOString();
    // A delete that did not go through after its backup: the backup stands while nothing was written since.
    const earlier = db.prepare("SELECT id, location, bytes, files FROM conversation_backups WHERE engine = ? AND session_id = ? AND removed_at IS NULL AND last_activity_at = ? ORDER BY id DESC LIMIT 1")
      .get(request.engine, request.sessionId, lastActivityAt) as { id: number; location: string; bytes: number; files: number } | undefined;
    if (earlier) return { ...earlier, reused: true };

    const titles = await sessionTitleOverrides();
    const title = titles[request.conversationId] ?? titles[request.sessionId] ?? (collected.firstTranscript ? await firstUserText(collected.firstTranscript).catch(() => "") : "");
    const local = await getClusterNode();
    const backedUpAt = new Date(now).toISOString();
    const manifest = {
      format: 1,
      about: "A conversation backed up by Joint Bob before its retention sweep deleted it. Each file under files/<agent>/ lay at the same path under that agent's folder (agentFolders).",
      backedUpAt, reason: request.reason,
      machine: { id: local.id, name: local.name },
      project: request.project,
      conversationId: request.conversationId, title, lastActivityAt,
      segments: request.segments,
      agentFolders: collected.roots,
      records: recordsOf(request),
      files: collected.listed,
    };
    const staging = await this.destination.staging();
    const archive = path.join(staging, `${randomUUID()}.tar.gz`);
    let written: { bytes: number };
    try {
      written = await writeTarGz(archive, [{ name: "conversation.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), modifiedAt: now }, ...collected.entries]);
      // Read back whole before anything is deleted on its strength: every file is in it, at the size it had.
      const inArchive = new Map((await readTarGzEntries(archive)).map((entry) => [entry.name, entry.bytes]));
      for (const file of collected.listed) {
        if (inArchive.get(file.name) !== file.bytes) throw new Error(`The backup of ${request.engine}:${request.sessionId} does not hold ${file.name} as it is on disk`);
      }
    } catch (error) { await rm(archive, { force: true }); throw error; }
    const folder = [slug(request.project.name, 48), safe(request.project.id)].filter(Boolean).join("_");
    const name = [backedUpAt.slice(0, 10), safe(request.engine), safe(request.sessionId), slug(title, 40)].filter(Boolean).join("_");
    let stored: { location: string; target: StoredTarget };
    try { stored = await this.destination.store(archive, folder, `${name}.tar.gz`); }
    catch (error) { await rm(archive, { force: true }); throw error; }
    try {
      db.prepare(`INSERT INTO conversation_backups (project_id, project_name, engine, session_id, conversation_id, title, reason, destination, location, target, bytes, files, last_activity_at, backed_up_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(request.project.id, request.project.name, request.engine, request.sessionId, request.conversationId, title, request.reason,
        this.destination.kind, stored.location, JSON.stringify(stored.target), written.bytes, collected.entries.length, lastActivityAt, backedUpAt);
      // Read back rather than taken from the insert: a node that keeps its database in PostgreSQL reports no row id there.
      const row = db.prepare("SELECT id FROM conversation_backups WHERE location = ? ORDER BY id DESC LIMIT 1").get(stored.location) as { id: number | bigint };
      clearBackupProblem("backup");
      return { id: Number(row.id), location: stored.location, bytes: written.bytes, files: collected.entries.length, reused: false };
    } catch (error) {
      // Not written down, so it would never be removed: taken back, and the conversation stays.
      await removeStored(stored.target, this.settings).catch(() => undefined);
      throw error;
    }
  }
}

/**
 * Deletes the backups that are older than the owner's `keepDays`, from the folder or the bucket each
 * was written to, and forgets rows of backups removed long ago. Runs whether backups are on or off:
 * turning them off stops new ones, and the ones made still go when their time is up. Returns how
 * many were removed.
 */
export async function removeExpiredBackups(now = Date.now(), settings: ConversationBackupSettings = getSettings().conversationBackup): Promise<number> {
  const db = ledger();
  db.prepare("DELETE FROM conversation_backups WHERE removed_at IS NOT NULL AND removed_at <= ?").run(new Date(now - ROW_RETENTION_MS).toISOString());
  if (settings.keepDays <= 0) return 0;
  const due = db.prepare("SELECT id, location, target FROM conversation_backups WHERE removed_at IS NULL AND backed_up_at <= ? ORDER BY backed_up_at, id")
    .all(new Date(now - settings.keepDays * DAY_MS).toISOString()) as Array<{ id: number; location: string; target: string }>;
  let removed = 0, noted = false;
  // A bucket that refuses one delete would refuse the next: its other backups wait for the next pass. The rest go on.
  const refusing = new Set<string>();
  for (const row of due) {
    let target: StoredTarget;
    try { target = JSON.parse(row.target) as StoredTarget; } catch { continue; }
    const place = target.kind === "s3" ? `${target.endpoint ?? ""}/${target.bucket}` : undefined;
    if (place !== undefined && refusing.has(place)) continue;
    try {
      await removeStored(target, settings);
      db.prepare("UPDATE conversation_backups SET removed_at = ? WHERE id = ?").run(new Date(now).toISOString(), row.id);
      removed += 1;
    } catch (error) {
      if (place !== undefined) refusing.add(place);
      const message = `The backup ${row.location} is past its ${settings.keepDays} days and could not be removed: ${error instanceof Error ? error.message : String(error)}`;
      if (!noted) noteBackupProblem(message, now, "removal");
      noted = true;
      console.warn(message);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  // Every backup that was due went: whatever stood in the way of removing them is over.
  if (!noted) clearBackupProblem("removal");
  if (removed) console.log(`Removed ${removed} conversation backup(s) older than ${settings.keepDays} days`);
  return removed;
}

/** Where backups go and what is kept now, for the settings page and the dry run. */
export async function conversationBackupStatus(settings: ConversationBackupSettings = getSettings().conversationBackup): Promise<BackupStatus> {
  const db = ledger();
  const kept = db.prepare("SELECT count(*) AS backups, coalesce(sum(bytes), 0) AS bytes, min(backed_up_at) AS oldest FROM conversation_backups WHERE removed_at IS NULL").get() as { backups: number; bytes: number; oldest: string | null };
  const problem = backupProblem();
  let where = "";
  if (settings.destination === "folder") where = backupFolder(settings);
  else if (settings.destination === "s3") where = (await destinationOf(settings)).where;
  return {
    destination: settings.destination, where, keepDays: settings.keepDays,
    kept: { backups: Number(kept.backups), bytes: Number(kept.bytes) },
    nextRemovalAt: kept.oldest && settings.keepDays > 0 ? new Date(Date.parse(kept.oldest) + settings.keepDays * DAY_MS).toISOString() : null,
    // With backups switched off, a backup that could not be made no longer holds anything up.
    problem: problem && !(settings.destination === "off" && problem.about === "backup") ? { at: problem.at, message: problem.message } : null,
  };
}

/**
 * Writes a small file to the destination and removes it again, so the owner learns before the
 * first sweep whether the folder or the bucket takes backups. Throws with the reason when it does not.
 */
export async function checkBackupDestination(settings: ConversationBackupSettings = getSettings().conversationBackup, typedSecret?: string): Promise<string> {
  if (settings.destination === "off") throw new Error("Choose a folder or S3 first");
  const destination = await destinationOf(settings, typedSecret);
  await destination.check();
  // The saved place takes a write again: the next hourly check will back up, and the problem line can go.
  const { hasSecretAccessKey: _has, defaultFolder: _default, ...saved } = getSettings().conversationBackup;
  if (typedSecret === undefined && JSON.stringify(saved) === JSON.stringify({ destination: settings.destination, keepDays: settings.keepDays, folder: settings.folder, s3: settings.s3 })) clearBackupProblem("backup");
  return destination.where;
}

/** Tests: the rows of the ledger. */
export function conversationBackupRows(): Array<Record<string, unknown>> {
  return ledger().prepare("SELECT * FROM conversation_backups ORDER BY id").all() as Array<Record<string, unknown>>;
}

/** Whether the staging folder of the data folder exists, for a test of what a failed upload leaves. */
export async function stagedBackups(): Promise<string[]> {
  const folder = path.join(resolveDataDirectory(), "conversation-backups-staging");
  return (await readdir(folder).catch(() => [] as string[])).filter((name) => name.endsWith(".tar.gz"));
}
