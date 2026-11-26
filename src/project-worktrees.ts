import { createHash, randomUUID } from "node:crypto";
import { promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { getClusterNode } from "./cluster.js";
import { mapWithConcurrency } from "./concurrency.js";
import { conversationPrivacy } from "./conversation-privacy.js";
import { syncConversationWorktrees } from "./conversation-records.js";
import { managedHomePaths } from "./managed-home.js";
import { applyMergeTransaction, recordMergeTransaction, rollbackMergeTransaction, type MergeOp } from "./merge-journal.js";
import { useWorktreeFiles, worktreeFilesChanged, worktreeHasPendingFiles } from "./file-sync/facade.js";
import { getSettings } from "./settings.js";
import { promisify } from "node:util";
import { execFile, spawn } from "./subprocess.js";
import { captureBaseline, copyAllowed, listTreeEntries, TICKET_BASELINE_DIR, TICKET_MERGE_DIR } from "./task-workspaces.js";
import { prepareTicketMerge, readBaseline } from "./ticket-merge-ops.js";
import { PROJECT_COLORS, type ProjectColor, type ProjectRecord } from "./types.js";
import { exportWorktreeBase, ignoredPaths, type WorktreeChanges, type WorktreeFileChange } from "./worktree-git.js";
import { WORKTREE_META_DIR, worktreeBinaryExtensions, worktreeHeavyDirectories, worktreeLinkedDirectories } from "./worktree-filters.js";

export { WORKTREE_META_DIR } from "./worktree-filters.js";
export { integrateProjectWorktree } from "./worktree-integration.js";
const binaryExtensions = new Set(worktreeBinaryExtensions.map((extension) => `.${extension}`));
const heavyDirectories = new Set<string>([...worktreeHeavyDirectories, WORKTREE_META_DIR, TICKET_MERGE_DIR]);

const MAX_FILE_BYTES = 1024 * 1024;
/** An ignored folder bigger than this is a build output, cache or tool workspace, not local configuration. */
const MAX_IGNORED_DIRECTORY_BYTES = 8 * 1024 * 1024;
export const WORKTREE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Vivid hues first: a worktree must stand out in the list, and slate reads as no colour.
const DEFAULT_COLOR_ORDER: ProjectColor[] = ["teal", "violet", "amber", "blue", "magenta", "green", "red", "slate"];
const BINARY_SNIFF_BYTES = 8192;
const exec = promisify(execFile);
const linkedDirectories = new Set<string>(worktreeLinkedDirectories);
/** Node-local: file sync ignores `.joint-bob/` at every depth and the copy never brings one. */
const LOCAL_FILES_MARKER = path.join(".joint-bob", "worktree-local-files.json");

export interface WorktreeCreator { engine: string; conversationId: string }
export interface WorktreePullRequest {
  number: number;
  url: string;
  branch: string;
  base: string;
  baseCommit: string;
  headCommit?: string;
  mergedCommit?: string;
  snapshotFile?: string;
}

export interface WorktreeChangeSnapshot {
  gitBase: string | null;
  writes: WorktreeFileChange[];
  deletes: string[];
}

export interface ProjectWorktree {
  id: string;
  projectId: string;
  name: string;
  color: ProjectColor;
  createdAt: string;
  createdByNodeId: string;
  lastMergedAt: string | null;
  path: string;
  createdBy: WorktreeCreator | null;
  pullRequest: WorktreePullRequest | null;
}

interface WorktreeMetadata {
  version: 1;
  id: string;
  name: string;
  color: ProjectColor;
  createdAt: string;
  createdByNodeId: string;
  baselineDigest: string;
  lastMergedAt: string | null;
  /** The commit the worktree's files started as; a pull request replays its changes from it. */
  gitBase?: string | null;
  /** The remote branch gitBase came from, e.g. origin/main; absent when the project folder was copied as it was. */
  gitBaseRef?: string | null;
  createdBy?: WorktreeCreator | null;
  pullRequest?: WorktreePullRequest | null;
  /** Last pull request from this worktree confirmed merged into its base branch, used as the 3-way merge base for follow-up PRs and merges. */
  mergedPullRequest?: WorktreePullRequest | null;
}

export class ProjectWorktreeError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function isHeavyPath(relative: string): boolean {
  const segments = relative.split(path.sep);
  if (segments.some((segment) => heavyDirectories.has(segment) || segment.endsWith(".egg-info"))) return true;
  const name = segments[segments.length - 1];
  return binaryExtensions.has(path.extname(name).toLowerCase());
}

/** Code and text only: the ticket exclusions, heavy trees, binaries and files over 1 MiB. */
export function worktreePathAllowed(root: string, file: string): boolean {
  if (!copyAllowed(root, file)) return false;
  const relative = path.relative(root, file);
  return !relative || !isHeavyPath(relative);
}

async function looksBinary(file: string): Promise<boolean> {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally { await handle.close(); }
}

async function copyCandidate(root: string, file: string): Promise<boolean> {
  if (!worktreePathAllowed(root, file)) return false;
  let info: Stats;
  try { info = await fs.lstat(file); } catch { return false; }
  if (info.isDirectory()) return true;
  if (info.isSymbolicLink()) return false;
  if (!info.isFile() || info.size > MAX_FILE_BYTES) return false;
  return !(await looksBinary(file));
}

function assertSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") throw new ProjectWorktreeError(400, `${label} is invalid`);
}

export function worktreeRoot(): string {
  return path.resolve(process.env.JOINT_BOB_WORKTREE_ROOT ?? managedHomePaths(getSettings().projects.homePath).worktrees);
}

export function projectWorktreeRoot(projectId: string, root = worktreeRoot()): string {
  assertSegment(projectId, "Project ID");
  const base = path.resolve(root);
  const target = path.resolve(base, projectId);
  if (!target.startsWith(`${base}${path.sep}`)) throw new ProjectWorktreeError(400, "Project ID is invalid");
  return target;
}

export function expectedWorktreePath(projectId: string, worktreeId: string, root = worktreeRoot()): string {
  assertSegment(worktreeId, "Worktree ID");
  const base = projectWorktreeRoot(projectId, root);
  const target = path.resolve(base, worktreeId);
  if (!target.startsWith(`${base}${path.sep}`)) throw new ProjectWorktreeError(400, "Worktree ID is invalid");
  return target;
}

function metadataFile(worktree: string): string { return path.join(worktree, WORKTREE_META_DIR, "worktree.json"); }

async function writeAtomic(file: string, content: string, container = path.dirname(file)): Promise<void> {
  const base = path.resolve(container);
  const target = path.resolve(file);
  if (!target.startsWith(`${base}${path.sep}`)) throw new ProjectWorktreeError(400, "Invalid worktree file path");
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const temporary = path.resolve(dir, `${path.basename(target)}.${randomUUID()}.tmp`);
  if (!temporary.startsWith(`${dir}${path.sep}`)) throw new ProjectWorktreeError(400, "Invalid temporary file path");
  await fs.writeFile(temporary, content, { mode: 0o644 });
  await fs.rename(temporary, target);
}

async function readMetadata(worktree: string): Promise<WorktreeMetadata | undefined> {
  try {
    const base = path.resolve(worktree);
    const file = path.resolve(metadataFile(base));
    if (!file.startsWith(`${base}${path.sep}`)) return undefined;
    const value = JSON.parse(await fs.readFile(file, "utf8")) as Partial<WorktreeMetadata>;
    if (value.version !== 1 || typeof value.id !== "string" || value.id !== path.basename(worktree) || typeof value.name !== "string"
      || typeof value.createdAt !== "string" || typeof value.createdByNodeId !== "string" || typeof value.baselineDigest !== "string") return undefined;
    const color = PROJECT_COLORS.includes(value.color as ProjectColor) ? value.color as ProjectColor : "teal";
    return { ...value, color, lastMergedAt: typeof value.lastMergedAt === "string" ? value.lastMergedAt : null } as WorktreeMetadata;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "") || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function view(projectId: string, worktree: string, metadata: WorktreeMetadata): ProjectWorktree {
  return { id: metadata.id, projectId, name: metadata.name, color: metadata.color, createdAt: metadata.createdAt, createdByNodeId: metadata.createdByNodeId, lastMergedAt: metadata.lastMergedAt, path: worktree, createdBy: metadata.createdBy ?? null, pullRequest: metadata.pullRequest ?? null };
}

function normalizeName(name: unknown): string {
  const value = typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "";
  if (!value || value.length > 80) throw new ProjectWorktreeError(400, "Worktree name must be 1-80 characters");
  return value;
}

function normalizeColor(color: unknown, fallback: ProjectColor): ProjectColor {
  if (color === undefined || color === null || color === "") return fallback;
  if (!PROJECT_COLORS.includes(color as ProjectColor)) throw new ProjectWorktreeError(400, "Unsupported worktree color");
  return color as ProjectColor;
}

/** Records where this node keeps the worktree, so peers can find the conversations it runs there. */
async function registerLocalPath(worktree: string, nodeId: string): Promise<void> {
  const base = path.resolve(worktree);
  const file = path.resolve(base, WORKTREE_META_DIR, "nodes", `${nodeId}.json`);
  if (!file.startsWith(`${base}${path.sep}`)) throw new ProjectWorktreeError(400, "Invalid node ID");
  const content = `${JSON.stringify({ path: worktree })}\n`;
  try { if (await fs.readFile(file, "utf8") === content) return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await writeAtomic(file, content, base);
  worktreeFilesChanged(path.basename(path.dirname(worktree)), file);
}

/* What the worktree folders of one project hold, read once for everything that asks: the list of
   worktrees, the conversations started inside them, and the paths every node keeps them at.

   Each of those used to read the folders itself, one small file after another: a listing or an
   opened conversation of a project with 165 worktrees waited on about 870 reads in a row, and on
   a busy server every one of them waits its turn (17 s for one open, measured). Now the folders
   are read side by side, and what was read is kept for as long as the folders stand still.

   "Stand still" is checked on every call, not assumed: the entries of the project's folder, each
   worktree.json, each `nodes` and `conversations` folder and each retired record are looked at
   again (one stat each, side by side), and anything that differs reads everything again. A file
   replaced, added or removed moves one of those. Two things a stat can miss are covered apart:
   a change made in the same moment as the reading (so what was read less than two seconds after
   the newest change is read once more), and a node's path file rewritten in place, which no
   folder notices (so nothing is kept longer than a minute).

   A caller that arrives while the folders are being looked at does not take that answer, which may
   have looked before the caller's own change: it waits for the next look, shared by all who wait. */
interface ScannedWorktree { worktree: ProjectWorktree; conversations: string[]; nodePaths: string[] }
interface WorktreeScan { stamp: string; quiet: boolean; readAt: number; worktrees: ScannedWorktree[]; retired: { paths: string[] } | { error: unknown } }
interface WorktreeFolders { stamp: string; newest: number; ids: string[]; archives: string[] | { error: unknown } }
interface ScanSlot { kept?: WorktreeScan; running?: Promise<WorktreeScan>; next?: Promise<WorktreeScan> }
/** Looking costs no open file, reading holds one (and a worktree reads a few at a time): bounded well under the usual limit of open files. */
const SCAN_STATS_AT_ONCE = 256;
const SCAN_READS_AT_ONCE = 48;
const SCAN_SAME_MOMENT_MS = 2_000;
const SCAN_MAX_AGE_MS = 60_000;
const MAX_SCAN_SLOTS = 500;
const scanSlots = new Map<string, ScanSlot>();

/** Tests: forget what was read of every project's worktree folders. */
export function resetWorktreeScans(): void { scanSlots.clear(); }
const scanUse = { looked: 0, read: 0 };
/** How often the folders were looked at, and how often that led to reading them, since this process started. */
export function worktreeScanUse(): { looked: number; read: number } { return { ...scanUse }; }

async function worktreeFolders(directory: string): Promise<WorktreeFolders | undefined> {
  let entries: string[];
  try { entries = await fs.readdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  // Other entries can lie here (old sync markers), and a worktree being created is a hidden staging folder.
  const ids = entries.filter((entry) => WORKTREE_ID.test(entry)).sort();
  const retired = path.join(directory, ".retired");
  let archives: WorktreeFolders["archives"];
  try { archives = (await fs.readdir(retired)).filter((file) => file.endsWith(".json") && WORKTREE_ID.test(file.slice(0, -5))); }
  catch (error) { archives = (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : { error }; }
  let newest = 0;
  const mark = async (file: string): Promise<string> => {
    try {
      const info = await fs.stat(file);
      if (info.mtimeMs > newest) newest = info.mtimeMs;
      return `${info.mtimeMs}:${info.size}:${info.ino}`;
    } catch (error) { return `!${(error as NodeJS.ErrnoException).code ?? "error"}`; }
  };
  const files = [
    ...ids.flatMap((id) => [metadataFile(path.join(directory, id)), path.join(directory, id, WORKTREE_META_DIR, "nodes"), path.join(directory, id, WORKTREE_META_DIR, "conversations")]),
    ...(Array.isArray(archives) ? archives.map((file) => path.join(retired, file)) : []),
  ];
  const marks = await mapWithConcurrency(files, SCAN_STATS_AT_ONCE, mark);
  return { stamp: JSON.stringify([ids, Array.isArray(archives) ? archives : "unreadable", marks]), newest, ids, archives };
}

async function readWorktreeFolders(projectId: string, directory: string, folders: WorktreeFolders): Promise<Pick<WorktreeScan, "worktrees" | "retired">> {
  const read = await mapWithConcurrency(folders.ids, SCAN_READS_AT_ONCE, async (id): Promise<ScannedWorktree | undefined> => {
    const worktree = path.join(directory, id);
    const metadata = await readMetadata(worktree);
    if (!metadata) return undefined;
    // Its path is registered when the worktree is used here (useProjectWorktree), not when it is listed: a
    // listing wrote one small synced file per worktree per node, and a write that landed after another
    // node's delete brought the deleted folder back.
    const [conversations, nodeFiles] = await Promise.all([
      fs.readdir(path.join(worktree, WORKTREE_META_DIR, "conversations")).catch(() => [] as string[]),
      fs.readdir(path.join(worktree, WORKTREE_META_DIR, "nodes")).catch(() => [] as string[]),
    ]);
    const nodePaths = await Promise.all(nodeFiles.filter((file) => file.endsWith(".json")).map(async (file) => {
      try {
        const value = JSON.parse(await fs.readFile(path.join(worktree, WORKTREE_META_DIR, "nodes", file), "utf8")) as { path?: unknown };
        return typeof value.path === "string" && path.isAbsolute(value.path) && path.basename(value.path) === id ? path.resolve(value.path) : undefined;
      } catch { return undefined; }
    }));
    return { worktree: view(projectId, worktree, metadata), conversations, nodePaths: nodePaths.filter((value): value is string => value !== undefined) };
  });
  const worktrees = read.filter((entry): entry is ScannedWorktree => entry !== undefined)
    .sort((left, right) => left.worktree.createdAt.localeCompare(right.worktree.createdAt));
  if (!Array.isArray(folders.archives)) return { worktrees, retired: folders.archives };
  // Every record is read; the first one that cannot be used, in the folder's order, is the failure reported.
  const records = await mapWithConcurrency(folders.archives, SCAN_READS_AT_ONCE, async (file): Promise<{ paths: string[] } | { error: unknown }> => {
    try {
      const saved: unknown = JSON.parse(await fs.readFile(path.join(directory, ".retired", file), "utf8"));
      if (!Array.isArray(saved) || saved.some(folder => typeof folder !== "string" || !path.isAbsolute(folder) || path.basename(folder) !== file.slice(0, -5))) throw new ProjectWorktreeError(409, `Invalid retired worktree paths: ${file}`);
      return { paths: saved.length ? [...saved as string[], path.join(directory, file.slice(0, -5))] : [] };
    } catch (error) { return { error }; }
  });
  const failed = records.find((record): record is { error: unknown } => "error" in record);
  return { worktrees, retired: failed ?? { paths: records.flatMap((record) => "paths" in record ? record.paths : []) } };
}

async function lookAtWorktrees(projectId: string, directory: string, slot: ScanSlot): Promise<WorktreeScan> {
  const lookedAt = Date.now();
  scanUse.looked += 1;
  const folders = await worktreeFolders(directory);
  if (!folders) return slot.kept = { stamp: "", quiet: false, readAt: lookedAt, worktrees: [], retired: { paths: [] } };
  const kept = slot.kept;
  if (kept && kept.quiet && kept.stamp === folders.stamp && lookedAt - kept.readAt < SCAN_MAX_AGE_MS && lookedAt >= kept.readAt) return kept;
  scanUse.read += 1;
  const read = await readWorktreeFolders(projectId, directory, folders);
  // The marks were taken before the reading: a change made during it differs from them at the next look.
  return slot.kept = { ...read, stamp: folders.stamp, quiet: lookedAt - folders.newest > SCAN_SAME_MOMENT_MS, readAt: lookedAt };
}

function scanProjectWorktrees(projectId: string, root: string): Promise<WorktreeScan> {
  const directory = projectWorktreeRoot(projectId, root);
  let slot = scanSlots.get(directory);
  if (!slot) {
    if (scanSlots.size >= MAX_SCAN_SLOTS) for (const [key, other] of scanSlots) if (!other.running && !other.next) scanSlots.delete(key);
    scanSlots.set(directory, slot = {});
  }
  const held = slot;
  const start = (): Promise<WorktreeScan> => {
    const run: Promise<WorktreeScan> = lookAtWorktrees(projectId, directory, held).finally(() => { if (held.running === run) held.running = undefined; });
    return held.running = run;
  };
  if (!held.running) return start();
  // The look in progress may have passed what this caller just changed: it takes the one after it.
  return held.next ??= held.running.then(() => undefined, () => undefined).then(() => { held.next = undefined; return held.running ?? start(); });
}

export async function listProjectWorktrees(projectId: string, root = worktreeRoot()): Promise<ProjectWorktree[]> {
  // Callers own what they get: the kept objects are never handed out.
  return structuredClone((await scanProjectWorktrees(projectId, root)).worktrees.map((entry) => entry.worktree));
}

const cleanupClaims = new Map<string, ReturnType<typeof setTimeout>>();

/** A short final-check reservation blocks new Joint Bob work in the same copy. */
export function claimWorktreeCleanup(projectId: string, worktreeId: string): (() => void) | undefined {
  const key = `${projectId}:${worktreeId}`;
  if (cleanupClaims.has(key)) return;
  const release = () => {
    if (cleanupClaims.get(key) !== timer) return;
    cleanupClaims.delete(key);
    clearTimeout(timer);
  };
  const timer = setTimeout(release, 30_000).unref();
  cleanupClaims.set(key, timer);
  return release;
}

function assertNoCleanupClaim(projectId: string, worktreeId: string) {
  if (cleanupClaims.has(`${projectId}:${worktreeId}`)) throw new ProjectWorktreeError(409, 'Workspace cleanup is checking this worktree. Try again shortly.');
}

export async function worktreeCopyNodeIds(worktree: ProjectWorktree): Promise<string[]> {
  const directory = path.join(worktree.path, WORKTREE_META_DIR, 'nodes');
  const entries = await fs.readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  return entries.filter(file => file.endsWith('.json')).map(file => file.slice(0, -5));
}

export async function getProjectWorktree(projectId: string, worktreeId: string, root = worktreeRoot()): Promise<ProjectWorktree | undefined> {
  assertNoCleanupClaim(projectId, worktreeId);
  const worktree = expectedWorktreePath(projectId, worktreeId, root);
  const metadata = await readMetadata(worktree);
  if (!metadata) return undefined;
  const found = view(projectId, worktree, metadata);
  assertNoCleanupClaim(projectId, worktreeId);
  // Asking for one worktree is using it (a terminal, an agent, a new conversation in it).
  await useProjectWorktree(found).catch((error) => console.warn("Worktree could not be marked as used here", error));
  return found;
}

/**
 * A conversation, terminal or agent works in the worktree on this node: its path here is recorded for the
 * other nodes (conversations are matched by working directory), and its files are downloaded from now on.
 * Returns how many files a machine that is present can still send.
 */
export async function useProjectWorktree(worktree: ProjectWorktree): Promise<number> {
  assertNoCleanupClaim(worktree.projectId, worktree.id);
  await registerLocalPath(worktree.path, (await getClusterNode()).id);
  return useWorktreeFiles(worktree.projectId, worktree.id);
}

async function gitHead(projectPath: string): Promise<string | null> {
  try {
    const head = (await exec("git", ["-C", projectPath, "rev-parse", "--verify", "HEAD"], { timeout: 10_000 })).stdout.trim();
    return /^[0-9a-f]{40}$/.test(head) ? head : null;
  } catch { return null; }
}

/** Captures uncommitted changes (staged and unstaged) as a unified diff, for syncing to other machines. */
async function gitDiff(projectPath: string): Promise<string | null> {
  try {
    // A node whose HEAD fell behind its synced files has a diff of megabytes; the default 1 MiB buffer dropped it.
    const diff = (await exec("git", ["-C", projectPath, "diff", "HEAD"], { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 })).stdout;
    return diff.trim() || null;
  } catch (error) {
    if ((error as { code?: unknown }).code !== 128) console.warn("Worktree base.patch not recorded", error instanceof Error ? error.message.slice(0, 200) : error);
    return null;
  }
}

/** Extracts file paths from a unified diff. Returns paths like "src/file.ts". */
function parseDiffPaths(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    // Match "diff --git a/path b/path" or "+++ b/path" or "--- a/path"
    const gitDiffMatch = /^diff --git a\/(.+?) b\//.exec(line);
    if (gitDiffMatch) { paths.add(gitDiffMatch[1]); continue; }
    const plusMatch = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plusMatch && plusMatch[1] !== "/dev/null") { paths.add(plusMatch[1]); continue; }
    const minusMatch = /^--- a\/(.+)$/.exec(line);
    if (minusMatch && minusMatch[1] !== "/dev/null") paths.add(minusMatch[1]);
  }
  return [...paths].sort();
}

async function lstatOrNull(file: string): Promise<Stats | null> {
  try { return await fs.lstat(file); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}

/** Copies the project's `.env` files and links its dependency folders into the worktree, once per node.
    Neither syncs, so every node that runs a conversation in the worktree provisions its own. */
export async function ensureWorktreeLocalFiles(projectPath: string, worktree: string): Promise<{ envFiles: number; links: number }> {
  const marker = path.join(worktree, LOCAL_FILES_MARKER);
  if (await lstatOrNull(marker)) return { envFiles: 0, links: 0 };
  const source = path.resolve(projectPath);
  let envFiles = 0;
  let links = 0;
  const pending = [""];
  while (pending.length) {
    const relative = pending.pop()!;
    let entries;
    try { entries = await fs.readdir(path.join(source, relative), { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const child = path.join(relative, entry.name);
      const target = path.join(worktree, child);
      if (linkedDirectories.has(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())) {
        if (!await lstatOrNull(target)) { await fs.symlink(path.join(source, child), target, "dir"); links += 1; }
      } else if (entry.isDirectory()) {
        // Only folders the copy kept: excluded trees (.git, builds, caches) are never walked.
        if ((await lstatOrNull(target))?.isDirectory()) pending.push(child);
      } else if (entry.isFile() && (entry.name === ".env" || entry.name.startsWith(".env."))) {
        if (!await lstatOrNull(target)) { await fs.copyFile(path.join(source, child), target, fs.constants.COPYFILE_EXCL); envFiles += 1; }
      }
    }
  }
  await writeAtomic(marker, `${JSON.stringify({ provisionedAt: new Date().toISOString(), envFiles, links })}\n`);
  return { envFiles, links };
}

/** True when the folder holds more than `limit` bytes; stops reading as soon as it does. */
async function exceedsSize(folder: string, limit: number): Promise<boolean> {
  let total = 0;
  const pending = [folder];
  while (pending.length) {
    const current = pending.pop()!;
    for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(() => [])) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile()) {
        total += (await fs.lstat(child).catch(() => null))?.size ?? 0;
        if (total > limit) return true;
      }
    }
  }
  return false;
}

/** Starts the worktree as the remote default branch is now, plus the folder's git-ignored local files.
    Returns null, having written nothing, when the project has no such branch. */
async function copyRemoteBase(source: string, staging: string, gitEnvironment: NodeJS.ProcessEnv, localMain = false, originMain = false): Promise<{ gitBase: string; gitBaseRef: string } | null> {
  let base;
  try {
    base = await exportWorktreeBase(source, gitEnvironment, staging, (relative, size) => size <= MAX_FILE_BYTES && worktreePathAllowed(staging, path.join(staging, ...relative.split("/"))), localMain, originMain);
  } catch (error) {
    if (localMain || originMain) throw error;
    console.warn("Worktree could not start from the remote branch; copying the project folder", error instanceof Error ? error.message.slice(0, 200) : error);
    await fs.rm(staging, { recursive: true, force: true });
    return null;
  }
  if (!base) return null;
  if (!base.fetched) console.warn(`Worktree starts from ${base.ref} as last fetched (${base.commit.slice(0, 8)}); fetching it failed`);
  // Uncommitted and untracked work in the folder stays there: it belongs to whoever is editing it.
  for (const entry of await ignoredPaths(source, gitEnvironment)) {
    const target = path.join(staging, entry);
    if (await lstatOrNull(target)) continue;
    if (await exceedsSize(path.join(source, entry), MAX_IGNORED_DIRECTORY_BYTES)) {
      console.info(`Worktree leaves out the ignored folder ${entry}: over ${MAX_IGNORED_DIRECTORY_BYTES / 1024 / 1024} MiB`);
      continue;
    }
    await fs.cp(path.join(source, entry), target, { recursive: true, force: false, errorOnExist: false, filter: (file) => copyCandidate(source, file) });
  }
  return { gitBase: base.commit, gitBaseRef: base.ref };
}

function normalizeId(value: unknown): string {
  if (value === undefined) return randomUUID();
  if (typeof value !== "string" || !WORKTREE_ID.test(value)) throw new ProjectWorktreeError(400, "Invalid worktree id");
  return value;
}

export async function createProjectWorktree(project: ProjectRecord, input: { id?: unknown; name: unknown; color?: unknown; createdBy?: WorktreeCreator; gitEnvironment?: NodeJS.ProcessEnv; localMain?: boolean; originMain?: boolean; restore?: { beforeBaseline(staging: string): Promise<void>; afterBaseline(staging: string): Promise<void> } }, root = worktreeRoot()): Promise<ProjectWorktree> {
  const name = normalizeName(input.name);
  const id = normalizeId(input.id);
  const existing = await listProjectWorktrees(project.id, root);
  // A caller-supplied id makes a retry after a lost response safe: the first attempt's worktree is returned as-is.
  const replayed = existing.find((worktree) => worktree.id === id);
  if (replayed) return replayed;
  if (existing.some((worktree) => worktree.name.toLowerCase() === name.toLowerCase())) throw new ProjectWorktreeError(409, "A worktree with this name already exists");
  const used = new Set(existing.map((worktree) => worktree.color));
  const color = normalizeColor(input.color, DEFAULT_COLOR_ORDER.find((candidate) => !used.has(candidate)) ?? DEFAULT_COLOR_ORDER[existing.length % DEFAULT_COLOR_ORDER.length]);
  const source = path.resolve(project.path);
  if (!(await fs.stat(source).catch(() => null))?.isDirectory()) throw new ProjectWorktreeError(409, "Project folder is not available on this node");
  const worktree = expectedWorktreePath(project.id, id, root);
  await fs.mkdir(path.dirname(worktree), { recursive: true });
  const node = await getClusterNode();
  // Copied privately, then renamed in: the synced folder never sees a half-made worktree.
  const staging = path.join(path.dirname(worktree), `.creating-${id}`);
  try {
    const remote = await copyRemoteBase(source, staging, input.gitEnvironment ?? {}, input.localMain, input.originMain);
    let gitBase = remote?.gitBase ?? null;
    let uncommittedDiff: string | null = null;
    if (!remote) {
      // No remote branch (a local-only repository, or none): the folder as it is, uncommitted work included.
      gitBase = await gitHead(source);
      uncommittedDiff = await gitDiff(source);
      await fs.cp(source, staging, { recursive: true, force: false, errorOnExist: true, filter: (entry) => copyCandidate(source, entry) });
    }
    await input.restore?.beforeBaseline(staging);
    await ensureWorktreeLocalFiles(source, staging);
    const baselineDigest = await captureBaseline(staging, worktreePathAllowed, [WORKTREE_META_DIR]);
    await input.restore?.afterBaseline(staging);
    const metadata: WorktreeMetadata = { version: 1, id, name, color, createdAt: new Date().toISOString(), createdByNodeId: node.id, baselineDigest, lastMergedAt: null, gitBase, gitBaseRef: remote?.gitBaseRef ?? null, createdBy: input.createdBy ?? null, pullRequest: null };
    await writeAtomic(metadataFile(staging), `${JSON.stringify(metadata, null, 2)}\n`);
    // Write base.patch if there were uncommitted changes - this syncs to other machines
    if (uncommittedDiff) await writeAtomic(path.join(staging, WORKTREE_META_DIR, "base.patch"), uncommittedDiff);
    await fs.rename(staging, worktree);
    await registerLocalPath(worktree, node.id);
    worktreeFilesChanged(project.id, worktree);
    // Created here, so used here: what other machines add to it later is downloaded.
    await useWorktreeFiles(project.id, id).catch((error) => console.warn("Worktree could not be marked as used here", error));
    return view(project.id, worktree, metadata);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function updateProjectWorktree(projectId: string, worktreeId: string, input: { name?: unknown; color?: unknown }, root = worktreeRoot()): Promise<ProjectWorktree> {
  const worktree = expectedWorktreePath(projectId, worktreeId, root);
  const metadata = await readMetadata(worktree);
  if (!metadata) throw new ProjectWorktreeError(404, "Worktree not found");
  const name = input.name === undefined ? metadata.name : normalizeName(input.name);
  if (name.toLowerCase() !== metadata.name.toLowerCase()
    && (await listProjectWorktrees(projectId, root)).some((other) => other.id !== worktreeId && other.name.toLowerCase() === name.toLowerCase())) {
    throw new ProjectWorktreeError(409, "A worktree with this name already exists");
  }
  const next = { ...metadata, name, color: normalizeColor(input.color, metadata.color) };
  await writeAtomic(metadataFile(worktree), `${JSON.stringify(next, null, 2)}\n`);
  worktreeFilesChanged(projectId, metadataFile(worktree));
  await carryToConversationRecords(projectId, worktreeId, { id: worktreeId, name: next.name, color: next.color });
  return view(projectId, worktree, next);
}

/** Nodes still waiting for the worktree's files list its conversations from their records, so the records follow it. */
async function carryToConversationRecords(projectId: string, worktreeId: string, next: { id: string; name: string; color: ProjectColor } | null): Promise<void> {
  try { await syncConversationWorktrees(projectId, worktreeId, next, (await getClusterNode()).id); }
  catch (error) { console.warn("Could not update conversation records for worktree %s", worktreeId, error); }
}

/** Deleting the folder is the deletion: file sync removes it from every node sharing the project. */
export async function deleteProjectWorktree(projectId: string, worktreeId: string, root = worktreeRoot(), options: { preserveSessionPaths?: boolean } = {}): Promise<void> {
  const projectRoot = projectWorktreeRoot(projectId, root);
  const worktree = expectedWorktreePath(projectId, worktreeId, root);
  if (!worktree.startsWith(`${projectRoot}${path.sep}`)) throw new ProjectWorktreeError(400, "Worktree ID is invalid");
  if (!await readMetadata(worktree)) throw new ProjectWorktreeError(404, "Worktree not found");
  const retired = path.resolve(projectRoot, ".retired", `${worktreeId}.json`);
  if (!retired.startsWith(`${projectRoot}${path.sep}`)) throw new ProjectWorktreeError(400, "Worktree ID is invalid");
  const paths = options.preserveSessionPaths === false ? [] : (await worktreeSessionPaths(projectId, root)).filter(directory => path.basename(directory) === worktreeId);
  await writeAtomic(retired, `${JSON.stringify(paths)}\n`, projectRoot);
  worktreeFilesChanged(projectId, retired);
  const metadata = path.resolve(metadataFile(worktree));
  if (metadata.startsWith(`${worktree}${path.sep}`)) await fs.rm(metadata, { force: true });
  await fs.rm(worktree, { recursive: true, force: true });
  worktreeFilesChanged(projectId, worktree);
  await carryToConversationRecords(projectId, worktreeId, null);
}

function conversationMarker(worktree: string, engine: string, sessionId: string): string {
  assertSegment(engine, "Engine");
  assertSegment(sessionId, "Conversation ID");
  return path.join(worktree, WORKTREE_META_DIR, "conversations", `${engine}--${sessionId}.json`);
}

export async function markWorktreeConversation(projectId: string, worktreeId: string, engine: string, sessionId: string, root = worktreeRoot()): Promise<void> {
  assertNoCleanupClaim(projectId, worktreeId);
  if (conversationPrivacy(sessionId)) return; // The placement lives on the private conversation record.
  const file = conversationMarker(expectedWorktreePath(projectId, worktreeId, root), engine, sessionId);
  try { await fs.access(file); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await writeAtomic(file, `${JSON.stringify({ engine, sessionId, createdAt: new Date().toISOString() })}\n`);
  worktreeFilesChanged(projectId, file);
}

/** `engine:sessionId` → worktree, for every conversation started inside a worktree of the project. */
export async function worktreeConversationIndex(projectId: string, root = worktreeRoot()): Promise<Map<string, ProjectWorktree>> {
  return (await worktreeConversations(projectId, root)).index;
}

/** The project's worktrees whose files are on this node, and the same index of the conversations started inside them. */
export async function worktreeConversations(projectId: string, root = worktreeRoot()): Promise<{ worktrees: ProjectWorktree[]; index: Map<string, ProjectWorktree> }> {
  const scan = await scanProjectWorktrees(projectId, root);
  const worktrees = structuredClone(scan.worktrees.map((entry) => entry.worktree));
  const index = new Map<string, ProjectWorktree>();
  scan.worktrees.forEach((entry, position) => {
    for (const file of entry.conversations) {
      const match = /^([A-Za-z0-9._-]+?)--([A-Za-z0-9._-]+)\.json$/.exec(file);
      if (match) index.set(`${match[1]}:${match[2]}`, worktrees[position]);
    }
  });
  return { worktrees, index };
}

/** Every path any node keeps a worktree of this project at: conversations are matched by working directory. */
export async function worktreeSessionPaths(projectId: string, root = worktreeRoot()): Promise<string[]> {
  const scan = await scanProjectWorktrees(projectId, root);
  if ("error" in scan.retired) throw scan.retired.error;
  const paths = new Set<string>(scan.retired.paths);
  for (const entry of scan.worktrees) {
    paths.add(entry.worktree.path);
    for (const nodePath of entry.nodePaths) paths.add(nodePath);
  }
  return [...paths];
}

export interface WorktreeMergeResult {
  merged: boolean;
  applied: number;
  deleted: number;
  conflicts: Array<{ path: string; reason: string }>;
}

const mergeLocks = new Map<string, Promise<unknown>>();

/** Three-way merges the worktree into the project folder. Conflicts change nothing. */
export async function mergeProjectWorktree(project: ProjectRecord, worktreeId: string, root = worktreeRoot()): Promise<WorktreeMergeResult> {
  const previous = mergeLocks.get(project.id) ?? Promise.resolve();
  const run = previous.then(() => mergeLocked(project, worktreeId, root), () => mergeLocked(project, worktreeId, root));
  const gate = run.catch(() => undefined);
  mergeLocks.set(project.id, gate);
  void gate.finally(() => { if (mergeLocks.get(project.id) === gate) mergeLocks.delete(project.id); });
  return await run;
}

async function sha256File(file: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function mergeLocked(project: ProjectRecord, worktreeId: string, root: string): Promise<WorktreeMergeResult> {
  assertNoCleanupClaim(project.id, worktreeId);
  const worktree = expectedWorktreePath(project.id, worktreeId, root);
  const metadata = await readMetadata(worktree);
  if (!metadata) throw new ProjectWorktreeError(404, "Worktree not found");
  // Built-in sync: newer files of the worktree still on their way would leave this merge working from an older copy (design §6.5).
  if (await worktreeHasPendingFiles(project.id, worktreeId)) throw new ProjectWorktreeError(409, "Files of this worktree are still arriving from another machine; merge again in a moment");
  const projectRoot = await fs.realpath(project.path).catch(() => { throw new ProjectWorktreeError(409, "Project folder is not available on this node"); });
  const baseRoot = path.resolve(root);
  if (!worktree.startsWith(`${baseRoot}${path.sep}`)) throw new ProjectWorktreeError(400, "Worktree ID is invalid");
  const workspace = await fs.realpath(worktree);
  try {
    const prepared = await prepareTicketMerge(projectRoot, workspace, metadata.baselineDigest, { workspaceOnlyDirs: [WORKTREE_META_DIR], allowed: worktreePathAllowed });
    if (prepared.conflicts.length) {
      return { merged: false, applied: 0, deleted: 0, conflicts: prepared.conflicts.map((conflict) => ({ path: conflict.path, reason: conflict.reason ?? conflict.kind })) };
    }
    const stagedRoot = path.join(workspace, TICKET_MERGE_DIR, "staged");
    const ops: MergeOp[] = [];
    for (const [file, entry] of Object.entries(prepared.plan.files)) {
      if (entry.decision === "apply" || entry.decision === "text") {
        ops.push({ op: "write", path: file, oldSha256: entry.projectSha256 ?? null, newSha256: entry.stagedSha256 ?? "", oldMode: entry.projectMode ?? null, newMode: entry.mode ?? 0o644, backupPath: null, createdParents: [], createdBackupDirs: [] });
      } else if (entry.decision === "delete") {
        ops.push({ op: "delete", path: file, oldSha256: entry.projectSha256 ?? null, newSha256: null, oldMode: entry.projectMode ?? null, newMode: null, backupPath: null, createdParents: [], createdBackupDirs: [] });
      }
    }
    for (const op of ops) {
      const target = path.join(projectRoot, op.path);
      const current = await fs.stat(target).catch(() => null);
      if ((op.oldSha256 === null) !== (current === null) || (current && await sha256File(target) !== op.oldSha256)) {
        throw new ProjectWorktreeError(409, `Project changed while merging: ${op.path}. Merge again.`);
      }
    }
    if (ops.length) {
      const txid = await recordMergeTransaction(`worktree-${worktreeId}`, project.id, ops);
      try {
        await applyMergeTransaction(projectRoot, txid, async (op) => {
          const bytes = await fs.readFile(path.join(stagedRoot, op.path));
          if (op.op === "write" && op.newSha256 && createHash("sha256").update(bytes).digest("hex") !== op.newSha256) {
            throw new ProjectWorktreeError(409, `Worktree changed while merging: ${op.path}. Merge again.`);
          }
          return bytes;
        });
      } catch (error) {
        await rollbackMergeTransaction(projectRoot, txid).catch((rollbackError) => console.warn("Worktree merge rollback failed; recovery retries it", rollbackError));
        throw error;
      }
    }
    // The merged worktree is the new common ancestor, so the next merge only carries later edits.
    const baselineDigest = await captureBaseline(workspace, worktreePathAllowed, [WORKTREE_META_DIR, TICKET_MERGE_DIR]);
    await writeAtomic(metadataFile(workspace), `${JSON.stringify({ ...metadata, baselineDigest, lastMergedAt: new Date().toISOString() }, null, 2)}\n`);
    worktreeFilesChanged(project.id, metadataFile(worktree));
    return { merged: true, applied: ops.filter((op) => op.op === "write").length, deleted: ops.filter((op) => op.op === "delete").length, conflicts: [] };
  } finally {
    await fs.rm(path.join(workspace, TICKET_MERGE_DIR), { recursive: true, force: true });
  }
}


export type { WorktreeChanges, WorktreeFileChange };

/** Reads the base.patch file if it exists and returns the paths that had uncommitted changes. */
async function readUncommittedPaths(worktree: string): Promise<Set<string>> {
  const base = path.resolve(worktree);
  const patchFile = path.resolve(base, WORKTREE_META_DIR, "base.patch");
  if (!patchFile.startsWith(`${base}${path.sep}`)) return new Set();
  try {
    const patch = await fs.readFile(patchFile, "utf8");
    return new Set(parseDiffPaths(patch));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
}

/** Everything the worktree changed since it was copied (or last merged), for a pull request. */
export async function worktreeChanges(projectId: string, worktreeId: string, root = worktreeRoot()): Promise<WorktreeChanges> {
  const worktree = expectedWorktreePath(projectId, worktreeId, root);
  const { metadata, baseline } = await readWorktreeBaseline(projectId, worktreeId, root);
  const skipped = new Set([TICKET_BASELINE_DIR, TICKET_MERGE_DIR, WORKTREE_META_DIR]);
  const writes: WorktreeFileChange[] = [];
  const present = new Set<string>();
  for (const entry of await listTreeEntries(worktree)) {
    const relative = path.relative(worktree, entry.path).split(path.sep).join("/");
    if (entry.symlink || skipped.has(relative.split("/")[0]) || !worktreePathAllowed(worktree, entry.path)) continue;
    present.add(relative);
    const [content, info] = await Promise.all([fs.readFile(entry.path), fs.stat(entry.path)]);
    const before = baseline.manifest.files[relative];
    const executable = (info.mode & 0o111) !== 0;
    if (before && !("symlink" in before) && before.sha256 === createHash("sha256").update(content).digest("hex") && ((before.mode & 0o111) !== 0) === executable) continue;
    writes.push({ path: relative, content, executable });
  }
  const deletes = Object.entries(baseline.manifest.files).filter(([file, entry]) => !("symlink" in entry) && !present.has(file)).map(([file]) => file).sort();
  const uncommittedAtCreation = await readUncommittedPaths(worktree);
  const changedPaths = new Set([...writes.map((w) => w.path), ...deletes]);
  const uncommittedPaths = [...changedPaths].filter((p) => uncommittedAtCreation.has(p)).sort();
  return { gitBase: metadata.gitBase ?? null, writes, deletes, uncommittedPaths };
}

export async function readWorktreeBaseline(projectId: string, worktreeId: string, root = worktreeRoot()) {
  const worktree = expectedWorktreePath(projectId, worktreeId, root);
  const metadata = await readMetadata(worktree);
  if (!metadata) throw new ProjectWorktreeError(404, "Worktree not found");
  const baseline = await readBaseline(worktree);
  // The digest recorded at creation pins the manifest an agent could otherwise rewrite.
  if (!baseline || baseline.digest !== metadata.baselineDigest) {
    // On another node than the creator the baseline is the last thing file sync brings, so it is often missing or older than worktree.json.
    if (await worktreeHasPendingFiles(projectId, worktreeId)) throw new ProjectWorktreeError(409, "Files of this worktree are still arriving from another machine; try again in a moment");
    throw new ProjectWorktreeError(409, "Worktree baseline changed; its changes cannot be determined");
  }
  return { metadata, baseline };
}

/** Paths the project's git ignores (.gitignore, .git/info/exclude, global excludes), tracked files excepted. */
function gitIgnoredPaths(projectPath: string, paths: string[]): Promise<Set<string>> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", projectPath, "check-ignore", "-z", "--stdin"]);
    let stdout = "";
    let stderr = "";
    let inputError: Error | undefined;
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
    child.on("error", reject);
    // Git can exit before reading stdin, for example when this is not a repository.
    child.stdin.on("error", (error: Error) => { inputError = error; });
    child.on("close", (code) => {
      // Exit status 1 means no path matched; anything else (not a repository, git missing) must not pass silently.
      if (code !== 0 && code !== 1) reject(new Error(stderr.trim() || `git check-ignore exited with status ${code}`));
      else if (inputError) reject(inputError);
      else resolve(new Set(stdout.split("\0").filter(Boolean)));
    });
    child.stdin.end(paths.map((file) => `${file}\0`).join(""));
  });
}

/** Drops changes the project's git ignores. A worktree copy has no repository of its own, so its changes are
    filtered the way git would before they reach a pull request. */
export async function withoutGitIgnored(projectPath: string, changes: WorktreeChanges): Promise<WorktreeChanges> {
  const ignored = await gitIgnoredPaths(projectPath, [...changes.writes.map((file) => file.path), ...changes.deletes]);
  return {
    ...changes,
    writes: changes.writes.filter((file) => !ignored.has(file.path)),
    deletes: changes.deletes.filter((file) => !ignored.has(file)),
  };
}

interface PersistedPullRequestSnapshot {
  version: 1;
  gitBase: string | null;
  writes: Array<{ path: string; executable: boolean; contentBase64: string }>;
  deletes: string[];
}

function snapshotFilePath(worktree: string, relative: string): string | null {
  if (!relative || path.isAbsolute(relative)) return null;
  const metaRoot = path.resolve(worktree, WORKTREE_META_DIR);
  const full = path.resolve(metaRoot, relative);
  if (full !== metaRoot && !full.startsWith(`${metaRoot}${path.sep}`)) return null;
  return full;
}

/** Saves the worktree's pre-rebase changes snapshot under `.joint-bob-worktree/` so follow-up PRs/merges across any node diff cleanly against the merged PR. */
export async function saveWorktreePullRequestSnapshot(projectId: string, worktreeId: string, prNumber: number, changes: WorktreeChanges, root = worktreeRoot()): Promise<string> {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new ProjectWorktreeError(400, "Invalid pull request number");
  const worktree = expectedWorktreePath(projectId, worktreeId, root);
  const relative = `pr-snapshots/pr-${prNumber}.json`;
  const target = snapshotFilePath(worktree, relative)!;
  const payload: PersistedPullRequestSnapshot = {
    version: 1,
    gitBase: changes.gitBase,
    writes: changes.writes.map((file) => ({ path: file.path, executable: file.executable, contentBase64: file.content.toString("base64") })),
    deletes: [...changes.deletes],
  };
  await writeAtomic(target, `${JSON.stringify(payload)}\n`);
  worktreeFilesChanged(projectId, target);
  return relative;
}

export async function readWorktreePullRequestSnapshot(projectId: string, worktreeId: string, snapshotFile: string | undefined, root = worktreeRoot()): Promise<WorktreeChangeSnapshot | null> {
  if (!snapshotFile) return null;
  const worktree = expectedWorktreePath(projectId, worktreeId, root);
  const target = snapshotFilePath(worktree, snapshotFile);
  if (!target) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(target, "utf8")) as Partial<PersistedPullRequestSnapshot>;
    if (parsed.version !== 1 || !Array.isArray(parsed.writes) || !Array.isArray(parsed.deletes)) return null;
    const writes: WorktreeFileChange[] = [];
    for (const item of parsed.writes) {
      if (!item || typeof item.path !== "string" || typeof item.contentBase64 !== "string") return null;
      writes.push({ path: item.path, executable: Boolean(item.executable), content: Buffer.from(item.contentBase64, "base64") });
    }
    const deletes = parsed.deletes.filter((entry): entry is string => typeof entry === "string");
    return { gitBase: typeof parsed.gitBase === "string" ? parsed.gitBase : null, writes, deletes };
  } catch { return null; }
}

export async function readWorktreeMergedPullRequest(projectId: string, worktreeId: string, root = worktreeRoot()): Promise<WorktreePullRequest | null> {
  const worktree = expectedWorktreePath(projectId, worktreeId, root);
  const metadata = await readMetadata(worktree);
  return metadata?.mergedPullRequest ?? null;
}

export async function recordWorktreeMergedPullRequest(projectId: string, worktreeId: string, mergedPullRequest: WorktreePullRequest, root = worktreeRoot()): Promise<ProjectWorktree> {
  const worktree = expectedWorktreePath(projectId, worktreeId, root);
  const metadata = await readMetadata(worktree);
  if (!metadata) throw new ProjectWorktreeError(404, "Worktree not found");
  const pullRequest = metadata.pullRequest?.number === mergedPullRequest.number
    ? { ...metadata.pullRequest, ...mergedPullRequest }
    : metadata.pullRequest ?? null;
  const next: WorktreeMetadata = { ...metadata, pullRequest, mergedPullRequest, lastMergedAt: metadata.lastMergedAt ?? new Date().toISOString() };
  await writeAtomic(metadataFile(worktree), `${JSON.stringify(next, null, 2)}\n`);
  worktreeFilesChanged(projectId, metadataFile(worktree));
  return view(projectId, worktree, next);
}

export async function recordWorktreePullRequest(projectId: string, worktreeId: string, pullRequest: WorktreePullRequest, root = worktreeRoot(), options?: { merged?: boolean }): Promise<ProjectWorktree> {
  const worktree = expectedWorktreePath(projectId, worktreeId, root);
  const metadata = await readMetadata(worktree);
  if (!metadata) throw new ProjectWorktreeError(404, "Worktree not found");
  const next: WorktreeMetadata = {
    ...metadata,
    pullRequest,
    ...(options?.merged ? { mergedPullRequest: pullRequest, lastMergedAt: new Date().toISOString() } : {}),
  };
  await writeAtomic(metadataFile(worktree), `${JSON.stringify(next, null, 2)}\n`);
  worktreeFilesChanged(projectId, metadataFile(worktree));
  return view(projectId, worktree, next);
}
