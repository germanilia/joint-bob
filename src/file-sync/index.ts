import { AsyncResource } from "node:async_hooks";
import { createHash, type KeyObject } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { peerAway } from "../peer-presence.js";
import { onRelayPeersChanged } from "../relay/events.js";
import { settled, warnOnChange } from "../server/quiet-log.js";
import type { BridgeOptions, BridgeState, WorkerBridge } from "./bridge.js";
import { controlDatabase, ensureRevisionTriggers, fileSyncListenAddresses, holdsEngineProjects, listEngineRecords, listPhases, listSettingsRecords, markProjectsIndexed, readFileSyncConfig, readIndexedProjects, readRevision, setPhase, writeFileSyncConfig, type FileSyncConfig, type FileSyncConfigPatch } from "./control.js";
import { FirstIndexQueue, type IndexingStatus } from "./first-index.js";
import { acceptablePeerOrigin, helloFileSync, notePeerFileSync, onPeerFileSyncChanged, onPeerPresent, parseFileSyncPart, peerFileSync, peerOrigins, peerSpecs, type HelloFileSync } from "./peers.js";
import { FILE_SYNC_SWITCH_PROTOCOL, type ConfigureArgs, type CoreEvent, type DifferenceItem, type ErrorItem, type ListPage, type PendingFiles, type RequestStats, type ScanResult, type ShareSpec, type ShareStatus } from "./protocol.js";
import { ShareStatusStore } from "./status.js";
import { parseShareKey, type Phase } from "./types.js";
import type { Adoption, AdoptionEngine, FileSyncProject } from "./adoption.js";
// app-integration (P4)
import path from "node:path";
import type { ShareKind } from "./types.js";

/* Starts and stops the file sync worker and keeps it configured with the shares derived from
   node.db. Callers (server.ts, turn ends, project opens, /hello, Settings) never get an exception
   from here: failures are logged once per reason. Nothing loads the engine's heavier modules until
   it actually runs, so the hooks cost nothing on a node with file sync off. */

const STOP_BUDGET_MS = 2_000;
const FLUSH_TIMEOUT_MS = 60_000;
const PROJECT_OPEN_INTERVAL_MS = 30_000;
const DERIVE_COALESCE_MS = 250;
/** A hello and a relay's "back online" for the same peer usually come together; one pull is enough. */
const PRESENCE_COALESCE_MS = 5_000;

interface Modules {
  bridge: typeof import("./bridge.js");
  shares: typeof import("./shares.js");
  records: typeof import("./records.js");
  identity: typeof import("../cluster-identity.js");
  cluster: typeof import("../cluster.js");
  performance: typeof import("../server/performance-diagnostics.js");
  account: typeof import("../account-runtime.js");
}

interface Engine {
  db: DatabaseSync;
  nodeId: string;
  hostId: string;
  signingKey?: KeyObject;
  bridge: WorkerBridge;
  shares: ShareSpec[];
  desired?: ConfigureArgs;
  /** The desired state the current worker last accepted; unset until its first configure. */
  sent?: string;
  pushing: boolean;
  pushAgain: boolean;
  pushWaiters: Array<() => void>;
  revision: number;
  schema: number;
  deriveTimer?: NodeJS.Timeout;
  /** Direct origins the worker bound (configure answer, ready event): what /hello advertises. */
  origins: string[];
  /** Start, wake and join each ask peers once for what changed; a request while one runs folds into one more. */
  announceWanted: boolean;
  announceSlept: boolean;
  announcing: boolean;
  presence: Map<string, { at: number; origins: string }>;
  unsubscribe: Array<() => void>;
  /** auto-transition: projects never indexed here join the worker's shares one at a time. */
  queue: FirstIndexQueue;
}

let modules: Promise<Modules> | undefined;
let engine: Engine | undefined;
/** The launch in flight and the lifecycle it belongs to: a stop in between makes it give up. */
let starting: { lifecycle: number; done: Promise<void> } | undefined;
let stopping: Promise<void> = Promise.resolve();
let lifecycle = 0;
/** Set by the first startFileSync, which runs once readiness allows cluster work and outside any request or background context. */
let scope: AsyncResource | undefined;
const statuses = new ShareStatusStore();
const projectOpenedAt = new Map<string, number>();
let workerOverride: Pick<BridgeOptions, "launch" | "workerData" | "dataDir"> | undefined;

function load(): Promise<Modules> {
  modules ??= Promise.all([import("./bridge.js"), import("./shares.js"), import("./records.js"), import("../cluster-identity.js"), import("../cluster.js"), import("../server/performance-diagnostics.js"), import("../account-runtime.js")])
    .then(([bridge, shares, records, identity, cluster, performance, account]) => ({ bridge, shares, records, identity, cluster, performance, account }));
  return modules;
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Network ops answer "unavailable" from a worker without a network part; that is not worth a warning. */
function quietly(key: string, what: string): (error: unknown) => void {
  return (error) => {
    if ((error as { code?: unknown })?.code === "unavailable") settled(key);
    else warnOnChange(key, `${what}: ${messageOf(error)}`);
  };
}

/** Work started from a request or a background pass runs in startup's context, so the worker's events and timers inherit neither. */
function neutral<T>(work: () => T): T { return scope ? scope.runInAsyncScope(work) : work(); }

/** Tests run the engine's main-thread half against a stand-in worker; undefined restores the real one. */
export function useFileSyncWorkerForTests(options: Pick<BridgeOptions, "launch" | "workerData" | "dataDir"> | undefined): void { workerOverride = options; }

/** From runClusterWork's one-time block; starts the worker only when file sync is enabled here. */
export async function startFileSync(): Promise<void> {
  scope ??= new AsyncResource("FileSync");
  try {
    const db = await controlDatabase();
    // A node that holds synced projects keeps its engine even where an old setting says off.
    if (!readFileSyncConfig(db).enabled && !holdsEngineProjects(db)) return;
    await neutral(ensureRunning);
  } catch (error) {
    warnOnChange("fileSync:start", `File sync could not start: ${messageOf(error)}`);
  }
}

/** Within the shutdown budget: a stop op, then terminate. */
export async function stopFileSync(): Promise<void> {
  lifecycle++;
  const current = engine;
  engine = undefined;
  // Take-overs stop with the engine; the next start resumes them from node.db.
  adoption?.machine.stop();
  adoption = undefined;
  statuses.clear();
  projectOpenedAt.clear();
  pulled.clear();
  if (!current) return;
  for (const unsubscribe of current.unsubscribe.splice(0)) unsubscribe();
  clearTimeout(current.deriveTimer);
  stopping = current.bridge.stop(STOP_BUDGET_MS).catch((error) => warnOnChange("fileSync:stop", `File sync did not stop cleanly: ${messageOf(error)}`));
  await stopping;
}

function ensureRunning(): Promise<void> {
  if (engine) return Promise.resolve();
  if (starting?.lifecycle === lifecycle) return starting.done;
  // A launch from before a stop gives up when it next looks; this one starts after it, never beside it.
  const previous = starting?.done ?? Promise.resolve();
  const generation = ++lifecycle;
  const done: Promise<void> = previous.catch(() => undefined).then(() => launch(generation)).finally(() => {
    if (starting?.done === done) starting = undefined;
  });
  starting = { lifecycle: generation, done };
  return done;
}

async function launch(generation: number): Promise<void> {
  if (generation !== lifecycle) return;
  const loaded = await load();
  const db = await controlDatabase();
  const nodeId = (await loaded.cluster.getClusterNode()).id;
  // A worker still stopping holds file-sync.db; the next one opens it after.
  await stopping;
  if (generation !== lifecycle) return;
  ensureRevisionTriggers(db);
  let signingKey: KeyObject | undefined;
  try { signingKey = loaded.identity.clusterPrivateKey(db, nodeId); }
  catch (error) { warnOnChange("fileSync:key", `File sync could not read this node's signing key, so its worker cannot reach peers directly: ${messageOf(error)}`); }
  const current: Engine = {
    db, nodeId, hostId: loaded.shares.fileSyncHostId(), signingKey, bridge: undefined as unknown as WorkerBridge, shares: [],
    pushing: false, pushAgain: false, pushWaiters: [], revision: -1, schema: readRevision(db).schema, origins: [],
    announceWanted: false, announceSlept: false, announcing: false, presence: new Map(), unsubscribe: [],
    queue: new FirstIndexQueue({
      indexed: () => readIndexedProjects(db) ?? new Set(),
      markIndexed: (projectId) => { try { markProjectsIndexed(db, [projectId]); } catch (error) { warnOnChange("fileSync:index", `File sync could not note that ${projectId} is indexed: ${messageOf(error)}`); } },
      changed: () => requestDerive(current),
      name: (projectId) => projectName(db, projectId),
    }),
  };
  current.unsubscribe.push(() => current.queue.stop());
  seedIndexedProjects(db);
  current.bridge = new loaded.bridge.WorkerBridge({
    nodeId,
    ...workerOverride,
    // A new worker knows nothing: it gets the whole desired state again, then asks peers what changed meanwhile.
    onStart: () => { current.sent = undefined; current.origins = []; current.announceWanted = true; void push(current); },
    onEvent: (event) => handleEvent(current, event),
  });
  engine = current;
  // The worker starts even so: its revision stays unknown, so the next 2 s pass derives again.
  await derive(current).catch((error) => warnOnChange("fileSync:derive", `File sync could not work out which folders to sync: ${messageOf(error)}`));
  if (engine !== current) return;
  current.unsubscribe.push(
    onRelayPeersChanged(() => requestDerive(current)),
    // Main had it as away: the worker stopped talking to it on that word (a relay answer marked away) and waits for this one.
    onPeerPresent((peer) => { requestDerive(current); fileSyncPeerPresent(peer, true); adoptionKick(); }),
    // New origins or capability reach the worker with the next configure.
    onPeerFileSyncChanged(() => requestDerive(current)),
  );
  current.bridge.start();
  // Each project this node has not taken over yet resumes where it was.
  startAdoption(current);
}

async function derive(current: Engine): Promise<void> {
  const loaded = await load();
  await loaded.performance.measureOperation("fileSync.derive", () => {
    const { revision } = readRevision(current.db);
    const config = readFileSyncConfig(current.db);
    const records = listSettingsRecords(current.db);
    // Only "builtin" lets the worker write a project's files; every other phase is a take-over still to finish (adoption.ts).
    const phases = new Map([...listPhases(current.db)].map(([projectId, record]): [string, Phase] => [projectId, record.phase]));
    const switched = new Set(listEngineRecords(current.db).map((record) => record.projectId));
    // Every project shared with another machine is synced; a list an older release let a person choose no longer narrows it.
    const allowed = loaded.shares.deriveShares(current.db, { local: current.nodeId, shadowProjects: config.enabled ? "all" : [], phases, switched, settings: new Map(records.map((record) => [record.key, record.value])) });
    // Projects never indexed here go in one at a time; those already being taken over are wanted now.
    const shares = current.queue.admit(allowed, (projectId) => (phases.get(projectId) ?? "syncthing") !== "syncthing" || switched.has(projectId));
    // Every peer main's cluster routes accept, not only those sharing a folder now: the direct listener verifies the same
    // signatures, and a share the caller is not in gets the service's 403 (not retried) instead of a 401 (retried for good).
    const peers = peerSpecs(current.db, [...shares.flatMap((share) => share.peers), ...loaded.shares.verifiablePeers(current.db, current.nodeId)]);
    // Shares it reported or was given before; a drop is repeated until the project comes back, since the worker may have restarted meanwhile.
    const derived = new Set(shares.map((share) => share.key));
    const known = new Set([...current.shares.map((share) => share.key), ...current.desired?.dropShares ?? [], ...statuses.keys()]);
    const dropShares = loaded.shares.droppedShares(current.db, known).filter((key) => !derived.has(key));
    current.shares = shares;
    current.desired = {
      enabled: true, hostId: current.hostId, ...(current.signingKey ? { signingKey: current.signingKey } : {}),
      listen: { addresses: fileSyncListenAddresses(), port: config.port },
      shares, peers, records: { engines: listEngineRecords(current.db), settings: records }, ...(dropShares.length ? { dropShares } : {}),
      // Apply never lowers group bits on Linux in multi-user mode (§1 Permissions); "turned on" holds even while its helper is missing.
      multiUser: loaded.account.multiUserTurnedOn(),
    };
    // Only now: a failed derivation is retried by the next pass.
    current.revision = revision;
  });
  if (engine !== current) return;
  statuses.retain(new Set(current.shares.map((share) => share.key)));
  settled("fileSync:derive");
  void push(current);
  // A phase, sharing or a peer's capability changed: take-overs take their next step.
  if (adoption?.engine === current) adoption.machine.kick();
}

/** Configure is the full desired state; one in flight at a time, and only when it changed. Resolves once what was desired at the call went out (or could not). */
function push(current: Engine): Promise<void> {
  return new Promise((resolve) => {
    current.pushWaiters.push(resolve);
    if (current.pushing) { current.pushAgain = true; return; }
    void runPush(current);
  });
}

async function runPush(current: Engine): Promise<void> {
  current.pushing = true;
  try {
    do {
      current.pushAgain = false;
      const desired = current.desired;
      if (!desired || engine !== current || current.bridge.state !== "running") return;
      // A KeyObject serializes as {}, so the key compares everything but the signing key, which never changes while running.
      const key = JSON.stringify(desired);
      if (key === current.sent) continue;
      const answer = await current.bridge.call("configure", desired);
      current.sent = key;
      if (Array.isArray(answer?.origins)) current.origins = answer.origins.filter((origin): origin is string => typeof origin === "string");
      settled("fileSync:configure");
    } while (current.pushAgain);
  } catch (error) {
    current.sent = undefined;
    warnOnChange("fileSync:configure", `File sync could not configure its worker: ${messageOf(error)}`);
  } finally {
    current.pushing = false;
    for (const resolve of current.pushWaiters.splice(0)) resolve();
  }
  if (current.announceWanted && current.sent !== undefined) void runAnnounce(current);
}

function projectName(db: DatabaseSync, projectId: string): string {
  try { return (db.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined)?.name ?? projectId; } catch { return projectId; }
}

/** Once, on the first start of this release: the projects this node already compared (its chosen list, any switched) count as indexed, so they keep their place. */
function seedIndexedProjects(db: DatabaseSync): void {
  try {
    if (readIndexedProjects(db) !== undefined) return;
    const stored = db.prepare("SELECT value FROM file_sync_config WHERE key = 'shadowProjects'").get() as { value: string } | undefined;
    let chosen: string[] = [];
    try { const parsed = stored ? JSON.parse(stored.value) as unknown : undefined; if (Array.isArray(parsed)) chosen = parsed.filter((id): id is string => typeof id === "string"); } catch { /* none chosen */ }
    markProjectsIndexed(db, [...chosen, ...listPhases(db).keys(), ...listEngineRecords(db).map((record) => record.projectId)]);
  } catch (error) {
    warnOnChange("fileSync:index", `File sync could not read which projects it indexed before: ${messageOf(error)}`);
  }
}

/** Coalesces bursts (a membership install rewrites several tables) into one derivation. */
function requestDerive(current: Engine | undefined = engine): void {
  if (!current || engine !== current || current.deriveTimer) return;
  current.deriveTimer = neutral(() => setTimeout(() => {
    current.deriveTimer = undefined;
    if (engine !== current) return;
    derive(current).catch((error) => warnOnChange("fileSync:derive", `File sync could not work out which folders to sync: ${messageOf(error)}`));
  }, DERIVE_COALESCE_MS));
  current.deriveTimer.unref();
}

function handleEvent(current: Engine, event: CoreEvent): void {
  if (engine !== current) return;
  // Logs, settles, metrics and relay requests are handled by the bridge.
  switch (event.event) {
    case "ready":
      if (Array.isArray(event.origins)) current.origins = event.origins.filter((origin): origin is string => typeof origin === "string");
      // A take-over waiting for the worker (its scan and bootstrap) goes on now.
      if (adoption?.engine === current) adoption.machine.kick();
      return;
    case "records":
      void receiveRecords(current, event);
      return;
    case "capability":
      // The worker learned it from the peer's signed /files/shares answer (or its 404: protocol 0).
      if (typeof event.peer !== "string" || !event.peer) return;
      notePeerFileSync(event.peer, {
        protocol: Number.isInteger(event.protocol) && event.protocol > 0 ? event.protocol : 0, via: "shares",
        ...(typeof event.enabled === "boolean" ? { enabled: event.enabled } : {}),
        // Only what main accepts reaches configure: a peer's answer must not point the worker at link-local or public addresses.
        origins: (Array.isArray(event.origins) ? event.origins : []).filter((origin) => typeof origin === "string" && acceptablePeerOrigin(origin)),
        ...(typeof event.hostId === "string" ? { hostId: event.hostId } : {}),
      });
      return;
    default:
      // app-integration (P4): compared with the report it replaces, so before it is stored.
      if (event.event === "shareState") notePulls(event.status);
      statuses.apply(event);
      if (event.event !== "shareState") return;
      // auto-transition: the project indexing may be done, and the next one goes in.
      current.queue.reported(event.status, (key) => statuses.get(key));
      // A take-over waiting for its peers' lists of files tries again once they are here.
      if (adoption?.engine === current) adoption.machine.shareChanged(event.status);
  }
}

/** Records come only from the peer whose signed answer carried them; records.ts decides which count. */
async function receiveRecords(current: Engine, event: Extract<CoreEvent, { event: "records" }>): Promise<void> {
  try {
    const loaded = await load();
    if (engine !== current) return;
    const outcome = loaded.records.acceptRecords(current.db, current.nodeId, { fromPeer: event.fromPeer, engines: event.engines ?? [], settings: event.settings ?? [] });
    settled("fileSync:records");
    // The triggers on the record tables would get there on the next 2 s pass; this does not wait for it.
    if (outcome.engines || outcome.settings) requestDerive(current);
  } catch (error) {
    warnOnChange("fileSync:records", `File sync could not store records from ${event.fromPeer}: ${messageOf(error)}`);
  }
}

/** The server's 2 s pass: one integer read unless the schema moved (a table rebuilt by a migration loses its triggers). */
export function fileSyncTick(): void {
  const current = engine;
  if (!current) return;
  try {
    const { revision, schema } = readRevision(current.db);
    let changed = revision !== current.revision;
    if (schema !== current.schema) {
      // Changes made while a trigger was missing went unseen.
      if (ensureRevisionTriggers(current.db) > 0) changed = true;
      current.schema = readRevision(current.db).schema;
    }
    if (changed) requestDerive(current);
    settled("fileSync:tick");
  } catch (error) {
    warnOnChange("fileSync:tick", `File sync could not check for sharing changes: ${messageOf(error)}`);
  }
}

/* Peers. Pulls happen on events only: this node starting or waking, a peer coming back or saying
   hello, a cluster join. Each asks the worker once; it decides which peers and shares need a pull. */

/** This node started, woke up or joined a cluster: the worker asks every capable peer what changed. A worker still starting does this after its first configure. */
export function fileSyncAnnounce(slept = false): void {
  // app-integration (P4): pulls before a sleep say nothing about what peers did meanwhile.
  if (slept) pulled.clear();
  const current = engine;
  if (!current) return;
  current.announceWanted = true;
  current.announceSlept ||= slept;
  if (current.bridge.state === "running" && current.sent !== undefined) void neutral(() => runAnnounce(current));
}

async function runAnnounce(current: Engine): Promise<void> {
  if (current.announcing) return;
  current.announcing = true;
  try {
    while (current.announceWanted && engine === current && current.bridge.state === "running" && current.sent !== undefined) {
      const slept = current.announceSlept;
      current.announceWanted = false;
      current.announceSlept = false;
      // Sharing may have changed (a join) and addresses too (a wake): the worker announces with what holds now.
      if (readRevision(current.db).revision !== current.revision || current.desired?.listen?.addresses.join(",") !== fileSyncListenAddresses().join(",")) await derive(current);
      await push(current);
      if (engine !== current || current.sent === undefined) break;
      await current.bridge.call("announce", { slept }).then(() => settled("fileSync:announce"), quietly("fileSync:announce", "File sync could not ask peers for changes"));
    }
  } catch (error) {
    warnOnChange("fileSync:announce", `File sync could not ask peers for changes: ${messageOf(error)}`);
  } finally {
    current.announcing = false;
  }
}

/** A peer is back (a relay saw it, it answered again, or it said hello): the worker flushes what it owes the peer and pulls what changed there. */
export function fileSyncPeerPresent(peer: string, returned = false): void {
  const current = engine;
  if (!current || current.bridge.state !== "running" || current.sent === undefined || peer === current.nodeId) return;
  const origins = peerOrigins(peer);
  const key = origins.join(",");
  const now = Date.now();
  const last = current.presence.get(peer);
  if (!returned && last && now - last.at < PRESENCE_COALESCE_MS && last.origins === key) return;
  current.presence.set(peer, { at: now, origins: key });
  neutral(() => current.bridge.call("peerPresence", { peer, present: true, origins }))
    .then(() => settled("fileSync:presence"), quietly("fileSync:presence", `File sync could not catch up with ${peer}`));
}

async function selfDescription(): Promise<HelloFileSync> {
  // Unknown is left out rather than said as off: an owner moves its built-in projects back from a peer with file sync off.
  let enabled: boolean | undefined;
  try { enabled = readFileSyncConfig(await controlDatabase()).enabled; } catch { /* unknown */ }
  return helloFileSync({ origins: engine?.origins ?? [], enabled });
}

/** The fileSync part of this node's /hello body. Never throws. */
export async function fileSyncHelloBody(): Promise<{ fileSync: HelloFileSync }> {
  return { fileSync: await selfDescription() };
}

/** A peer said hello: note what it says about its engine, catch up with it, and answer with this node's part. Never throws. */
export async function fileSyncHelloReceived(peer: string, body: unknown): Promise<HelloFileSync> {
  try {
    notePeerFileSync(peer, { ...parseFileSyncPart(body), via: "hello" });
    fileSyncPeerPresent(peer);
    adoptionKick();
  } catch (error) {
    warnOnChange("fileSync:hello", `File sync could not read ${peer}'s hello: ${messageOf(error)}`);
  }
  return selfDescription();
}

/** A peer answered this node's hello; an older one answers {ok: true} and so has no engine. Never throws. */
export function fileSyncHelloAnswered(peer: string, answer: unknown): void {
  try { notePeerFileSync(peer, { ...parseFileSyncPart(answer), via: "answer" }); adoptionKick(); }
  catch (error) { warnOnChange("fileSync:hello", `File sync could not read ${peer}'s hello answer: ${messageOf(error)}`); }
}

function flush(current: Engine, share: string, subtree?: string): void {
  // A share the worker has not reported is still waiting for its configure, which queues a full scan anyway.
  if (!statuses.get(share)) return;
  current.bridge.call("flush", subtree ? { share, subtree } : { share }, { timeoutMs: FLUSH_TIMEOUT_MS })
    .then(() => settled("fileSync:flush"), (error) => warnOnChange("fileSync:flush", `File sync could not pick up changed files: ${messageOf(error)}`));
}

/** A turn ended: what it wrote under its working directory goes out now, not after the watcher's debounce. */
export function fileSyncTurnEnded(cwd: string): void {
  const current = engine;
  if (!current || current.bridge.state !== "running" || !cwd) return;
  void load().then(({ shares }) => {
    if (engine !== current) return;
    const found = shares.shareContaining(current.shares, cwd);
    if (found) flush(current, found.share.key, found.subtree);
  }).catch((error) => warnOnChange("fileSync:flush", `File sync could not pick up changed files: ${messageOf(error)}`));
}

/** Someone opened the project: its shares are brought up to date, at most once per 30 s per project. */
export function fileSyncProjectOpened(projectId: string): void {
  const current = engine;
  if (!current || current.bridge.state !== "running") return;
  const now = Date.now();
  if (now - (projectOpenedAt.get(projectId) ?? -Infinity) < PROJECT_OPEN_INTERVAL_MS) return;
  projectOpenedAt.set(projectId, now);
  for (const share of current.shares) if (share.projectId === projectId) flush(current, share.key);
}

/* Status and the admin's actions (Settings → File sync). */

export interface FileSyncPeerStatus {
  nodeId: string;
  /** False while peer presence leaves the peer alone (it stopped answering). */
  present: boolean;
  /** null: not heard from since this node started; 0: the peer has no file sync engine. */
  protocol: number | null;
  /** fix (P4+P5): its engine can move a project to built-in sync (null: not heard from). */
  switchCapable: boolean | null;
  enabled: boolean | null;
  origins: string[];
  /** How the worker last reached it for any share. */
  route: "direct" | "relay" | "none";
  heardAt: string | null;
}

export interface FileSyncStatusAnswer {
  enabled: boolean;
  /** Turned off by an old setting while it holds synced projects: it keeps running for them. */
  leaving: boolean;
  worker: BridgeState | "starting" | "off";
  config: FileSyncConfig;
  /** Direct origins this node's worker listens on. */
  origins: string[];
  shares: ShareStatus[];
  peers: FileSyncPeerStatus[];
  /** /files/* requests since the worker started: sent by route, served directly and through main's routes. Absent while the worker does not answer. */
  requests?: { sent: RequestStats["sent"]; served: RequestStats["served"] & { relay: number } };
  /** auto-transition: the project whose first index runs now (one at a time), and its place among the projects compared here. */
  indexing: IndexingStatus | null;
}

const STATS_TIMEOUT_MS = 2_000;

function peerStatuses(current: Engine, shares: readonly ShareStatus[]): FileSyncPeerStatus[] {
  const routes = new Map<string, "direct" | "relay" | "none">();
  for (const share of shares) for (const peer of share.peers ?? []) {
    const held = routes.get(peer.peer);
    if (peer.route === "direct" || !held || held === "none") routes.set(peer.peer, peer.route ?? "none");
  }
  // Peers that share a folder with this node; configure also lists the others, only so their signatures verify.
  const ids = new Set([...current.shares.flatMap((share) => share.peers), ...routes.keys()]);
  return [...ids].sort().map((nodeId) => {
    const known = peerFileSync(nodeId);
    return {
      nodeId, present: !peerAway(nodeId), protocol: known?.protocol ?? null, switchCapable: known ? known.protocol >= FILE_SYNC_SWITCH_PROTOCOL : null, enabled: known?.enabled ?? null,
      origins: known?.origins ?? [], route: routes.get(nodeId) ?? "none", heardAt: known ? new Date(known.at).toISOString() : null,
    };
  });
}

export async function fileSyncStatus(): Promise<FileSyncStatusAnswer> {
  const config = readFileSyncConfig(await controlDatabase());
  const current = engine;
  // cutover-engine (P5): each share carries its project's engine, so a builtin share tells from a shadow one.
  const shares = current ? withEngines(statuses.list(current.shares)) : [];
  // The counters live in the worker's network layer; a busy or restarting worker leaves them out rather than holding up the page.
  const stats = current?.bridge.state === "running" ? await current.bridge.call("stats", {}, { timeoutMs: STATS_TIMEOUT_MS }).catch(() => undefined) : undefined;
  return {
    enabled: config.enabled, leaving: !config.enabled && Boolean(current), worker: current?.bridge.state ?? (starting ? "starting" : "off"), config,
    origins: current?.origins ?? [], shares, peers: current ? peerStatuses(current, shares) : [],
    ...(stats?.requests && current ? { requests: { sent: stats.requests.sent, served: { direct: stats.requests.served.direct, relay: current.bridge.served } } } : {}),
    indexing: current?.queue.status() ?? null,
  };
}

/** A request the admin made that cannot be carried out; `status` is the HTTP answer. */
export class FileSyncRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export class FileSyncConfigError extends FileSyncRequestError {}

function runningEngine(): Engine {
  const current = engine;
  if (!current) throw new FileSyncRequestError(503, starting ? "File sync is starting on this node" : "File sync is off on this node");
  if (current.bridge.state !== "running") throw new FileSyncRequestError(503, current.bridge.state === "failed" ? "File sync stopped after repeated failures; save it as on again to retry" : "File sync is restarting on this node");
  return current;
}

function derivedShare(current: Engine, share: string, peer?: string): ShareSpec {
  try { parseShareKey(share); } catch { throw new FileSyncRequestError(400, "Invalid share"); }
  const spec = current.shares.find((candidate) => candidate.key === share);
  if (!spec) throw new FileSyncRequestError(404, "This node does not sync that folder");
  if (peer !== undefined && !spec.peers.includes(peer)) throw new FileSyncRequestError(404, "That machine does not sync this folder with this node");
  return spec;
}

/** The worker's error codes as HTTP answers: "invalid" 400, "unavailable" 503, a share it does not hold 404. */
async function adminCall<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === "invalid") throw new FileSyncRequestError(400, messageOf(error));
    if (code === "unavailable") throw new FileSyncRequestError(503, messageOf(error));
    if (/share not found/i.test(messageOf(error))) throw new FileSyncRequestError(404, "This node does not sync that folder");
    throw error;
  }
}

export async function fileSyncDifferences(share: string, peer: string, offset: number, limit: number): Promise<ListPage<DifferenceItem>> {
  const current = runningEngine();
  derivedShare(current, share, peer);
  return adminCall(() => current.bridge.call("differences", { share, peer, offset, limit }));
}

export async function fileSyncErrors(share: string, offset: number, limit: number): Promise<ListPage<ErrorItem>> {
  const current = runningEngine();
  derivedShare(current, share);
  return adminCall(() => current.bridge.call("errors", { share, offset, limit }));
}

/** Drops what this node stored about the peer's index for the share and pulls it again in full. */
export async function fileSyncRepair(share: string, peer: string): Promise<void> {
  const current = runningEngine();
  derivedShare(current, share, peer);
  await adminCall(() => current.bridge.call("repair", { share, peer }, { timeoutMs: FLUSH_TIMEOUT_MS }));
}

/** The admin confirms that a folder which looks replaced is the one to sync. */
export async function fileSyncConfirmReplaced(share: string): Promise<ScanResult> {
  const current = runningEngine();
  derivedShare(current, share);
  return adminCall(() => current.bridge.call("confirmReplacedRoot", { share }, { timeoutMs: FLUSH_TIMEOUT_MS }));
}

/** Settings → File sync. Takes effect at once: enabling starts the worker (once startup has reached cluster work), disabling stops it. */
export async function applyFileSyncConfig(patch: FileSyncConfigPatch): Promise<FileSyncStatusAnswer> {
  const db = await controlDatabase();
  const held = readFileSyncConfig(db);
  // Saving the switch would change nothing while the environment overrides it; say so instead.
  if (patch.enabled !== undefined && held.enabledBy === "environment" && patch.enabled !== held.enabled) {
    throw new FileSyncConfigError(409, `JOINT_BOB_FILE_SYNC=${held.enabled ? 1 : 0} keeps file sync ${held.enabled ? "on" : "off"} on this node; change it in the service's environment`);
  }
  const wanted = Array.isArray(patch.shadowProjects) ? [...new Set(patch.shadowProjects)].sort() : patch.shadowProjects;
  if (wanted !== undefined && held.shadowProjectsBy === "environment" && JSON.stringify(wanted) !== JSON.stringify(held.shadowProjects)) {
    throw new FileSyncConfigError(409, "JOINT_BOB_FILE_SYNC_PROJECTS sets which projects file sync checks on this node; change it in the service's environment");
  }
  const config = writeFileSyncConfig(db, patch);
  // A node that holds synced projects keeps its engine running for them.
  if (!config.enabled && !holdsEngineProjects(db)) await stopFileSync();
  else if (scope) {
    await neutral(ensureRunning);
    // Saving the switch again is how an admin retries a worker that kept crashing.
    if (engine?.bridge.state === "failed") neutral(() => engine?.bridge.start());
    if (engine && (patch.shadowProjects !== undefined || patch.enabled !== undefined)) await derive(engine);
  }
  // fix: peers hear of the switch now, not at this node's next return.
  if (patch.enabled !== undefined && config.enabled !== held.enabled) void announceSwitch();
  return fileSyncStatus();
}

/* Tests only: a project's node-local phase set directly, without the switch (P5) and its bootstrap, so
   two real nodes can run the engine in builtin mode. Present only under NODE_ENV=test with
   JOINT_BOB_FILE_SYNC_TEST_PHASES=1; admin-routes.ts registers its route under the same condition. */

export function fileSyncTestPhasesEnabled(): boolean {
  return process.env.NODE_ENV === "test" && process.env.JOINT_BOB_FILE_SYNC_TEST_PHASES === "1";
}

export async function fileSyncTestPhase(projectId: string, phase: Phase): Promise<FileSyncStatusAnswer> {
  if (!fileSyncTestPhasesEnabled()) throw new FileSyncRequestError(404, "Not found");
  const current = runningEngine();
  setPhase(current.db, projectId, phase);
  // At once rather than on the next 2 s pass: the answer's statuses then belong to the new phase's configure.
  await derive(current);
  await push(current);
  return fileSyncStatus();
}

/* ---- taking projects over (adoption.ts): the machine that brings each shared project onto built-in
   sync on this node, and what Settings → File sync lists. ---- */

let adoption: { engine: Engine; machine: Adoption } | undefined;
let adoptionModule: Promise<typeof import("./adoption.js")> | undefined;
function loadAdoption(): Promise<typeof import("./adoption.js")> { return adoptionModule ??= import("./adoption.js"); }

function adoptionEngine(current: Engine | undefined): AdoptionEngine {
  const live = (): boolean => Boolean(current && engine === current);
  const specs = (projectId: string): ShareSpec[] => live() ? current!.shares.filter((share) => share.projectId === projectId) : [];
  return {
    running: () => live() && current!.bridge.state === "running" && current!.sent !== undefined,
    apply: async () => {
      if (!live()) return false;
      try { await derive(current!); } catch (error) {
        warnOnChange("fileSync:derive", `File sync could not work out which folders to sync: ${messageOf(error)}`);
        return false;
      }
      await push(current!);
      if (!live()) return false;
      // No worker runs to hold an older state: the next one starts from this desired state.
      if (current!.bridge.state !== "running") return true;
      return current!.desired !== undefined && current!.sent === JSON.stringify(current!.desired);
    },
    specs,
    statuses: (projectId) => statuses.list(specs(projectId)),
    call: (op, args, options) => {
      if (!live() || current!.bridge.state !== "running") return Promise.reject(Object.assign(new Error("File sync is not running on this node"), { code: "not-running" }));
      return neutral(() => current!.bridge.call(op, args, options));
    },
    nudge: (peer) => fileSyncPeerPresent(peer, true),
  };
}

/** File sync was turned on or off here: every peer gets this node's hello again. */
async function announceSwitch(): Promise<void> {
  try { await (await import("../server/peer-return.js")).helloPeers(); }
  catch (error) { warnOnChange("fileSync:hello", `File sync could not tell the other machines it was turned ${readFileSyncConfig(await controlDatabase()).enabled ? "on" : "off"}: ${messageOf(error)}`); }
}

/** Whether this machine's Syncthing has let go of Joint Bob's folders (syncthing-retirement.ts); one request at a time. */
let releasing: Promise<boolean> | undefined;
const RETIRE_BOOT_GRACE_MS = 3 * 60_000, RETIRE_ASK_MS = 10 * 60_000, RETIRE_ASKS = 6;
let retireAsks = 0;
function syncthingReleased(db: DatabaseSync): Promise<boolean> {
  // A test node must never reach for the Syncthing of the machine the tests run on.
  if (process.env.NODE_ENV === "test" || fileSyncTestPhasesEnabled()) return Promise.resolve(true);
  return releasing ??= (async () => {
    try {
      const [{ retireSyncthing }, { legacySyncthingConnection }] = await Promise.all([import("./syncthing-retirement.js"), import("../settings.js")]);
      const outcome = await retireSyncthing({ db, stored: legacySyncthingConnection });
      if (outcome !== "idle") return outcome === "done";
      // No Syncthing answers. Right after a boot it may only be starting, beside this node: projects wait a few minutes
      // for it. After that nothing writes their folders, and it is asked again a few times in case it starts later.
      if (retireAsks < RETIRE_ASKS) {
        retireAsks++;
        const timer = setTimeout(() => { void syncthingReleased(db).then(() => adoptionKick()); }, RETIRE_ASK_MS);
        timer.unref();
      }
      return process.uptime() * 1000 > RETIRE_BOOT_GRACE_MS;
    } catch (error) {
      warnOnChange("fileSync:retire", `Joint Bob could not take its folders out of this machine's Syncthing: ${messageOf(error)}`);
      return false;
    }
  })().finally(() => { releasing = undefined; });
}

function startAdoption(current: Engine): void {
  // Tests that set phases directly (JOINT_BOB_FILE_SYNC_TEST_PHASES) drive them without the machine.
  if (fileSyncTestPhasesEnabled()) return;
  void (async () => {
    try {
      const module = await loadAdoption();
      if (engine !== current) return;
      adoption?.machine.stop();
      const machine = new module.Adoption({ db: current.db, nodeId: current.nodeId, engine: adoptionEngine(current), released: () => syncthingReleased(current.db), log: warnOnChange });
      adoption = { engine: current, machine };
      // Also where nothing waits to be taken over: the folders an older release gave Syncthing leave it once.
      void syncthingReleased(current.db);
      neutral(() => machine.kick());
    } catch (error) {
      warnOnChange("fileSync:adopt", `File sync could not go on taking over this machine's shared projects: ${messageOf(error)}`);
    }
  })();
}

function adoptionKick(): void {
  const held = adoption;
  if (held && held.engine === engine) neutral(() => held.machine.kick());
}

/** The running machine, or a stand-in while file sync is off or starting here: it lists and takes nothing over. */
async function adoptionMachine(): Promise<Adoption> {
  const current = engine;
  if (current && adoption?.engine === current) return adoption.machine;
  const module = await loadAdoption();
  const db = current?.db ?? await controlDatabase();
  const nodeId = current?.nodeId ?? (await (await load()).cluster.getClusterNode()).id;
  return new module.Adoption({ db, nodeId, engine: adoptionEngine(undefined), log: warnOnChange });
}

function withEngines(shares: ShareStatus[]): ShareStatus[] {
  return shares.map((share) => ({ ...share, engine: "builtin" as const }));
}

/** Every project shared with another machine, and whether this node has taken it over yet. */
export async function fileSyncProjects(): Promise<{ projects: FileSyncProject[] }> {
  return { projects: (await adoptionMachine()).projects() };
}

/* ---- app-integration (P4): what the facade (facade.ts) asks of the running engine for projects on
   built-in sync. Status comes from main's in-memory reports; the calls that reach the worker are
   bounded, and none reaches the network. ---- */

/** A manual rescan of a large folder can take minutes: the request waits this long, the walk goes on. */
const RESCAN_WAIT_MS = 60_000;
const RESCAN_TIMEOUT_MS = 30 * 60_000;

/** `share\npeer` → when a pull from that peer was seen to complete since this node last started or woke (worktree sweeps, design §6.5). */
const pulled = new Map<string, number>();

/** A pull always ends with a report: one whose cursor for a peer moved and is caught up means a pull from it completed. */
function notePulls(next: ShareStatus): void {
  const previous = statuses.get(next.share);
  if (!previous) return;
  for (const peer of next.peers ?? []) {
    const before = previous.peers?.find((candidate) => candidate.peer === peer.peer);
    if (peer.caughtUp && before && (peer.cursor !== before.cursor || peer.peerIndexId !== before.peerIndexId)) pulled.set(`${next.share}\n${peer.peer}`, Date.now());
  }
}

/** Whether a pull of the share from `peer` completed since this node last started or woke. */
export function fileSyncPulledSinceStart(share: string, peer: string): boolean {
  return pulled.has(`${share}\n${peer}`);
}

export interface FileSyncProjectView {
  worker: BridgeState | "starting" | "off";
  enabled: boolean;
  /** The project's derived shares with the worker's last report (one not reported yet reads as starting). */
  shares: ShareStatus[];
  /** Eligible peers of each share right now. */
  peers: Partial<Record<ShareKind, string[]>>;
}

/** No worker call: what main last heard, per project. */
export async function fileSyncProjectViews(projectIds: readonly string[]): Promise<Map<string, FileSyncProjectView>> {
  let enabled = false;
  try { enabled = readFileSyncConfig(await controlDatabase()).enabled; } catch { /* unknown counts as off */ }
  const current = engine;
  const worker = current?.bridge.state ?? (starting ? "starting" : "off");
  const phases = current ? listPhases(current.db) : new Map<string, { phase: Phase }>();
  return new Map(projectIds.map((projectId) => {
    const specs = current ? current.shares.filter((share) => share.projectId === projectId) : [];
    return [projectId, { worker, enabled, shares: statuses.list(specs), peers: Object.fromEntries(specs.map((spec) => [spec.kind, [...spec.peers]])) }];
  }));
}

export interface FileSyncPeerFacts {
  name: string;
  /** False while peer presence leaves the peer alone. */
  present: boolean;
  /** What it said about its engine since this node started (0: none); absent until it said anything. */
  protocol?: number;
  enabled?: boolean;
}

/** Names, presence and engine of peers for status texts; ids stand in for names this node cannot look up. */
export async function fileSyncPeerFacts(peers: Iterable<string>): Promise<{ local: string; peers: Map<string, FileSyncPeerFacts> }> {
  let local = "this machine";
  let names = new Map<string, string>();
  try {
    const [{ getClusterNode }, { replicationPeers }] = await Promise.all([import("../cluster.js"), import("../server/replication-v2.js")]);
    const node = await getClusterNode();
    local = node.name || local;
    names = new Map(replicationPeers(engine?.db ?? await controlDatabase(), node.id).map((peer) => [peer.nodeId, peer.name]));
  } catch { /* names are only for texts */ }
  return {
    local,
    peers: new Map([...new Set(peers)].map((peer) => {
      const known = peerFileSync(peer);
      return [peer, { name: names.get(peer) || peer, present: !peerAway(peer), ...(known ? { protocol: known.protocol } : {}), ...(known?.enabled !== undefined ? { enabled: known.enabled } : {}) }];
    })),
  };
}

function reportedShares(current: Engine, projectId: string, kinds?: readonly ShareKind[]): ShareSpec[] {
  // A share the worker has not reported yet waits for its first configure, whose full scan covers everything.
  return current.shares.filter((share) => share.projectId === projectId && (!kinds || kinds.includes(share.kind)) && statuses.get(share.key));
}

function configuredEngine(): Engine {
  const current = runningEngine();
  if (current.sent === undefined) throw new FileSyncRequestError(503, "File sync is restarting on this node");
  return current;
}

/**
 * "Rescan files": a full walk of each of the project's shares; the scan op's "manual" reason also
 * gives blocked items another try. Waits a minute at most; a longer walk goes on and the status says
 * "Checking files" meanwhile. Returns the walks that finished, with the error of any that failed.
 */
export async function fileSyncRescanProject(projectId: string): Promise<Array<{ kind: ShareKind; error?: string }>> {
  const current = configuredEngine();
  const scans = reportedShares(current, projectId).map((spec) => neutral(() => current.bridge.call("scan", { share: spec.key, scope: "full", reason: "manual" }, { timeoutMs: RESCAN_TIMEOUT_MS }))
    .then((result) => ({ kind: spec.kind, ...(result.error ? { error: result.error } : {}) }), (error) => ({ kind: spec.kind, error: messageOf(error) })));
  let timer: NodeJS.Timeout | undefined;
  const waited = new Promise<undefined>((resolve) => { const wait = setTimeout(() => resolve(undefined), RESCAN_WAIT_MS); wait.unref(); timer = wait; });
  const finished = await Promise.race([Promise.all(scans), waited]);
  clearTimeout(timer);
  return finished ?? [];
}

/**
 * A write the app made itself (a worktree's metadata, a worktree created or deleted) is scanned now,
 * so peers hear of it after the commit instead of the watcher's debounce. Absolute paths; with none
 * inside the share, what the watcher holds is flushed instead.
 */
export function fileSyncScanPaths(projectId: string, kind: ShareKind, paths: readonly string[]): void {
  const current = engine;
  if (!current || current.bridge.state !== "running" || current.sent === undefined) return;
  const [spec] = reportedShares(current, projectId, [kind]);
  if (!spec) return;
  const root = path.resolve(spec.root);
  const relative = [...new Set(paths.map((target) => path.relative(root, path.resolve(target)))
    .filter((candidate) => candidate && !candidate.startsWith("..") && !path.isAbsolute(candidate))
    .map((candidate) => candidate.split(path.sep).join("/")))];
  if (!relative.length) { flush(current, spec.key); return; }
  neutral(() => current.bridge.call("scan", { share: spec.key, scope: { paths: relative }, reason: "app" }))
    .then(() => settled("fileSync:scanPaths"), (error) => warnOnChange("fileSync:scanPaths", `File sync could not pick up changed files: ${messageOf(error)}`));
}

const PENDING_TIMEOUT_MS = 2_000;

/**
 * fix (P4+P5): need rows of the project's share of `kind` under `prefix` (a worktree): what can arrive
 * now from `availablePeers` or a local copy, and what only other peers have. Undefined when the share
 * is not reported yet; rejects when the worker does not answer in time.
 */
export async function fileSyncPendingFiles(projectId: string, kind: ShareKind, prefix: string, availablePeers: readonly string[], peek = false): Promise<PendingFiles | undefined> {
  const current = configuredEngine();
  const [spec] = reportedShares(current, projectId, [kind]);
  if (!spec) return undefined;
  return neutral(() => current.bridge.call("pending", { share: spec.key, prefix, availablePeers: [...availablePeers], ...(peek ? { peek: true } : {}) }, { timeoutMs: PENDING_TIMEOUT_MS }));
}

/** Need rows of the share under `prefix` go first until `untilMs` (a merge waiting on a worktree's files). */
export function fileSyncPrioritize(projectId: string, kind: ShareKind, prefix: string | undefined, untilMs: number): void {
  const current = engine;
  if (!current || current.bridge.state !== "running" || current.sent === undefined) return;
  const [spec] = reportedShares(current, projectId, [kind]);
  if (!spec) return;
  neutral(() => current.bridge.call("prioritize", { share: spec.key, ...(prefix ? { prefix } : {}), untilMs }))
    .then(() => settled("fileSync:prioritize"), quietly("fileSync:prioritize", "File sync could not move files up its queue"));
}

