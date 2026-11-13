import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { runtimeExec } from "./account-runtime.js";
import { execFile, spawn } from "./subprocess.js";
import { assertOpContained } from "./merge-journal.js";

/* A worktree's history lives in its project's repository, never in the worktree: the worktree
   starts as a commit of the remote's default branch, and its pull request is built there too.
   A node's own HEAD plays no part, since file sync moves the files between nodes but not `.git`,
   so HEAD can sit days behind the files it describes. */

const execute = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const COMMIT = /^[0-9a-f]{40}$/;
const BRANCH = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*\.lock$)[A-Za-z0-9._/-]{1,200}(?<!\/)$/;
const BINARY_SNIFF_BYTES = 8192;
/** The local commits only feed `merge-tree`; the published commit is written through GitHub. */
const IDENTITY = { GIT_AUTHOR_NAME: "Joint Bob", GIT_AUTHOR_EMAIL: "joint-bob@localhost", GIT_COMMITTER_NAME: "Joint Bob", GIT_COMMITTER_EMAIL: "joint-bob@localhost" };

interface GitResult { code: number; stdout: Buffer; stderr: string }
type Git = (args: string[], options?: { input?: string | Buffer; env?: NodeJS.ProcessEnv; timeout?: number }) => Promise<GitResult>;

export interface WorktreeFileChange { path: string; content: Buffer; executable: boolean }
export interface WorktreeChanges { gitBase: string | null; writes: WorktreeFileChange[]; deletes: string[]; uncommittedPaths: string[] }

/** git in the project's repository, as the account that owns it, never prompting. Exit statuses come back; a kill or timeout throws. */
function projectGit(cwd: string, env: NodeJS.ProcessEnv): Git {
  return async (args, options = {}) => {
    const launch = runtimeExec("git", ["-C", cwd, ...args], { ...process.env, ...env, ...options.env, GIT_TERMINAL_PROMPT: "0" });
    const pending = execute(launch.command, launch.args, { env: launch.env, encoding: "buffer", timeout: options.timeout ?? GIT_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES });
    pending.child.stdin?.on("error", () => undefined);
    pending.child.stdin?.end(options.input ?? "");
    try {
      const { stdout, stderr } = await pending;
      return { code: 0, stdout, stderr: stderr.toString() };
    } catch (error) {
      const failure = error as Error & { code?: unknown; killed?: boolean; stdout?: Buffer; stderr?: Buffer };
      if (typeof failure.code === "number" && !failure.killed) return { code: failure.code, stdout: failure.stdout ?? Buffer.alloc(0), stderr: failure.stderr?.toString() ?? "" };
      throw new Error(`git ${args[0]} failed: ${failure.stderr?.toString().trim() || failure.message}`);
    }
  };
}

async function output(git: Git, args: string[], options?: Parameters<Git>[1]): Promise<string> {
  const result = await git(args, options);
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || `exit status ${result.code}`}`);
  return result.stdout.toString().trim();
}

/** The branch pull requests go into: origin's default branch, else the project branch's upstream. */
async function remoteBranch(git: Git): Promise<{ remote: string; branch: string } | null> {
  const head = /^refs\/remotes\/origin\/(.+)$/.exec((await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])).stdout.toString().trim());
  if (head && BRANCH.test(head[1])) return { remote: "origin", branch: head[1] };
  const current = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.toString().trim();
  if (current) {
    const remote = (await git(["config", "--get", `branch.${current}.remote`])).stdout.toString().trim();
    const merge = /^refs\/heads\/(.+)$/.exec((await git(["config", "--get", `branch.${current}.merge`])).stdout.toString().trim());
    if (/^[A-Za-z0-9._-]+$/.test(remote) && merge && BRANCH.test(merge[1])) return { remote, branch: merge[1] };
  }
  for (const branch of ["main", "master"]) {
    if ((await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}^{commit}`])).code === 0) return { remote: "origin", branch };
  }
  return null;
}

/** The branch's commit on the remote now; when the fetch fails, the one fetched last. */
async function fetchBranch(git: Git, remote: string, branch: string): Promise<{ commit: string | null; fetched: boolean }> {
  const ref = `refs/remotes/${remote}/${branch}`;
  const fetch = await git(["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${branch}:${ref}`], { timeout: FETCH_TIMEOUT_MS }).catch(() => null);
  const commit = (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).stdout.toString().trim();
  return { commit: COMMIT.test(commit) ? commit : null, fetched: fetch?.code === 0 };
}

interface TreeFile { mode: string; blob: string; size: number; path: string }

async function commitFiles(git: Git, commit: string): Promise<TreeFile[]> {
  const files: TreeFile[] = [];
  for (const record of (await git(["ls-tree", "-r", "-z", "--long", "--full-tree", commit])).stdout.toString().split("\0")) {
    const entry = /^(\d{6}) blob ([0-9a-f]{40}) +(\d+)\t(.+)$/s.exec(record);
    if (entry) files.push({ mode: entry[1], blob: entry[2], size: Number(entry[3]), path: entry[4] });
  }
  return files;
}

/** Streams blobs out of `git cat-file --batch`, one at a time, in the order asked. */
async function readBlobs(cwd: string, env: NodeJS.ProcessEnv, blobs: string[], each: (index: number, content: Buffer) => Promise<void>): Promise<void> {
  if (!blobs.length) return;
  const launch = runtimeExec("git", ["-C", cwd, "cat-file", "--batch"], { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" });
  const child = spawn(launch.command, launch.args, { env: launch.env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk; });
  child.stdin!.on("error", () => undefined);
  const exited = new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  exited.catch(() => undefined);
  child.stdin!.end(blobs.map((blob) => `${blob}\n`).join(""));
  let buffer: Buffer = Buffer.alloc(0);
  let next = 0;
  try {
    for await (const chunk of child.stdout!) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk as Buffer]) : chunk as Buffer;
      for (;;) {
        const newline = buffer.indexOf(10);
        if (newline < 0) break;
        const [, type, size] = buffer.subarray(0, newline).toString().split(" ");
        if (type !== "blob") throw new Error(`git cat-file could not read ${blobs[next]}`);
        const end = newline + 1 + Number(size);
        if (buffer.length < end + 1) break;
        await each(next, buffer.subarray(newline + 1, end));
        next += 1;
        buffer = buffer.subarray(end + 1);
      }
    }
  } catch (error) {
    child.kill();
    throw error;
  }
  const code = await exited;
  if (code !== 0 || next !== blobs.length) throw new Error(`git cat-file failed: ${stderr.trim() || `exit status ${code}`}`);
}

/** Writes the commit's regular files that `allowed` keeps into `target`, skipping binaries, as a checkout would write them. */
async function exportCommit(cwd: string, env: NodeJS.ProcessEnv, git: Git, commit: string, target: string, allowed: (relative: string, size: number) => boolean): Promise<number> {
  const files = (await commitFiles(git, commit)).filter((file) => (file.mode === "100644" || file.mode === "100755") && allowed(file.path, file.size));
  let written = 0;
  await readBlobs(cwd, env, files.map((file) => file.blob), async (index, content) => {
    if (content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return;
    const file = path.join(target, ...files[index].path.split("/"));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, { mode: files[index].mode === "100755" ? 0o755 : 0o644 });
    written += 1;
  });
  return written;
}

export async function exportWorktreeCommit(projectPath: string, env: NodeJS.ProcessEnv, commit: string, target: string): Promise<Array<{ path: string; hash: string; executable: boolean }>> {
  if (!COMMIT.test(commit)) throw new Error("Invalid worktree commit");
  const git = projectGit(projectPath, env);
  const files = await commitFiles(git, commit);
  if (files.some(file => path.isAbsolute(file.path) || file.path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git"))) throw new Error("Candidate contains an unsafe Git path");
  if (files.some(file => !["100644", "100755"].includes(file.mode)) || /^160000 commit /m.test(await output(git, ["ls-tree", "-r", commit]))) throw new Error("Candidate verification requires regular Git files; symlinks and submodules need explicit support");
  const manifest: Array<{ path: string; hash: string; executable: boolean }> = [];
  await readBlobs(projectPath, env, files.map(file => file.blob), async (index, content) => {
    const file = files[index];
    const destination = path.join(target, ...file.path.split("/"));
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.writeFile(destination, content, { mode: file.mode === "100755" ? 0o755 : 0o644 });
    manifest.push({ path: file.path, hash: createHash("sha256").update(content).digest("hex"), executable: file.mode === "100755" });
  });
  return manifest;
}

export interface WorktreeBase { commit: string; ref: string; fetched: boolean }

/**
 * Fills `target` with the remote default branch as it is now: the base a pull request goes into,
 * with none of the project folder's uncommitted work. Null when the project is not the root of a
 * repository with a remote branch, so the caller copies the folder instead.
 */
export async function exportWorktreeBase(projectPath: string, env: NodeJS.ProcessEnv, target: string, allowed: (relative: string, size: number) => boolean, useLocalMain = false): Promise<WorktreeBase | null> {
  const git = projectGit(projectPath, env);
  const top = await git(["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return null;
  const [root, project] = await Promise.all([fs.realpath(top.stdout.toString().trim()), fs.realpath(projectPath)]);
  if (root !== project) return null;
  if (useLocalMain) {
    const commit = await localMain(git, projectPath);
    await exportCommit(projectPath, env, git, commit, target, allowed);
    return { commit, ref: "main", fetched: true };
  }
  const branch = await remoteBranch(git);
  if (!branch) return null;
  const { commit, fetched } = await fetchBranch(git, branch.remote, branch.branch);
  if (!commit) return null;
  await exportCommit(projectPath, env, git, commit, target, allowed);
  return { commit, ref: `${branch.remote}/${branch.branch}`, fetched };
}

/** The project folder's git-ignored files and folders (local configuration and the like), folders collapsed. */
export async function ignoredPaths(projectPath: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const listing = await output(projectGit(projectPath, env), ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]).catch(() => "");
  return listing.split("\0").map((entry) => entry.replace(/\/$/, "")).filter(Boolean);
}

/** `git diff-tree --raw -z` entries: `:modes blobs status\0path\0`. */
function rawChanges(text: string): Array<{ file: string; mode: string; blob: string; status: string }> {
  const fields = text.split("\0");
  const changes: Array<{ file: string; mode: string; blob: string; status: string }> = [];
  for (let index = 0; index + 1 < fields.length; index += 1) {
    if (!fields[index].startsWith(":")) continue;
    const [, mode, , blob, status] = fields[index].slice(1).split(" ");
    changes.push({ file: fields[index + 1], mode, blob, status });
    index += 1;
  }
  return changes;
}

/** Commits the worktree's changes on its base with a throwaway index; nothing in the project's checkout moves. */
async function commitChanges(projectPath: string, git: Git, gitBase: string, changes: WorktreeChanges): Promise<string> {
  const entries: string[] = [];
  for (const file of changes.writes) {
    const blob = await output(git, ["hash-object", "-w", "--stdin"], { input: file.content });
    entries.push(`${file.executable ? "100755" : "100644"} ${blob}\t${file.path}\0`);
  }
  for (const file of changes.deletes) entries.push(`0 ${"0".repeat(40)}\t${file}\0`);
  const index = path.resolve(projectPath, await output(git, ["rev-parse", "--git-path", `joint-bob-worktree-${randomUUID()}.index`]));
  const env = { GIT_INDEX_FILE: index };
  try {
    await output(git, ["read-tree", gitBase], { env });
    await output(git, ["update-index", "-z", "--index-info"], { env, input: entries.join("") });
    const tree = await output(git, ["write-tree"], { env });
    return await output(git, ["commit-tree", tree, "-p", gitBase, "-m", "Joint Bob worktree changes"], { env: IDENTITY });
  } finally {
    await fs.rm(index, { force: true }).catch(() => undefined);
  }
}

export interface LocalWorktreeCandidate {
  status: "prepared";
  reconciliation?: boolean;
  targetCommit: string;
  commit: string;
  tree: string;
  digest: string;
  paths: string[];
}
export interface LocalWorktreeConflict {
  status: "conflict";
  targetCommit: string;
  digest: string;
  conflicts: string[];
}

/** A stable identifier for the exact task contribution, including modes and deletions. */
export function worktreeChangesDigest(changes: WorktreeChanges): string {
  return createHash("sha256").update(JSON.stringify({
    base: changes.gitBase,
    writes: [...changes.writes].sort((a, b) => a.path.localeCompare(b.path)).map(file => [file.path, file.executable, createHash("sha256").update(file.content).digest("hex")]),
    deletes: [...changes.deletes].sort(),
    uncommittedPaths: [...changes.uncommittedPaths].sort(),
  })).digest("hex");
}

async function localMain(git: Git, projectPath: string): Promise<string> {
  const root = await output(git, ["rev-parse", "--show-toplevel"]);
  if (await fs.realpath(root) !== await fs.realpath(projectPath)) throw new Error("Local integration requires the project to be the repository root");
  const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch.code !== 0 || branch.stdout.toString().trim() !== "main") throw new Error("Local integration requires the project checkout on main; no branch was switched");
  if (await output(git, ["ls-files", "--unmerged"])) throw new Error("Project index has unresolved conflicts");
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
    const file = await output(git, ["rev-parse", "--git-path", marker]);
    try { await fs.lstat(path.resolve(projectPath, file)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    throw new Error(`Project has an unfinished Git operation: ${marker}`);
  }
  return output(git, ["rev-parse", "HEAD"]);
}

function validateLocalChanges(changes: WorktreeChanges, title: string): void {
  if (!changes.gitBase || !COMMIT.test(changes.gitBase)) throw new Error("Worktree needs a recorded Git base before local integration");
  if (changes.uncommittedPaths.length) throw new Error("Worktree inherited uncommitted project edits; separate them before integration");
  if (!title.trim() || title.length > 256 || /[\r\n\0]/.test(title)) throw new Error("Commit title must be a single line of 1–256 characters");
  const paths = [...changes.writes.map(file => file.path), ...changes.deletes];
  if (new Set(paths).size !== paths.length) throw new Error("Duplicate worktree change paths");
  for (const file of paths) {
    if (file.includes("\0") || file.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) throw new Error(`Invalid worktree change path: ${file}`);
  }
}

/** Prepares a task-only commit without changing HEAD, the shared index, or working files. */
export async function prepareLocalWorktreeCommit(projectPath: string, env: NodeJS.ProcessEnv, changes: WorktreeChanges, title: string, resolutionTarget?: string): Promise<LocalWorktreeCandidate | LocalWorktreeConflict> {
  validateLocalChanges(changes, title);
  const git = projectGit(projectPath, env);
  let targetCommit = await localMain(git, projectPath);
  if (changes.gitBase && (await git(["merge-base", "--is-ancestor", changes.gitBase, targetCommit])).code !== 0) {
    const reconciliation = await reconcileWorktreeMain(projectPath, env, changes.gitBase);
    if (reconciliation.status === "blocked") throw new Error(`Main reconciliation blocked: ${reconciliation.reason}. Paths: ${reconciliation.conflicts.join(", ")}. Run reconcile-main for diagnostics; do not reset shared files.`);
    targetCommit = await localMain(git, projectPath);
  }
  if (resolutionTarget !== undefined && resolutionTarget !== targetCommit) throw new Error("Main changed since conflict resolution; inspect the new revision before retrying");
  const digest = worktreeChangesDigest(changes);
  const base = changes.gitBase!;
  if ((await git(["merge-base", "--is-ancestor", base, targetCommit])).code !== 0) throw new Error("Local main does not contain the worktree base; synchronize committed main before integrating");
  const taskCommit = await commitChanges(projectPath, git, base, changes);
  const merged = await git(["merge-tree", "--write-tree", "-z", "--name-only", "--no-messages", `--merge-base=${base}`, targetCommit, taskCommit]);
  let [tree, ...conflicts] = merged.stdout.toString().split("\0");
  const paths = [...new Set(conflicts.filter(Boolean))].sort();
  if (merged.code === 1 && !resolutionTarget) return { status: "conflict", targetCommit, digest, conflicts: paths };
  if ((merged.code !== 0 && merged.code !== 1) || !COMMIT.test(tree)) throw new Error(`Cannot prepare local integration: ${merged.stderr.trim()}`);
  if (merged.code === 1) {
    if (paths.some(file => !changes.writes.some(write => write.path === file) && !changes.deletes.includes(file))) throw new Error("Every conflict needs an explicit worktree write or deletion before resolution");
    const mergedCommit = await output(git, ["commit-tree", tree, "-p", targetCommit, "-m", "Joint Bob conflict preparation"], { env: IDENTITY });
    const resolved = await commitChanges(projectPath, git, mergedCommit, { ...changes, writes: changes.writes.filter(file => paths.includes(file.path)), deletes: changes.deletes.filter(file => paths.includes(file)) });
    tree = await output(git, ["rev-parse", `${resolved}^{tree}`]);
  }
  const delta = rawChanges(await output(git, ["diff-tree", "-r", "-z", "--no-renames", "--no-abbrev", targetCommit, tree]));
  if (delta.some(file => file.status !== "D" && !["100644", "100755"].includes(file.mode))) throw new Error("Local integration contains unsupported file types");
  const commit = delta.length ? await output(git, ["commit-tree", tree, "-p", targetCommit, "-m", title], { env: IDENTITY }) : targetCommit;
  return { status: "prepared", targetCommit, commit, tree, digest, paths: delta.map(file => file.file).sort() };
}

interface LocalIntegrationJournal {
  candidate: LocalWorktreeCandidate;
  phase: "prepared" | "installing" | "committed";
  beforeIndexHash: string;
  installedIndexTree: string;
}

const activeIntegrations = new Set<string>();
const hashBytes = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

async function syncContainingDirectory(directory: string): Promise<void> {
  let handle;
  try { handle = await fs.open(directory, "r"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return syncContainingDirectory(path.dirname(directory));
  }
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeIndexSnapshot(file: string, bytes: Buffer): Promise<void> {
  const handle = await fs.open(file, "w", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function durableJournal(file: string, value: LocalIntegrationJournal): Promise<void> {
  const temporary = `${file}.tmp`;
  const handle = await fs.open(temporary, "w", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temporary, file);
  const directory = await fs.open(path.dirname(file), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function integrationJournal(file: string): Promise<LocalIntegrationJournal | null> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as LocalIntegrationJournal; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** Git's index lock also prevents ordinary commits/staging while files and the ref are installed. */
async function lockIntegration(indexLock: string, operationId: string, recovering: boolean): Promise<void> {
  try {
    const handle = await fs.open(indexLock, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify({ jointBobOperation: operationId, pid: process.pid })); await handle.sync(); }
    finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let owner: { jointBobOperation: string; pid: number };
    try { owner = JSON.parse(await fs.readFile(indexLock, "utf8")); }
    catch { throw new Error("Git index is locked by another operation; no files were changed"); }
    if (!recovering || owner.jointBobOperation !== operationId || !Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error("Git index is locked by another operation; no files were changed");
    if (owner.pid !== process.pid) {
      try { process.kill(owner.pid, 0); }
      catch (failure) { if ((failure as NodeJS.ErrnoException).code === "ESRCH") { await fs.unlink(indexLock); return lockIntegration(indexLock, operationId, false); } throw failure; }
      throw new Error("Integration is still running in another process");
    }
    // Only a failed call in this process can leave our lock; activeIntegrations excludes live calls.
  }
}

async function candidateFilesMatch(git: Git, candidate: LocalWorktreeCandidate, commit: string): Promise<boolean> {
  if (!candidate.paths.length) return true;
  const result = await git(["diff", "--quiet", commit, "--", ...candidate.paths]);
  if (result.code > 1) throw new Error(`Cannot verify installed files: ${result.stderr.trim()}`);
  return result.code === 0;
}

async function prepareInstallation(git: Git, projectPath: string, candidate: LocalWorktreeCandidate, index: string, shadow: string, journalFile: string): Promise<LocalIntegrationJournal> {
  if (await localMain(git, projectPath) !== candidate.targetCommit) throw new Error("Local main changed; prepare and verify a new candidate");
  for (const file of candidate.paths) await assertOpContained(projectPath, file);
  if (candidate.paths.length) {
    const dirty = await output(git, ["status", "--porcelain", "--untracked-files=all", "--", ...candidate.paths]);
    if (candidate.reconciliation) {
      if (!await candidateFilesMatch(git, candidate, candidate.commit)) throw new Error("Synced files changed before reconciliation; no history was advanced");
      if ((await git(["diff", "--cached", "--quiet", candidate.targetCommit, "--", ...candidate.paths])).code !== 0) throw new Error("Staged edits overlap reconciliation; no history was advanced");
    } else if (dirty) throw new Error(`Protected uncommitted edits overlap this task:\n${dirty}`);
  }
  const bytes = await fs.readFile(index);
  await writeIndexSnapshot(`${shadow}.before`, bytes);
  await writeIndexSnapshot(shadow, bytes);
  const env = { GIT_INDEX_FILE: shadow };
  await output(git, ["read-tree", "-i", "-m", candidate.targetCommit, candidate.commit], { env });
  const installedIndexTree = await output(git, ["write-tree"], { env });
  const journal: LocalIntegrationJournal = { candidate, phase: "prepared", beforeIndexHash: hashBytes(bytes), installedIndexTree };
  await durableJournal(journalFile, journal);
  return journal;
}

async function finishInstallation(git: Git, projectPath: string, journal: LocalIntegrationJournal, files: { index: string; lock: string; shadow: string; journal: string }): Promise<void> {
  const candidate = journal.candidate;
  const env = { GIT_INDEX_FILE: files.shadow };
  const head = await localMain(git, projectPath);
  if (head !== candidate.targetCommit && head !== candidate.commit) throw new Error("Main changed during integration; inspect the retained operation before recovery");
  const before = await candidateFilesMatch(git, candidate, candidate.targetCommit);
  const after = await candidateFilesMatch(git, candidate, candidate.commit);
  const indexHash = hashBytes(await fs.readFile(files.index));
  if (head === candidate.commit && after && (await git(["diff-index", "--cached", "--quiet", journal.installedIndexTree, "--"])).code === 0) {
    journal.phase = "committed"; await durableJournal(files.journal, journal); return;
  }
  if (indexHash !== journal.beforeIndexHash) throw new Error("Project index changed during integration; retained operation needs inspection");
  if (!after) {
    if (candidate.reconciliation) throw new Error("Synced files changed during reconciliation; retained operation needs inspection");
    if (!before || head !== candidate.targetCommit) throw new Error("Project files changed during integration; retained operation needs inspection");
    await fs.copyFile(`${files.shadow}.before`, files.shadow);
    journal.phase = "installing"; await durableJournal(files.journal, journal);
    await output(git, ["read-tree", "-m", "-u", candidate.targetCommit, candidate.commit], { env });
    if (!await candidateFilesMatch(git, candidate, candidate.commit)) throw new Error("Installed files differ from the verified candidate; recovery retained");
  }
  if (await output(git, ["write-tree"], { env }) !== journal.installedIndexTree) throw new Error("Prepared index differs from the recorded integration");
  for (const file of candidate.paths) {
    await assertOpContained(projectPath, file);
    const target = path.join(projectPath, file);
    let handle;
    try { handle = await fs.open(target, "r"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (handle) { try { await handle.sync(); } finally { await handle.close(); } }
    await syncContainingDirectory(path.dirname(target));
  }
  const handle = await fs.open(files.shadow, "r");
  try { await handle.sync(); } finally { await handle.close(); }
  if (head === candidate.targetCommit && candidate.commit !== head) await output(git, ["update-ref", "-m", "Joint Bob worktree integration", "refs/heads/main", candidate.commit, candidate.targetCommit]);
  await fs.rename(files.shadow, files.index);
  const directory = await fs.open(path.dirname(files.index), "r");
  try { await directory.sync(); } finally { await directory.close(); }
  if (await localMain(git, projectPath) !== candidate.commit || !await candidateFilesMatch(git, candidate, candidate.commit)) throw new Error("Integration changed before final verification; worktree retained");
  journal.phase = "committed"; await durableJournal(files.journal, journal);
}

/** Install a caller-verified candidate. An uncertain operation retains its lock and journal for explicit same-ID recovery. */
export async function installLocalWorktreeCommit(projectPath: string, env: NodeJS.ProcessEnv, candidate: LocalWorktreeCandidate, operationId: string): Promise<{ operationId: string; commit: string }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operationId)) throw new Error("Invalid integration operation ID");
  if (![candidate.targetCommit, candidate.commit, candidate.tree].every(value => COMMIT.test(value))) throw new Error("Invalid candidate commit");
  const git = projectGit(projectPath, env);
  const tree = await output(git, ["rev-parse", `${candidate.commit}^{tree}`]);
  const paths = rawChanges(await output(git, ["diff-tree", "-r", "-z", "--no-renames", "--no-abbrev", candidate.targetCommit, candidate.commit])).map(file => file.file).sort();
  const parents = (await output(git, ["rev-list", "--parents", "-n", "1", candidate.commit])).split(" ").slice(1);
  const validHistory = candidate.reconciliation
    ? (await git(["merge-base", "--is-ancestor", candidate.targetCommit, candidate.commit])).code === 0
    : candidate.commit === candidate.targetCommit || (parents.length === 1 && parents[0] === candidate.targetCommit);
  if (tree !== candidate.tree || JSON.stringify(paths) !== JSON.stringify(candidate.paths) || !validHistory) throw new Error("Candidate metadata does not match its Git commit");
  const directory = await output(git, ["rev-parse", "--absolute-git-dir"]);
  if (activeIntegrations.has(directory)) throw new Error("Another integration is running for this project");
  activeIntegrations.add(directory);
  const store = path.join(directory, "joint-bob-integrations");
  const files = { index: path.join(directory, "index"), lock: path.join(directory, "index.lock"), shadow: path.join(store, `${operationId}.index`), journal: path.join(store, `${operationId}.json`) };
  let locked = false;
  let journal: LocalIntegrationJournal | null = null;
  try {
    await fs.mkdir(store, { recursive: true, mode: 0o700 });
    await syncContainingDirectory(directory);
    journal = await integrationJournal(files.journal);
    if (journal && (journal.candidate.digest !== candidate.digest || journal.candidate.commit !== candidate.commit)) throw new Error("Integration operation belongs to a different candidate revision");
    if (journal?.phase === "committed") {
      if ((await git(["merge-base", "--is-ancestor", candidate.commit, await localMain(git, projectPath)])).code !== 0) throw new Error("Recorded integration commit is no longer on main");
      return { operationId, commit: candidate.commit };
    }
    await localMain(git, projectPath);
    await lockIntegration(files.lock, operationId, journal !== null); locked = true;
    if (!journal) journal = await prepareInstallation(git, projectPath, candidate, files.index, files.shadow, files.journal);
    await finishInstallation(git, projectPath, journal, files);
    return { operationId, commit: candidate.commit };
  } finally {
    try { if (locked && (!journal || journal.phase === "prepared" || journal.phase === "committed")) await fs.unlink(files.lock); }
    finally { activeIntegrations.delete(directory); }
  }
}

export interface MainReconciliationResult {
  status: "current" | "reconciled" | "blocked";
  targetCommit: string;
  conflicts: string[];
  reason?: string;
}

/** Advance only already-synced history; never rewrite shared working files or discard staged edits. */
export async function reconcileWorktreeMain(projectPath: string, env: NodeJS.ProcessEnv, requiredBase?: string): Promise<MainReconciliationResult> {
  const git = projectGit(projectPath, env);
  const head = await localMain(git, projectPath);
  const blocked = (reason: string, conflicts: string[] = []): MainReconciliationResult => ({ status: "blocked", targetCommit: head, reason, conflicts });
  if (requiredBase !== undefined && !COMMIT.test(requiredBase)) throw new Error("Invalid worktree base commit");
  const remote = await remoteBranch(git);
  if (!remote) return blocked("No configured upstream; configure the project's Git remote");
  const fetched = await fetchBranch(git, remote.remote, remote.branch);
  if (!fetched.fetched || !fetched.commit) return blocked("Upstream fetch failed; restore remote access before retrying reconcile-main");
  const upstream = fetched.commit;
  if (requiredBase && (await git(["merge-base", "--is-ancestor", requiredBase, upstream])).code !== 0) return blocked("Upstream does not contain the worktree base; inspect the project's history");
  // Stable across retries, including a crash between advancing the ref and installing the index.
  const hash = createHash("sha256").update(`reconcile-main:${upstream}`).digest("hex");
  const operationId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  const directory = await output(git, ["rev-parse", "--absolute-git-dir"]);
  const previous = await integrationJournal(path.join(directory, "joint-bob-integrations", `${operationId}.json`));
  if (previous && previous.phase !== "committed") {
    await installLocalWorktreeCommit(projectPath, env, previous.candidate, operationId);
    return { status: "reconciled", targetCommit: upstream, conflicts: [] };
  }
  if (head === upstream || (await git(["merge-base", "--is-ancestor", upstream, head])).code === 0) return { status: "current", targetCommit: head, conflicts: [] };
  if ((await git(["merge-base", "--is-ancestor", head, upstream])).code !== 0) return blocked("Local main and upstream diverged; local commits were retained");
  const paths = rawChanges(await output(git, ["diff-tree", "-r", "-z", "--no-renames", "--no-abbrev", head, upstream])).map(file => file.file).sort();
  const conflicts: string[] = [];
  for (const file of paths) {
    await assertOpContained(projectPath, file);
    const disk = await git(["diff", "--quiet", upstream, "--", file]);
    const staged = await git(["diff", "--cached", "--quiet", head, "--", file]);
    if (disk.code > 1 || staged.code > 1) throw new Error(`Cannot inspect reconciliation path: ${file}`);
    if (disk.code !== 0 || staged.code !== 0) conflicts.push(file);
  }
  if (conflicts.length) return blocked("Upstream paths have unsynced files or staged edits; let file sync finish or resolve those edits with their owner", conflicts);
  const candidate: LocalWorktreeCandidate = { status: "prepared", reconciliation: true, targetCommit: head, commit: upstream,
    tree: await output(git, ["rev-parse", `${upstream}^{tree}`]), digest: hash, paths };
  await installLocalWorktreeCommit(projectPath, env, candidate, operationId);
  return { status: "reconciled", targetCommit: upstream, conflicts: [] };
}

export type RebasedWorktreeChanges =
  | { baseCommit: string; writes: WorktreeFileChange[]; deletes: string[] }
  | { baseCommit: string; conflicts: string[] };

/**
 * The worktree's changes replayed on the base branch as it is now: a three-way merge from the commit
 * the worktree started at, so the pull request starts from today's branch and carries only the
 * worktree's own edits. Conflicting files come back instead. Null when the repository cannot
 * provide both commits; the caller then publishes on the worktree's own base.
 */
export async function rebaseWorktreeChanges(projectPath: string, env: NodeJS.ProcessEnv, changes: WorktreeChanges, base: string): Promise<RebasedWorktreeChanges | null> {
  const gitBase = changes.gitBase;
  if (!gitBase || !COMMIT.test(gitBase) || !BRANCH.test(base)) return null;
  const git = projectGit(projectPath, env);
  const { commit: onto } = await fetchBranch(git, "origin", base);
  if (!onto) return null;
  const present = async () => (await git(["cat-file", "-e", `${gitBase}^{commit}`])).code === 0;
  if (!await present()) {
    await git(["fetch", "--quiet", "--no-tags", "origin", gitBase], { timeout: FETCH_TIMEOUT_MS }).catch(() => null);
    if (!await present()) return null;
  }
  const commit = await commitChanges(projectPath, git, gitBase, changes);
  let tree: string;
  if (onto === gitBase) tree = await output(git, ["rev-parse", `${commit}^{tree}`]);
  else {
    const merged = await git(["merge-tree", "--write-tree", "-z", "--name-only", "--no-messages", `--merge-base=${gitBase}`, onto, commit]);
    const [written, ...conflicted] = merged.stdout.toString().split("\0");
    if (merged.code === 1) return { baseCommit: onto, conflicts: [...new Set(conflicted.filter(Boolean))].sort() };
    if (merged.code !== 0 || !COMMIT.test(written)) throw new Error(`git merge-tree failed: ${merged.stderr.trim() || `exit status ${merged.code}`}`);
    tree = written;
  }
  const writes: WorktreeFileChange[] = [];
  const deletes: string[] = [];
  for (const change of rawChanges(await output(git, ["diff-tree", "-r", "-z", "--no-renames", "--no-abbrev", onto, tree]))) {
    if (change.status === "D") deletes.push(change.file);
    else if (change.mode === "100644" || change.mode === "100755") {
      const blob = await git(["cat-file", "blob", change.blob]);
      if (blob.code !== 0) throw new Error(`git cat-file could not read ${change.file}`);
      writes.push({ path: change.file, content: blob.stdout, executable: change.mode === "100755" });
    }
  }
  return { baseCommit: onto, writes, deletes };
}
