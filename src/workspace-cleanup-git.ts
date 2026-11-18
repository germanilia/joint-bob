import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createProjectWorktree, readWorktreeBaseline, WORKTREE_META_DIR, type ProjectWorktree } from './project-worktrees.js';
import { execFile } from './subprocess.js';
import { copyAllowed, TICKET_BASELINE_DIR } from './task-workspaces.js';
import type { ProjectRecord } from './types.js';
import { worktreeHeavyDirectories, worktreeLinkedDirectories } from './worktree-filters.js';

const exec = promisify(execFile);
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const refPattern = /^refs\/joint-bob\/workspace-cleanup\/[a-zA-Z0-9_-]+\/[0-9a-f-]{36}\/[0-9a-f]{64}$/;
const gitObject = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const appDirectories = new Set([TICKET_BASELINE_DIR, WORKTREE_META_DIR]);
const generated = new Set<string>(worktreeHeavyDirectories.filter(dir => ['node_modules', '.venv', 'venv', '__pycache__'].includes(dir)));
const linked = new Set<string>(worktreeLinkedDirectories);
type SnapshotFile = { mode: '100644' | '100755' | '120000'; bytes: Buffer };
type Change = { file: string; before?: SnapshotFile; after?: SnapshotFile };
export type WorkspaceChanges = { base: string | null; fingerprint: string; entries: Change[]; updatedAt: number };

function safePath(root: string, file: string): string {
  if (file.split('/').some(part => !part || ['.', '..', '.git'].includes(part.toLowerCase())) || file.includes('\\')) throw new Error('Unsupported workspace path');
  return path.join(root, ...file.split('/'));
}

async function snapshotFile(file: string): Promise<SnapshotFile | undefined> {
  const stat = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!stat) return undefined;
  if (stat.isSymbolicLink()) return { mode: '120000', bytes: await fs.readlink(file, { encoding: 'buffer' }) };
  if (!stat.isFile() || stat.size > 60 * 1024 * 1024) throw new Error('Workspace file exceeds the supported recovery size or type');
  return { mode: stat.mode & 0o111 ? '100755' : '100644', bytes: await fs.readFile(file) };
}

export async function inspectWorkspaceChanges(project: ProjectRecord, workspace: ProjectWorktree): Promise<WorkspaceChanges> {
  const { metadata, baseline } = await readWorktreeBaseline(project.id, workspace.id, path.dirname(path.dirname(workspace.path)));
  const remaining = new Map(Object.entries(baseline.manifest.files));
  const entries: Change[] = [];
  let updatedAt = 0;
  const readBefore = async (file: string, before: NonNullable<ReturnType<typeof remaining.get>>): Promise<SnapshotFile> => {
    if ('symlink' in before) throw new Error('An original workspace link cannot be verified');
    const saved = await snapshotFile(safePath(path.join(workspace.path, TICKET_BASELINE_DIR), file));
    if (!saved || saved.mode === '120000' || sha(saved.bytes) !== before.sha256) throw new Error('Workspace baseline data could not be verified');
    return { mode: before.mode & 0o111 ? '100755' : '100644', bytes: saved.bytes };
  };
  const visit = async (dir: string, prefix = ''): Promise<void> => {
    updatedAt = Math.max(updatedAt, (await fs.lstat(dir)).mtimeMs);
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = prefix + entry.name;
      if ((!prefix && appDirectories.has(entry.name)) || file === '.joint-bob/worktree-local-files.json' || entry.name === '.DS_Store') continue;
      const full = safePath(workspace.path, file);
      if (entry.isDirectory() && generated.has(entry.name)) continue;
      if (entry.isSymbolicLink() && linked.has(entry.name) && await fs.readlink(full) === path.join(project.path, file)) continue;
      if (entry.isDirectory()) { await visit(full, `${file}/`); continue; }
      updatedAt = Math.max(updatedAt, (await fs.lstat(full)).mtimeMs);
      const after = (await snapshotFile(full))!;
      if (!copyAllowed(workspace.path, full)) {
        const original = await snapshotFile(safePath(project.path, file));
        if (original?.mode === after.mode && original.bytes.equals(after.bytes)) continue;
        throw new Error('Workspace contains excluded files not verified as copies of project files');
      }
      const before = remaining.get(file);
      remaining.delete(file);
      if (before && !('symlink' in before) && after.mode !== '120000' && sha(after.bytes) === before.sha256 && (after.mode === '100755') === Boolean(before.mode & 0o111)) continue;
      entries.push({ file, before: before && await readBefore(file, before), after });
    }
  };
  await visit(workspace.path);
  for (const [file, before] of remaining) entries.push({ file, before: await readBefore(file, before) });
  entries.sort((a, b) => a.file.localeCompare(b.file, 'en'));
  const base = metadata.gitBase ?? null;
  return { base, entries, updatedAt, fingerprint: sha(JSON.stringify([base, metadata.baselineDigest, entries.map(({file, before, after}) => [file, before?.mode, before && sha(before.bytes), after?.mode, after && sha(after.bytes)])])) };
}

const identity = { GIT_AUTHOR_NAME: 'Joint Bob', GIT_AUTHOR_EMAIL: 'workspace-cleanup@joint-bob.local', GIT_COMMITTER_NAME: 'Joint Bob', GIT_COMMITTER_EMAIL: 'workspace-cleanup@joint-bob.local' };
function git(project: ProjectRecord, args: string[], env: NodeJS.ProcessEnv = {}) {
  return exec('git', ['-C', project.path, '-c', 'core.fsync=all', ...args], { env: { ...process.env, ...identity, ...env }, encoding: 'buffer', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }).then(result => result.stdout);
}
const text = async (project: ProjectRecord, args: string[], env?: NodeJS.ProcessEnv) => (await git(project, args, env)).toString().trim();

/** Build a stash against a synthetic baseline containing only the changed paths. No shared index or stash stack writes. */
export async function saveWorkspaceStash(project: ProjectRecord, workspace: ProjectWorktree, changes: WorkspaceChanges): Promise<string> {
  const { base, entries, fingerprint } = changes;
  if (!base || !gitObject.test(base) || !entries.length) throw new Error('No Git base for the workspace changes');
  const ref = `refs/joint-bob/workspace-cleanup/${project.id}/${workspace.id}/${fingerprint}`;
  if (!refPattern.test(ref)) throw new Error('Invalid workspace recovery ref');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'joint-bob-cleanup-index-'));
  try {
    const tree = async (side: 'before' | 'after') => {
      const env = { GIT_INDEX_FILE: path.join(tmp, side) };
      await git(project, ['read-tree', '--empty'], env);
      for (const {file, [side]: saved} of entries) {
        if (!saved) continue;
        const tempFile = path.join(tmp, `${side}.blob`);
        await fs.writeFile(tempFile, saved.bytes, { mode: 0o600 });
        const blob = await text(project, ['hash-object', '-w', '--no-filters', '--', tempFile]);
        await git(project, ['update-index', '--add', '--cacheinfo', saved.mode, blob, file], env);
      }
      return text(project, ['write-tree'], env);
    };
    const [before, after] = await Promise.all([tree('before'), tree('after')]);
    const existing = await text(project, ['for-each-ref', '--format=%(objectname)', ref]);
    if (!existing) {
      const baseline = await text(project, ['commit-tree', before, '-p', base, '-m', 'Workspace cleanup baseline']);
      const index = await text(project, ['commit-tree', before, '-p', baseline, '-m', 'Workspace cleanup index']);
      const stash = await text(project, ['commit-tree', after, '-p', baseline, '-p', index, '-m', `Workspace cleanup: ${workspace.name}`]);
      await git(project, ['update-ref', ref, stash, '0'.repeat(stash.length)]);
    }
    if (await text(project, ['rev-parse', `${ref}^{tree}`]) !== after || await text(project, ['rev-parse', `${ref}^1^{tree}`]) !== before) throw new Error('Workspace stash verification failed');
    return ref;
  } finally { await fs.rm(tmp, { force: true, recursive: true }); }
}

async function materialize(project: ProjectRecord, root: string, files: string[], ref: string) {
  for (const file of [...files].sort((a, b) => b.length - a.length)) {
    const full = safePath(root, file);
    // Never follow a symlink in the staging copy when replacing a file.
    const parent = path.dirname(full);
    const resolved = await fs.realpath(parent).catch(error => { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; });
    if (resolved && resolved !== parent) throw new Error('Restore path crosses a link');
    if (!resolved) continue;
    const stat = await fs.lstat(full).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (stat && !stat.isDirectory()) await fs.unlink(full);
  }
  const listing = (await git(project, ['ls-tree', '-rz', ref])).toString();
  for (const row of listing.split('\0').filter(Boolean)) {
    const tab = row.indexOf('\t'), file = row.slice(tab + 1);
    const [mode, type, hash] = row.slice(0, tab).split(' ');
    if (!files.includes(file) || type !== 'blob' || !gitObject.test(hash)) throw new Error('Invalid workspace stash object');
    const full = safePath(root, file), parent = path.dirname(full);
    await fs.mkdir(parent, { recursive: true });
    if (await fs.realpath(parent) !== parent || !copyAllowed(root, full)) throw new Error('Unsafe workspace restore path');
    // Removing an empty directory is safe; an unrelated non-empty one fails without publishing the workspace.
    await fs.rmdir(full).catch(error => { if (error.code !== 'ENOENT') throw error; });
    const bytes = await git(project, ['cat-file', 'blob', hash]);
    if (mode === '120000') await fs.symlink(bytes, full);
    else await fs.writeFile(full, bytes, { flag: 'wx', mode: mode === '100755' ? 0o755 : 0o644 });
  }
}

export async function restoreWorkspaceStash(project: ProjectRecord, ref: string, name: string, root?: string) {
  if (!refPattern.test(ref) || !ref.startsWith(`refs/joint-bob/workspace-cleanup/${project.id}/`)) throw new Error('Invalid workspace recovery ref');
  const before = `${ref}^1`;
  const files = (await git(project, ['diff-tree', '-r', '--no-renames', '--name-only', '-z', before, ref])).toString().split('\0').filter(Boolean);
  return createProjectWorktree(project, { name, restore: {
    beforeBaseline: async staging => materialize(project, await fs.realpath(staging), files, before),
    afterBaseline: async staging => materialize(project, await fs.realpath(staging), files, ref),
  } }, root);
}
