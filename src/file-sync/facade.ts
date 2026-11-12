import { peerAway } from "../peer-presence.js";
import { getProject } from "../store.js";
import type { ProjectRecord, ProjectSyncStatus } from "../types.js";
import { controlDatabase, listPhases, type PhaseRecord } from "./control.js";
import type { FileSyncPeerFacts, FileSyncProjectView } from "./index.js";
import { FILE_SYNC_SWITCH_PROTOCOL } from "./protocol.js";
import { projectSyncStatus } from "./status.js";
import type { Phase, ShareKind } from "./types.js";

/* The one place callers ask about a project's files on other machines. A project shared with another
   machine is moved by the built-in engine: once this node has taken it over (phase "builtin") the
   answers come from the engine's in-memory reports; while the take-over runs ("moving") nothing
   should start work on it. A project with no phase here is shared with nobody ("none"): there is
   nothing to wait for. */

/** How a project's files reach other machines from this node: "builtin" synced, "moving" being taken over, "none" shared with nobody. */
export type ProjectFilesEngine = "builtin" | "moving" | "none";
/** What the UI is told besides the status: whether the project is synced or still being taken over. */
export type FacadeSyncStatus = ProjectSyncStatus & { engine?: "builtin" | "moving" | "none" };

export class ProjectNotSynchronizedError extends Error {
  constructor() { super("Project is not synchronized"); }
}

/** The built-in engine cannot act for the project on this node right now (off, restarting); `message` says why in plain words. */
export class ProjectFilesUnavailableError extends Error {}

export function unavailableProjectStatus(message = "This project is not shared with another machine"): ProjectSyncStatus {
  return { state: "unavailable", remainingFiles: 0, remainingBytes: 0, message };
}

/* ---- engine choice ---- */

/** The engine's main-thread answers the facade uses (index.ts); tests stand one in with useFacadeEngineForTests. */
export type EngineApi = Pick<typeof import("./index.js"),
  "fileSyncProjectViews" | "fileSyncPeerFacts" | "fileSyncRescanProject" | "fileSyncScanPaths"
  | "fileSyncPrioritize" | "fileSyncPulledSinceStart" | "fileSyncPendingFiles">;

let engineModule: Promise<EngineApi> | undefined;
let engineOverride: EngineApi | undefined;

function engineApi(): Promise<EngineApi> {
  return engineOverride ? Promise.resolve(engineOverride) : (engineModule ??= import("./index.js"));
}

/** Tests: the engine's main-thread answers from a stand-in; undefined restores the real one. */
export function useFacadeEngineForTests(engine: EngineApi | undefined): void {
  engineOverride = engine;
}

export function filesEngineOf(phase: Phase | undefined): ProjectFilesEngine {
  return !phase ? "none" : phase === "builtin" ? "builtin" : "moving";
}

/** Node-local phases; a node.db that cannot be read counts as nothing shared. */
async function phases(): Promise<Map<string, Phase>> {
  return new Map([...await phaseRecords()].map(([projectId, record]) => [projectId, record.phase]));
}

async function phaseRecords(): Promise<Map<string, PhaseRecord>> {
  try { return listPhases(await controlDatabase()); }
  catch { return new Map(); }
}

async function phaseOfProject(projectId: string): Promise<Phase | undefined> {
  return (await phases()).get(projectId);
}

/** Which engine moves the project's files on this node (design §6.5). */
export async function projectFilesEngine(projectId: string): Promise<ProjectFilesEngine> {
  return filesEngineOf(await phaseOfProject(projectId));
}

/** The same for many projects with one read. */
export async function projectFilesEngines(projectIds: readonly string[]): Promise<Map<string, ProjectFilesEngine>> {
  const held = projectIds.length ? await phases() : new Map<string, Phase>();
  return new Map(projectIds.map((id) => [id, filesEngineOf(held.get(id))]));
}

function movingStatus(): FacadeSyncStatus {
  return { state: "syncing", remainingFiles: 0, remainingBytes: 0, message: "Checking both machines' files", engine: "moving" };
}

/* ---- built-in status texts (pure; exported for tests) ---- */

export interface PeerFacts { local: string; peers: ReadonlyMap<string, FileSyncPeerFacts> }

function plural(count: number, one: string, many = `${one}s`): string { return `${count} ${count === 1 ? one : many}`; }

export function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function nameOf(facts: PeerFacts, peer: string): string { return facts.peers.get(peer)?.name ?? peer; }
function presentPeer(facts: PeerFacts, peer: string): boolean { return facts.peers.get(peer)?.present ?? !peerAway(peer); }

/** "homeserver", "homeserver and laptop", or "3 other machines". */
function machines(facts: PeerFacts, peers: readonly string[]): string {
  const names = [...new Set(peers)].map((peer) => nameOf(facts, peer));
  if (!names.length) return "other machines";
  return names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.length} other machines`;
}

/** An eligible peer that cannot receive files (design §7 continuous check), named for the person reading it. */
function peerProblem(view: FileSyncProjectView, facts: PeerFacts): string | undefined {
  for (const peer of [...new Set(Object.values(view.peers).flat())].sort()) {
    const known = facts.peers.get(peer);
    if (known?.protocol === 0) return `${nameOf(facts, peer)} runs a Joint Bob without the built-in file sync`;
    // An engine older than the take-over protocol receives nothing.
    if (known?.protocol !== undefined && known.protocol < FILE_SYNC_SWITCH_PROTOCOL) return `${nameOf(facts, peer)} needs a newer Joint Bob to receive these files`;
    if (known?.enabled === false) return `File sync is off on ${nameOf(facts, peer)}`;
  }
  return undefined;
}

/** A built-in project's status from its shares (design §6.5); `kinds` narrows it to some of them. */
export function builtinProjectStatus(view: FileSyncProjectView, facts: PeerFacts, kinds?: readonly ShareKind[]): FacadeSyncStatus {
  const shares = kinds ? view.shares.filter((share) => kinds.includes(share.kind)) : view.shares;
  const done = (status: ProjectSyncStatus): FacadeSyncStatus => ({ ...status, engine: "builtin" });
  if (view.worker === "failed") return done({ state: "error", remainingFiles: 0, remainingBytes: 0, message: "File sync stopped on this node after repeated failures" });
  if (view.enabled && view.worker === "running" && !view.shares.length) {
    return done({ state: "unavailable", remainingFiles: 0, remainingBytes: 0, message: "No other machine shares this project right now" });
  }
  const status = projectSyncStatus(shares, { enabled: view.enabled, running: view.worker === "running", present: (peer) => presentPeer(facts, peer) }, peerProblem(view, facts));
  if (status.state !== "syncing") return done(status);
  const behind = shares.flatMap((share) => share.peers.filter((peer) => !peer.caughtUp && presentPeer(facts, peer.peer)).map((peer) => peer.peer));
  if (status.remainingFiles > 0) {
    // Need rows do not say which peer has the content: the ones still ahead, else every present peer.
    const sources = behind.length ? behind : shares.flatMap((share) => share.peers.filter((peer) => presentPeer(facts, peer.peer)).map((peer) => peer.peer));
    const amount = `${plural(status.remainingFiles, "file")} (${formatBytes(status.remainingBytes)})`;
    // fix (P4+P5): with every machine that could send away, nothing is being copied: the files wait for them.
    if (!sources.length) {
      const away = shares.flatMap((share) => share.peers.map((peer) => peer.peer));
      return done({ ...status, message: `${amount} waiting for ${machines(facts, away)}, which ${new Set(away).size === 1 ? "is" : "are"} away` });
    }
    return done({ ...status, message: `Copying ${amount} from ${machines(facts, sources)}` });
  }
  if (status.message === "Catching up with other machines") return done({ ...status, message: `Catching up with ${machines(facts, behind)}` });
  return done(status);
}

/** Where a peer reads it as the plain status. */
function withoutEngine(status: FacadeSyncStatus): ProjectSyncStatus {
  const { engine: _engine, ...plain } = status;
  return plain;
}

/* ---- the facade ---- */

/** Keyed by project id, computed in memory from the engine's reports. */
export async function projectSyncStatuses(projects: ProjectRecord[]): Promise<Record<string, FacadeSyncStatus>> {
  const held = projects.length ? await phases() : new Map<string, Phase>();
  const result: Record<string, FacadeSyncStatus> = {};
  const builtin: ProjectRecord[] = [];
  for (const project of projects) {
    const engine = filesEngineOf(held.get(project.id));
    if (engine === "builtin") builtin.push(project);
    else result[project.id] = engine === "moving" ? movingStatus() : { ...unavailableProjectStatus(), engine: "none" };
  }
  if (!builtin.length) return result;
  const engine = await engineApi();
  const views = await engine.fileSyncProjectViews(builtin.map((project) => project.id));
  const facts = await engine.fileSyncPeerFacts([...views.values()].flatMap((view) => view.shares.flatMap((share) => share.peers.map((peer) => peer.peer)).concat(Object.values(view.peers).flat())));
  for (const project of builtin) result[project.id] = builtinProjectStatus(views.get(project.id)!, facts);
  return result;
}

/** Takeover waits on the conversation's working folder, never on unrelated worktree copies. */
export async function conversationFilesStatus(project: ProjectRecord, worktreeId?: string): Promise<FacadeSyncStatus> {
  const phase = await phaseOfProject(project.id);
  const engine = filesEngineOf(phase);
  if (engine === "none") return { ...unavailableProjectStatus(), engine: "none" };
  if (engine === "moving") return movingStatus();
  const api = await engineApi();
  const view = (await api.fileSyncProjectViews([project.id])).get(project.id)!;
  const kind = worktreeId ? "worktrees" : "project";
  const shares = view.shares.filter((share) => share.kind === kind).map((share) => worktreeId ? { ...share, need: { files: 0, bytes: 0 } } : share);
  const peers = [...new Set([...(view.peers[kind] ?? []), ...shares.flatMap((share) => share.peers.map((peer) => peer.peer))])];
  const facts = await api.fileSyncPeerFacts(peers);
  const scoped = { ...view, shares, peers: { [kind]: peers } };
  if (!worktreeId || view.worker !== "running" || !view.enabled || !shares.length) return builtinProjectStatus(scoped, facts);
  api.fileSyncPrioritize(project.id, "worktrees", worktreeId, Date.now() + WORKTREE_PRIORITY_MS);
  const present = peers.filter((peer) => presentPeer(facts, peer) && facts.peers.get(peer)?.protocol !== 0 && facts.peers.get(peer)?.enabled !== false);
  const pending = await api.fileSyncPendingFiles(project.id, "worktrees", worktreeId, present);
  if (!pending) return { state: "syncing", remainingFiles: 0, remainingBytes: 0, message: "Checking files", engine: "builtin" };
  const share = shares[0];
  share.need = { files: pending.files + pending.waiting.files, bytes: pending.bytes + pending.waiting.bytes };
  share.blocked = pending.blocked;
  share.errors = pending.errors;
  // After the first index, sibling rescans do not hold this worktree. Root errors still do.
  if (share.indexed && share.state === "scanning") { share.state = "idle"; share.scanning = false; }
  // Keep peer-index catch-up: an empty prefix is not current until newer index pages have arrived.
  return builtinProjectStatus(scoped, facts);
}

/** Asks for an immediate scan of the project and of its other folders. */
export async function rescanProjectFiles(projectId: string): Promise<void> {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");
  if (await projectFilesEngine(project.id) === "none") throw new ProjectNotSynchronizedError();
  const api = await engineApi();
  let finished: Array<{ kind: ShareKind; error?: string }>;
  try { finished = await api.fileSyncRescanProject(project.id); }
  catch (error) { throw new ProjectFilesUnavailableError(error instanceof Error ? error.message : "File sync is not running on this node"); }
  // A worktree (or old ticket) folder this node never had is not the project's problem; the project folder's is.
  const failed = finished.find((scan) => scan.kind === "project" && scan.error);
  if (failed) throw new ProjectFilesUnavailableError(failed.error!);
}

/**
 * The app wrote under the project's worktree folder (`changed`: the absolute path it wrote or
 * removed): the engine scans that path now and tells peers after the commit.
 */
export function worktreeFilesChanged(projectId: string, changed?: string): void {
  void projectFilesEngine(projectId).then(async (engine) => {
    if (engine !== "none") (await engineApi()).fileSyncScanPaths(projectId, "worktrees", changed ? [changed] : []);
  }).catch((error) => console.warn("Worktree folder rescan failed", error));
}

/** How long a worktree whose files are still arriving goes first in the engine's queue. */
const WORKTREE_PRIORITY_MS = 10 * 60_000;

/**
 * Whether files of the worktree are still on their way to this node, so merging or sweeping it now
 * would act on an old copy. The engine holds only while something can still arrive: a present peer whose index of
 * the worktree folder is ahead of this node's copy (known per folder, and over in moments), or need
 * rows under this worktree that a present peer or a local copy can supply (fix P4+P5: another
 * worktree's files, or files only a machine that is away has, do not hold it). Pending files of the
 * worktree are moved up the queue.
 */
export async function worktreeHasPendingFiles(projectId: string, worktreeId: string, options: { use?: boolean } = {}): Promise<boolean> {
  // A merge uses the worktree here, so its files are fetched from now on. Housekeeping only looks (use: false):
  // a worktree this node never used has nothing on its way, and looking must not start a download.
  const use = options.use !== false;
  const engine = await projectFilesEngine(projectId);
  if (engine === "none") return false;
  if (engine === "moving") return true;
  const api = await engineApi();
  const view = (await api.fileSyncProjectViews([projectId])).get(projectId)!;
  // Off or given up: nothing will arrive, and waiting would block the worktree for good.
  if (view.worker === "off" || view.worker === "failed" || view.worker === "stopped" || view.worker === "stopping") return false;
  if (view.worker !== "running") return true;
  const share = view.shares.find((candidate) => candidate.kind === "worktrees");
  if (!share) return false;
  const prioritize = () => { if (use) api.fileSyncPrioritize(projectId, "worktrees", worktreeId, Date.now() + WORKTREE_PRIORITY_MS); };
  if (share.state === "starting") { prioritize(); return true; }
  const eligible = [...new Set([...view.peers.worktrees ?? [], ...share.peers.map((peer) => peer.peer)])];
  const facts = await api.fileSyncPeerFacts(eligible);
  const sending = (peer: string) => presentPeer(facts, peer) && facts.peers.get(peer)?.protocol !== 0 && facts.peers.get(peer)?.enabled !== false;
  const present = eligible.filter(sending);
  // No machine that could send is around: nothing arrives until one is back, and the merge need not wait for that.
  if (!present.length) return false;
  let pending = share.peers.some((peer) => !peer.caughtUp && sending(peer.peer));
  // Asked even when the share needs nothing: a worktree first used now has its rows made by this very question.
  if (!pending && (use || share.need.files > 0)) {
    // A worker that does not answer in time holds the merge only while a present machine could still send.
    const counted = await api.fileSyncPendingFiles(projectId, "worktrees", worktreeId, present, !use).catch(() => undefined);
    pending = counted ? counted.files > 0 : true;
  }
  if (pending) prioritize();
  return pending;
}

/**
 * This node uses the worktree now (a conversation, a terminal or an agent works in it): its files are
 * downloaded from here on, ahead of everything else. Returns how many of them a machine that is present
 * can still send; 0 when all are here, and for projects that are not on built-in sync.
 */
export async function useWorktreeFiles(projectId: string, worktreeId: string): Promise<number> {
  if (await projectFilesEngine(projectId) !== "builtin") return 0;
  const api = await engineApi();
  const view = (await api.fileSyncProjectViews([projectId])).get(projectId)!;
  if (view.worker !== "running") return 0;
  const share = view.shares.find((candidate) => candidate.kind === "worktrees");
  if (!share) return 0;
  api.fileSyncPrioritize(projectId, "worktrees", worktreeId, Date.now() + WORKTREE_PRIORITY_MS);
  const eligible = [...new Set([...view.peers.worktrees ?? [], ...share.peers.map((peer) => peer.peer)])];
  const facts = await api.fileSyncPeerFacts(eligible);
  const present = eligible.filter((peer) => presentPeer(facts, peer) && facts.peers.get(peer)?.protocol !== 0 && facts.peers.get(peer)?.enabled !== false);
  if (!present.length) return 0;
  const counted = await api.fileSyncPendingFiles(projectId, "worktrees", worktreeId, present).catch(() => undefined);
  return counted?.files ?? 0;
}

/**
 * Whether a worktree folder without its worktree.json is what is left of a deleted worktree, rather
 * than one still arriving: on built-in sync, every present machine's index has been read and none of
 * them offers the file. Its metadata always arrives first, so a folder that fails this is dead.
 */
export async function worktreeMetadataGone(projectId: string, worktreeId: string): Promise<boolean> {
  if (await projectFilesEngine(projectId) !== "builtin") return false;
  const api = await engineApi();
  const view = (await api.fileSyncProjectViews([projectId])).get(projectId)!;
  const share = view.shares.find((candidate) => candidate.kind === "worktrees");
  if (view.worker !== "running" || !share || share.state !== "idle" || share.phase !== "builtin") return false;
  const eligible = [...new Set([...view.peers.worktrees ?? [], ...share.peers.map((peer) => peer.peer)])];
  const facts = await api.fileSyncPeerFacts(eligible);
  const present = eligible.filter((peer) => presentPeer(facts, peer) && facts.peers.get(peer)?.protocol !== 0 && facts.peers.get(peer)?.enabled !== false);
  if (present.some((peer) => !share.peers.find((entry) => entry.peer === peer)?.caughtUp)) return false;
  const counted = await api.fileSyncPendingFiles(projectId, "worktrees", `${worktreeId}/.joint-bob-worktree/worktree.json`, eligible, true).catch(() => undefined);
  return Boolean(counted && counted.files === 0 && counted.waiting.files === 0 && counted.blocked === 0);
}

/**
 * Why housekeeping (the sweep, the done-cleanup) must keep a worktree for now, or undefined when it
 * may delete it (design §6.5). On built-in sync a deletion here reaches every machine, so it acts on
 * a worktree another machine created only after a completed pull from every eligible peer since this
 * node last started or woke, with none of them ahead: until then its conversation markers may simply
 * not have arrived. A project shared with nobody has nothing to wait for.
 */
export async function worktreeSweepRefusal(projectId: string, worktree: { id: string; createdByNodeId: string }, options: { requirePeerCheck?: boolean } = {}): Promise<string | undefined> {
  const engine = await projectFilesEngine(projectId);
  if (engine === "none") return undefined;
  if (engine === "moving") return "Worktree kept: file sync is still checking this project's files";
  if (await worktreeHasPendingFiles(projectId, worktree.id, { use: false })) return "Worktree kept: its files are still arriving from another machine";
  const api = await engineApi();
  const { getClusterNode } = await import("../cluster.js");
  if (!options.requirePeerCheck && worktree.createdByNodeId === (await getClusterNode()).id) return undefined;
  const view = (await api.fileSyncProjectViews([projectId])).get(projectId)!;
  const share = view.shares.find((candidate) => candidate.kind === "worktrees");
  const eligible = view.peers.worktrees ?? [];
  if (options.requirePeerCheck && !eligible.length && worktree.createdByNodeId === (await getClusterNode()).id) return undefined;
  if (!share || view.worker !== "running" || !eligible.length) return "Worktree kept: this node cannot check the other machines' copies now";
  const peerFacts = await api.fileSyncPeerFacts(eligible);
  for (const peer of eligible) {
    const known = peerFacts.peers.get(peer);
    const entry = share.peers.find((candidate) => candidate.peer === peer);
    if (!known?.protocol || known.enabled === false || !known.present || !entry?.caughtUp || !api.fileSyncPulledSinceStart(share.share, peer)) {
      return `Worktree kept: another machine created it and this node has not caught up with ${known?.name ?? peer} since it started`;
    }
  }
  return undefined;
}

/**
 * Whether this node holds what `peer` has of these projects (a takeover from it, a twin's
 * readiness): this node's cursor of the peer's index caught up with nothing left to receive. No network request:
 * built-in answers come from the reports main already holds. An away peer cannot send more, so it
 * holds nothing back.
 */
export async function peerFilesReady(peer: string, projectIds: readonly string[]): Promise<{ ready: boolean; statuses: Record<string, ProjectSyncStatus> }> {
  const held = await phases();
  const statuses: Record<string, ProjectSyncStatus> = {};
  const projects = (await Promise.all(projectIds.map((id) => getProject(id)))).filter((project): project is ProjectRecord => Boolean(project));
  for (const project of projects) if (filesEngineOf(held.get(project.id)) === "moving") statuses[project.id] = movingStatus();
  const builtin = projects.filter((project) => held.get(project.id) === "builtin");
  if (builtin.length) {
    const api = await engineApi();
    const views = await api.fileSyncProjectViews(builtin.map((project) => project.id));
    const facts = await api.fileSyncPeerFacts([peer]);
    for (const project of builtin) {
      const view = views.get(project.id)!;
      // Only this peer: another machine being behind or off does not hold back what this one sent.
      const narrowed: FileSyncProjectView = {
        ...view,
        shares: view.shares.map((share) => ({ ...share, peers: share.peers.filter((entry) => entry.peer === peer) })),
        peers: Object.fromEntries(Object.entries(view.peers).map(([kind, peers]) => [kind, peers.filter((candidate) => candidate === peer)])),
      };
      statuses[project.id] = withoutEngine(builtinProjectStatus(narrowed, facts));
    }
  }
  return { ready: Object.values(statuses).every((status) => status.state === "synced"), statuses };
}
