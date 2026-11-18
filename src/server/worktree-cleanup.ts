import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { backgroundTaskConversationId, readActiveBackgroundTaskIdentities } from "../background-tasks.js";
import { listConversationRecords } from "../conversation-records.js";
import { conversationWorkActive } from "../conversation-work.js";
import { resolveDataDirectory } from "../data-directory.js";
import { conversationLeaseRunning } from "../conversation-runtime.js";
import { sessionDoneOverrides } from "../names.js";
import { hasVerifiedIntegration, retireVerifiedWorktree, worktreeIntegrationPending } from "../worktree-integration.js";
import { listProjectWorktrees, projectWorktreeRoot, WORKTREE_ID, worktreeConversationIndex } from "../project-worktrees.js";
import { worktreeFilesChanged, worktreeSweepRefusal } from "../file-sync/facade.js";
import { listProjects } from "../store.js";
import { isHarnessId, type ProjectRecord } from "../types.js";
import { findHarnessSession, harnessSessionBusy, harnessSessions } from "./harness-sessions.js";
import { assertProjectEditable, ProjectLockedError } from "./projects.js";
import { broadcastToProject } from "./realtime.js";

interface CleanupResult {
  deletedWorktreeIds: string[];
  retainedWorktrees: Record<string, string>;
}

const pending = new Map<string, Promise<CleanupResult>>();

/** Reconcile persisted done marks, not the filtered or capped conversation list. Inactivity cleanup is separate. */
export async function cleanupDoneWorktrees(project: ProjectRecord): Promise<CleanupResult> {
  const existing = pending.get(project.id);
  if (existing) return existing;
  const operation = cleanup(project);
  pending.set(project.id, operation);
  try { return await operation; }
  finally { pending.delete(project.id); }
}

/** Reconcile verified finish and previously retired folders. */
export async function sweepWorktrees(): Promise<string[]> {
  const deleted: string[] = [];
  for (const project of await listProjects()) {
    try { deleted.push(...(await cleanupDoneWorktrees(project)).deletedWorktreeIds); }
    catch (error) { console.warn(`Worktree sweep failed for ${project.id}`, error); }
  }
  return deleted;
}

async function cleanup(project: ProjectRecord): Promise<CleanupResult> {
  const result: CleanupResult = { deletedWorktreeIds: [], retainedWorktrees: {} };
  const [index, records, done] = await Promise.all([
    worktreeConversationIndex(project.id), listConversationRecords(project.id), sessionDoneOverrides(),
  ]);
  const logicalIds = new Map(records.map((record) => [`${record.engine}:${record.sessionId}`, record.conversationId ?? record.sessionId]));
  const members = [...index].map(([key, worktree]) => {
    const [engine, sessionId] = key.split(":");
    return { engine, sessionId, worktree, conversationId: logicalIds.get(key) ?? sessionId };
  });
  const worktrees = new Map(members.map(({ worktree }) => [worktree.id, worktree]));
  for (const worktree of worktrees.values()) {
    const group = members.filter((member) => member.worktree.id === worktree.id);
    if (!group.every((member) => done[member.conversationId])) continue;
    try {
      await assertProjectEditable(project);
      // A harness switch can leave only the original segment's worktree marker.
      const conversations = new Set(group.map((member) => member.conversationId));
      const segments = [...group, ...records.filter((record) => conversations.has(record.conversationId ?? record.sessionId))];
      const running = () => worktreeIntegrationPending(project.id, worktree.id) || [...harnessSessions.values()].some(({ cwd }) => cwd === worktree.path || cwd.startsWith(`${worktree.path}${path.sep}`)) || [...readActiveBackgroundTaskIdentities(resolveDataDirectory())].map(backgroundTaskConversationId).some((id) => conversations.has(id)) || segments.some(({ engine, sessionId }) => {
        if (!isHarnessId(engine)) return true;
        const session = findHarnessSession(project.id, engine, sessionId);
        return Boolean(session && harnessSessionBusy(session)) || conversationWorkActive(engine, sessionId) || conversationLeaseRunning(engine, sessionId);
      });
      if (running()) {
        result.retainedWorktrees[worktree.id] = "Worktree kept: a conversation is still running";
        continue;
      }
      // Recheck membership and done marks right before deleting: a conversation may have reopened or started meanwhile.
      await assertProjectEditable(project);
      const current = await worktreeConversationIndex(project.id);
      segments.push(...(await listConversationRecords(project.id)).filter((record) => conversations.has(record.conversationId ?? record.sessionId)));
      const currentDone = await sessionDoneOverrides();
      const keys = [...index].filter(([, candidate]) => candidate.id === worktree.id).map(([key]) => key).sort();
      const currentKeys = [...current].filter(([, candidate]) => candidate.id === worktree.id).map(([key]) => key).sort();
      if (JSON.stringify(keys) !== JSON.stringify(currentKeys) || !group.every((member) => currentDone[member.conversationId])) continue;
      if (running()) {
        result.retainedWorktrees[worktree.id] = "Worktree kept: a conversation is still running";
        continue;
      }
      // app-integration (P4): on built-in sync this deletion reaches every machine (design §6.5).
      const refusal = await worktreeSweepRefusal(project.id, worktree);
      if (refusal) {
        result.retainedWorktrees[worktree.id] = refusal;
        continue;
      }
      if (!hasVerifiedIntegration(project.id, worktree.id) || worktree.pullRequest) {
        result.retainedWorktrees[worktree.id] = "Worktree kept: no verified local integration or explicit PR finish path";
        continue;
      }
      await retireVerifiedWorktree(project, worktree.id);
      result.deletedWorktreeIds.push(worktree.id);
    } catch (error) {
      // Housekeeping must not turn a successfully saved done mark into an HTTP error.
      result.retainedWorktrees[worktree.id] = error instanceof ProjectLockedError
        ? "Worktree kept: project is locked on another machine"
        : "Worktree kept: cleanup could not be completed";
      if (!(error instanceof ProjectLockedError)) console.warn(`Worktree cleanup failed for ${worktree.id}`, error);
    }
  }
  await removeDeadWorktreeFolders(project).catch((error) => console.warn(`Removing leftover worktree folders of ${project.id} failed`, error));
  if (result.deletedWorktreeIds.length) {
    broadcastToProject(project.id, { type: "worktreesChanged" });
    broadcastToProject(project.id, { type: "sessionsChanged" });
  }
  return result;
}

/** Never infer retirement from missing or late metadata. Only explicit retirements are removed. */
const STAGING_GRACE_MS = 24 * 60 * 60_000;

async function removeDeadWorktreeFolders(project: ProjectRecord): Promise<void> {
  const root = projectWorktreeRoot(project.id);
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch { return; }
  const listed = new Set((await listProjectWorktrees(project.id)).map((worktree) => worktree.id));
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(root, entry.name);
    if (entry.name.startsWith(".creating-")) {
      const info = await lstat(folder).catch(() => undefined);
      if (info && now - info.mtimeMs > STAGING_GRACE_MS && !await changedSince(folder, now - STAGING_GRACE_MS)) await rm(folder, { recursive: true, force: true });
      continue;
    }
    if (!WORKTREE_ID.test(entry.name) || listed.has(entry.name)) continue;
    // A retirement marker is the explicit, synced record that a merge or deletion removed this worktree on some node:
    // what is left here (copied .env files, links, this node's path file) goes without waiting out the grace period,
    // and file changes inside it are the delete arriving, not work.
    if (await lstat(path.join(root, ".retired", `${entry.name}.json`)).then(() => true, () => false)) {
      if (sessionOpenIn(folder)) continue;
      await rm(folder, { recursive: true, force: true });
      worktreeFilesChanged(project.id, folder);
      continue;
    }
  }
}

function sessionOpenIn(worktreePath: string): boolean {
  const prefix = `${worktreePath}${path.sep}`;
  return [...harnessSessions.values()].some(({ cwd }) => cwd === worktreePath || cwd.startsWith(prefix));
}

async function changedSince(dir: string, since: number, strict = false): Promise<boolean> {
  if (strict && (await lstat(dir)).mtimeMs >= since) return true;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (error) { if (strict) throw error; return false; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    let info;
    try { info = await lstat(full); }
    catch (error) { if (strict) throw error; continue; }
    if (info.mtimeMs >= since) return true;
    if (entry.isDirectory() && await changedSince(full, since, strict)) return true;
  }
  return false;
}
