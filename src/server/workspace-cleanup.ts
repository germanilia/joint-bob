import path from 'node:path';
import { z } from 'zod';
import { asNode } from '../account-context.js';
import { backgroundTaskConversationId, readActiveBackgroundTaskIdentities } from '../background-tasks.js';
import { getClusterNode } from '../cluster.js';
import { listConversationRecords } from '../conversation-records.js';
import { conversationLeaseRunning } from '../conversation-runtime.js';
import { conversationWorkActive } from '../conversation-work.js';
import { resolveDataDirectory } from '../data-directory.js';
import { projectFilesEngine, worktreeSweepRefusal } from '../file-sync/facade.js';
import { listHarnessSessions } from '../harnesses.js';
import { withProjectRuntime } from '../project-runtime.js';
import { claimWorktreeCleanup, deleteProjectWorktree, listProjectWorktrees, worktreeConversationIndex, worktreeCopyNodeIds, type ProjectWorktree } from '../project-worktrees.js';
import { settingsDatabase, value } from '../settings-store.js';
import { listProjects } from '../store.js';
import { terminalOpenIn } from '../terminal-session.js';
import { isHarnessId, type ProjectRecord } from '../types.js';
import { worktreeIntegrationPending } from '../worktree-integration.js';
import { inspectWorkspaceChanges, saveWorkspaceStash } from '../workspace-cleanup-git.js';
import { findHarnessSession, harnessSessionBusy, harnessSessions } from './harness-sessions.js';
import { assertProjectEditable } from './projects.js';
import { broadcastToProject } from './realtime.js';
import { listRuntimePeers, runtimeFetch } from './runtime-peers.js';

const HOUR = 3600_000;
export const cleanupDue = (lastActivity: number, hasConversations: boolean, now: number) => Number.isFinite(lastActivity)
  && (hasConversations ? now - lastActivity > 72 * HOUR : now - lastActivity >= HOUR);
export const nextWorkspaceCleanup = (now: number) => (Math.floor(now / HOUR) + 1) * HOUR;
export const workspaceCleanupEnabled = () => value('workspaceCleanup') === 'true';

type Row = { projectId: string; projectName: string; workspaceId: string; name: string; status: 'ready' | 'kept' | 'removed'; detail: string };
type Recovery = { projectId: string; workspaceId: string; name: string; ref: string; base: string; savedAt: string };
const checkSchema = z.object({ reason: z.string().optional(), fingerprint: z.string().optional(), hasConversations: z.boolean().optional() });

/** Read local membership and liveness. Remote holders run the same check on their own copy. */
export async function workspaceCleanupCheck(project: ProjectRecord, tree: ProjectWorktree, now = Date.now()) {
  await assertProjectEditable(project);
  const open = () => terminalOpenIn(tree.path) || worktreeIntegrationPending(project.id, tree.id) || [...harnessSessions.values()].some(({ cwd }) => cwd === tree.path || cwd.startsWith(`${tree.path}${path.sep}`));
  if (open()) return { reason: 'Work in progress' };
  const [index, records] = await Promise.all([worktreeConversationIndex(project.id), listConversationRecords(project.id)]);
  const members = new Set([...index].filter(([, item]) => item.id === tree.id).map(([key]) => key));
  for (const row of records) if (row.worktree?.id === tree.id) members.add(`${row.engine}:${row.sessionId}`);
  const logical = new Set(records.filter(row => members.has(`${row.engine}:${row.sessionId}`)).map(row => row.conversationId ?? row.sessionId));
  // Scope the filesystem search to this workspace; unrelated project records are filtered below.
  const sessions = await listHarnessSessions({ ...project, path: tree.path, historyDays: 0, includeUnstarted: true }, [], [...members]);
  const recorded = new Set(records.map(row => `${row.engine}:${row.sessionId}`));
  for (const session of sessions) {
    const key = `${session.harnessId}:${session.id}`;
    if (session.worktree?.id === tree.id || !recorded.has(key)) members.add(key);
    if (members.has(key) && session.conversationId) logical.add(session.conversationId);
  }
  const related = records.filter(row => members.has(`${row.engine}:${row.sessionId}`) || logical.has(row.conversationId ?? row.sessionId));
  const segments = new Set([...members, ...related.map(row => `${row.engine}:${row.sessionId}`)]);
  const ids = new Set([...logical, ...[...segments].map(key => key.split(':')[1])]);
  const active = () => open() || [...readActiveBackgroundTaskIdentities(resolveDataDirectory())].some(task => ids.has(backgroundTaskConversationId(task))) || [...segments].some(key => {
    const [engine, id] = key.split(':');
    if (!isHarnessId(engine)) return true;
    const live = findHarnessSession(project.id, engine, id);
    return Boolean(live && harnessSessionBusy(live)) || conversationLeaseRunning(engine, id) || conversationWorkActive(engine, id);
  });
  if (active()) return { reason: 'A conversation or task is running' };
  const activity = [tree.createdAt, ...related.map(row => row.updatedAt), ...sessions.filter(row => segments.has(`${row.harnessId}:${row.id}`)).map(row => row.updatedAt)].map(at => at ? Date.parse(at) : NaN);
  if (activity.some(at => !Number.isFinite(at))) return { reason: 'Conversation activity could not be verified' };
  if (!cleanupDue(Math.max(...activity), members.size > 0, now)) return { reason: 'Recent conversation or workspace activity' };
  const changes = await inspectWorkspaceChanges(project, tree);
  if (active() || !cleanupDue(changes.updatedAt, members.size > 0, now)) return { reason: 'Recent workspace activity' };
  if (changes.entries.length && !changes.base) return { reason: 'Unmerged work has no Git base' };
  return { fingerprint: changes.fingerprint, changes, hasConversations: members.size > 0 };
}

async function checkPeers(project: ProjectRecord, tree: ProjectWorktree, fingerprint: string, hasConversations: boolean, reserve = false) {
  const refusal = await worktreeSweepRefusal(project.id, tree, { requirePeerCheck: true });
  if (refusal) return refusal.replace(/^Worktree kept: /, '');
  const peers = await listRuntimePeers(project.id);
  const known = new Set([tree.createdByNodeId, ...peers.map(peer => peer.id)]);
  if ((await worktreeCopyNodeIds(tree)).some(id => !known.has(id))) return 'A registered workspace holder cannot be contacted';
  if (!peers.length) return;
  if (await projectFilesEngine(project.id) !== 'builtin') return 'Cannot verify the shared workspace copies';
  const checks = await Promise.all(peers.map(async peer => {
    try {
      const reply = await runtimeFetch(new URL('/api/cluster/workspace-cleanup/check', peer.url), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(5000),
        body: JSON.stringify({ projectId: project.id, workspaceId: tree.id, reserve }),
      });
      if (!reply.ok) throw new Error('Cleanup check rejected');
      const check = checkSchema.parse(await reply.json());
      if (check.reason) return `${peer.name}: ${check.reason}`;
      if (check.fingerprint !== fingerprint || check.hasConversations !== hasConversations) return `${peer.name}: workspace contents or conversation membership differ`;
    } catch { return `${peer.name}: cannot verify its copy`; }
  }));
  return checks.find(Boolean);
}

function historyDb() {
  const db = settingsDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_cleanup_saves (
    project_id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT NOT NULL, ref TEXT PRIMARY KEY, base TEXT NOT NULL, saved_at TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS workspace_cleanup_last_run (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), finished_at TEXT NOT NULL, outcome TEXT NOT NULL
  )`);
  return db;
}

export function rememberWorkspaceStash(project: ProjectRecord, tree: ProjectWorktree, ref: string, base: string) {
  historyDb().prepare('INSERT OR IGNORE INTO workspace_cleanup_saves VALUES (?, ?, ?, ?, ?, ?)').run(project.id, tree.id, tree.name, ref, base, new Date().toISOString());
}

export function workspaceCleanupHistory(projectIds: Set<string>) {
  const db = settingsDatabase();
  const exists = (table: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  const last = exists('workspace_cleanup_last_run') ? db.prepare('SELECT finished_at AS finishedAt, outcome FROM workspace_cleanup_last_run WHERE singleton=1').get() as { finishedAt: string; outcome: string } | undefined : undefined;
  const saved = exists('workspace_cleanup_saves') ? db.prepare('SELECT project_id AS projectId, workspace_id AS workspaceId, name, ref, base, saved_at AS savedAt FROM workspace_cleanup_saves ORDER BY saved_at DESC').all() as unknown as Recovery[] : [];
  return { lastRun: last && { finishedAt: last.finishedAt, rows: (JSON.parse(last.outcome) as Row[]).filter(row => projectIds.has(row.projectId)) }, saved: saved.filter(row => projectIds.has(row.projectId)) };
}

async function evaluate(project: ProjectRecord, tree: ProjectWorktree, nodeId: string, mode: 'preview' | 'manual' | 'scheduled'): Promise<Row> {
  const row = { projectId: project.id, projectName: project.name, workspaceId: tree.id, name: tree.name };
  const keep = (detail: string): Row => ({ ...row, status: 'kept', detail });
  try {
    if (tree.createdByNodeId !== nodeId) return keep('Checked by the workspace’s creating machine');
    const check = await workspaceCleanupCheck(project, tree);
    if (!check.changes) return keep(check.reason);
    const refusal = await checkPeers(project, tree, check.fingerprint, check.hasConversations);
    if (refusal) return keep(refusal);
    const detail = check.changes.entries.length ? 'Save unmerged changes in Git, then remove' : 'Remove local files';
    if (mode === 'preview') return { ...row, status: 'ready', detail };
    if (check.changes.entries.length) {
      const ref = await saveWorkspaceStash(project, tree, check.changes);
      rememberWorkspaceStash(project, tree, ref, check.changes.base!);
    }
    const release = claimWorktreeCleanup(project.id, tree.id);
    if (!release) return keep('Another cleanup is checking this workspace');
    try {
      const deadline = Date.now() + 25_000;
      const remote = await checkPeers(project, tree, check.fingerprint, check.hasConversations, true);
      if (remote) return keep(remote);
      const current = await workspaceCleanupCheck(project, tree);
      if (current.fingerprint !== check.fingerprint || current.hasConversations !== check.hasConversations || Date.now() >= deadline) return keep('Workspace activity changed or the final check expired');
      if (mode === 'scheduled' && !workspaceCleanupEnabled()) return keep('Automatic cleanup is off');
      await deleteProjectWorktree(project.id, tree.id, undefined, { preserveSessionPaths: check.hasConversations });
    } finally { release(); }
    broadcastToProject(project.id, { type: 'worktreesChanged' });
    broadcastToProject(project.id, { type: 'sessionsChanged' });
    return { ...row, status: 'removed', detail: check.changes.entries.length ? 'Saved in Git' : 'Removed without a stash' };
  } catch (error) {
    // Details from Git can contain local paths. Do not expose them in the admin UI.
    if (error instanceof Error && /^Workspace contains excluded files/.test(error.message)) return keep(error.message);
    console.warn('Workspace cleanup could not verify or save a workspace', project.id, tree.id, error);
    return keep('Could not verify activity, file sync or Git recovery');
  }
}

let pending: Promise<Row[]> | undefined;
async function scan(projects: ProjectRecord[], mode: 'preview' | 'manual' | 'scheduled') {
  const { id } = await getClusterNode();
  const rows: Row[] = [];
  for (const project of projects) {
    try {
      await withProjectRuntime(project.id, async () => {
        for (const workspace of await listProjectWorktrees(project.id)) rows.push(await evaluate(project, workspace, id, mode));
      });
    } catch (error) {
      console.warn('Workspace cleanup could not scan a project', project.id, error);
      rows.push({ projectId: project.id, projectName: project.name, name: 'Project', workspaceId: '', status: 'kept', detail: 'Project could not be scanned' });
    }
  }
  return rows;
}

export const previewWorkspaceCleanup = (projects: ProjectRecord[]) => scan(projects, 'preview');
export function runWorkspaceCleanup(mode: 'manual' | 'scheduled', projects?: ProjectRecord[]): Promise<Row[]> {
  if (mode === 'scheduled' && !workspaceCleanupEnabled()) return Promise.resolve([]);
  if (pending) return pending.then(rows => projects ? rows.filter(row => projects.some(project => project.id === row.projectId)) : rows);
  const job = async () => {
    const rows = await scan(projects ?? await listProjects(), mode);
    historyDb().prepare('INSERT OR REPLACE INTO workspace_cleanup_last_run VALUES (1, ?, ?)').run(new Date().toISOString(), JSON.stringify(rows));
    return rows;
  };
  pending = (mode === 'scheduled' ? asNode(job) : job()).finally(() => { pending = undefined; });
  return pending;
}

/** Built-in hourly job, independent of browser sessions and user prompt cron. */
export function scheduleWorkspaceCleanup(ready: () => boolean) {
  const run = () => {
    if (ready()) void runWorkspaceCleanup('scheduled').catch(error => console.warn('Hourly workspace cleanup failed', error));
  };
  const arm = () => setTimeout(() => { arm(); run(); }, nextWorkspaceCleanup(Date.now()) - Date.now()).unref();
  arm();
  setTimeout(run, 5 * 60_000).unref();
}
