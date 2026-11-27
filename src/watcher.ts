import { statSync } from "node:fs";
import path from "node:path";
import { multiUserEnabled, runInRuntime, serviceRuntime, type RuntimeAccount } from "./account-runtime.js";
import { listDiscoveredHarnesses } from "./harnesses/registry.js";
import { sessionCwdSet, type SessionProjectPaths } from "./harnesses/shared-paths.js";
import { watchTree, type TreeWatch } from "./tree-watch.js";
import type { ProjectRecord } from "./types.js";

const DEBOUNCE_MS = 750;
const RESCAN_MS = 15_000;
/** The longest a directory whose watcher keeps failing is left unwatched. */
const MAX_RETRY_MS = 10 * 60_000;
const MAX_KNOWN_OWNERS = 5_000;
/*
 * A running conversation writes its transcript every few seconds, and each refresh made every
 * open page rebuild the project's whole conversation list: 21 refreshes a minute for Joint Bob
 * on 2026-11-22, and list building was 45% of the Mac's CPU. A transcript this watcher already
 * announced, written by a turn that announces its own end (`announcesItsEnd`: a turn running
 * in this server, whose agent_end refreshes the list at once, harness-sessions.ts), refreshes
 * its project at most this often. Anything else still refreshes after the debounce: a new
 * transcript, a folder change, and a transcript written from outside (a CLI session, a copy
 * from another machine), where the watcher is how a finished turn is noticed.
 */
const KNOWN_REFRESH_MS = 10_000;
const MAX_ANNOUNCED_FILES = 20_000;
export type SessionChangeListener = (projectId: string, changedFiles: string[]) => void;
export interface SessionWatcherOptions { knownRefreshMs?: number; announcesItsEnd?: (file: string) => boolean }
interface WatchedProject { paths: SessionProjectPaths; directories: Set<string>; pendingFiles: Map<string, ReturnType<typeof listDiscoveredHarnesses>[number]>; needsFullRefresh: boolean; debounceTimer: NodeJS.Timeout | null; runtime: RuntimeAccount; lastFlushAt: number; }
interface SharedWatch { watcher: TreeWatch; projects: Set<string>; openedAt: number; }

export function sessionWatchDirs(project: SessionProjectPaths): string[] {
  return [...new Set(listDiscoveredHarnesses().flatMap((adapter) => adapter.sync.watchDirs?.(project) ?? [adapter.sync.transcriptRoot()]))];
}
/** Certainly not there. Anything unclear (no permission, a file in the way) is left for the watch itself to report. */
function absent(dir: string): boolean {
  try { return statSync(dir, { throwIfNoEntry: false }) === undefined; } catch { return false; }
}
function missing(error: unknown): boolean { const code = (error as NodeJS.ErrnoException).code; return code === "ENOENT" || code === "ENOTDIR"; }

export class SessionWatcher {
  private projects = new Map<string, WatchedProject>();
  private directories = new Map<string, SharedWatch>();
  // Reopening a directory walks its whole tree and refreshes every project that uses it. A
  // watcher that fails again at once (Linux out of inotify watches) repeated that every
  // rescan and kept the node saturated, so each failure waits longer than the last.
  private failures = new Map<string, { count: number; retryAt: number }>();
  private ownerReads = new Map<string, Promise<string | null>>();
  // A transcript's header never changes once written, and every project watching the shared
  // root asks for it on every write.
  private owners = new Map<string, string>();
  private rescanTimer: NodeJS.Timeout;
  /** Transcripts already announced to their project: a later write of one is only growth. */
  private announced = new Set<string>();
  private readonly knownRefreshMs: number;
  private readonly announcesItsEnd: (file: string) => boolean;
  constructor(private listener: SessionChangeListener, options: SessionWatcherOptions = {}) {
    this.knownRefreshMs = options.knownRefreshMs ?? KNOWN_REFRESH_MS;
    this.announcesItsEnd = options.announcesItsEnd ?? (() => false);
    this.rescanTimer = setInterval(() => this.rescan(), RESCAN_MS); this.rescanTimer.unref();
  }

  ensureProject(project: ProjectRecord): void {
    const watched = this.projects.get(project.id);
    const paths = { path: project.path, macPath: project.macPath, locations: project.locations, additionalPaths: "additionalPaths" in project ? project.additionalPaths as string[] | undefined : undefined };
    if (watched) watched.paths = paths;
    else this.projects.set(project.id, { paths, directories: new Set(), pendingFiles: new Map(), needsFullRefresh: false, debounceTimer: null, runtime: serviceRuntime(), lastFlushAt: 0 });
    if (!multiUserEnabled()) { this.watchDirs(project.id); return; }
    // In multi-user mode a project's transcripts are in its runtime account's home.
    void import("./project-runtime.js").then(({ runtimeForProject }) => runtimeForProject(project.id)).then((runtime) => {
      const current = this.projects.get(project.id);
      if (current) current.runtime = runtime;
    }, () => undefined).finally(() => this.watchDirs(project.id));
  }
  removeProject(projectId: string): void {
    const project = this.projects.get(projectId); if (!project) return;
    if (project.debounceTimer) clearTimeout(project.debounceTimer);
    for (const dir of project.directories) this.unsubscribe(projectId, dir);
    this.projects.delete(projectId);
  }
  close(): void {
    clearInterval(this.rescanTimer);
    for (const projectId of this.projects.keys()) this.removeProject(projectId);
    this.ownerReads.clear();
    this.owners.clear();
    this.announced.clear();
  }
  private unsubscribe(projectId: string, dir: string): void {
    const shared = this.directories.get(dir)!;
    shared.projects.delete(projectId);
    if (!shared.projects.size) { shared.watcher.close(); this.directories.delete(dir); }
    this.projects.get(projectId)!.directories.delete(dir);
  }

  private watchDirs(projectId: string): void {
    const project = this.projects.get(projectId); if (!project) return;
    const desired = new Set(runInRuntime(project.runtime, () => sessionWatchDirs(project.paths)));
    for (const dir of project.directories) if (!desired.has(dir)) this.unsubscribe(projectId, dir);
    for (const dir of desired) {
      if (project.directories.has(dir)) continue;
      if (!this.directories.has(dir) && (this.failures.get(dir)?.retryAt ?? 0) > Date.now()) continue;
      // Most folders a project could have transcripts in do not exist (one per worktree per agent, well
      // over a thousand for a project with many worktrees), and this runs on every listing. Asking
      // whether one is there costs an eighth of trying to watch it and failing (3 ms against 25 ms for 1,400).
      if (!this.directories.has(dir) && absent(dir)) continue;
      try {
        const shared = this.directories.get(dir) ?? this.openDirectory(dir);
        shared.projects.add(projectId);
        project.directories.add(dir);
        void this.handleEvent(projectId, dir, null).catch((error) => console.error(`Session watcher event failed for ${dir}:`, error));
      } catch (error) { if (!missing(error)) console.error(`Session watcher could not watch ${dir}:`, error); }
    }
  }
  private openDirectory(dir: string): SharedWatch {
    const projects = new Set<string>();
    const watcher = watchTree(dir, (_event, file) => {
      for (const projectId of projects) {
        void this.handleEvent(projectId, dir, file).catch((error) => console.error(`Session watcher event failed for ${dir}:`, error));
      }
    });
    watcher.unref();
    watcher.on("error", (error) => {
      for (const projectId of projects) this.unsubscribe(projectId, dir);
      if (missing(error)) return;
      // A watcher that ran for a long while before failing starts a new streak.
      const streak = Date.now() - shared.openedAt < MAX_RETRY_MS ? this.failures.get(dir)?.count ?? 0 : 0;
      const delay = Math.min(MAX_RETRY_MS, RESCAN_MS * 2 ** streak);
      this.failures.set(dir, { count: streak + 1, retryAt: Date.now() + delay });
      const cause = (error as NodeJS.ErrnoException).code === "ENOSPC"
        ? "this user is out of inotify watches (raise fs.inotify.max_user_watches)"
        : error instanceof Error ? error.message : String(error);
      console.error(`Session watcher failed for ${dir}: ${cause}. Conversation lists under it refresh again in ${Math.round(delay / 1000)} s.`);
    });
    const shared: SharedWatch = { watcher, projects, openedAt: Date.now() };
    this.directories.set(dir, shared);
    return shared;
  }
  private rescan(): void { for (const projectId of this.projects.keys()) this.watchDirs(projectId); }

  private async ownerCwd(adapter: ReturnType<typeof listDiscoveredHarnesses>[number], filePath: string): Promise<string | null> {
    if (!adapter.sync.transcriptCwd) return null;
    const key = `${adapter.id}:${path.resolve(filePath)}`;
    const known = this.owners.get(key);
    if (known) return known;
    const existing = this.ownerReads.get(key);
    if (existing) return existing;
    const reading = adapter.sync.transcriptCwd(filePath).then((cwd) => {
      if (cwd) {
        if (this.owners.size >= MAX_KNOWN_OWNERS) this.owners.clear();
        this.owners.set(key, cwd);
      }
      return cwd;
    }).catch((error) => {
      console.error(`Session watcher could not read transcript owner for ${filePath}:`, error);
      return null;
    }).finally(() => this.ownerReads.delete(key));
    this.ownerReads.set(key, reading);
    return reading;
  }

  private async flush(projectId: string, project: WatchedProject): Promise<void> {
    await runInRuntime(project.runtime, () => this.flushPending(projectId, project));
  }

  private async flushPending(projectId: string, project: WatchedProject): Promise<void> {
    const fullRefresh = project.needsFullRefresh;
    const pending = [...project.pendingFiles];
    project.lastFlushAt = Date.now();
    project.needsFullRefresh = false;
    project.pendingFiles.clear();
    // A create event can precede the first header write. Read ownership after debounce.
    const resolved = await Promise.all(pending.map(async ([file, adapter]) => {
      const cwd = await this.ownerCwd(adapter, file);
      return cwd && !sessionCwdSet(project.paths).has(cwd) ? null : file;
    }));
    if (this.projects.get(projectId) !== project) return;
    const files = resolved.filter((file): file is string => file !== null);
    if (this.announced.size + files.length > MAX_ANNOUNCED_FILES) this.announced.clear();
    for (const file of files) this.announced.add(file);
    if (fullRefresh || files.length) this.listener(projectId, fullRefresh ? [] : files);
  }

  private async handleEvent(projectId: string, dir: string, fileName: string | Buffer | null): Promise<void> {
    const project = this.projects.get(projectId); if (!project) return;
    const name = typeof fileName === "string" ? fileName : Buffer.isBuffer(fileName) ? fileName.toString() : "";
    if (!name) project.needsFullRefresh = true;
    else {
      const file = path.join(dir, name);
      const adapter = runInRuntime(project.runtime, () => listDiscoveredHarnesses().find((candidate) => candidate.paths.ownsTranscript(file)));
      if (!adapter) return;
      const canonicalFile = runInRuntime(project.runtime, () => adapter.paths.canonicalTranscript?.(file) ?? file);
      // Dropped before the debounce: another project's write must not keep postponing this project's refresh.
      if (adapter.sync.transcriptBelongs && !runInRuntime(project.runtime, () => adapter.sync.transcriptBelongs!(project.paths, canonicalFile))) return;
      project.pendingFiles.set(canonicalFile, adapter);
    }
    if (this.projects.get(projectId) !== project) return;
    const held = !project.needsFullRefresh && project.pendingFiles.size > 0
      && [...project.pendingFiles.keys()].every((file) => this.announced.has(file) && this.announcesItsEnd(file));
    const wait = held ? Math.max(DEBOUNCE_MS, project.lastFlushAt + this.knownRefreshMs - Date.now()) : DEBOUNCE_MS;
    if (project.debounceTimer) clearTimeout(project.debounceTimer);
    project.debounceTimer = setTimeout(() => {
      project.debounceTimer = null;
      void this.flush(projectId, project).catch(error => console.error(`Session watcher refresh failed for ${projectId}:`, error));
    }, wait);
  }
}
