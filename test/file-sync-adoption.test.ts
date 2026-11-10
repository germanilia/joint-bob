import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pinClusterPublicKey } from "../src/cluster-identity.js";
import { ensurePeerEndpointSchema, recordPeerEndpoint } from "../src/cluster-peer-endpoints.js";
import { ensureResourceSharingSchema } from "../src/cluster-sharing.js";
import { addSharingMember, createSharingCluster, getSharingCluster, registerOwnedResource, setResourceShares } from "../src/cluster-sharing-policy.js";
import { Adoption, adoptionPhase, projectDifferences, projectPeers, removeLeftoverTemps, type AdoptionDeps, type AdoptionEngine } from "../src/file-sync/adoption.js";
import { engineRecordOf, ensureControlSchema, listEngineRecords, phaseOf, saveEngineRecord, setPhase } from "../src/file-sync/control.js";
import { FirstIndexQueue } from "../src/file-sync/first-index.js";
import type { OpArgs, OpName, ShareSpec, ShareStatus } from "../src/file-sync/protocol.js";
import { EMPTY_RULE_SETTINGS, SHARE_KINDS, type Clock, type Phase, type ShareKind } from "../src/file-sync/types.js";

/* Taking a shared project over (adoption.ts), against a stand-in engine: never a real worker. The
   decision the bootstrap op itself makes per file is need.ts' (test/file-sync-bootstrap.test.ts), and
   two real nodes take a project over in test/file-sync-adoption-nodes.test.ts. */

const LOCAL = "00000000-0000-4000-8000-000000000001";
const PEER = "00000000-0000-4000-8000-000000000002";
const CLUSTER = "10000000-0000-4000-8000-000000000001";
const NOW = "2026-10-25T00:00:00.000Z";
const HASH = "a".repeat(64);
const PROJECT = "alpha";
const SHARES = SHARE_KINDS.map((kind) => `${kind}:${PROJECT}`);
const RELEASE_MESSAGE = "Waiting for Syncthing on this machine to let go of Joint Bob's folders";

class FakeClock implements Clock {
  at = Date.parse(NOW);
  timers: Array<{ at: number; run: () => void; cancelled: boolean }> = [];
  now(): number { return this.at; }
  setTimeout(run: () => void, ms: number): { cancel(): void } {
    const timer = { at: this.at + ms, run, cancelled: false };
    this.timers.push(timer);
    return { cancel: () => { timer.cancelled = true; } };
  }
  live(): number { return this.timers.filter((timer) => !timer.cancelled).length; }
  /** Moves time on and runs what came due. */
  advance(ms: number): void {
    this.at += ms;
    const due = this.timers.filter((timer) => !timer.cancelled && timer.at <= this.at);
    this.timers = this.timers.filter((timer) => !due.includes(timer));
    for (const timer of due) timer.run();
  }
}

function status(kind: ShareKind, phase: Phase, overrides: Partial<ShareStatus> = {}, peer: Partial<ShareStatus["peers"][number]> = {}): ShareStatus {
  return {
    share: `${kind}:${PROJECT}`, projectId: PROJECT, kind, state: "idle", phase, maxSeq: 7, indexId: `idx-${kind}`, digest: HASH, rulesHash: HASH,
    liveFiles: 3, liveBytes: 30, need: { files: 0, bytes: 0 }, blocked: 0, errors: 0, scanning: false, watch: "watching", builtinSince: null,
    peers: [{ peer: PEER, cursor: 9, peerMaxSeq: 9, peerIndexId: "peer-idx", peerDigest: HASH, rulesMatch: true, caughtUp: true, differences: 0, cleanSince: "2026-10-24T23:59:00.000Z", route: "direct", builtinSince: null, ...peer }],
    ...overrides,
  };
}

interface Fixture {
  db: DatabaseSync;
  dir: string;
  roots: Record<ShareKind, string>;
  clock: FakeClock;
  engine: FakeEngine;
  logs: string[];
  machine(overrides?: Partial<AdoptionDeps>): Adoption;
  cleanup(): Promise<void>;
}

/** The running engine as adoption.ts sees it: the project's three shares in its phase here, reports the test edits, op calls recorded. */
class FakeEngine {
  running_ = true;
  accept = true;
  /** False: no peer is eligible right now, so nothing is derived for the project. */
  derived = true;
  calls: Array<{ op: OpName; args: unknown }> = [];
  /** The project's phase each accepted apply carried to the worker. */
  applied: Phase[] = [];
  tweak: Partial<Record<ShareKind, Partial<ShareStatus>>> = {};
  peerTweak: Partial<ShareStatus["peers"][number]> = {};
  /** Shares whose bootstrap answers "not-ready" this many more times. */
  notReady = new Map<string, number>();
  /** Shares whose scan could not read the folder. */
  scanError = new Map<string, string>();
  builtinSince = new Map<string, number>();
  nudged: string[] = [];
  hook?: (op: OpName, args: unknown) => void | Promise<void>;
  /** The projects the engine derives shares for. */
  projects = new Set([PROJECT]);

  constructor(private readonly fixture: () => Fixture) {}

  private phase(projectId = PROJECT): Phase { return phaseOf(this.fixture().db, projectId)?.phase ?? "syncthing"; }

  api(): AdoptionEngine {
    return {
      running: () => this.running_,
      apply: async () => { if (this.accept) this.applied.push(this.phase()); return this.accept; },
      specs: (projectId) => this.specs(projectId),
      statuses: (projectId) => this.specs(projectId).map((spec) => this.report(spec.kind, projectId)),
      call: (async <K extends OpName>(op: K, args: OpArgs[K]) => {
        this.calls.push({ op, args });
        await this.hook?.(op, args);
        const share = (args as { share?: string }).share ?? "";
        if (op === "scan") return { share, changed: 0, tombstones: 0, newGeneration: false, files: 3, hashedBytes: 0, durationMs: 1, ...(this.scanError.has(share) ? { error: this.scanError.get(share) } : {}) };
        if (op === "status") return (args as OpArgs["status"]).shares!.map((key) => this.report(key.split(":")[0] as ShareKind, key.split(":")[1]));
        if (op === "bootstrap") {
          const left = this.notReady.get(share) ?? 0;
          if (left > 0) { this.notReady.set(share, left - 1); throw Object.assign(new Error(`File sync has not pulled the whole index of ${PEER} for ${share} yet`), { code: "not-ready" }); }
          this.builtinSince.set(share, 7);
          return { merged: 0, need: 0 };
        }
        throw new Error(`unexpected op ${op}`);
      }) as AdoptionEngine["call"],
      nudge: (peer) => { this.nudged.push(peer); },
    };
  }

  specs(projectId: string): ShareSpec[] {
    if (!this.projects.has(projectId) || !this.derived) return [];
    const f = this.fixture();
    const roots = projectId === PROJECT ? f.roots : otherRoots(f.db, f.dir, projectId)!;
    return SHARE_KINDS.map((kind) => ({ key: `${kind}:${projectId}`, projectId, kind, root: roots[kind], phase: this.phase(projectId), rules: { ...EMPTY_RULE_SETTINGS }, peers: [PEER] }));
  }

  report(kind: ShareKind, projectId = PROJECT): ShareStatus {
    const since = this.builtinSince.get(`${kind}:${projectId}`);
    return { ...status(kind, this.phase(projectId), { ...this.tweak[kind], ...(since !== undefined ? { builtinSince: since } : {}) }, this.peerTweak), share: `${kind}:${projectId}`, projectId };
  }

  ops(op: OpName): string[] { return this.calls.filter((call) => call.op === op).map((call) => (call.args as { share: string }).share); }
}

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  ensureResourceSharingSchema(db);
  ensurePeerEndpointSchema(db);
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT 'personal', color TEXT,
    path TEXT NOT NULL UNIQUE, mac_path TEXT, sync_folder_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  ensureControlSchema(db);
  return db;
}

function addPeer(db: DatabaseSync, nodeId: string): void {
  if (!db.prepare("SELECT 1 FROM sharing_clusters WHERE id = ?").get(CLUSTER)) createSharingCluster(db, { id: CLUSTER, name: "home" }, LOCAL);
  addSharingMember(db, CLUSTER, LOCAL, nodeId, getSharingCluster(db, CLUSTER).managerEpoch);
  recordPeerEndpoint(db, { kind: "cluster", id: CLUSTER }, { nodeId, name: `node ${nodeId.slice(-1)}`, url: `https://${nodeId.slice(-4)}.example.com` });
  pinClusterPublicKey(db, nodeId, generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString());
}

/** A project shared with the whole cluster; `owner` is the node that owns it. */
function addProject(db: DatabaseSync, id: string, root: string, owner = LOCAL): void {
  db.prepare("INSERT INTO projects (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, `Project ${id}`, root, NOW, NOW);
  registerOwnedResource(db, { kind: "project", id, ownerNodeId: owner }, LOCAL);
  db.prepare("INSERT INTO cluster_v2_resource_policy VALUES ('project', ?, ?, 1, 0)").run(id, owner);
  setResourceShares(db, owner, "project", id, [{ clusterId: CLUSTER, projectId: null }]);
}

function addUnshared(db: DatabaseSync, root: string): void {
  db.prepare("INSERT INTO projects (id, name, path, created_at, updated_at) VALUES ('solo', 'Solo', ?, ?, ?)").run(root, NOW, NOW);
}

/** "alpha" is shared between LOCAL and PEER and has no phase here yet; its ticket and worktree folders do not exist. */
async function fixture(options: { owner?: string } = {}): Promise<Fixture> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "file-sync-adoption-"));
  const real = path.join(dir, "real-alpha");
  await mkdir(real, { recursive: true });
  // The project's root is a link, as a project on another disk is.
  await symlink(real, path.join(dir, "alpha"));
  const roots: Record<ShareKind, string> = { project: path.join(dir, "alpha"), tickets: path.join(dir, "tickets", PROJECT), worktrees: path.join(dir, "worktrees", PROJECT) };
  const db = database();
  addPeer(db, PEER);
  addProject(db, PROJECT, roots.project, options.owner);
  const clock = new FakeClock();
  const logs: string[] = [];
  let self: Fixture;
  const engine = new FakeEngine(() => self);
  const machines: Adoption[] = [];
  self = {
    db, dir, roots, clock, engine, logs,
    machine: (overrides = {}) => {
      const machine = new Adoption({
        db, nodeId: LOCAL, engine: engine.api(), roots: (id) => id === PROJECT ? roots : otherRoots(db, dir, id), log: (_key, message) => { logs.push(message); }, clock,
        retry: { minMs: 1_000, maxMs: 8_000 }, ...overrides,
      });
      machines.push(machine);
      return machine;
    },
    cleanup: async () => { for (const machine of machines) machine.stop(); db.close(); await rm(dir, { recursive: true, force: true }); },
  };
  return self;
}

function otherRoots(db: DatabaseSync, dir: string, id: string): Record<ShareKind, string> | undefined {
  const row = db.prepare("SELECT path FROM projects WHERE id = ?").get(id) as { path: string } | undefined;
  return row ? { project: row.path, tickets: path.join(dir, "tickets", id), worktrees: path.join(dir, "worktrees", id) } : undefined;
}

const TAKEN = { project: 7, tickets: 7, worktrees: 7 };

test("a shared project with no phase is taken over: bootstrapping, each folder scanned in full and decided once, then builtin", async () => {
  const f = await fixture();
  try {
    // Leftovers of an older sync tool's download cut short go; files that only look alike stay; ignored folders are not walked.
    await writeFile(path.join(f.dir, "real-alpha", ".syncthing.notes.md.tmp"), "partial");
    await writeFile(path.join(f.dir, "real-alpha", "~syncthing~draft.txt.tmp"), "partial");
    await writeFile(path.join(f.dir, "real-alpha", "keep.tmp"), "mine");
    await writeFile(path.join(f.dir, "real-alpha", ".syncthing.notes.md"), "mine");
    await mkdir(path.join(f.dir, "real-alpha", "node_modules"));
    await writeFile(path.join(f.dir, "real-alpha", "node_modules", ".syncthing.x.tmp"), "ignored tree");
    assert.equal(phaseOf(f.db, PROJECT), undefined);
    // What the phase row held each time the worker was asked to decide a folder.
    const seen: Array<{ share: string; phase?: Phase; since: Record<string, number> }> = [];
    f.engine.hook = (op, args) => { if (op === "bootstrap") seen.push({ share: (args as { share: string }).share, phase: phaseOf(f.db, PROJECT)?.phase, since: { ...phaseOf(f.db, PROJECT)?.builtinSince } }); };
    const machine = f.machine();
    machine.kick();
    await machine.idle();
    const held = phaseOf(f.db, PROJECT)!;
    assert.equal(held.phase, "builtin", JSON.stringify({ held, logs: f.logs, message: machine.message(PROJECT) }));
    assert.deepEqual(held.builtinSince, TAKEN);
    assert.equal(held.error, null);
    assert.deepEqual(seen, [
      { share: SHARES[0], phase: "bootstrapping", since: {} },
      { share: SHARES[1], phase: "bootstrapping", since: { project: 7 } },
      { share: SHARES[2], phase: "bootstrapping", since: { project: 7, tickets: 7 } },
    ], "the phase is bootstrapping throughout, and each folder's builtinSince is kept as soon as it is decided");
    assert.deepEqual(f.engine.calls.filter((call) => call.op === "scan").map((call) => call.args), SHARES.map((share) => ({ share, scope: "full", reason: "switch" })));
    // The worker saw the project as not written here before it was builtin, and builtin only after every folder was decided.
    assert.deepEqual([...new Set(f.engine.applied)], ["bootstrapping", "builtin"]);
    assert.equal(f.engine.applied.at(-1), "builtin", "the worker is told the new phase");
    assert.deepEqual((await readdir(path.join(f.dir, "real-alpha"))).sort(), [".syncthing.notes.md", "keep.tmp", "node_modules"]);
    assert.equal(existsSync(path.join(f.dir, "real-alpha", "node_modules", ".syncthing.x.tmp")), true);
    assert.ok(existsSync(f.roots.tickets) && existsSync(f.roots.worktrees), "a node that never held a ticket or worktree gets the empty folders");
    assert.equal(machine.message(PROJECT), undefined);
    assert.deepEqual([machine.pendingTimers(), f.clock.live(), f.logs], [[], 0, []]);
    // Done for good: another kick asks the worker nothing.
    const asked = f.engine.calls.length;
    machine.kick();
    machine.kick(PROJECT);
    await machine.idle();
    assert.equal(f.engine.calls.length, asked);
  } finally { await f.cleanup(); }
});

test("a missing project folder is not made: it may be on a disk that is not mounted", async () => {
  const f = await fixture();
  try {
    await rm(path.join(f.dir, "real-alpha"), { recursive: true });
    const machine = f.machine();
    machine.kick();
    await machine.idle();
    assert.equal(existsSync(path.join(f.dir, "real-alpha")), false);
    assert.ok(existsSync(f.roots.tickets));
  } finally { await f.cleanup(); }
});

test("a project shared with nobody is left alone: no phase, nothing asked of the worker", async () => {
  const f = await fixture();
  try {
    addUnshared(f.db, path.join(f.dir, "solo"));
    setPhase(f.db, PROJECT, "builtin", { builtinSince: TAKEN });
    const machine = f.machine();
    machine.kick();
    machine.kick("solo");
    await machine.idle();
    assert.equal(phaseOf(f.db, "solo"), undefined);
    assert.deepEqual([f.engine.calls, f.engine.applied, machine.pendingTimers(), f.clock.live()], [[], [], [], 0]);
    assert.deepEqual(projectPeers(f.db, LOCAL, "solo"), []);
    assert.deepEqual(projectPeers(f.db, LOCAL, PROJECT), [PEER]);
    assert.deepEqual(listEngineRecords(f.db), []);
  } finally { await f.cleanup(); }
});

test("while released() says no the project waits untouched with the reason and one retry timer, and goes on when it says yes", async () => {
  const f = await fixture();
  try {
    let released = false, asked = 0;
    const machine = f.machine({ released: async () => { asked++; return released; } });
    machine.kick();
    await machine.idle();
    assert.equal(phaseOf(f.db, PROJECT), undefined, "nothing is written while something else may still write the folders");
    assert.deepEqual([machine.message(PROJECT), machine.pendingTimers(), f.clock.live(), asked], [RELEASE_MESSAGE, [PROJECT], 1, 1]);
    assert.deepEqual([f.engine.calls, f.engine.applied], [[], []]);
    assert.equal(machine.project(PROJECT).phaseMessage, RELEASE_MESSAGE);
    // A kick while it waits does not ask again before the timer.
    machine.kick();
    await machine.idle();
    assert.equal(asked, 1);
    // The retries back off: 1 s, then 2 s.
    f.clock.advance(1_000);
    await machine.idle();
    assert.equal(asked, 2);
    f.clock.advance(1_000);
    await machine.idle();
    assert.equal(asked, 2, "the second wait is twice as long");
    assert.deepEqual([machine.pendingTimers(), f.clock.live()], [[PROJECT], 1]);
    released = true;
    f.clock.advance(1_000);
    await machine.idle();
    assert.equal(asked, 3);
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "builtin");
    assert.deepEqual([machine.message(PROJECT), machine.pendingTimers(), f.clock.live()], [undefined, [], 0]);
  } finally { await f.cleanup(); }
});

test("the retry delay doubles up to its cap", async () => {
  const f = await fixture();
  try {
    let asked = 0;
    const machine = f.machine({ released: async () => { asked++; return false; } });
    machine.kick();
    await machine.idle();
    const delays: number[] = [];
    for (let round = 0; round < 6; round++) {
      const before = asked;
      let waited = 0;
      while (asked === before) { f.clock.advance(500); waited += 500; await machine.idle(); assert.ok(waited <= 20_000); }
      delays.push(waited);
    }
    assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
    assert.equal(f.clock.live(), 1, "one timer at a time");
  } finally { await f.cleanup(); }
});

test("the bootstrap gets each peer's builtin_since and waits, without scanning again, until the peers' lists are whole", async () => {
  const f = await fixture();
  try {
    f.engine.peerTweak = { builtinSince: 4 };
    f.engine.notReady.set(`tickets:${PROJECT}`, 1);
    const machine = f.machine();
    machine.kick();
    await machine.idle();
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "bootstrapping");
    assert.deepEqual(phaseOf(f.db, PROJECT)!.builtinSince, { project: 7 }, "the folder done before the wait is not done again");
    assert.deepEqual(f.engine.nudged, [PEER], "the pulls are asked for");
    assert.equal(machine.project(PROJECT).phaseMessage, "Checking both machines' files: waiting for the other machines' lists of files");
    assert.deepEqual(machine.pendingTimers(), [PROJECT]);
    // Reports that do not say the lists are whole change nothing.
    const bootstraps = f.engine.ops("bootstrap").length;
    machine.shareChanged({ ...f.engine.report("tickets"), peers: [{ ...f.engine.report("tickets").peers[0], caughtUp: false }] });
    machine.shareChanged({ ...f.engine.report("tickets"), state: "scanning", scanning: true });
    machine.kick();
    await machine.idle();
    assert.equal(f.engine.ops("bootstrap").length, bootstraps);
    // The peer's list arrived: its report lets the take-over go on at once, without the timer.
    machine.shareChanged(f.engine.report("tickets"));
    await machine.idle();
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "builtin");
    assert.deepEqual(f.engine.ops("scan"), SHARES, "one full scan per folder");
    assert.deepEqual(f.engine.ops("bootstrap"), [`project:${PROJECT}`, `tickets:${PROJECT}`, `tickets:${PROJECT}`, `worktrees:${PROJECT}`]);
    for (const call of f.engine.calls.filter((entry) => entry.op === "bootstrap")) assert.deepEqual((call.args as OpArgs["bootstrap"]).builtinSinceByPeer, { [PEER]: 4 });
    assert.deepEqual([machine.pendingTimers(), f.clock.live(), f.logs], [[], 0, []]);
    // A report for a project already taken over starts nothing.
    const asked = f.engine.calls.length;
    machine.shareChanged(f.engine.report("tickets"));
    await machine.idle();
    assert.equal(f.engine.calls.length, asked);
  } finally { await f.cleanup(); }
});

test("a folder this machine cannot read waits with a message, and is scanned again at the retry", async () => {
  const f = await fixture();
  try {
    f.engine.scanError.set(`project:${PROJECT}`, "EACCES: permission denied");
    const machine = f.machine();
    machine.kick();
    await machine.idle();
    assert.deepEqual([phaseOf(f.db, PROJECT)!.phase, phaseOf(f.db, PROJECT)!.builtinSince], ["bootstrapping", {}]);
    assert.equal(machine.message(PROJECT), "Checking both machines' files: this machine could not read its files (EACCES: permission denied)");
    assert.deepEqual([f.engine.ops("bootstrap"), machine.pendingTimers()], [[], [PROJECT]]);
    const listed = machine.project(PROJECT);
    assert.deepEqual([listed.phase, listed.phaseMessage], ["bootstrapping", machine.message(PROJECT)]);
    f.engine.scanError.clear();
    f.engine.scanError.set(`worktrees:${PROJECT}`, "ENOTDIR: not a directory");
    f.clock.advance(1_000);
    await machine.idle();
    assert.equal(machine.message(PROJECT), "Checking both machines' files: this machine could not read its worktrees (ENOTDIR: not a directory)");
    assert.deepEqual(phaseOf(f.db, PROJECT)!.builtinSince, { project: 7, tickets: 7 });
    f.engine.scanError.clear();
    f.clock.advance(2_000);
    await machine.idle();
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "builtin");
    assert.deepEqual(f.engine.ops("scan"), [SHARES[0], SHARES[0], SHARES[1], SHARES[2], SHARES[2]], "a scan that failed is run again; one that passed is not");
    assert.deepEqual(f.engine.ops("bootstrap"), SHARES);
  } finally { await f.cleanup(); }
});

test("the take-over waits for the engine: not running, a configure the worker has not taken, no machine to share with right now", async () => {
  const f = await fixture();
  try {
    const machine = f.machine();
    f.engine.running_ = false;
    machine.kick();
    await machine.idle();
    assert.deepEqual([phaseOf(f.db, PROJECT)!.phase, machine.message(PROJECT), machine.pendingTimers()], ["bootstrapping", "Waiting for file sync to start on this machine", [PROJECT]]);
    f.engine.running_ = true;
    f.engine.accept = false;
    f.clock.advance(1_000);
    await machine.idle();
    assert.deepEqual([phaseOf(f.db, PROJECT)!.phase, machine.pendingTimers(), f.engine.calls], ["bootstrapping", [PROJECT], []]);
    f.engine.accept = true;
    f.engine.derived = false;
    f.clock.advance(2_000);
    await machine.idle();
    assert.deepEqual([machine.message(PROJECT), machine.pendingTimers(), f.engine.calls], ["Waiting for the other machines to be reachable", [PROJECT], []]);
    f.engine.derived = true;
    f.clock.advance(4_000);
    await machine.idle();
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "builtin");
    assert.deepEqual(f.logs, [], "waiting is not a failure");
  } finally { await f.cleanup(); }
});

test("a step that fails is logged with the project's name and tried again later", async () => {
  const f = await fixture();
  try {
    let failures = 1;
    f.engine.hook = (op) => { if (op === "bootstrap" && failures-- > 0) throw new Error("File sync worker stopped"); };
    const machine = f.machine();
    machine.kick();
    await machine.idle();
    assert.deepEqual(f.logs, ["File sync could not take over Project alpha: File sync worker stopped"]);
    assert.deepEqual([phaseOf(f.db, PROJECT)!.phase, machine.pendingTimers()], ["bootstrapping", [PROJECT]]);
    f.clock.advance(1_000);
    await machine.idle();
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "builtin");
    assert.deepEqual(f.engine.ops("scan"), SHARES, "the folder scanned before the failure is not scanned again");
  } finally { await f.cleanup(); }
});

test("a phase an older release left (syncthing, releasing, restoring) is taken over the same way, from the start", async () => {
  for (const phase of ["syncthing", "releasing", "restoring"] as const) {
    const f = await fixture();
    try {
      // What the older release recorded for another engine's time is not kept: every folder is decided again.
      setPhase(f.db, PROJECT, phase, { builtinSince: { project: 3, tickets: 3, worktrees: 3 }, error: "Syncthing did not answer" });
      const machine = f.machine();
      assert.deepEqual([machine.project(PROJECT).phase, adoptionPhase(phase)], ["bootstrapping", "bootstrapping"], phase);
      machine.kick();
      await machine.idle();
      const held = phaseOf(f.db, PROJECT)!;
      assert.deepEqual([held.phase, held.builtinSince, held.error], ["builtin", TAKEN, null], phase);
      assert.deepEqual(f.engine.ops("scan"), SHARES, phase);
      assert.deepEqual(f.engine.ops("bootstrap"), SHARES, phase);
      assert.deepEqual([...new Set(f.engine.applied)], ["bootstrapping", "builtin"], phase);
    } finally { await f.cleanup(); }
  }
  assert.equal(adoptionPhase("builtin"), "builtin");
  assert.equal(adoptionPhase(undefined), "bootstrapping");
  assert.equal(adoptionPhase("bootstrapping"), "bootstrapping");
});

test("a node that stops at any step resumes there after a restart and finishes, deciding each folder once", async () => {
  const crashes: Array<{ name: string; arm: (f: Fixture, crash: () => never) => void; decided: string[] }> = [
    { name: "during the scan of the first folder", arm: (f, crash) => { f.engine.hook = (op) => { if (op === "scan") crash(); }; }, decided: [] },
    { name: "during the scan of the second folder", arm: (f, crash) => { f.engine.hook = (op, args) => { if (op === "scan" && (args as { share: string }).share.startsWith("tickets")) crash(); }; }, decided: ["project"] },
    { name: "between two bootstraps", arm: (f, crash) => { f.engine.hook = (op, args) => { if (op === "bootstrap" && (args as { share: string }).share.startsWith("worktrees")) crash(); }; }, decided: ["project", "tickets"] },
  ];
  for (const { name, arm, decided } of crashes) {
    const f = await fixture();
    try {
      const first = f.machine();
      let crashed = false;
      arm(f, () => { if (!crashed) { crashed = true; first.stop(); } throw new Error("node stopped"); });
      first.kick();
      await first.idle();
      assert.ok(crashed, name);
      assert.equal(phaseOf(f.db, PROJECT)!.phase, "bootstrapping", `${name}: not builtin after a stop`);
      assert.deepEqual(Object.keys(phaseOf(f.db, PROJECT)!.builtinSince), decided, name);
      assert.deepEqual([first.pendingTimers(), f.clock.live()], [[], 0], `${name}: a stopped machine holds no timer`);
      f.engine.hook = undefined;
      const before = f.engine.calls.length;
      const second = f.machine();
      second.kick();
      await second.idle();
      assert.deepEqual([phaseOf(f.db, PROJECT)!.phase, phaseOf(f.db, PROJECT)!.builtinSince], ["builtin", TAKEN], `${name}: ${f.logs.join(" | ")}`);
      const after = f.engine.calls.slice(before);
      const left = SHARES.filter((share) => !decided.includes(share.split(":")[0]));
      // A folder decided before the stop is neither scanned nor decided again.
      assert.deepEqual(after.filter((call) => call.op === "bootstrap").map((call) => (call.args as { share: string }).share), left, name);
      assert.deepEqual(after.filter((call) => call.op === "scan").map((call) => (call.args as { share: string }).share), left, name);
      assert.equal(f.engine.ops("bootstrap").filter((share) => share.startsWith("project")).length, 1, name);
    } finally { await f.cleanup(); }
  }
});

test("the owner writes one builtin engine record for machines on older releases; a machine that does not own the project writes none", async () => {
  const owner = await fixture();
  try {
    const machine = owner.machine();
    machine.kick();
    await machine.idle();
    assert.deepEqual(listEngineRecords(owner.db), [{ projectId: PROJECT, mode: "builtin", generation: 1, updatedAt: NOW, origin: LOCAL }]);
    // Asked again (a restart, a new peer): the record stands as written.
    owner.clock.advance(60_000);
    const again = owner.machine();
    again.kick();
    again.kick(PROJECT);
    await again.idle();
    assert.deepEqual(listEngineRecords(owner.db), [{ projectId: PROJECT, mode: "builtin", generation: 1, updatedAt: NOW, origin: LOCAL }]);
  } finally { await owner.cleanup(); }

  // The older release's owner had moved it back: the new record is one generation on and newer, so every machine takes it.
  const moved = await fixture();
  try {
    const later = new Date(Date.parse(NOW) + 3_600_000).toISOString();
    saveEngineRecord(moved.db, { projectId: PROJECT, mode: "syncthing", generation: 3, updatedAt: later, origin: LOCAL });
    const machine = moved.machine();
    machine.kick();
    await machine.idle();
    assert.deepEqual(engineRecordOf(moved.db, PROJECT), { projectId: PROJECT, mode: "builtin", generation: 4, updatedAt: new Date(Date.parse(later) + 1).toISOString(), origin: LOCAL });
  } finally { await moved.cleanup(); }

  const peer = await fixture({ owner: PEER });
  try {
    const machine = peer.machine();
    assert.equal(machine.project(PROJECT).owner, false);
    machine.kick();
    await machine.idle();
    assert.deepEqual([phaseOf(peer.db, PROJECT)!.phase, phaseOf(peer.db, PROJECT)!.builtinSince], ["builtin", TAKEN], "it takes the project over all the same");
    assert.deepEqual(listEngineRecords(peer.db), []);
  } finally { await peer.cleanup(); }
});

test("the listing shows every shared project with its phase, what it waits for and its differences", async () => {
  const f = await fixture();
  try {
    addUnshared(f.db, path.join(f.dir, "solo"));
    f.engine.tweak.project = { peers: [{ ...status("project", "syncthing").peers[0], differences: 2 }] };
    f.engine.tweak.worktrees = { peers: [{ ...status("worktrees", "syncthing").peers[0], differences: 1 }] };
    const machine = f.machine({ released: async () => false });
    const before = { projectId: PROJECT, name: "Project alpha", owner: true, phase: "bootstrapping", phaseMessage: null, phaseError: null, differences: 3, shares: ["project", "tickets", "worktrees"], waiting: false };
    assert.deepEqual(machine.projects(), [before], "the project shared with nobody is not listed");
    machine.kick();
    await machine.idle();
    assert.deepEqual(machine.projects(), [{ ...before, phaseMessage: RELEASE_MESSAGE }]);
    assert.deepEqual(machine.project(PROJECT), machine.projects()[0]);
    assert.deepEqual(machine.roots(PROJECT), f.roots);
    assert.equal(projectDifferences(f.engine.api().statuses(PROJECT)), 3);
    assert.equal(projectDifferences([]), 0);

    const taken = f.machine();
    taken.kick();
    await taken.idle();
    assert.deepEqual(taken.projects(), [{ ...before, phase: "builtin" }]);
    // A project taken over before stays listed while no machine shares it right now, and one with a stored error says so.
    f.db.prepare("DELETE FROM sharing_resource_shares WHERE resource_id = ?").run(PROJECT);
    f.engine.derived = false;
    setPhase(f.db, "solo", "bootstrapping", { error: "The folder is on a disk that is not mounted" });
    assert.deepEqual(taken.projects(), [
      { ...before, phase: "builtin", differences: 0, shares: [] },
      { projectId: "solo", name: "Solo", owner: false, phase: "bootstrapping", phaseMessage: null, phaseError: "The folder is on a disk that is not mounted", differences: 0, shares: [], waiting: true },
    ]);
  } finally { await f.cleanup(); }
});

test("stop() cancels the retry timers, and a stopped machine starts nothing", async () => {
  const f = await fixture();
  try {
    let asked = 0;
    const machine = f.machine({ released: async () => { asked++; return false; } });
    machine.kick();
    await machine.idle();
    assert.deepEqual([machine.pendingTimers(), f.clock.live()], [[PROJECT], 1]);
    machine.stop();
    assert.deepEqual([machine.pendingTimers(), f.clock.live()], [[], 0]);
    f.clock.advance(60_000);
    machine.kick();
    machine.kick(PROJECT);
    machine.shareChanged(f.engine.report("project"));
    await machine.idle();
    assert.deepEqual([asked, f.engine.calls, phaseOf(f.db, PROJECT), f.clock.live()], [1, [], undefined, 0]);
  } finally { await f.cleanup(); }
});

test("a kick that arrives while a step runs is not lost: the step runs once more when it ends", async () => {
  const f = await fixture();
  try {
    let release!: (value: boolean) => void;
    let asked = 0;
    const machine = f.machine({ released: () => { asked++; return asked === 1 ? new Promise<boolean>((resolve) => { release = resolve; }) : Promise.resolve(true); } });
    machine.kick();
    machine.kick();
    machine.kick(PROJECT);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(asked, 1, "one step per project at a time");
    release(true);
    await machine.idle();
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "builtin");
    assert.deepEqual(f.engine.ops("bootstrap"), SHARES);
  } finally { await f.cleanup(); }
});

test("projects are taken over one at a time, lowest id first, and one that waits lets the next go", async () => {
  const f = await fixture();
  try {
    for (const id of ["beta", "gamma"]) { addProject(f.db, id, path.join(f.dir, id)); f.engine.projects.add(id); }
    const ids = [PROJECT, "beta", "gamma"];
    const phases = () => ids.map((id) => phaseOf(f.db, id)?.phase ?? null);
    // Every scan is held until the test lets it go; what the phases were when each began is kept.
    const scans: Array<{ share: string; phases: Array<Phase | null>; go: () => void }> = [];
    f.engine.hook = (op, args) => op === "scan" ? new Promise<void>((resolve) => { scans.push({ share: (args as { share: string }).share, phases: phases(), go: resolve }); }) : undefined;
    let seen = 0;
    // The next scan began, or every project is done. The take-over reads the folders in between, so this takes a moment.
    const settle = async () => {
      for (const deadline = Date.now() + 10_000; scans.length === seen && phases().some((phase) => phase !== "builtin") && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 2));
      for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
    };
    const machine = f.machine();
    machine.kick();
    machine.kick();
    await settle();
    assert.deepEqual(scans.map((scan) => scan.share), [`project:${PROJECT}`], "one scan in flight");
    assert.deepEqual(phases(), ["bootstrapping", null, null], "the others have not been touched");
    const order: string[] = [];
    while (phases().some((phase) => phase !== "builtin")) {
      assert.equal(scans.length, seen + 1, "never two scans at once");
      const scan = scans[seen++];
      order.push(scan.share);
      const project = scan.share.split(":")[1];
      // While a project's scan runs it is the only one in bootstrapping: those before it are done, those after untouched.
      assert.deepEqual(scan.phases, ids.map((id) => id < project ? "builtin" : id === project ? "bootstrapping" : null), scan.share);
      scan.go();
      await settle();
      assert.ok(seen <= 9);
    }
    await machine.idle();
    assert.deepEqual(order, ids.flatMap((id) => SHARE_KINDS.map((kind) => `${kind}:${id}`)));
    assert.deepEqual(ids.map((id) => phaseOf(f.db, id)!.builtinSince), [TAKEN, TAKEN, TAKEN]);
    assert.deepEqual([machine.pendingTimers(), f.clock.live(), f.logs], [[], 0, []]);
  } finally { await f.cleanup(); }

  const waiting = await fixture();
  try {
    for (const id of ["beta", "gamma"]) { addProject(waiting.db, id, path.join(waiting.dir, id)); waiting.engine.projects.add(id); }
    // alpha's peers have not sent their whole list: it waits, and beta and gamma are taken over meanwhile.
    waiting.engine.notReady.set(`project:${PROJECT}`, 1);
    const machine = waiting.machine();
    machine.kick();
    await machine.idle();
    assert.deepEqual([PROJECT, "beta", "gamma"].map((id) => phaseOf(waiting.db, id)?.phase), ["bootstrapping", "builtin", "builtin"]);
    assert.deepEqual(machine.pendingTimers(), [PROJECT]);
    // A kick while it waits does not put it back in the queue before its timer.
    const asked = waiting.engine.calls.length;
    machine.kick();
    await machine.idle();
    assert.equal(waiting.engine.calls.length, asked);
    waiting.clock.advance(1_000);
    await machine.idle();
    assert.equal(phaseOf(waiting.db, PROJECT)!.phase, "builtin");
    assert.deepEqual([machine.pendingTimers(), waiting.clock.live()], [[], 0]);
  } finally { await waiting.cleanup(); }
});

test("leftover download temps go by name only, without following links", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "file-sync-temps-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "file-sync-temps-outside-"));
  try {
    await mkdir(path.join(dir, "a", "b"), { recursive: true });
    await mkdir(path.join(dir, "skipped"));
    await writeFile(path.join(dir, "a", "b", ".syncthing.x.tmp"), "");
    await writeFile(path.join(dir, "a", "~syncthing~y.tmp"), "");
    await writeFile(path.join(dir, "a", "syncthing.z.tmp"), "");
    await writeFile(path.join(dir, "skipped", ".syncthing.q.tmp"), "");
    await writeFile(path.join(outside, ".syncthing.elsewhere.tmp"), "");
    await symlink(outside, path.join(dir, "link"));
    assert.equal(await removeLeftoverTemps(dir, (relative) => relative === "skipped"), 2);
    assert.deepEqual((await readdir(path.join(dir, "a"), { recursive: true })).sort(), ["b", "syncthing.z.tmp"]);
    assert.equal(existsSync(path.join(outside, ".syncthing.elsewhere.tmp")), true);
    assert.equal(existsSync(path.join(dir, "skipped", ".syncthing.q.tmp")), true, "a folder the engine ignores is not walked");
    assert.equal(await removeLeftoverTemps(path.join(dir, "missing")), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("the worker reports builtin_since for the take-over, its own and each peer's", async (t) => {
  const { createWorkerCore } = await import("../src/file-sync/core.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "file-sync-adoption-core-"));
  const root = path.join(dir, "root");
  await mkdir(root);
  await writeFile(path.join(root, "a.txt"), "a");
  let now = Date.now();
  let seed = 7;
  const core = createWorkerCore({
    nodeId: "node-a", dataDir: path.join(dir, "data"), watch: false, emit: () => {},
    clock: { now: () => now++, setTimeout: () => ({ cancel() {} }) }, random: () => (seed = (seed * 16807) % 2147483647) / 2147483647,
  });
  t.after(async () => { await core.close(); await rm(dir, { recursive: true, force: true }); });
  const key = "project:p1";
  const configure = (phase: Phase) => core.call("configure", {
    enabled: true, hostId: "host", peers: [], records: { engines: [], settings: [] },
    shares: [{ key, projectId: "p1", kind: "project", root, phase, rules: { ...EMPTY_RULE_SETTINGS }, peers: ["node-b"] }],
  });
  await configure("bootstrapping");
  await core.call("scan", { share: key, scope: "full", reason: "switch" });
  // The peer is on built-in sync since its seq 4: its pages say so, and the status hands it to the bootstrap.
  await core.need.storeRemote(key, "node-b", 0, { indexId: "b-gen", maxSeq: 6, digest: "0".repeat(64), prunedBelow: 0, builtinSince: 4, entries: [], more: false });
  await core.need.idle();
  const [before] = await core.call("status", { shares: [key] });
  assert.equal(before.builtinSince, null);
  assert.equal(before.peers[0].builtinSince, 4);
  await core.call("bootstrap", { share: key, builtinSinceByPeer: { "node-b": 4 } });
  const [after] = await core.call("status", { shares: [key] });
  assert.equal(after.builtinSince, after.maxSeq);
  await configure("builtin");
  assert.equal((await core.call("status", { shares: [key] }))[0].builtinSince, after.maxSeq, "kept once the project is builtin");
});

test("the first index of every shared project runs one at a time, smallest first, and waits while main is busy", () => {
  const clock = new FakeClock();
  const indexed = new Set<string>(["known"]);
  let changed = 0;
  let busy = true;
  const queue = new FirstIndexQueue({
    indexed: () => indexed, markIndexed: (id) => { indexed.add(id); }, changed: () => { changed++; },
    name: (id) => `Project ${id}`, clock, calmWindowMs: 2_000, loopUtilization: () => () => busy ? 0.95 : 0.1,
  });
  const spec = (projectId: string, kind: ShareKind): ShareSpec => ({ key: `${kind}:${projectId}`, projectId, kind, root: `/r/${projectId}/${kind}`, phase: "syncthing", rules: { ...EMPTY_RULE_SETTINGS }, peers: [PEER] });
  const all = ["alpha", "beta", "gamma", "known", "taken"].flatMap((id) => SHARE_KINDS.map((kind) => spec(id, kind)));
  // A project already being taken over (it has a phase here) is wanted at once.
  const always = (id: string) => id === "taken";
  // beta and gamma have a known file count; alpha's is unknown, so it goes last.
  queue.setCounts(new Map([["beta", 900], ["gamma", 12]]));
  const projectsOf = (shares: ShareSpec[]) => [...new Set(shares.map((share) => share.projectId))].sort();
  let admitted = queue.admit(all, always);
  assert.deepEqual(projectsOf(admitted), ["gamma", "known", "taken"], "indexed and taken-over projects at once, one new project");
  assert.deepEqual(queue.status(), { projectId: "gamma", name: "Project gamma", position: 2, total: 5 });
  const reports = new Map<string, ShareStatus>();
  const report = (projectId: string, kind: ShareKind, overrides: Partial<ShareStatus>) => {
    const value = { ...status(kind, "syncthing"), share: `${kind}:${projectId}`, projectId, ...overrides };
    reports.set(value.share, value);
    queue.reported(value, (key) => reports.get(key));
  };
  report("gamma", "project", { indexed: true });
  report("gamma", "tickets", { indexed: false, state: "scanning", scanning: true });
  report("gamma", "worktrees", { state: "unavailable" });
  assert.equal(indexed.has("gamma"), false, "one folder still scanning");
  report("gamma", "tickets", { indexed: true });
  assert.equal(indexed.has("gamma"), true);
  assert.equal(changed, 0, "the next waits for main to be calm");
  clock.advance(2_000);
  assert.equal(changed, 0, "a busy window waits for another");
  busy = false;
  clock.advance(2_000);
  assert.equal(changed, 1);
  admitted = queue.admit(all, always);
  assert.deepEqual(projectsOf(admitted), ["beta", "gamma", "known", "taken"]);
  assert.deepEqual(queue.status(), { projectId: "beta", name: "Project beta", position: 3, total: 5 });
  // A project that is no longer shared leaves the queue; the next goes in.
  admitted = queue.admit(all.filter((share) => share.projectId !== "beta"), always);
  assert.deepEqual(projectsOf(admitted), ["alpha", "gamma", "known", "taken"]);
  assert.ok(clock.live() === 0, "no timer while a project indexes");
  // A file rewritten every second keeps a folder scanning: its first index is done all the same, and a main thread
  // that stays busy lets the next project go after a few windows instead of holding the queue for good.
  busy = true;
  report("alpha", "project", { indexed: true, state: "scanning", scanning: true });
  report("alpha", "tickets", { indexed: true, state: "scanning", scanning: true });
  report("alpha", "worktrees", { indexed: true });
  assert.equal(indexed.has("alpha"), true, "indexed while still scanning");
  const before = changed;
  for (let window = 0; window < 4; window++) clock.advance(2_000);
  assert.equal(changed, before, "four busy windows wait");
  clock.advance(2_000);
  assert.equal(changed, before + 1, "the fifth goes on anyway");
  assert.equal(clock.live(), 0);
  queue.stop();
});

test("the project listing is the node admin's only", async () => {
  const { isAdminRoute } = await import("../src/server/admin.js");
  for (const [method, route] of [["GET", "/file-sync/projects"], ["GET", "/File-Sync/Projects/"]]) assert.equal(isAdminRoute(method, route), true, `${method} ${route}`);
});
