import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { runtimeExec } from "./account-runtime.js";
import { getClusterNode } from "./cluster.js";
import { resolveDataDirectory } from "./data-directory.js";
import { worktreeHasPendingFiles } from "./file-sync/facade.js";
import { openNodeDatabase } from "./node-database.js";
import { deleteProjectWorktree, ensureWorktreeLocalFiles, getProjectWorktree, ProjectWorktreeError, worktreeChanges, worktreePathAllowed, worktreeRoot, withoutGitIgnored, WORKTREE_META_DIR } from "./project-worktrees.js";
import { nodeSettings } from "./settings.js";
import { spawn } from "./subprocess.js";
import { captureBaseline, TICKET_BASELINE_DIR, TICKET_MERGE_DIR } from "./task-workspaces.js";
import type { ProjectRecord } from "./types.js";
import { exportWorktreeCommit, installLocalWorktreeCommit, prepareLocalWorktreeCommit, worktreeChangesDigest, type LocalWorktreeCandidate } from "./worktree-git.js";

export interface WorktreeIntegrationInput { operationId: string; title: string; check: string; resolutionTarget?: string; ownerId?: string; deferCleanup?: boolean }
export interface WorktreeIntegrationResult {
  operationId: string;
  status: "committed" | "verification-failed" | "conflict";
  worktreeDeleted: boolean;
  commit?: string;
  checkExitCode?: number;
  conflicts?: string[];
  targetCommit?: string;
}
interface Receipt {
  projectId: string; worktreeId: string; ownerId?: string; requestHash: string; candidate: LocalWorktreeCandidate;
  phase: "verifying" | "verified" | "finished";
  result: WorktreeIntegrationResult | null;
}
let database: DatabaseSync | undefined;
const pending = new Map<string, Promise<unknown>>();

function db(): DatabaseSync {
  if (database) return database;
  database = openNodeDatabase(path.join(resolveDataDirectory(), "node.db"));
  database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
  database.exec("CREATE TABLE IF NOT EXISTS worktree_integrations(operation_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, worktree_id TEXT NOT NULL, receipt TEXT NOT NULL)");
  return database;
}
function load(id: string): Receipt | null {
  const row = db().prepare("SELECT receipt FROM worktree_integrations WHERE operation_id=?").get(id) as { receipt: string } | undefined;
  return row ? JSON.parse(row.receipt) : null;
}
function save(id: string, receipt: Receipt): void {
  db().prepare("UPDATE worktree_integrations SET receipt=? WHERE operation_id=? AND project_id=? AND worktree_id=?")
    .run(JSON.stringify(receipt), id, receipt.projectId, receipt.worktreeId);
}

export function integrationStatus(projectId: string, operationId: string, ownerId: string): { worktreeId: string; phase: Receipt["phase"]; result: WorktreeIntegrationResult | null } | null {
  const receipt = load(operationId);
  if (!receipt || receipt.projectId !== projectId || receipt.ownerId !== ownerId) return null;
  return { worktreeId: receipt.worktreeId, phase: receipt.phase, result: receipt.result };
}

export function integrationCheckpoint(projectId: string, operationId: string, ownerId: string) {
  const receipt = load(operationId);
  if (!receipt || receipt.projectId !== projectId || receipt.ownerId !== ownerId || receipt.result?.status !== "verification-failed") return null;
  return { worktreeId: receipt.worktreeId, baseCommit: receipt.candidate.targetCommit, candidateCommit: receipt.candidate.commit, checkIds: [operationId] };
}

export function hasVerifiedIntegration(projectId: string, worktreeId: string): boolean {
  return Boolean(verifiedReceipt(projectId, worktreeId));
}

/** An interrupted verification/install must be resolved before automatic expiry. */
export function worktreeIntegrationPending(projectId: string, worktreeId: string): boolean {
  return pending.has(projectId) || Boolean(db().prepare("SELECT 1 FROM worktree_integrations WHERE project_id=? AND worktree_id=? AND json_extract(receipt,'$.phase') != 'finished' LIMIT 1").get(projectId, worktreeId));
}

function verifiedReceipt(projectId: string, worktreeId: string): { operationId: string; receipt: Receipt } | null {
  const row = db().prepare("SELECT operation_id, receipt FROM worktree_integrations WHERE project_id=? AND worktree_id=? AND json_extract(receipt,'$.result.status')='committed' ORDER BY rowid DESC LIMIT 1").get(projectId, worktreeId) as { operation_id: string; receipt: string } | undefined;
  return row ? { operationId: row.operation_id, receipt: JSON.parse(row.receipt) } : null;
}

/** Caller must exclude running conversations and background tasks before retirement. */
export async function retireVerifiedWorktree(project: ProjectRecord, worktreeId: string): Promise<void> {
  const record = verifiedReceipt(project.id, worktreeId);
  if (!record) throw new ProjectWorktreeError(409, "Worktree has no verified local commit; kept");
  await retire(project, worktreeId, { operationId: record.operationId }, record.receipt, worktreeRoot(), {});
}

/** Serialized per project. The Git index lock supplies cross-process installation exclusion. */
export async function integrateProjectWorktree(project: ProjectRecord, worktreeId: string, input: WorktreeIntegrationInput, root = worktreeRoot(), env: NodeJS.ProcessEnv = {}): Promise<WorktreeIntegrationResult> {
  const previous = pending.get(project.id) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(() => integrate(project, worktreeId, input, root, env));
  const settled = operation.then(() => undefined, () => undefined);
  pending.set(project.id, settled);
  void settled.then(() => { if (pending.get(project.id) === settled) pending.delete(project.id); });
  return operation;
}

async function checkSnapshot(project: ProjectRecord, candidate: LocalWorktreeCandidate, folder: string, command: string, env: NodeJS.ProcessEnv): Promise<number> {
  const manifest = await exportWorktreeCommit(project.path, env, candidate.commit, folder);
  await ensureWorktreeLocalFiles(project.path, folder);
  const excluded = [WORKTREE_META_DIR, TICKET_BASELINE_DIR, TICKET_MERGE_DIR];
  const before = await captureBaseline(folder, worktreePathAllowed, excluded);
  const launch = runtimeExec("/bin/sh", ["-c", command], { ...process.env, ...env });
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(launch.command, launch.args, { cwd: folder, env: launch.env, stdio: "ignore", timeout: nodeSettings().gitPullTimeoutSeconds * 1000 });
    child.once("error", reject);
    child.once("close", code => resolve(code === null ? 124 : code));
  });
  if (before !== await captureBaseline(folder, worktreePathAllowed, excluded)) throw new ProjectWorktreeError(409, "Verification changed candidate source files; no commit was installed");
  for (const file of manifest) {
    const target = path.join(folder, file.path);
    const info = await fs.lstat(target);
    if (!info.isFile() || Boolean(info.mode & 0o111) !== file.executable || createHash("sha256").update(await fs.readFile(target)).digest("hex") !== file.hash) throw new ProjectWorktreeError(409, `Verification changed candidate file ${file.path}; no commit was installed`);
  }
  return exitCode;
}

async function unchangedWorktree(project: ProjectRecord, worktreeId: string, root: string, digest: string): Promise<void> {
  if (await worktreeHasPendingFiles(project.id, worktreeId)) throw new ProjectWorktreeError(409, "Worktree files are still arriving; no integration or deletion is safe");
  const changes = await withoutGitIgnored(project.path, await worktreeChanges(project.id, worktreeId, root));
  if (worktreeChangesDigest(changes) !== digest) throw new ProjectWorktreeError(409, "Worktree changed after verification; keep it and verify a new operation");
}

async function retire(project: ProjectRecord, worktreeId: string, input: Pick<WorktreeIntegrationInput, "operationId" | "deferCleanup">, receipt: Receipt, root: string, env: NodeJS.ProcessEnv): Promise<WorktreeIntegrationResult> {
  const result = receipt.result!;
  if (result.status !== "committed" || result.worktreeDeleted || input.deferCleanup) return result;
  await installLocalWorktreeCommit(project.path, env, receipt.candidate, input.operationId);
  const existing = await getProjectWorktree(project.id, worktreeId, root);
  if (existing) {
    await unchangedWorktree(project, worktreeId, root, receipt.candidate.digest);
    await deleteProjectWorktree(project.id, worktreeId, root);
  }
  result.worktreeDeleted = true;
  save(input.operationId, receipt);
  return result;
}

async function integrate(project: ProjectRecord, worktreeId: string, input: WorktreeIntegrationInput, root: string, env: NodeJS.ProcessEnv): Promise<WorktreeIntegrationResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.operationId)) throw new ProjectWorktreeError(400, "Invalid integration operation ID");
  if (!input.check.trim() || input.check.length > 10_000 || input.check.includes("\0")) throw new ProjectWorktreeError(400, "A bounded verification command is required");
  const requestHash = createHash("sha256").update(JSON.stringify([project.id, worktreeId, input.title, input.check, input.ownerId, input.resolutionTarget])).digest("hex");
  let receipt = load(input.operationId);
  if (receipt && receipt.requestHash !== requestHash) throw new ProjectWorktreeError(409, "Operation ID belongs to a different worktree integration request");
  if (receipt?.phase === "finished") return retire(project, worktreeId, input, receipt, root, env);
  if (receipt?.phase === "verifying") throw new ProjectWorktreeError(409, "Verification is running or was interrupted; its command will not be replayed automatically");
  const worktree = await getProjectWorktree(project.id, worktreeId, root);
  if (!worktree) throw new ProjectWorktreeError(404, "Worktree not found");
  if (worktree.createdByNodeId !== (await getClusterNode()).id) throw new ProjectWorktreeError(409, `Integrate on the worktree's creating node ${worktree.createdByNodeId}; no other main was selected`);
  if (!receipt) {
    const changes = await withoutGitIgnored(project.path, await worktreeChanges(project.id, worktreeId, root));
    await unchangedWorktree(project, worktreeId, root, worktreeChangesDigest(changes));
    const candidate = await prepareLocalWorktreeCommit(project.path, env, changes, input.title, input.resolutionTarget);
    if (candidate.status === "conflict") return { operationId: input.operationId, status: "conflict", worktreeDeleted: false, conflicts: candidate.conflicts, targetCommit: candidate.targetCommit };
    receipt = { projectId: project.id, worktreeId, ownerId: input.ownerId, requestHash, candidate, phase: "verifying", result: null };
    const reserved = db().prepare("INSERT INTO worktree_integrations VALUES(?,?,?,?) ON CONFLICT(operation_id) DO NOTHING")
      .run(input.operationId, project.id, worktreeId, JSON.stringify(receipt));
    if (reserved.changes !== 1) throw new ProjectWorktreeError(409, "Integration operation is already reserved; verification was not repeated");
    const snapshot = await fs.mkdtemp(path.join(os.tmpdir(), "joint-bob-verification-"));
    let exitCode: number;
    try { exitCode = await checkSnapshot(project, candidate, snapshot, input.check, env); }
    finally { await fs.rm(snapshot, { recursive: true, force: true }); }
    if (exitCode !== 0) {
      receipt.phase = "finished";
      receipt.result = { operationId: input.operationId, status: "verification-failed", checkExitCode: exitCode, worktreeDeleted: false };
      save(input.operationId, receipt);
      return receipt.result;
    }
    receipt.phase = "verified";
    save(input.operationId, receipt);
  }
  await unchangedWorktree(project, worktreeId, root, receipt.candidate.digest);
  const installed = await installLocalWorktreeCommit(project.path, env, receipt.candidate, input.operationId);
  receipt.phase = "finished";
  receipt.result = { operationId: input.operationId, status: "committed", commit: installed.commit, checkExitCode: 0, worktreeDeleted: false };
  save(input.operationId, receipt);
  return retire(project, worktreeId, input, receipt, root, env);
}
