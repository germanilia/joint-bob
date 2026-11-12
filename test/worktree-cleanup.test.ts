import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureConversationRecord } from "../src/conversation-records.js";
import { holdEndedRun, releaseEndedRun } from "../src/conversation-runtime.js";
import { setSessionDone } from "../src/names.js";
import { createProjectWorktree, markWorktreeConversation, recordWorktreePullRequest } from "../src/project-worktrees.js";
import { cleanupDoneWorktrees, sweepWorktrees } from "../src/server/worktree-cleanup.js";
import { addProject } from "../src/store.js";

async function fixture(context: test.TestContext, verified = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-cleanup-"));
  process.env.JOINT_BOB_WORKTREE_ROOT = path.join(root, "worktrees");
  context.after(async () => { delete process.env.JOINT_BOB_WORKTREE_ROOT; await rm(root, { recursive: true, force: true }); });
  const source = path.join(root, "project");
  await mkdir(source);
  await writeFile(path.join(source, "index.ts"), "export const value = 1;\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", source, ...args]);
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test"); git("add", "."); git("commit", "-qm", "base");
  const project = await addProject("Cleanup fixture", source, { writeInstructions: false });
  const worktree = await createProjectWorktree(project, { name: "finished" });
  const sessionId = randomUUID();
  await markWorktreeConversation(project.id, worktree.id, "pi", sessionId);
  if (verified) {
    const { integrateProjectWorktree } = await import("../src/worktree-integration.js");
    await integrateProjectWorktree(project, worktree.id, { operationId: randomUUID(), title: "chore: verified task", check: "node -e 'process.exit(0)'", deferCleanup: true });
  }
  return { project, worktree, sessionId };
}

test("cleanup handles old done marks, keeps new empty worktrees, and is idempotent", async (context) => {
  const { project, worktree, sessionId } = await fixture(context);
  const empty = await createProjectWorktree(project, { name: "not started" });
  await setSessionDone(sessionId, true);
  const results = await Promise.all([cleanupDoneWorktrees(project), cleanupDoneWorktrees(project)]);
  for (const result of results) assert.deepEqual(result.deletedWorktreeIds, [worktree.id]);
  await assert.rejects(access(worktree.path), { code: "ENOENT" });
  const { worktreeSessionPaths } = await import("../src/project-worktrees.js");
  assert.ok((await worktreeSessionPaths(project.id)).includes(worktree.path), "retired cwd remains discoverable for transcript history");
  await access(empty.path);
  assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, []);
});

test("cleanup waits for running work, then retries after it ends", async (context) => {
  const { project, worktree, sessionId } = await fixture(context);
  await setSessionDone(sessionId, true);
  holdEndedRun("pi", sessionId, false);
  try {
    assert.match((await cleanupDoneWorktrees(project)).retainedWorktrees[worktree.id], /still running/);
    await access(worktree.path);
  } finally { releaseEndedRun("pi", sessionId); }
  assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, [worktree.id]);
});

test("a switched logical conversation stays until its current segment stops", async (context) => {
  const { project, worktree, sessionId } = await fixture(context);
  const conversationId = randomUUID();
  const switched = randomUUID();
  await ensureConversationRecord(project.id, "pi", sessionId, "fixture-node", undefined, { conversationId, segmentIndex: 0 });
  await ensureConversationRecord(project.id, "claude", switched, "fixture-node", undefined, { conversationId, segmentIndex: 1 });
  await setSessionDone(conversationId, true);
  holdEndedRun("claude", switched, false);
  try {
    assert.match((await cleanupDoneWorktrees(project)).retainedWorktrees[worktree.id], /still running/);
  } finally { releaseEndedRun("claude", switched); }
  assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, [worktree.id]);
});

test("reopened conversations and missing done marks keep the folder", async (context) => {
  const { project, worktree, sessionId } = await fixture(context);
  await setSessionDone(sessionId, true);
  await setSessionDone(sessionId, false);
  assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, []);
  await setSessionDone(sessionId, true);
  await markWorktreeConversation(project.id, worktree.id, "pi", randomUUID());
  assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, []);
  await access(worktree.path);
});

test("Done cannot delete unmerged changes or an explicit pull request", async (context) => {
  const { project, worktree, sessionId } = await fixture(context, false);
  context.mock.method(globalThis, "fetch", async () => { throw new Error("cleanup must not contact GitHub"); });
  await recordWorktreePullRequest(project.id, worktree.id, { number: 12, url: "https://github.com/o/r/pull/12", branch: "joint-bob/finished", base: "main", baseCommit: "a".repeat(40) });
  await writeFile(path.join(worktree.path, "index.ts"), "export const value = 2;\n");
  await setSessionDone(sessionId, true);
  assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, []);
  await access(worktree.path);
});

test("a damaged baseline blocks removing a finished worktree", async (context) => {
  const { project, worktree, sessionId } = await fixture(context);
  await setSessionDone(sessionId, true);
  await rm(path.join(worktree.path, ".joint-bob-baseline"), { recursive: true, force: true });
  assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, []);
  await access(worktree.path);
});

test("unverified worktrees without conversations survive the grace period", async (context) => {
  const { project } = await fixture(context);
  const clean = await createProjectWorktree(project, { name: "abandoned" });
  const edited = await createProjectWorktree(project, { name: "abandoned with edits" });
  await writeFile(path.join(edited.path, "index.ts"), "export const value = 2;\n");
  assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, [], "a new worktree stays");
  const now = Date.now();
  context.mock.method(Date, "now", () => now + 31 * 60_000);
  const result = await cleanupDoneWorktrees(project);
  assert.deepEqual(result.deletedWorktreeIds, []);
  await access(clean.path);
  await access(edited.path);
});

test("quiet time does not authorize deleting an unverified worktree", async (context) => {
  const { project } = await fixture(context);
  const worktree = await createProjectWorktree(project, { name: "active without conversation" });
  const created = Date.now();
  let clock = created + 31 * 60_000;
  context.mock.method(Date, "now", () => clock);
  const file = path.join(worktree.path, "index.ts");
  await writeFile(file, "export const value = 2;\n");
  await utimes(file, new Date(clock - 5 * 60_000), new Date(clock - 5 * 60_000));
  const kept = await cleanupDoneWorktrees(project);
  assert.deepEqual(kept.deletedWorktreeIds, []);
  assert.equal(kept.retainedWorktrees[worktree.id], "Worktree kept: recent activity");
  await access(worktree.path);
  clock = created + 31 * 60_000 + 40 * 60_000;
  assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, []);
  await access(worktree.path);
});

test("the periodic sweep retains unmerged edits and pull requests", async (context) => {
  const { project, worktree, sessionId } = await fixture(context, false);
  await writeFile(path.join(worktree.path, "index.ts"), "export const value = 2;\n");
  await recordWorktreePullRequest(project.id, worktree.id, { number: 7, url: "https://github.com/o/r/pull/7", branch: "joint-bob/open", base: "main", baseCommit: "a".repeat(40) });
  await setSessionDone(sessionId, true);
  assert.ok(!(await sweepWorktrees()).includes(worktree.id));
  await access(worktree.path);
});

test("five inactive days retire a verified worktree without a Done mark", async (context) => {
  const { project, worktree } = await fixture(context);
  const now = Date.now();
  context.mock.method(Date, "now", () => now + 6 * 86_400_000);
  assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, [worktree.id]);
});

test("merged retention counts file activity as well as conversation age", async (context) => {
  const { project, worktree } = await fixture(context);
  const now = Date.now();
  const touched = new Date(now + 4 * 86_400_000);
  await utimes(path.join(worktree.path, "index.ts"), touched, touched);
  context.mock.method(Date, "now", () => now + 11 * 86_400_000);
  assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, [worktree.id], "seven quiet days qualify for merged cleanup, even though the conversation is eleven days old");
});

test("unmerged work survives five days but expires after ten, preserving history", async (context) => {
  const { project, worktree } = await fixture(context, false);
  await writeFile(path.join(worktree.path, "index.ts"), "unmerged work\n");
  const now = Date.now();
  let days = 6;
  context.mock.method(Date, "now", () => now + days * 86_400_000);
  assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, []);
  days = 11;
  assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, [worktree.id]);
  const { worktreeSessionPaths } = await import("../src/project-worktrees.js");
  assert.ok((await worktreeSessionPaths(project.id)).includes(worktree.path));
});

test("unstarted worktrees and open PRs expire only after ten inactive days", async (context) => {
  const { project, worktree } = await fixture(context, false);
  const empty = await createProjectWorktree(project, { name: "never started" });
  await recordWorktreePullRequest(project.id, worktree.id, { number: 8, url: "https://github.com/o/r/pull/8", branch: "task", base: "main", baseCommit: "a".repeat(40) });
  const now = Date.now();
  context.mock.method(Date, "now", () => now + 11 * 86_400_000);
  assert.deepEqual(new Set((await cleanupDoneWorktrees(project)).deletedWorktreeIds), new Set([empty.id, worktree.id]));
});

test("a file-only merge expires after five inactive days", async (context) => {
  const { project, worktree } = await fixture(context, false);
  const { mergeProjectWorktree } = await import("../src/project-worktrees.js");
  await writeFile(path.join(worktree.path, "index.ts"), "merged\n");
  assert.ok((await mergeProjectWorktree(project, worktree.id)).merged);
  const now = Date.now();
  context.mock.method(Date, "now", () => now + 6 * 86_400_000);
  assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, [worktree.id]);
});

test("unresolved integration blocks ten-day expiration", async (context) => {
  const { project, worktree } = await fixture(context);
  const { openNodeDatabase } = await import("../src/node-database.js");
  const { resolveDataDirectory } = await import("../src/data-directory.js");
  const db = openNodeDatabase(path.join(resolveDataDirectory(), "node.db"));
  db.prepare("INSERT INTO worktree_integrations(operation_id,project_id,worktree_id,receipt) VALUES (?,?,?,?)")
    .run(randomUUID(), project.id, worktree.id, JSON.stringify({ phase: "verifying" }));
  db.close();
  const now = Date.now();
  context.mock.method(Date, "now", () => now + 11 * 86_400_000);
  assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, []);
});

test("recent transcript activity keeps an old worktree even with no file edits", async (context) => {
  const { project, worktree, sessionId } = await fixture(context, false);
  const now = Date.now();
  const recent = new Date(now + 10 * 86_400_000).toISOString();
  const folder = path.join(os.homedir(), ".pi", "agent", "sessions");
  await mkdir(folder, { recursive: true });
  const transcript = path.join(folder, `${sessionId}.jsonl`);
  await writeFile(transcript, [
    { type: "session", version: 3, id: sessionId, timestamp: recent, cwd: worktree.path },
    { type: "message", id: "recent", parentId: null, timestamp: recent, message: { role: "user", content: [{ type: "text", text: "Still working" }], timestamp: Date.parse(recent) } },
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  context.after(() => rm(transcript, { force: true }));
  context.mock.method(Date, "now", () => now + 11 * 86_400_000);
  assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, []);
});

test("ten-day expiration protects running work and recent file activity", async (context) => {
  const { project, worktree, sessionId } = await fixture(context, false);
  const now = Date.now();
  context.mock.method(Date, "now", () => now + 11 * 86_400_000);
  holdEndedRun("pi", sessionId, false);
  try { assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, []); }
  finally { releaseEndedRun("pi", sessionId); }
  const recent = new Date(now + 10 * 86_400_000);
  await utimes(path.join(worktree.path, "index.ts"), recent, recent);
  assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, []);
});

test("the periodic sweep keeps a worktree with an undone or running conversation", async (context) => {
  const { project, worktree, sessionId } = await fixture(context);
  assert.deepEqual(await sweepWorktrees(), [], "an undone conversation keeps it");
  await setSessionDone(sessionId, true);
  holdEndedRun("pi", sessionId, false);
  try { assert.deepEqual(await sweepWorktrees(), [], "running work keeps it"); }
  finally { releaseEndedRun("pi", sessionId); }
  await access(worktree.path);
  assert.deepEqual(await sweepWorktrees(), [worktree.id]);
});
