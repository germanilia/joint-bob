// A conversation deleted on one node is deleted everywhere. The deleting node removes its own
// files; every other node removes its copies here, when the deletion arrives, and at start-up
// for a delete that did not finish.
//
// A delete that is not finished is a row in a queue (conversation-forget.ts). The row is written
// in the transaction that makes the delete or applies the one that arrived, and it goes when the
// files and the background task logs are gone. So this module only works the queue off.
//
// The files are found by session id anywhere under the harness's folder, not only in the folders
// the project lists today: a copy made on another node records that node's directory, and a
// project that moved leaves its transcripts under the old one. Nothing is removed for a
// conversation that is on record (conversation-delete.ts checks the tombstone before each one).
//
// What deletes made before the complete delete existed left behind is not in the queue. It stays
// until the owner turns on the `leftovers` box of the retention setting, which queues it: here at
// start-up when backups are off, and in the hourly check, after a backup, when they are on.
import type { ConversationEngine } from "../conversation-ownership.js";
import { conversationRecordsReady } from "../conversation-records.js";
import type { ReplicationEvent } from "../replication.js";
import { getSettings } from "../settings.js";
import { getProject } from "../store.js";
import { finishAllPendingDeletes, finishPendingDeletes, queueLeftovers } from "./conversation-delete.js";

/** Finishes one project's unfinished deletes on this node: files and background task leftovers. */
export async function removeDeletedTranscripts(projectId: string): Promise<void> {
  const project = await getProject(projectId);
  if (project) await finishPendingDeletes({ projectId: project.id });
}

/** After replicated events are applied: remove this node's copies of the conversations they deleted. */
export async function removeTranscriptsDeletedBy(events: ReplicationEvent[]): Promise<void> {
  const sessions = new Set<string>();
  for (const event of events) {
    if (event.entityType !== "conversation.record" || event.operation !== "delete") continue;
    const payload = event.payload as { engine: ConversationEngine; sessionId: string };
    sessions.add(`${payload.engine}:${payload.sessionId}`);
  }
  if (!sessions.size) return;
  // Only what the applier queued is touched: a delete that lost to a newer record, or to a held-back copy, queued nothing.
  await finishPendingDeletes({ sessions }).catch((error) => console.warn("Removing the transcripts of deleted conversations failed", error));
}

/** At start-up: finish the deletes that did not finish, and with the `leftovers` box take what earlier deletes left. */
export async function removeAllDeletedTranscripts(): Promise<void> {
  // Opens the record store first: its start-up repairs run before anything reads its tables.
  await conversationRecordsReady();
  const finished = await finishAllPendingDeletes();
  const settings = getSettings();
  // With backups on, what earlier deletes left is backed up before it goes. The hourly check does both
  // (conversation-retention.ts); here nothing of it is taken, so nothing goes without its backup.
  if (settings.conversationRetentionScope.leftovers && settings.conversationBackup.destination === "off") {
    const taken = await queueLeftovers();
    const more = await finishAllPendingDeletes();
    finished.finished += more.finished; finished.files += more.files; finished.tasks += more.tasks; finished.waiting = more.waiting;
    if (taken.held) console.log(`${taken.held} conversation(s) deleted here by an earlier release still have a transcript on this machine; they are left alone (the retention dry run lists them)`);
  }
  if (finished.finished || finished.waiting) {
    console.log(`Finished ${finished.finished} conversation delete(s): ${finished.files} file(s) and ${finished.tasks} background task(s) removed${finished.waiting ? `; ${finished.waiting} still wait in the queue` : ""}`);
  }
}
