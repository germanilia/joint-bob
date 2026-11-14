// The retention sweep: what this machine deletes on its own, by age.
//
// The owner chooses how far it reaches (the `conversationRetentionScope` setting, five boxes, all
// off until ticked). With every box off it deletes what it always did: conversations idle past the
// retention setting, and empty ones, among those a project's list shows. The list shows 50
// conversations per project, so anything outside that window is never reached.
//
//   full            every conversation on record in a project, with the exemptions: pinned;
//                   running, open or with work unfinished; an assistant's conversation; the
//                   conversation a scheduled task or webhook writes into. Never a conversation
//                   another machine owns, anything outside every project, or Kiro's own files.
//   includeUnrecorded   with full: transcripts that have no record, inside a current project's folders.
//   includeScheduled    with full: conversations a scheduled task or webhook made, one per run.
//   leftovers       what deletes made before the complete delete existed left on this machine:
//                   they are put in the queue of unfinished deletes. Without the box only that
//                   queue is worked off: deletes made or received by this release that did not finish.
//   backgroundRuns  Joint Bob's own background runs, seven days after their last activity. They
//                   are never listed and nobody opens them; the one exception is a side chat's
//                   agent, kept while its side chat exists.
//
// With the owner's backup setting on (`conversationBackup`), a conversation that goes for its age,
// and what an earlier delete left behind, is written to the backup destination first
// (conversation-backup.ts). One that cannot be backed up stays, and so does every other one of that
// pass: a destination that refuses one backup would refuse them all. Background runs and empty
// conversations are not backed up. Backups older than the setting's days are removed at the end of
// every sweep.
//
// Only the machine that owns a conversation deletes it; the tombstone makes the others follow.
// Every candidate is checked again right before it goes (mayDeleteNow), and the dry run applies
// the same checks without deleting, so it reports what a sweep would delete at that moment.
import path from "node:path";
import { readActiveBackgroundTaskIdentities, backgroundTaskConversationId } from "../background-tasks.js";
import { listByTheWaySessionIds } from "../by-the-way-leases.js";
import { getClusterNode } from "../cluster.js";
import { conversationForgotten, forgetConversationRows, forgottenConversations } from "../conversation-forget.js";
import { getConversationOwnership, type ConversationEngine } from "../conversation-ownership.js";
import { listConversationRecords, type ConversationRecord } from "../conversation-records.js";
import { EMPTY_CONVERSATION_GRACE_MS, retentionReason, type ConversationRetentionScope } from "../conversation-retention.js";
import { conversationLeaseRunning } from "../conversation-runtime.js";
import { conversationWorkActive } from "../conversation-work.js";
import { resolveDataDirectory } from "../data-directory.js";
import { listHarnesses, listHarnessSessions } from "../harnesses.js";
import { sessionCwds, type SessionProjectPaths } from "../harnesses/shared-paths.js";
import { isInternalSession } from "../internal-sessions.js";
import { allPinnedSessionPaths, starredConversationKeys } from "../preferences.js";
import { withProjectRuntime } from "../project-runtime.js";
import { listQueuedPrompts } from "../prompt-queue.js";
import { getSettings } from "../settings.js";
import { listProjects } from "../store.js";
import type { ProjectRecord } from "../types.js";
import { pinnedConversationKeys } from "../user-pins.js";
import { ConversationBackups, conversationBackupStatus, noteBackupProblem, removeExpiredBackups, type BackupStatus } from "./conversation-backup.js";
import { finishAllPendingDeletes, heldBack, queueLeftovers, retentionDatabase, type ConversationSegment, type FilesByHarness } from "./conversation-delete.js";
import { harnessFiles, measureSessionFiles, removeSessionFiles, type HarnessFiles, type SessionFiles } from "./conversation-files.js";
import { findHarnessSession, harnessSessionBusy } from "./harness-sessions.js";
import { assertProjectEditable } from "./projects.js";
import { deleteOwnedConversation } from "./routes/sessions.js";
import { projectAdditionalPaths } from "./session-scope.js";

const DAY_MS = 86_400_000;
/** Joint Bob's own background runs are removed this long after their last activity. */
export const BACKGROUND_RUN_RETENTION_MS = 7 * DAY_MS;
/** Conversations one pass deletes at most; the rest wait for the next hourly pass. A wrong clock cannot empty a machine in one go. */
export const SWEEP_PASS_LIMIT = 500;
/** Background runs one pass removes at most. */
export const BACKGROUND_PASS_LIMIT = 2_000;
/** The sweep lets other work run after every conversation and pauses after this many. */
const BATCH = 25;
const BATCH_PAUSE_MS = 200;
/** How old a reading of the harness folders may be when a delete relies on it. */
const READING_MAX_AGE_MS = 10_000;

/** The owner's five boxes (ConversationRetentionScope in ../conversation-retention.ts). */
export type RetentionSwitches = ConversationRetentionScope;

/** The boxes the hourly sweep runs with: the machine's saved setting. A box that depends on `full` counts only with it. */
export function retentionSwitches(): RetentionSwitches {
  return effective(getSettings().conversationRetentionScope);
}

function effective(scope: RetentionSwitches): RetentionSwitches {
  return { ...scope, includeUnrecorded: scope.full && scope.includeUnrecorded, includeScheduled: scope.full && scope.includeScheduled };
}

/** `held`: deleted here before the complete delete existed, with a transcript still on this machine. Counted, never removed (heldBack in conversation-delete.ts). */
export type RetentionCategory = "expired" | "empty" | "background" | "leftover" | "held";

interface Candidate {
  category: RetentionCategory;
  project?: ProjectRecord;
  engine: ConversationEngine;
  sessionId: string;
  conversationId: string;
  segments: ConversationSegment[];
  /** Keys a pin can name this conversation by. */
  pinKeys: string[];
  /** Found without a record. */
  unrecorded?: boolean;
  /** Chosen from the list, by the time of its last message. The others are chosen by the time their files were last written. */
  listed?: boolean;
  /** The harness folder the files lie under, for a background run or a leftover. */
  root?: string;
}

export interface RetentionCount { conversations: number; files: number; bytes: number }
export interface RetentionPreview {
  generatedAt: string;
  switches: RetentionSwitches;
  retentionDays: number;
  /** What a sweep started now would delete, in all its passes together. `held` is the exception: counted, and left alone. */
  totals: Record<RetentionCategory, RetentionCount>;
  projects: Array<{ projectId: string; name: string; expired: RetentionCount; empty: RetentionCount }>;
  /** With `full`: conversations of this machine's projects that are old enough and stay, by the reason they stay. */
  kept: Record<string, number>;
  passLimit: number;
  /** Where an expired conversation and a leftover are backed up before they go, and what is kept there now. */
  backup: BackupStatus;
  /** `engine:sessionId` of everything counted above, by category. */
  conversations: Record<RetentionCategory, string[]>;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const pause = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms).unref(); });

/** The readings of the harness folders, one per folder, shared by the projects that use it. */
class Readings {
  private readonly held = new Map<string, { at: number; files: Promise<HarnessFiles> }>();

  /** The harness folders as the project's agents see them, read again when older than `maxAgeMs`. */
  forProject(projectId: string, maxAgeMs = Number.POSITIVE_INFINITY): Promise<FilesByHarness> {
    return withProjectRuntime(projectId, async () => {
      const found: FilesByHarness = new Map();
      for (const adapter of listHarnesses()) {
        const key = `${adapter.id}\n${path.resolve(adapter.sync.transcriptRoot())}`;
        let reading = this.held.get(key);
        if (!reading || Date.now() - reading.at > maxAgeMs) {
          reading = { at: Date.now(), files: harnessFiles(adapter) };
          this.held.set(key, reading);
        }
        found.set(adapter.id, await reading.files);
      }
      return found;
    });
  }

  async all(): Promise<HarnessFiles[]> {
    return Promise.all([...this.held.values()].map((reading) => reading.files));
  }
}

function table(name: string): boolean {
  return retentionDatabase().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function ids(sql: string, tableName: string): string[] {
  if (!table(tableName)) return [];
  return (retentionDatabase().prepare(sql).all() as Array<{ id: unknown }>).map((row) => row.id).filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** Conversations that belong to an assistant: its own, its topics and its team conversations. */
function assistantConversations(): Set<string> {
  return new Set([
    ...ids("SELECT session_id AS id FROM personal_assistants", "personal_assistants"),
    ...ids("SELECT session_id AS id FROM personal_assistant_topics", "personal_assistant_topics"),
    ...ids("SELECT conversation_id AS id FROM assistant_team_conversations", "assistant_team_conversations"),
  ]);
}

/** Conversations an existing scheduled task or webhook writes into every time it runs. */
function automationTargets(): Set<string> {
  return new Set([
    ...ids("SELECT json_extract(input, '$.sessionId') AS id FROM cron_tasks", "cron_tasks"),
    ...ids("SELECT session_id AS id FROM webhooks", "webhooks"),
  ]);
}

/** Background runs a side chat still resumes: its state names the agent's session. */
function sideChatAgents(): Set<string> {
  const agents = new Set<string>();
  if (!table("transcript_summaries")) return agents;
  for (const row of retentionDatabase().prepare("SELECT payload FROM transcript_summaries WHERE kind = 'conversation-chat'").all() as Array<{ payload: string }>) {
    try {
      const sessionId = (JSON.parse(row.payload) as { agent?: { sessionId?: unknown } }).agent?.sessionId;
      if (typeof sessionId === "string") agents.add(sessionId);
    } catch { /* a state that cannot be read names no agent */ }
  }
  return agents;
}

function pendingRecovery(sessionIds: string[]): boolean {
  if (!table("update_recoveries")) return false;
  return retentionDatabase().prepare("SELECT 1 FROM update_recoveries WHERE status = 'pending' AND session_id IN (SELECT value FROM json_each(?)) LIMIT 1").get(JSON.stringify(sessionIds)) !== undefined;
}

function conversationsWithActiveTasks(): Set<string> {
  try { return new Set([...readActiveBackgroundTaskIdentities(resolveDataDirectory())].map(backgroundTaskConversationId)); }
  catch (error) { console.warn("Background tasks could not be read for the retention sweep", error); return new Set(); }
}

function pinKeysOf(engine: string, conversationId: string, segments: ConversationSegment[], files: FilesByHarness): string[] {
  return [
    `${engine}:${conversationId}`,
    ...segments.flatMap((segment) => [
      `${segment.engine}:${segment.sessionId}`,
      ...(files.get(segment.engine)?.sessions.get(segment.sessionId)?.transcripts ?? []).flatMap((file) => [file, `${segment.engine}:${file}`]),
    ]),
  ];
}

function hasTranscript(files: FilesByHarness, segment: ConversationSegment): boolean {
  return Boolean(files.get(segment.engine)?.sessions.get(segment.sessionId)?.transcripts.length);
}

/** When the newest of the conversation's transcripts was last written; 0 when it has none here. */
async function lastWritten(files: FilesByHarness, segments: ConversationSegment[], whole = false): Promise<number> {
  let newest = 0;
  for (const segment of segments) {
    const found = files.get(segment.engine)?.sessions.get(segment.sessionId);
    if (!found) continue;
    const measured = await measureSessionFiles(whole ? found : { transcripts: found.transcripts, leftovers: [], folders: [] });
    newest = Math.max(newest, measured.modifiedAt);
  }
  return newest;
}

interface Plan {
  now: number;
  cutoff: number;
  retentionDays: number;
  localId: string;
  switches: RetentionSwitches;
  readings: Readings;
  candidates: Candidate[];
  kept: Record<string, number>;
}

/** Today's reach: what the project's list shows, by the rule in conversation-retention.ts. */
async function listedCandidates(project: ProjectRecord, plan: Plan, pinned: Set<string>): Promise<void> {
  const records = new Map((await listConversationRecords(project.id)).map((record) => [`${record.engine}:${record.sessionId}`, record]));
  const temporary = await listByTheWaySessionIds(project.id);
  const sessions = await listHarnessSessions({ ...project, additionalPaths: await projectAdditionalPaths(project.id) });
  const ownership = new Map(await Promise.all(sessions.map(async (session) => [session, await getConversationOwnership(session.harnessId, session.id)] as const)));
  const files = await plan.readings.forProject(project.id);
  for (const session of sessions) {
    if (temporary.has(session.id)) continue;
    const reason = retentionReason(session, {
      now: plan.now, retentionDays: plan.retentionDays, pinned,
      ownedLocally: (candidate) => {
        const owner = ownership.get(candidate);
        if (owner) return owner.ownerNodeId === plan.localId;
        const record = records.get(`${candidate.harnessId}:${candidate.id}`);
        return record ? record.originNodeId === plan.localId : undefined;
      },
      hasQueuedPrompts: (candidate) => listQueuedPrompts(`${project.id}:${candidate.conversationId ?? candidate.id}`).length > 0,
    });
    if (!reason) continue;
    const segments: ConversationSegment[] = session.segments?.length
      ? session.segments.map((segment) => ({ engine: segment.engine, sessionId: segment.sessionId }))
      : [{ engine: session.harnessId, sessionId: session.id }];
    // A record is empty only when no transcript of the conversation exists anywhere under the harness
    // folders. One that lies in a folder the project does not list is shown as a draft, and is not empty.
    if (reason === "empty" && segments.some((segment) => hasTranscript(files, segment))) continue;
    plan.candidates.push({
      category: reason, project, engine: session.harnessId, sessionId: session.id, conversationId: session.conversationId ?? session.id, segments, listed: true,
      pinKeys: [...pinKeysOf(session.segments?.[0]?.engine ?? session.harnessId, session.conversationId ?? session.id, segments, files), session.path, ...(session.segments ?? []).map((segment) => segment.path)],
    });
  }
}

/** The full reach: every conversation on record in the project, with the exemptions. */
async function recordedCandidates(project: ProjectRecord, plan: Plan, pinned: Set<string>, assistants: Set<string>, targets: Set<string>): Promise<void> {
  const temporary = await listByTheWaySessionIds(project.id);
  const files = await plan.readings.forProject(project.id);
  const conversations = new Map<string, ConversationRecord[]>();
  for (const record of await listConversationRecords(project.id)) {
    // Background runs have their own rule, and a sub-agent's transcript goes with its parent.
    if (isInternalSession(record.sessionId) || record.sessionId.includes("/")) continue;
    const id = record.conversationId ?? record.sessionId;
    conversations.set(id, [...(conversations.get(id) ?? []), record]);
  }
  const keep = (reason: string): void => { plan.kept[reason] = (plan.kept[reason] ?? 0) + 1; };
  for (const [conversationId, unsorted] of conversations) {
    const records = unsorted.sort((left, right) => (left.segmentIndex ?? 0) - (right.segmentIndex ?? 0) || left.createdAt.localeCompare(right.createdAt));
    const segments = records.map((record) => ({ engine: record.engine, sessionId: record.sessionId }));
    const names = [conversationId, ...segments.map((segment) => segment.sessionId)];
    if (names.some((name) => temporary.has(name))) continue;
    const written = await lastWritten(files, segments);
    const empty = written === 0;
    const age = plan.now - (empty ? Math.max(...records.map((record) => Date.parse(record.updatedAt) || 0)) : written);
    if (empty ? age < EMPTY_CONVERSATION_GRACE_MS : written > plan.cutoff) continue;
    const pinKeys = pinKeysOf(records[0].engine, conversationId, segments, files);
    if (pinKeys.some((key) => pinned.has(key))) { keep("pinned"); continue; }
    let owned = true;
    for (const record of records) {
      const owner = await getConversationOwnership(record.engine, record.sessionId);
      if (owner ? owner.ownerNodeId !== plan.localId : record.originNodeId !== plan.localId) owned = false;
    }
    if (!owned) { keep("owned by another machine"); continue; }
    if (names.some((name) => assistants.has(name))) { keep("an assistant's conversation"); continue; }
    if (names.some((name) => targets.has(name))) { keep("the target of a scheduled task or webhook"); continue; }
    if (records.some((record) => record.cronTaskId || record.webhookHistory) && !plan.switches.includeScheduled) { keep("made by a scheduled task or webhook"); continue; }
    plan.candidates.push({ category: empty ? "empty" : "expired", project, engine: records[0].engine, sessionId: records[0].sessionId, conversationId, segments, pinKeys });
  }
}

/** With `includeUnrecorded`: old transcripts that have no record and lie in a current project's folders. */
async function unrecordedCandidates(projects: ProjectRecord[], plan: Plan, pinned: Set<string>, assistants: Set<string>, targets: Set<string>): Promise<void> {
  const db = retentionDatabase();
  const recorded = new Set<string>();
  for (const row of db.prepare("SELECT session_id, conversation_id FROM conversation_records").all() as Array<{ session_id: string; conversation_id: string | null }>) {
    recorded.add(row.session_id);
    if (row.conversation_id) recorded.add(row.conversation_id);
  }
  const keep = (reason: string): void => { plan.kept[reason] = (plan.kept[reason] ?? 0) + 1; };
  // One answer per transcript, whichever project asks: old enough or not, and the working directory it names.
  const old = new Map<string, boolean>(), named = new Map<string, string | null>(), placed = new Set<string>();
  for (const project of projects) {
    const scope: SessionProjectPaths = { ...project, additionalPaths: await projectAdditionalPaths(project.id) };
    const cwds = new Set(sessionCwds(scope));
    const files = await plan.readings.forProject(project.id);
    const temporary = await listByTheWaySessionIds(project.id);
    await withProjectRuntime(project.id, async () => {
      for (const adapter of listHarnesses()) {
        const harness = files.get(adapter.id), engine = adapter.id as ConversationEngine;
        if (!harness) continue;
        for (const [sessionId, found] of harness.sessions) {
          const key = `${harness.root}\n${sessionId}`;
          if (placed.has(key) || old.get(key) === false || !found.transcripts.length || recorded.has(sessionId) || temporary.has(sessionId) || isInternalSession(sessionId) || conversationForgotten(db, sessionId)) continue;
          const segments = [{ engine, sessionId }];
          if (!old.has(key)) { const written = await lastWritten(files, segments); old.set(key, written > 0 && written <= plan.cutoff); }
          if (!old.get(key)) continue;
          // Inside the project: by its folder for a harness that keeps one folder per working directory, else by the working directory its first line names.
          let inside = false;
          for (const file of found.transcripts) {
            if (adapter.sync.transcriptBelongs) { inside ||= adapter.sync.transcriptBelongs(scope, file); continue; }
            if (!named.has(file)) named.set(file, await adapter.sync.transcriptCwd?.(file).catch(() => null) ?? null);
            const cwd = named.get(file);
            inside ||= Boolean(cwd && cwds.has(path.resolve(cwd)));
          }
          if (!inside) continue;
          placed.add(key);
          const pinKeys = pinKeysOf(engine, sessionId, segments, files);
          if (pinKeys.some((pin) => pinned.has(pin))) { keep("pinned"); continue; }
          const owner = await getConversationOwnership(engine, sessionId);
          if (owner && owner.ownerNodeId !== plan.localId) { keep("owned by another machine"); continue; }
          if (assistants.has(sessionId)) { keep("an assistant's conversation"); continue; }
          if (targets.has(sessionId)) { keep("the target of a scheduled task or webhook"); continue; }
          plan.candidates.push({ category: "expired", project, engine, sessionId, conversationId: sessionId, segments, pinKeys, unrecorded: true });
        }
      }
    });
    await tick();
  }
}

/** Background runs past their seven days, and files of conversations that already have a tombstone. */
async function fileCandidates(plan: Plan): Promise<void> {
  const db = retentionDatabase();
  const resumed = sideChatAgents();
  const forgotten = new Map(forgottenConversations(db).map((row) => [`${row.engine}:${row.sessionId}`, row]));
  for (const harness of await plan.readings.all()) {
    for (const [sessionId, found] of harness.sessions) {
      const engine = harness.engine as ConversationEngine;
      const base = { engine, sessionId, conversationId: sessionId, segments: [{ engine, sessionId }], pinKeys: [], root: harness.root };
      const deleted = forgotten.get(`${engine}:${sessionId}`);
      if (deleted) {
        const held = heldBack(deleted, new Map([[engine, harness]]));
        // In the queue: an unfinished delete, finished whatever the boxes say. Not in it: left by an earlier delete, and taken only with the owner's box.
        if (held || deleted.pending || plan.switches.leftovers) plan.candidates.push({ ...base, category: held ? "held" : "leftover" });
        continue;
      }
      if (!plan.switches.backgroundRuns || !isInternalSession(sessionId) || resumed.has(sessionId)) continue;
      const measured = await measureSessionFiles(found);
      if (measured.files && plan.now - measured.modifiedAt >= BACKGROUND_RUN_RETENTION_MS) plan.candidates.push({ ...base, category: "background" });
    }
  }
}

async function buildPlan(now: number, given: RetentionSwitches): Promise<Plan> {
  const switches = effective(given);
  const local = await getClusterNode();
  const { conversationRetentionDays } = getSettings();
  const plan: Plan = { now, cutoff: now - conversationRetentionDays * DAY_MS, retentionDays: conversationRetentionDays, localId: local.id, switches, readings: new Readings(), candidates: [], kept: {} };
  const pinned = new Set([...pinnedConversationKeys(), ...starredConversationKeys(), ...allPinnedSessionPaths()]);
  const assistants = switches.full ? assistantConversations() : new Set<string>();
  const targets = switches.full ? automationTargets() : new Set<string>();
  const editable: ProjectRecord[] = [];
  for (const project of await listProjects()) {
    try { await assertProjectEditable(project); } catch { continue; }
    editable.push(project);
    try {
      if (switches.full) await recordedCandidates(project, plan, pinned, assistants, targets);
      else await listedCandidates(project, plan, pinned);
    } catch (error) { console.warn(`Could not read the conversations of ${project.name} for the retention sweep`, error); }
    await tick();
  }
  if (switches.full && switches.includeUnrecorded) await unrecordedCandidates(editable, plan, pinned, assistants, targets);
  // A machine with no project still has harness folders: the service's own are read for background runs.
  if (!editable.length) await plan.readings.forProject("");
  await fileCandidates(plan);
  return plan;
}

function filesOf(candidate: Candidate, files: FilesByHarness): SessionFiles[] {
  return candidate.segments.flatMap((segment) => { const found = files.get(segment.engine)?.sessions.get(segment.sessionId); return found ? [found] : []; });
}

/**
 * The checks made right before a conversation goes, on what is true at that moment: not pinned,
 * not open, no run on any machine, no unfinished background work, no waiting prompt, still owned
 * here, still idle. A candidate that fails one is left for a later pass.
 */
async function mayDeleteNow(candidate: Candidate, plan: Plan, files: FilesByHarness, active: Set<string>): Promise<boolean> {
  const project = candidate.project!;
  const pinned = new Set([...pinnedConversationKeys(), ...starredConversationKeys(), ...allPinnedSessionPaths()]);
  if (candidate.pinKeys.some((key) => pinned.has(key))) return false;
  const names = [candidate.conversationId, ...candidate.segments.map((segment) => segment.sessionId)];
  for (const segment of candidate.segments) {
    const open = findHarnessSession(project.id, segment.engine, segment.sessionId);
    if (open && (open.clients.size || harnessSessionBusy(open))) return false;
    if (conversationLeaseRunning(segment.engine, segment.sessionId) || conversationWorkActive(segment.engine, segment.sessionId)) return false;
    const owner = await getConversationOwnership(segment.engine, segment.sessionId);
    if (owner && (owner.ownerNodeId !== plan.localId || owner.status !== "owned")) return false;
  }
  if (names.some((name) => active.has(name)) || pendingRecovery(names)) return false;
  const queued = listQueuedPrompts(`${project.id}:${candidate.conversationId}`);
  // An empty conversation with a prompt waiting is about to start. An old one keeps a prompt that was queued since the cutoff.
  if (candidate.category === "empty" ? queued.length > 0 : queued.some((prompt) => !(Date.parse(prompt.createdAt) <= plan.cutoff))) return false;
  if (candidate.category === "empty") return !candidate.segments.some((segment) => hasTranscript(files, segment));
  // Chosen by its files: nothing of it, a sub-agent's transcript included, was written since the cutoff.
  return candidate.listed || await lastWritten(files, candidate.segments, true) <= plan.cutoff;
}

/** Whether a background run or a leftover may still go: nothing runs in it, it has no record, and a background run is still idle. */
async function mayRemoveFilesNow(candidate: Candidate, plan: Plan, found: SessionFiles): Promise<boolean> {
  const db = retentionDatabase();
  if (candidate.category === "leftover") return conversationForgotten(db, candidate.sessionId);
  if (db.prepare("SELECT 1 FROM conversation_records WHERE session_id = ? OR conversation_id = ? LIMIT 1").get(candidate.sessionId, candidate.sessionId)) return false;
  if (sideChatAgents().has(candidate.sessionId)) return false;
  if (conversationLeaseRunning(candidate.engine, candidate.sessionId) || conversationWorkActive(candidate.engine, candidate.sessionId)) return false;
  const measured = await measureSessionFiles(found);
  return measured.files > 0 && plan.now - measured.modifiedAt >= BACKGROUND_RUN_RETENTION_MS;
}

async function countOf(candidate: Candidate, files: SessionFiles[]): Promise<RetentionCount> {
  const count: RetentionCount = { conversations: 1, files: 0, bytes: 0 };
  for (const found of files) { const measured = await measureSessionFiles(found); count.files += measured.files; count.bytes += measured.bytes; }
  return count;
}

function add(total: RetentionCount, count: RetentionCount): void {
  total.conversations += count.conversations; total.files += count.files; total.bytes += count.bytes;
}

const zero = (): RetentionCount => ({ conversations: 0, files: 0, bytes: 0 });

async function harnessOf(plan: Plan, candidate: Candidate): Promise<SessionFiles | undefined> {
  return (await plan.readings.all()).find((harness) => harness.engine === candidate.engine && harness.root === candidate.root)?.sessions.get(candidate.sessionId);
}

/**
 * What a sweep with these switches would delete now, without changing anything: counts and bytes
 * per kind and per project, and the conversations themselves. The same choices and the same last
 * checks as the sweep; the sweep spreads the work over passes of `passLimit`.
 */
export async function previewConversationRetention(switches: RetentionSwitches = retentionSwitches(), now = Date.now()): Promise<RetentionPreview> {
  const plan = await buildPlan(now, switches);
  const active = conversationsWithActiveTasks();
  const preview: RetentionPreview = {
    generatedAt: new Date(now).toISOString(), switches: plan.switches, retentionDays: plan.retentionDays,
    totals: { expired: zero(), empty: zero(), background: zero(), leftover: zero(), held: zero() }, projects: [], kept: plan.kept, passLimit: SWEEP_PASS_LIMIT,
    backup: await conversationBackupStatus(),
    conversations: { expired: [], empty: [], background: [], leftover: [], held: [] },
  };
  const projects = new Map<string, RetentionPreview["projects"][number]>();
  for (const candidate of plan.candidates) {
    let count: RetentionCount;
    if (candidate.project) {
      const files = await plan.readings.forProject(candidate.project.id);
      if (!await mayDeleteNow(candidate, plan, files, active)) { plan.kept["running, open or waiting"] = (plan.kept["running, open or waiting"] ?? 0) + 1; continue; }
      count = await countOf(candidate, filesOf(candidate, files));
      let project = projects.get(candidate.project.id);
      if (!project) projects.set(candidate.project.id, project = { projectId: candidate.project.id, name: candidate.project.name, expired: zero(), empty: zero() });
      add(project[candidate.category as "expired" | "empty"], count);
    } else {
      const found = await harnessOf(plan, candidate);
      if (!found || (candidate.category !== "held" && !await mayRemoveFilesNow(candidate, plan, found))) continue;
      count = await countOf(candidate, [found]);
    }
    add(preview.totals[candidate.category], count);
    preview.conversations[candidate.category].push(`${candidate.engine}:${candidate.sessionId}`);
    await tick();
  }
  preview.projects = [...projects.values()].sort((left, right) => right.expired.bytes + right.empty.bytes - left.expired.bytes - left.empty.bytes);
  return preview;
}

let activeSweep: Promise<number> | undefined;

/**
 * Deletes this node's empty conversations and those idle past the retention setting, removes old
 * background runs and what earlier deletes left. Returns how many conversations went.
 */
export function sweepConversationRetention(now = Date.now(), switches: RetentionSwitches = retentionSwitches()): Promise<number> {
  activeSweep ??= runSweep(now, switches).finally(() => { activeSweep = undefined; });
  return activeSweep;
}

async function runSweep(now: number, switches: RetentionSwitches): Promise<number> {
  try { return await deleteByAge(now, switches); }
  finally {
    // Backups that are past the owner's days go, whatever else this sweep did.
    await removeExpiredBackups(now).catch((error) => console.warn("Removing old conversation backups failed", error));
  }
}

async function deleteByAge(now: number, switches: RetentionSwitches): Promise<number> {
  // Deletes that did not finish come first, whatever the boxes say: a file that could not be removed, a machine that stopped half-way.
  await finishAllPendingDeletes();
  const plan = await buildPlan(now, switches);
  const db = retentionDatabase();
  // The owner's backup setting. With it on nothing goes for its age unless its backup is stored first.
  const setting = getSettings().conversationBackup;
  const backup = { on: setting.destination !== "off", store: undefined as ConversationBackups | undefined, failed: false, made: 0 };
  const backupFailed = (what: string, error: unknown): void => {
    backup.failed = true;
    const message = `${what}: ${(error instanceof Error ? error.message : String(error)).replace(/\.+$/, "")}. Nothing more is deleted for its age until a backup succeeds.`;
    noteBackupProblem(message, now);
    console.warn(message);
  };
  if (backup.on) {
    try { backup.store = await ConversationBackups.open(setting); }
    catch (error) { backupFailed("Conversation backups could not be started", error); }
  }
  if (plan.switches.leftovers) {
    // The owner's box: what deletes made before the complete delete left here goes into the queue, and the queue is worked off.
    const projects = backup.on ? new Map((await listProjects()).map((project) => [project.id, project])) : new Map<string, ProjectRecord>();
    const taken = await queueLeftovers((projectId) => plan.readings.forProject(projectId), !backup.on ? undefined : async (left, files) => {
      if (backup.failed || !backup.store) throw new Error("Backups are not working");
      const project = projects.get(left.projectId);
      try {
        const saved = await backup.store.save({
          reason: "leftover", project: { id: left.projectId, name: project?.name ?? `Project ${left.projectId}`, ...(project ? { path: project.path } : {}) },
          engine: left.engine, sessionId: left.sessionId, conversationId: left.sessionId, segments: [{ engine: left.engine as ConversationEngine, sessionId: left.sessionId }], files,
        }, now);
        if (saved && !saved.reused) backup.made += 1;
      } catch (error) { backupFailed(`What was left of conversation ${left.engine}:${left.sessionId} could not be backed up`, error); throw error; }
    });
    if (taken.queued) await finishAllPendingDeletes();
  }
  let deleted = 0, runs = 0, handled = 0;
  for (const candidate of plan.candidates) {
    // Counted by the dry run only: the queue above took what may go, and a held-back conversation never goes.
    if (candidate.category === "leftover" || candidate.category === "held") continue;
    if (++handled % BATCH === 0) await pause(BATCH_PAUSE_MS); else await tick();
    try {
      if (candidate.project) {
        if (deleted >= SWEEP_PASS_LIMIT) continue;
        const project = candidate.project;
        // A delete relies on a reading of the folders: one taken long ago could miss a transcript written since.
        let files = await plan.readings.forProject(project.id, READING_MAX_AGE_MS);
        if (!await mayDeleteNow(candidate, plan, files, conversationsWithActiveTasks())) continue;
        if (backup.on && candidate.category === "expired") {
          if (backup.failed || !backup.store) continue;
          try {
            const saved = await backup.store.save({
              reason: "expired", project: { id: project.id, name: project.name, path: project.path },
              engine: candidate.engine, sessionId: candidate.sessionId, conversationId: candidate.conversationId, segments: candidate.segments, files,
            }, now);
            if (saved && !saved.reused) backup.made += 1;
          } catch (error) { backupFailed(`Conversation ${candidate.engine}:${candidate.sessionId} in ${project.name} could not be backed up`, error); continue; }
          // A backup takes a while, an upload longer: whatever happened to the conversation meanwhile counts.
          files = await plan.readings.forProject(project.id, READING_MAX_AGE_MS);
          if (!await mayDeleteNow(candidate, plan, files, conversationsWithActiveTasks())) continue;
        }
        await deleteOwnedConversation(project, candidate.engine, candidate.sessionId, candidate.segments, files);
        deleted += 1;
        console.log(`Deleted ${candidate.category} conversation ${candidate.engine}:${candidate.sessionId} in ${project.name}`);
        continue;
      }
      if (runs >= BACKGROUND_PASS_LIMIT) continue;
      const found = await harnessOf(plan, candidate);
      if (!found || !await mayRemoveFilesNow(candidate, plan, found)) continue;
      if (!await removeSessionFiles(candidate.root!, found)) continue;
      // What described the run goes with it: its stored summary, its work rows.
      db.exec("BEGIN IMMEDIATE");
      try { forgetConversationRows(db, [candidate.sessionId]); db.exec("COMMIT"); }
      catch (error) { db.exec("ROLLBACK"); throw error; }
      runs += 1;
    } catch (error) {
      console.warn(`Could not delete ${candidate.category} conversation ${candidate.engine}:${candidate.sessionId}${candidate.project ? ` in ${candidate.project.name}` : ""}`, error);
    }
  }
  if (runs) console.log(`Retention removed ${runs} background run(s)`);
  if (backup.made && backup.store) console.log(`Backed up ${backup.made} conversation(s) to ${backup.store.where} before deleting them`);
  return deleted;
}
