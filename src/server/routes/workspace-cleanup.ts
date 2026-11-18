import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { getClusterNode } from '../../cluster.js';
import { clusterV2Database } from '../../cluster-v2-store.js';
import { isTrustedTwin } from '../../cluster-sharing-policy.js';
import { mayShareProject } from '../sharing-files.js';
import { withProjectRuntime } from '../../project-runtime.js';
import { claimWorktreeCleanup, listProjectWorktrees } from '../../project-worktrees.js';
import { settingsDatabase } from '../../settings-store.js';
import { saveSystemAiSetting } from '../../system-ai-replication.js';
import { getProject, listProjects } from '../../store.js';
import { restoreWorkspaceStash } from '../../workspace-cleanup-git.js';
import { requireAdmin } from '../admin.js';
import { sendError } from '../http-auth.js';
import { assertProjectEditable } from '../projects.js';
import { broadcastToProject } from '../realtime.js';
import { listRuntimePeers, runtimeFetch, twinRuntimeGuard } from '../runtime-peers.js';
import { app } from '../state.js';
import { previewWorkspaceCleanup, runWorkspaceCleanup, workspaceCleanupCheck, workspaceCleanupEnabled, workspaceCleanupHistory } from '../workspace-cleanup.js';

const projectId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const restore = z.object({ projectId, ref: z.string().max(300) }).strict();
const action = z.enum(['status', 'preview', 'run', 'restore']);
const remoteCommand = z.object({ action, projectIds: z.array(projectId).max(5000), recovery: restore.optional() }).strict();

function route(handler: (request: Request, response: Response) => Promise<void>) {
  return async (request: Request, response: Response, next: NextFunction) => {
    response.set('Cache-Control', 'no-store');
    try { await handler(request, response); }
    catch (error) {
      if (error instanceof z.ZodError) sendError(response, 400, 'Invalid workspace cleanup request');
      else next(error);
    }
  };
}

async function onNode(mode: z.infer<typeof action>, ids: string[], recovery?: z.infer<typeof restore>) {
  const allowed = new Set(ids);
  const projects = (await listProjects()).filter(project => allowed.has(project.id));
  const visible = new Set(projects.map(project => project.id));
  if (mode === 'restore') {
    const entry = workspaceCleanupHistory(visible).saved.find(row => row.projectId === recovery?.projectId && row.ref === recovery.ref);
    const project = entry && projects.find(item => item.id === entry.projectId);
    if (!entry || !project) return { error: 'Workspace recovery entry not found' };
    return withProjectRuntime(project.id, async () => {
      await assertProjectEditable(project);
      const prefix = `Restored ${entry.name}`.slice(0, 68);
      const existing = new Set((await listProjectWorktrees(project.id)).map(tree => tree.name.toLowerCase()));
      let name = prefix;
      for (let n = 2; existing.has(name.toLowerCase()); n++) name = `${prefix} (${n})`;
      const workspace = await restoreWorkspaceStash(project, entry.ref, name);
      broadcastToProject(project.id, { type: 'worktreesChanged' });
      return { restored: workspace.name };
    });
  }
  const rows = mode === 'preview' ? await previewWorkspaceCleanup(projects) : mode === 'run' ? await runWorkspaceCleanup('manual', projects) : undefined;
  return { enabled: workspaceCleanupEnabled(), ...workspaceCleanupHistory(visible), rows };
}

async function remote(peer: { url: string }, mode: z.infer<typeof action>, projectIds: string[], recovery?: z.infer<typeof restore>) {
  const reply = await runtimeFetch(new URL('/api/cluster/workspace-cleanup/admin', peer.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(mode === 'status' ? 5000 : 120_000),
    body: JSON.stringify({ action: mode, projectIds, recovery }),
  });
  if (!reply.ok) throw new Error('Node rejected the cleanup request');
  return await reply.json() as Awaited<ReturnType<typeof onNode>>;
}

async function twins(localId: string) {
  const db = await clusterV2Database();
  return (await listRuntimePeers()).filter(peer => isTrustedTwin(db, localId, peer.id));
}

async function systemView(mode: 'status' | 'preview' | 'run') {
  const local = await getClusterNode(), ids = (await listProjects()).map(project => project.id);
  const peers = await twins(local.id);
  const nodes = await Promise.all([local, ...peers].map(async node => {
    const identity = { id: node.id, name: node.name };
    if (node.id === local.id) return { ...identity, ...await onNode(mode, ids) };
    const peer = peers.find(item => item.id === node.id)!;
    try { return { ...identity, ...await remote(peer, mode, ids) }; }
    catch { return { ...identity, error: mode === 'run' ? 'No response. Check this machine’s last run before retrying.' : 'Machine unavailable' }; }
  }));
  return { enabled: workspaceCleanupEnabled(), nodes };
}

app.get('/api/workspace-cleanup', requireAdmin, route(async (_request, response) => { response.json(await systemView('status')); }));
app.put('/api/workspace-cleanup', requireAdmin, route(async (request, response) => {
  const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(request.body);
  const { id } = await getClusterNode(), db = settingsDatabase();
  db.exec('BEGIN IMMEDIATE');
  try { saveSystemAiSetting(db, id, 'workspaceCleanup', JSON.stringify(enabled)); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
  response.json({ enabled });
}));
app.post('/api/workspace-cleanup/preview', requireAdmin, route(async (_request, response) => { response.json(await systemView('preview')); }));
app.post('/api/workspace-cleanup/run', requireAdmin, route(async (request, response) => {
  z.object({ confirm: z.literal(true) }).strict().parse(request.body);
  response.json(await systemView('run'));
}));
app.post('/api/workspace-cleanup/restore', requireAdmin, route(async (request, response) => {
  const { nodeId, ...recovery } = restore.extend({ nodeId: z.string().uuid() }).parse(request.body);
  const { id } = await getClusterNode();
  if (!await getProject(recovery.projectId)) { sendError(response, 404, 'Project not found'); return; }
  if (nodeId === id) { response.json(await onNode('restore', [recovery.projectId], recovery)); return; }
  const peer = (await twins(id)).find(item => item.id === nodeId);
  if (!peer) { sendError(response, 404, 'Recovery machine not found'); return; }
  response.json(await remote(peer, 'restore', [recovery.projectId], recovery));
}));

app.post('/api/cluster/workspace-cleanup/admin', twinRuntimeGuard, route(async (request, response) => {
  const command = remoteCommand.parse(request.body);
  const { id } = await getClusterNode(), db = await clusterV2Database();
  const ids = command.projectIds.filter(project => mayShareProject(db, id, response.locals.machineNodeId, project));
  response.json(await onNode(command.action, ids, command.recovery));
}));
app.post('/api/cluster/workspace-cleanup/check', twinRuntimeGuard, route(async (request, response) => {
  const input = z.object({ projectId, workspaceId: z.string().uuid(), reserve: z.boolean() }).strict().parse(request.body);
  const project = await getProject(input.projectId);
  if (!project) { response.json({ reason: 'Project unavailable' }); return; }
  await withProjectRuntime(project.id, async () => {
    const tree = (await listProjectWorktrees(project.id)).find(item => item.id === input.workspaceId);
    if (!tree) { response.json({ reason: 'Workspace copy unavailable' }); return; }
    if (tree.createdByNodeId !== response.locals.machineNodeId) { response.json({ reason: 'Workspace owner differs' }); return; }
    const release = input.reserve ? claimWorktreeCleanup(project.id, tree.id) : undefined;
    if (input.reserve && !release) { response.json({ reason: 'Another cleanup is checking this workspace' }); return; }
    try {
      const check = await workspaceCleanupCheck(project, tree);
      if (check.reason) release?.();
      response.json({ reason: check.reason, fingerprint: check.fingerprint, hasConversations: check.hasConversations });
    } catch (error) { release?.(); throw error; }
  });
}));
