// Deleting a conversation completely, in an order that can stop anywhere and be finished later.
//
//   1. One node.db transaction: a tombstone for every segment, the records gone, this machine's
//      rows about the conversation gone, the delete queued for the other machines, and each
//      segment put in the queue of unfinished deletes (deleteConversationRecords). From here on
//      the conversation is deleted: the list hides any file whose id has a tombstone.
//   2. Files: every segment's transcript wherever it lies under the harness's folder, its copies and
//      transfer leftovers, the Claude session folder with sub-agent transcripts and tool results.
//   3. Background tasks: the logs and shell exit files of the conversation's finished tasks, then
//      their rows in supervisor.db.
//
// A segment leaves the queue once steps 2 and 3 both ran for it without error. Both only remove
// what is still there, so they can run again: whatever is in the queue is tried again right after
// a delete, after tombstones arrive, at start-up and in the hourly check. A machine that receives
// a tombstone from another machine queues it in the same way, in the transaction that applies it
// (applyConversationRecordEvent), whatever the tombstone's date.
//
// The same delete serves a person's delete, the retention sweep and a received tombstone.
//
// Deletes that releases before this one made are not in the queue. What they left here stays until
// the owner ticks the `leftovers` box (queueLeftovers), and some of it is never taken (heldBack).
import { unlink } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openNodeDatabase } from "../node-database.js";
import { revokeAgentCapabilities } from "../agent-capabilities.js";
import { supervisorDatabaseFile } from "../background-tasks.js";
import { getClusterNode } from "../cluster.js";
import { conversationForgotten, deleteFinished, ensureDeleteQueue, forgetConversationRows, forgottenConversations, pendingDeleteState, pendingDeletes, queueDelete, type ForgottenConversation, type PendingDelete } from "../conversation-forget.js";
import type { ConversationEngine } from "../conversation-ownership.js";
import { conversationRecordsReady, deleteConversationRecords, type DeletedConversation } from "../conversation-records.js";
import { resolveDataDirectory } from "../data-directory.js";
import { clearHarnessSessionCache, listHarnesses } from "../harnesses.js";
import { withProjectRuntime } from "../project-runtime.js";
import { projectAliasIds } from "../store.js";
import { harnessFiles, removeSessionFiles, removeTranscriptConflictCopies, type HarnessFiles } from "./conversation-files.js";

export interface ConversationSegment { engine: ConversationEngine; sessionId: string }

let database: DatabaseSync | undefined;

/** This module's own connection to node.db, for the checks and clean-up that run outside another module's transaction. */
export function retentionDatabase(): DatabaseSync {
  if (!database) {
    database = openNodeDatabase(path.join(resolveDataDirectory(), "node.db"));
    database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  }
  // The first time on a machine this writes down the deletes it already knew (conversation-forget.ts).
  ensureDeleteQueue(database);
  return database;
}

/** Every harness's files by session id, read once for a batch of deletes. Keyed by harness. */
export type FilesByHarness = Map<string, HarnessFiles>;

/** The harness folders as the project's agents see them: the project's runtime account's in multi-user mode, the service's own for a project that is gone. */
export function projectHarnessFiles(projectId: string, engines?: Iterable<string>): Promise<FilesByHarness> {
  const wanted = engines ? new Set(engines) : undefined;
  return withProjectRuntime(projectId, async () => {
    const found: FilesByHarness = new Map();
    for (const adapter of listHarnesses()) {
      if (wanted && !wanted.has(adapter.id)) continue;
      found.set(adapter.id, await harnessFiles(adapter));
    }
    return found;
  });
}

/**
 * Whether a delete is held back: this machine made it before the complete delete existed, and a
 * transcript of the conversation still lies on this machine.
 *
 * Until then a delete removed the transcript first and the record after, so a transcript that
 * outlived its own machine's delete was never at the place the project listed. That is how the old
 * "empty" rule deleted real conversations: it took a record for empty because the list did not
 * look in the folder its transcript lay in. Such a transcript may be the only copy of a
 * conversation nobody chose to delete, so nothing clears it on its own: it is never put in the
 * queue, with or without the `leftovers` box, and a later delete of the same conversation by
 * another machine does not clear it either. The dry run counts these for a person to decide.
 */
export function heldBack(deleted: ForgottenConversation, files: FilesByHarness | undefined): boolean {
  return deleted.madeHere && Boolean(files?.get(deleted.engine)?.sessions.get(deleted.sessionId)?.transcripts.length);
}

/**
 * Step 2. Removes the files of deleted segments. A segment is skipped unless it has a tombstone and
 * no record: a transcript on record is never removed here, whatever asked for it.
 */
async function removeDeletedFiles(projectId: string, segments: ConversationSegment[], files?: FilesByHarness): Promise<number> {
  const db = retentionDatabase();
  const found = files ?? await projectHarnessFiles(projectId, segments.map((segment) => segment.engine));
  let removed = 0;
  for (const segment of segments) {
    if (!conversationForgotten(db, segment.sessionId)) continue;
    const harness = found.get(segment.engine);
    if (harness) removed += await removeSessionFiles(harness.root, harness.sessions.get(segment.sessionId));
    removed += await removeTranscriptConflictCopies(segment.engine, segment.sessionId);
  }
  return removed;
}

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FINISHED = "status NOT IN ('starting','running','stopping')";

/**
 * Step 3. Removes what the conversations' finished background tasks left: the log and the shell
 * exit file of each, its shell call row in node.db, then its rows in supervisor.db. A task that
 * still runs is left alone; the supervisor ends a shell whose conversation is gone. Returns how
 * many tasks went.
 */
async function removeDeletedTasks(projectId: string, conversationIds: string[]): Promise<number> {
  const dataDirectory = resolveDataDirectory();
  const file = supervisorDatabaseFile(dataDirectory);
  if (!file || !conversationIds.length) return 0;
  const projects = [projectId, ...await projectAliasIds(projectId).catch(() => [] as string[])];
  const identities = projects.flatMap((project) => conversationIds.map((conversation) => JSON.stringify([project, conversation])));
  const supervisor = new DatabaseSync(file);
  try {
    supervisor.exec("PRAGMA busy_timeout = 5000");
    if (!supervisor.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'supervisor_tasks'").get()) return 0;
    const completions = supervisor.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'supervisor_completions'").get() !== undefined;
    const node = retentionDatabase();
    const shellCalls = node.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'supervised_shell_calls'").get() !== undefined;
    let removed = 0;
    for (let start = 0; start < identities.length; start += 200) {
      const list = JSON.stringify(identities.slice(start, start + 200));
      const tasks = (supervisor.prepare(`SELECT id FROM supervisor_tasks WHERE identity IN (SELECT value FROM json_each(?)) AND ${FINISHED}`).all(list) as Array<{ id: string }>)
        .map((row) => row.id).filter((id) => TASK_ID.test(id));
      for (let from = 0; from < tasks.length; from += 200) {
        const ids = tasks.slice(from, from + 200), idList = JSON.stringify(ids);
        for (const id of ids) {
          for (const leftover of [path.join(dataDirectory, "background-tasks", `${id}.log`), path.join(dataDirectory, "shell-exits", id)]) {
            await unlink(leftover).catch((error) => { if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; });
          }
        }
        if (shellCalls) node.prepare("DELETE FROM supervised_shell_calls WHERE task_id IN (SELECT value FROM json_each(?))").run(idList);
        supervisor.exec("BEGIN IMMEDIATE");
        try {
          if (completions) supervisor.prepare("DELETE FROM supervisor_completions WHERE task_id IN (SELECT value FROM json_each(?))").run(idList);
          removed += Number(supervisor.prepare(`DELETE FROM supervisor_tasks WHERE id IN (SELECT value FROM json_each(?)) AND ${FINISHED}`).run(idList).changes);
          supervisor.exec("COMMIT");
        } catch (error) { supervisor.exec("ROLLBACK"); throw error; }
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    return removed;
  } finally { supervisor.close(); }
}

/** The steps that follow the transaction. A test replaces one to stand in for a machine that stopped half-way or a disk that refused. */
export const deleteSteps = { files: removeDeletedFiles, tasks: removeDeletedTasks };

export interface FinishedDeletes { finished: number; waiting: number; files: number; tasks: number }

let working: Promise<unknown> = Promise.resolve();

/**
 * Finishes the deletes in the queue: steps 2 and 3 for each, and the row goes when both ran
 * without error. A delete whose step fails stays in the queue for the next call. `only` limits the
 * call to some segments (`engine:sessionId`) or one project; `files` is a reading of the harness
 * folders the caller already has. One call runs at a time, so two never work on the same delete.
 */
export function finishPendingDeletes(only?: { sessions?: Set<string>; projectId?: string }, files?: FilesByHarness): Promise<FinishedDeletes> {
  const next = working.then(() => finish(only, files));
  working = next.catch(() => undefined);
  return next;
}

/**
 * Works the whole queue off, a few deletes at a time. Between the parts a delete that a person
 * just made, or one that just arrived, gets its turn: it does not wait behind a long queue.
 */
export async function finishAllPendingDeletes(): Promise<FinishedDeletes> {
  const total: FinishedDeletes = { finished: 0, waiting: 0, files: 0, tasks: 0 };
  const keys = pendingDeletes(retentionDatabase()).map((row) => `${row.engine}:${row.sessionId}`);
  for (let start = 0; start < keys.length; start += 100) {
    const part = await finishPendingDeletes({ sessions: new Set(keys.slice(start, start + 100)) });
    total.finished += part.finished; total.waiting += part.waiting; total.files += part.files; total.tasks += part.tasks;
  }
  return total;
}

async function finish(only: { sessions?: Set<string>; projectId?: string } | undefined, files: FilesByHarness | undefined): Promise<FinishedDeletes> {
  const db = retentionDatabase();
  const result: FinishedDeletes = { finished: 0, waiting: 0, files: 0, tasks: 0 };
  const byProject = new Map<string, PendingDelete[]>();
  for (const row of pendingDeletes(db)) {
    if (only?.projectId && row.projectId !== only.projectId) continue;
    if (only?.sessions && !only.sessions.has(`${row.engine}:${row.sessionId}`)) continue;
    byProject.set(row.projectId, [...(byProject.get(row.projectId) ?? []), row]);
  }
  for (const [projectId, rows] of byProject) {
    let found: FilesByHarness;
    try { found = files ?? await projectHarnessFiles(projectId, rows.map((row) => row.engine)); }
    catch (error) { result.waiting += rows.length; console.warn(`The harness folders of project ${projectId} could not be read; ${rows.length} delete(s) wait`, error); continue; }
    let removed = 0;
    for (const row of rows) {
      const state = pendingDeleteState(db, row.engine, row.sessionId);
      // A newer record brought the conversation back: there is nothing to delete any more.
      if (state === "ended") { deleteFinished(db, row.engine, row.sessionId); continue; }
      // Another segment of the conversation is still on record here; its delete is on its way.
      if (state === "waiting") { result.waiting += 1; continue; }
      const ids = [...new Set([row.sessionId, row.conversationId])];
      try {
        const gone = await deleteSteps.files(projectId, [{ engine: row.engine as ConversationEngine, sessionId: row.sessionId }], found);
        result.tasks += await deleteSteps.tasks(projectId, ids);
        for (const id of ids) revokeAgentCapabilities(projectId, id);
        // Out of the queue, together with any row that was written about the conversation since its record went.
        db.exec("BEGIN IMMEDIATE");
        try { forgetConversationRows(db, [row.sessionId]); deleteFinished(db, row.engine, row.sessionId); db.exec("COMMIT"); }
        catch (error) { db.exec("ROLLBACK"); throw error; }
        result.finished += 1; result.files += gone; removed += gone;
      } catch (error) {
        result.waiting += 1;
        console.warn(`The delete of conversation ${row.engine}:${row.sessionId} is not finished; it stays in the queue`, error);
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (removed) clearHarnessSessionCache(projectId);
  }
  return result;
}

/**
 * Deletes a conversation with everything this machine holds about it. The caller has already
 * decided that it may go: the project can be edited, this machine owns the conversation, nothing
 * runs in it. `known` adds segments the caller listed that may have no record. When a file cannot
 * be removed the delete still stands: the conversation is gone from the list and from the other
 * machines, and what is left of it here waits in the queue.
 */
export async function deleteConversationCompletely(projectId: string, engine: ConversationEngine, sessionId: string, known: ConversationSegment[] = [], files?: FilesByHarness): Promise<DeletedConversation> {
  const local = await getClusterNode();
  const deleted = await deleteConversationRecords(projectId, engine, sessionId, local.id, known);
  await finishPendingDeletes({ sessions: new Set(deleted.segments.map((segment) => `${segment.engine}:${segment.sessionId}`)) }, files);
  clearHarnessSessionCache(projectId);
  return deleted;
}

/**
 * The `leftovers` box: puts in the queue what deletes made before the complete delete left on this
 * machine, and clears their rows. Taken: a deleted conversation that is not in the queue, is not
 * held back, and either was already known as deleted when the complete delete first ran here or
 * has files on disk now. `filesOf` gives the harness folders for a project. Returns how many were
 * queued and how many are held back.
 */
export async function queueLeftovers(filesOf: (projectId: string) => Promise<FilesByHarness> = (projectId) => projectHarnessFiles(projectId)): Promise<{ queued: number; held: number; rows: number }> {
  await conversationRecordsReady();
  const db = retentionDatabase();
  const result = { queued: 0, held: 0, rows: 0 };
  const byProject = new Map<string, ForgottenConversation[]>();
  for (const row of forgottenConversations(db)) {
    if (!row.pending) byProject.set(row.projectId, [...(byProject.get(row.projectId) ?? []), row]);
  }
  for (const [projectId, deleted] of byProject) {
    let files: FilesByHarness;
    try { files = await filesOf(projectId); }
    catch (error) { console.warn(`The harness folders of project ${projectId} could not be read; what earlier deletes left there stays`, error); continue; }
    const take: ForgottenConversation[] = [];
    for (const row of deleted) {
      if (heldBack(row, files)) { result.held += 1; continue; }
      const found = files.get(row.engine)?.sessions.get(row.sessionId);
      if (row.earlier || (found && found.transcripts.length + found.leftovers.length + found.folders.length > 0)) take.push(row);
    }
    for (let start = 0; start < take.length; start += 200) {
      const batch = take.slice(start, start + 200);
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const row of batch) queueDelete(db, row.projectId, row.engine, row.sessionId, row.sessionId);
        result.rows += forgetConversationRows(db, batch.map((row) => row.sessionId));
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      result.queued += batch.length;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  return result;
}
