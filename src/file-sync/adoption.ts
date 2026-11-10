import { mkdir, opendir, rm } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { mayReceiveResource } from "../cluster-sharing-policy.js";
import { projectWorktreeRoot } from "../project-worktrees.js";
import { replicationPeers } from "../server/replication-v2.js";
import { ticketWorkspaceRoot } from "../task-workspaces.js";
import { engineRecordOf, listPhases, phaseOf, projectOwnerNode, saveEngineRecord, setPhase } from "./control.js";
import { compileRules, effectiveRules } from "./ignore.js";
import type { OpArgs, OpName, OpResults, ShareSpec, ShareStatus } from "./protocol.js";
import { SHARE_KINDS, systemClock, type Clock, type Phase, type ShareKind } from "./types.js";

/* Every project shared with another machine is moved by built-in sync. Before the engine writes a
   project's files on this node it takes the project over once: each of its folders is scanned in full
   and compared with the other machines' lists (need.ts' bootstrap decision: the same content merges,
   a file on one side only is copied, and a missing file is never read as a delete). Until that is
   done the project's phase is "bootstrapping" and nothing is written here; afterwards it is
   "builtin" for good. The phase is node-local and kept in node.db, so a restart goes on where it was. */

/** What Settings → File sync lists for each shared project. */
export interface FileSyncProject {
  projectId: string;
  name: string;
  /** This node owns the project. */
  owner: boolean;
  /** "builtin": synced; "bootstrapping": this node is still taking it over. */
  phase: "builtin" | "bootstrapping";
  phaseMessage: string | null;
  phaseError: string | null;
  differences: number;
  shares: ShareKind[];
  /** The take-over waits for something outside it: nothing changes until then, so Settings need not refresh for it. */
  waiting: boolean;
}

/** The running engine (index.ts), or a stand-in that is not running. */
export interface AdoptionEngine {
  /** The worker runs and took its first configure. */
  running(): boolean;
  /** Derives again and pushes configure; true once the worker took the desired state, or no worker runs to hold an older one. */
  apply(): Promise<boolean>;
  /** The project's derived shares (only those with an eligible peer now). */
  specs(projectId: string): ShareSpec[];
  /** What the worker last reported for them. */
  statuses(projectId: string): ShareStatus[];
  call<K extends OpName>(op: K, args: OpArgs[K], options?: { timeoutMs?: number }): Promise<OpResults[K]>;
  /** Asks the worker to catch up with a peer now (its index pull). */
  nudge(peer: string): void;
}

export interface AdoptionDeps {
  db: DatabaseSync;
  nodeId: string;
  engine: AdoptionEngine;
  /** Whether nothing else writes the projects' folders here any more (syncthing-retirement.ts); when it is false, `released` is asked again at the next retry. */
  released?: () => Promise<boolean>;
  roots?: (projectId: string) => Record<ShareKind, string> | undefined;
  log?: (key: string, message: string) => void;
  clock?: Clock;
  /** Delays of the retries after a step could not finish (peers not caught up, a folder that cannot be read). */
  retry?: { minMs: number; maxMs: number };
}

const SCAN_TIMEOUT_MS = 2 * 60 * 60_000;
const BOOTSTRAP_TIMEOUT_MS = 60 * 60_000;
const RETRY = { minMs: 5_000, maxMs: 5 * 60_000 };
/** Half-downloaded files an earlier sync tool left behind. */
const LEFTOVER_TEMP = /^(?:\.syncthing\..*\.tmp|~syncthing~.*\.tmp)$/s;

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function tableExists(db: DatabaseSync, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

/** A grant that lapses only with a relay's lease (relay resource groups): still a peer that holds the files. */
function relayGrant(db: DatabaseSync, node: string, projectId: string, owner: string): boolean {
  if (!tableExists(db, "relay_sharing_groups")) return false;
  try {
    const rows = db.prepare(`SELECT s.node_ids FROM sharing_resource_shares s JOIN relay_sharing_groups g ON g.cluster_id = s.cluster_id
      JOIN sharing_clusters c ON c.id = s.cluster_id AND c.closed = 0
      JOIN sharing_memberships om ON om.cluster_id = s.cluster_id AND om.node_id = ?
      JOIN sharing_memberships rm ON rm.cluster_id = s.cluster_id AND rm.node_id = ?
      WHERE s.kind = 'project' AND s.resource_id = ?`).all(owner, node, projectId) as Array<{ node_ids: string | null }>;
    return rows.some((row) => row.node_ids === null || (JSON.parse(row.node_ids) as string[]).includes(node));
  } catch { return false; }
}

function receivesIgnoringLease(db: DatabaseSync, node: string, projectId: string, owner: string | undefined): boolean {
  try { if (mayReceiveResource(db, node, "project", projectId)) return true; } catch { return false; }
  return owner !== undefined && (node === owner || relayGrant(db, node, projectId, owner));
}

/**
 * Peers that may hold the project with this node from the sharing tables, relay leases ignored: a
 * relay-only peer whose lease lapsed still has the files.
 */
export function projectPeers(db: DatabaseSync, local: string, projectId: string, candidates?: readonly string[]): string[] {
  try {
    const policy = db.prepare("SELECT deleted FROM cluster_v2_resource_policy WHERE kind = 'project' AND resource_id = ?").get(projectId) as { deleted: number } | undefined;
    if (!policy || policy.deleted) return [];
  } catch { return []; }
  const owner = projectOwnerNode(db, projectId);
  if (!receivesIgnoringLease(db, local, projectId, owner)) return [];
  let known: string[];
  try { known = [...candidates ?? replicationPeers(db, local).map((peer) => peer.nodeId)]; } catch { known = []; }
  if (owner && owner !== local) known.push(owner);
  return [...new Set(known)].filter((peer) => peer !== local && receivesIgnoringLease(db, peer, projectId, owner)).sort();
}

function defaultRoots(db: DatabaseSync, projectId: string): Record<ShareKind, string> | undefined {
  const row = db.prepare("SELECT path FROM projects WHERE id = ?").get(projectId) as { path: string } | undefined;
  if (!row) return undefined;
  try { return { project: row.path, tickets: path.join(ticketWorkspaceRoot(), projectId), worktrees: projectWorktreeRoot(projectId) }; } catch { return undefined; }
}

export function projectDifferences(statuses: readonly ShareStatus[]): number {
  return statuses.reduce((sum, status) => sum + status.peers.reduce((count, peer) => count + peer.differences, 0), 0);
}

/** Deletes leftover download temps under `root`, never following links and skipping folders the engine ignores. */
export async function removeLeftoverTemps(root: string, ignoredDirectory: (relative: string) => boolean = () => false): Promise<number> {
  let removed = 0;
  let visited = 0;
  const walk = async (relative: string): Promise<void> => {
    let directory;
    try { directory = await opendir(path.join(root, relative)); } catch { return; }
    for await (const entry of directory) {
      // A large tree is walked a slice at a time: requests keep their turn on the main thread.
      if (++visited % 500 === 0) await new Promise((resolve) => setImmediate(resolve));
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!ignoredDirectory(child)) await walk(child); continue; }
      if (!entry.isFile() || !LEFTOVER_TEMP.test(entry.name)) continue;
      try { await rm(path.join(root, child)); removed++; } catch { /* gone already, or not ours to remove */ }
    }
  };
  await walk("");
  return removed;
}

function kindLabel(kind: ShareKind): string { return kind === "project" ? "files" : kind === "tickets" ? "ticket folders" : "worktrees"; }

/** The phase as the engine reads it: anything an older release left that is not "builtin" is a take-over still to do. */
export function adoptionPhase(phase: Phase | undefined): "builtin" | "bootstrapping" {
  return phase === "builtin" ? "builtin" : "bootstrapping";
}

export class Adoption {
  private readonly db: DatabaseSync;
  private readonly local: string;
  private readonly clock: Clock;
  private readonly retry: { minMs: number; maxMs: number };
  /** One project is taken over at a time: a machine that joins with many projects scans them one after another. */
  private readonly queued = new Set<string>();
  private active: Promise<void> | undefined;
  private readonly waits = new Map<string, { attempts: number; until: number; timer?: { cancel(): void } }>();
  private readonly messages = new Map<string, string>();
  /** Shares scanned in full for the take-over since this node started: a retry after peers caught up does not scan again. */
  private readonly scanned = new Set<string>();
  private stopped = false;

  constructor(private readonly deps: AdoptionDeps) {
    this.db = deps.db;
    this.local = deps.nodeId;
    this.clock = deps.clock ?? systemClock;
    this.retry = deps.retry ?? RETRY;
  }

  /** Projects shared with another machine that this node has not taken over yet. */
  private pending(): string[] {
    const phases = listPhases(this.db);
    let candidates: string[];
    try { candidates = replicationPeers(this.db, this.local).map((peer) => peer.nodeId); } catch { candidates = []; }
    const rows = this.db.prepare("SELECT id FROM projects").all() as Array<{ id: string }>;
    return rows.filter((row) => phases.get(row.id)?.phase !== "builtin" && projectPeers(this.db, this.local, row.id, candidates).length > 0).map((row) => row.id).sort();
  }

  /** Sharing, a phase or a peer's capability changed: every project still to take over takes its next step. */
  kick(projectId?: string): void {
    if (this.stopped) return;
    for (const id of projectId ? [projectId] : this.pending()) if (!this.waiting(id)) this.queued.add(id);
    this.pump();
  }

  /** A share report came in: a project waiting for its peers to catch up tries again at once when they have. */
  shareChanged(status: ShareStatus): void {
    if (this.stopped || phaseOf(this.db, status.projectId)?.phase === "builtin") return;
    if (status.state !== "idle" || status.scanning || !status.peers.every((peer) => peer.caughtUp)) return;
    const wait = this.waits.get(status.projectId);
    if (wait) wait.until = 0;
    this.run(status.projectId);
  }

  /** What the take-over waits for now, in plain words. */
  message(projectId: string): string | undefined { return this.messages.get(projectId); }

  stop(): void {
    this.stopped = true;
    for (const wait of this.waits.values()) wait.timer?.cancel();
    this.waits.clear();
  }

  /** Tests: resolves once no step runs. */
  async idle(): Promise<void> {
    while (this.active) await this.active;
  }

  /** Tests: the projects a retry timer is held for. */
  pendingTimers(): string[] {
    return [...this.waits].filter(([, wait]) => wait.timer).map(([projectId]) => projectId).sort();
  }

  private run(projectId: string): void {
    this.queued.add(projectId);
    this.pump();
  }

  private pump(): void {
    if (this.active || this.stopped) return;
    const [projectId] = [...this.queued].sort();
    if (projectId === undefined) return;
    this.queued.delete(projectId);
    const done: Promise<void> = this.step(projectId).catch((error) => {
      this.log(`fileSync:adopt:${projectId}`, `File sync could not take over ${this.name(projectId)}: ${messageOf(error)}`);
      this.wait(projectId);
    }).finally(() => {
      if (this.active === done) this.active = undefined;
      this.pump();
    });
    this.active = done;
  }

  private async step(projectId: string): Promise<void> {
    if (this.stopped) return;
    if (phaseOf(this.db, projectId)?.phase === "builtin") { this.settled(projectId); return; }
    if (!this.roots(projectId) || !projectPeers(this.db, this.local, projectId).length) { this.settled(projectId); return; }
    if (this.waiting(projectId)) return;
    if (this.deps.released && !(await this.deps.released())) {
      this.messages.set(projectId, "Waiting for Syncthing on this machine to let go of Joint Bob's folders");
      this.wait(projectId);
      return;
    }
    if (phaseOf(this.db, projectId)?.phase !== "bootstrapping") this.updatePhase(projectId, "bootstrapping", { builtinSince: {}, error: null });
    const outcome = await this.bootstrap(projectId);
    if (outcome === "wait") { this.wait(projectId); return; }
    this.settled(projectId);
  }

  /** bootstrapping → builtin: per folder a full scan and the bootstrap decision (need.ts). */
  private async bootstrap(projectId: string): Promise<"done" | "wait"> {
    const engine = this.deps.engine;
    if (!engine.running()) { this.messages.set(projectId, "Waiting for file sync to start on this machine"); return "wait"; }
    if (!(await engine.apply())) return "wait";
    const specs = engine.specs(projectId).sort((a, b) => SHARE_KINDS.indexOf(a.kind) - SHARE_KINDS.indexOf(b.kind));
    if (!specs.length) { this.messages.set(projectId, "Waiting for the other machines to be reachable"); return "wait"; }
    this.messages.set(projectId, "Checking both machines' files");
    const since: Record<string, number> = { ...phaseOf(this.db, projectId)?.builtinSince };
    for (const spec of specs) {
      if (Object.hasOwn(since, spec.kind)) continue;
      if (this.stopped) return "wait";
      if (!this.scanned.has(spec.key)) {
        // A node that never held a ticket or worktree gets the empty folder now. A missing project folder is not
        // made: it may be on a disk that is not mounted.
        if (spec.kind !== "project") await mkdir(spec.root, { recursive: true }).catch(() => undefined);
        const matcher = compileRules(effectiveRules(spec.kind, spec.rules));
        await removeLeftoverTemps(spec.root, (relative) => matcher.classify(relative, true) !== null);
        const scanned = await engine.call("scan", { share: spec.key, scope: "full", reason: "switch" }, { timeoutMs: SCAN_TIMEOUT_MS });
        if (scanned.error) { this.messages.set(projectId, `Checking both machines' files: this machine could not read its ${kindLabel(spec.kind)} (${scanned.error})`); return "wait"; }
        this.scanned.add(spec.key);
      }
      const [status] = await engine.call("status", { shares: [spec.key] });
      if (!status) return "wait";
      const byPeer = Object.fromEntries(status.peers.flatMap((peer) => typeof peer.builtinSince === "number" ? [[peer.peer, peer.builtinSince]] : []));
      try {
        await engine.call("bootstrap", { share: spec.key, builtinSinceByPeer: byPeer }, { timeoutMs: BOOTSTRAP_TIMEOUT_MS });
      } catch (error) {
        if ((error as { code?: unknown })?.code !== "not-ready") throw error;
        // Its index or a peer's is not whole yet: the pulls are asked for now, and the share's next report tries again.
        for (const peer of spec.peers) engine.nudge(peer);
        this.messages.set(projectId, "Checking both machines' files: waiting for the other machines' lists of files");
        return "wait";
      }
      const [after] = await engine.call("status", { shares: [spec.key] });
      since[spec.kind] = typeof after?.builtinSince === "number" ? after.builtinSince : after?.maxSeq ?? status.maxSeq;
      this.updatePhase(projectId, "bootstrapping", { builtinSince: since });
    }
    if (this.stopped) return "wait";
    this.updatePhase(projectId, "builtin", { builtinSince: since, error: null });
    this.ownerRecord(projectId);
    await engine.apply();
    return "done";
  }

  /** Machines on a release that still chose an engine per project follow their owner's record; the owner writes it once. */
  private ownerRecord(projectId: string): void {
    if (projectOwnerNode(this.db, projectId) !== this.local) return;
    const held = engineRecordOf(this.db, projectId);
    if (held?.mode === "builtin") return;
    const at = Math.max(this.clock.now(), held ? Date.parse(held.updatedAt) + 1 : 0);
    saveEngineRecord(this.db, { projectId, mode: "builtin", generation: (held?.generation ?? 0) + 1, updatedAt: new Date(at).toISOString(), origin: this.local });
  }

  // ---- what Settings shows ----

  project(projectId: string): FileSyncProject {
    const held = phaseOf(this.db, projectId);
    const statuses = this.deps.engine.statuses(projectId);
    const phase = adoptionPhase(held?.phase);
    return {
      projectId, name: this.name(projectId), owner: projectOwnerNode(this.db, projectId) === this.local,
      phase, phaseMessage: phase === "builtin" ? null : this.messages.get(projectId) ?? null, phaseError: held?.error ?? null,
      differences: projectDifferences(statuses),
      shares: this.deps.engine.specs(projectId).map((spec) => spec.kind).sort((a, b) => SHARE_KINDS.indexOf(a) - SHARE_KINDS.indexOf(b)),
      waiting: Boolean(held?.error),
    };
  }

  /** Every project shared with at least one peer, and any this node took over before. */
  projects(): FileSyncProject[] {
    const rows = this.db.prepare("SELECT id FROM projects").all() as Array<{ id: string }>;
    let candidates: string[];
    try { candidates = replicationPeers(this.db, this.local).map((peer) => peer.nodeId); } catch { candidates = []; }
    const held = listPhases(this.db);
    return rows.filter((row) => held.has(row.id) || projectPeers(this.db, this.local, row.id, candidates).length > 0)
      .map((row) => this.project(row.id)).sort((a, b) => a.name.localeCompare(b.name) || a.projectId.localeCompare(b.projectId));
  }

  // ---- helpers ----

  roots(projectId: string): Record<ShareKind, string> | undefined {
    return (this.deps.roots ?? ((id: string) => defaultRoots(this.db, id)))(projectId);
  }

  /** Writes only what changed: every write bumps the revision, which derives and kicks again. */
  private updatePhase(projectId: string, phase: Phase, options: { error?: string | null; builtinSince?: Record<string, number> } = {}): void {
    const held = phaseOf(this.db, projectId);
    const error = options.error === undefined ? (held?.phase === phase ? held.error : null) : options.error;
    const since = options.builtinSince ?? held?.builtinSince ?? {};
    if (held && held.phase === phase && held.error === error && JSON.stringify(held.builtinSince) === JSON.stringify(since)) return;
    setPhase(this.db, projectId, phase, { builtinSince: since, error });
  }

  private settled(projectId: string): void {
    this.messages.delete(projectId);
    this.waits.get(projectId)?.timer?.cancel();
    this.waits.delete(projectId);
    const held = phaseOf(this.db, projectId);
    if (held?.error) this.updatePhase(projectId, held.phase, { error: null });
  }

  private waiting(projectId: string): boolean {
    const wait = this.waits.get(projectId);
    return Boolean(wait && wait.until > this.clock.now());
  }

  private wait(projectId: string): void {
    if (this.stopped) return;
    const held = this.waits.get(projectId);
    held?.timer?.cancel();
    const attempts = (held?.attempts ?? 0) + 1;
    const delay = Math.min(this.retry.maxMs, this.retry.minMs * 2 ** (attempts - 1));
    const timer = this.clock.setTimeout(() => {
      const wait = this.waits.get(projectId);
      if (wait) { wait.until = 0; wait.timer = undefined; }
      this.run(projectId);
    }, delay);
    this.waits.set(projectId, { attempts, until: this.clock.now() + delay, timer });
  }

  private name(projectId: string): string {
    try { return (this.db.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined)?.name ?? projectId; } catch { return projectId; }
  }

  private log(key: string, message: string): void { (this.deps.log ?? ((_key: string, text: string) => console.warn(text)))(key, message); }
}
