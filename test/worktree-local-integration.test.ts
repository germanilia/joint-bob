import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { promises as filesystem } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as worktreeGit from "../src/worktree-git.ts";
import * as worktrees from "../src/project-worktrees.ts";
import type { ProjectRecord } from "../src/types.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { encoding: "utf8" }).trim();
}

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "jb-local-integration-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  for (const [file, text] of Object.entries({ "app.txt": "one\ntwo\nthree\n", "other.txt": "original\n", "delete.txt": "remove me\n" })) await writeFile(path.join(root, file), text);
  git(root, "add", "."); git(root, "commit", "-qm", "initial");
  const base = git(root, "rev-parse", "HEAD");
  return { root, base, changes: { gitBase: base, writes: [{ path: "app.txt", content: Buffer.from("one\ntwo\nTHREE\n"), executable: false }], deletes: [] as string[], uncommittedPaths: [] as string[] } };
}

function upstreamFixture(root: string) {
  const remote = path.join(root, ".git", "test-remote");
  git(root, "init", "--bare", "-q", remote);
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-qu", "origin", "main");
}

test("reconcile-main advances synced history while preserving unrelated staged and unstaged edits", async t => {
  const { root, base } = await fixture(t);
  await writeFile(path.join(root, "app.txt"), "upstream\n");
  git(root, "add", "app.txt"); git(root, "commit", "-qm", "upstream");
  const upstream = git(root, "rev-parse", "HEAD");
  upstreamFixture(root);
  git(root, "reset", "--mixed", base);
  await writeFile(path.join(root, "other.txt"), "staged\n"); git(root, "add", "other.txt");
  await writeFile(path.join(root, "other.txt"), "unstaged\n");
  const result = await worktreeGit.reconcileWorktreeMain(root, {}, upstream);
  assert.equal(result.status, "reconciled");
  assert.equal(git(root, "rev-parse", "HEAD"), upstream);
  assert.equal(git(root, "show", ":other.txt"), "staged");
  assert.equal(await readFile(path.join(root, "other.txt"), "utf8"), "unstaged\n");
  assert.equal(await readFile(path.join(root, "app.txt"), "utf8"), "upstream\n");
});

test("reconcile-main reports overlapping unsynced paths without changing HEAD or index", async t => {
  const { root, base } = await fixture(t);
  await writeFile(path.join(root, "app.txt"), "upstream\n");
  git(root, "add", "."); git(root, "commit", "-qm", "upstream");
  const upstream = git(root, "rev-parse", "HEAD");
  upstreamFixture(root);
  git(root, "reset", "--mixed", base);
  await writeFile(path.join(root, "app.txt"), "local work\n");
  const index = await readFile(path.join(root, ".git/index"));
  const result = await worktreeGit.reconcileWorktreeMain(root, {}, upstream);
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.conflicts, ["app.txt"]);
  assert.equal(git(root, "rev-parse", "HEAD"), base);
  assert.deepEqual(await readFile(path.join(root, ".git/index")), index);
});

test("merge preparation automatically reconciles a synced main behind the task base", async t => {
  const { root, base, changes } = await fixture(t);
  await writeFile(path.join(root, "other.txt"), "upstream\n");
  git(root, "add", "."); git(root, "commit", "-qm", "upstream");
  changes.gitBase = git(root, "rev-parse", "HEAD");
  upstreamFixture(root);
  git(root, "reset", "--mixed", base);
  const candidate = await prepare(root, changes);
  assert.equal(candidate.status, "prepared");
  assert.equal(git(root, "rev-parse", "HEAD"), changes.gitBase);
  if (candidate.status !== "prepared") return;
  await install(root, candidate);
  assert.equal(git(root, "show", "HEAD:app.txt"), "one\ntwo\nTHREE");
  assert.equal(git(root, "show", "HEAD:other.txt"), "upstream");
});

test("reconciliation retains overlapping staged edits, then drops a local commit upstream already has", async t => {
  const { root, base } = await fixture(t);
  await writeFile(path.join(root, "app.txt"), "upstream\n");
  git(root, "add", "."); git(root, "commit", "-qm", "upstream");
  const upstream = git(root, "rev-parse", "HEAD");
  upstreamFixture(root);
  git(root, "reset", "--mixed", base);
  git(root, "add", "app.txt");
  const index = await readFile(path.join(root, ".git/index"));
  const result = await worktreeGit.reconcileWorktreeMain(root, {}, upstream);
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.conflicts, ["app.txt"]);
  assert.deepEqual(await readFile(path.join(root, ".git/index")), index);
  // The same change committed here as well, as a machine does when synced files arrive: upstream already has it.
  git(root, "commit", "-qm", "same change committed locally");
  const local = git(root, "rev-parse", "HEAD");
  const divergent = await worktreeGit.reconcileWorktreeMain(root, {}, upstream);
  assert.equal(divergent.status, "reconciled");
  assert.deepEqual(divergent.alreadyUpstream, [local]);
  assert.deepEqual(divergent.replayed, []);
  assert.equal(git(root, "rev-parse", "HEAD"), upstream);
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.match(git(root, "reflog", "-n", "2", "--format=%H", "main"), new RegExp(local), "the old main stays in the reflog");
});

test("reconcile-main replays local commits upstream lacks on top of upstream", async t => {
  const { root, base } = await fixture(t);
  await writeFile(path.join(root, "app.txt"), "upstream\n");
  git(root, "commit", "-qam", "upstream");
  const upstream = git(root, "rev-parse", "HEAD");
  upstreamFixture(root);
  git(root, "reset", "--mixed", base);
  await writeFile(path.join(root, "other.txt"), "local\n");
  git(root, "add", "other.txt");
  execFileSync("git", ["-C", root, "commit", "-qm", "local work\n\nwith a body"], { env: { ...process.env, GIT_AUTHOR_NAME: "Local Author", GIT_AUTHOR_EMAIL: "local@example.com", GIT_COMMITTER_NAME: "Local", GIT_COMMITTER_EMAIL: "local@example.com" } });
  const local = git(root, "rev-parse", "HEAD");
  await writeFile(path.join(root, "delete.txt"), "someone's unstaged edit\n");
  const result = await worktreeGit.reconcileWorktreeMain(root, {}, upstream);
  assert.equal(result.status, "reconciled");
  assert.deepEqual(result.replayed, [local]);
  const head = git(root, "rev-parse", "HEAD");
  assert.equal(result.targetCommit, head);
  assert.equal(git(root, "rev-parse", "HEAD^"), upstream);
  assert.equal(git(root, "show", "HEAD:app.txt"), "upstream");
  assert.equal(git(root, "show", "HEAD:other.txt"), "local");
  assert.equal(git(root, "log", "-1", "--format=%an <%ae>", "HEAD"), "Local Author <local@example.com>");
  const message = (commit: string) => execFileSync("git", ["-C", root, "cat-file", "commit", commit], { encoding: "utf8" }).split("\n\n").slice(1).join("\n\n");
  assert.equal(message(head), message(local));
  assert.equal(git(root, "status", "--porcelain"), "M delete.txt");
  assert.equal(await readFile(path.join(root, "delete.txt"), "utf8"), "someone's unstaged edit\n");
  const again = await worktreeGit.reconcileWorktreeMain(root, {}, upstream);
  assert.equal(again.status, "current");
});

test("a local commit that conflicts with upstream blocks with its paths and keeps main", async t => {
  const { root, base } = await fixture(t);
  await writeFile(path.join(root, "app.txt"), "upstream\n");
  git(root, "commit", "-qam", "upstream");
  const upstream = git(root, "rev-parse", "HEAD");
  upstreamFixture(root);
  git(root, "reset", "--hard", base);
  await writeFile(path.join(root, "app.txt"), "local\n");
  git(root, "commit", "-qam", "local");
  const local = git(root, "rev-parse", "HEAD");
  const result = await worktreeGit.reconcileWorktreeMain(root, {}, upstream);
  assert.equal(result.status, "blocked");
  assert.match(result.reason!, new RegExp(`Local commit ${local.slice(0, 8)} conflicts with upstream`));
  assert.deepEqual(result.conflicts, ["app.txt"]);
  assert.match(result.next!, /pr --merge/);
  assert.equal(git(root, "rev-parse", "HEAD"), local);
});

test("merge preparation reconciles a main whose only local commit already reached upstream", async t => {
  const { root, base, changes } = await fixture(t);
  await writeFile(path.join(root, "other.txt"), "fix\n");
  git(root, "commit", "-qam", "fix, pushed from another machine");
  await writeFile(path.join(root, "delete.txt"), "later upstream work\n");
  git(root, "commit", "-qam", "later upstream work");
  changes.gitBase = git(root, "rev-parse", "HEAD");
  upstreamFixture(root);
  git(root, "reset", "--mixed", base);
  git(root, "add", "other.txt");
  git(root, "commit", "-qm", "fix, committed by a local merge");
  const candidate = await prepare(root, changes);
  assert.equal(candidate.status, "prepared");
  assert.equal(git(root, "rev-parse", "HEAD"), changes.gitBase);
  if (candidate.status !== "prepared") return;
  await install(root, candidate);
  assert.equal(git(root, "rev-parse", "HEAD^"), changes.gitBase);
  assert.equal(git(root, "show", "HEAD:app.txt"), "one\ntwo\nTHREE");
});

async function prepare(root: string, changes: worktreeGit.WorktreeChanges) {
  assert.equal(typeof worktreeGit.prepareLocalWorktreeCommit, "function", "local integration must prepare an isolated task commit");
  return worktreeGit.prepareLocalWorktreeCommit(root, {}, changes, "feat: task");
}

test("local preparation commits only task changes and never touches the shared index or working files", async t => {
  const { root, base, changes } = await fixture(t);
  await writeFile(path.join(root, "other.txt"), "staged by another agent\n"); git(root, "add", "other.txt");
  await writeFile(path.join(root, "other.txt"), "unstaged by another agent\n");
  await writeFile(path.join(root, "draft.txt"), "private draft\n");
  const index = await readFile(path.join(root, ".git/index"));
  const candidate = await prepare(root, changes);
  assert.equal(candidate.status, "prepared");
  if (candidate.status !== "prepared") return;
  assert.equal(candidate.targetCommit, base);
  assert.match(candidate.digest, /^[a-f0-9]{64}$/);
  assert.equal(git(root, "show", `${candidate.commit}:app.txt`), "one\ntwo\nTHREE");
  assert.equal(git(root, "show", `${candidate.commit}:other.txt`), "original");
  assert.equal(git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", candidate.commit), "app.txt");
  assert.equal(git(root, "rev-parse", "HEAD"), base);
  assert.deepEqual(await readFile(path.join(root, ".git/index")), index);
  assert.equal(await readFile(path.join(root, "app.txt"), "utf8"), "one\ntwo\nthree\n");
  assert.equal(await readFile(path.join(root, "other.txt"), "utf8"), "unstaged by another agent\n");
});

test("local preparation replays onto committed main and reports conflicts without publishing", async t => {
  const { root, base, changes } = await fixture(t);
  await writeFile(path.join(root, "app.txt"), "ONE\ntwo\nthree\n"); git(root, "add", "app.txt"); git(root, "commit", "-qm", "another task");
  const current = git(root, "rev-parse", "HEAD");
  const candidate = await prepare(root, changes);
  assert.equal(candidate.status, "prepared");
  if (candidate.status !== "prepared") return;
  assert.notEqual(candidate.targetCommit, base);
  assert.equal(candidate.targetCommit, current);
  assert.equal(git(root, "show", `${candidate.commit}:app.txt`), "ONE\ntwo\nTHREE");
  await writeFile(path.join(root, "app.txt"), "ONE\ntwo\ncompeting third line\n"); git(root, "add", "app.txt"); git(root, "commit", "-qm", "competing task");
  const conflicted = await prepare(root, changes);
  assert.equal(conflicted.status, "conflict");
  if (conflicted.status === "conflict") assert.deepEqual(conflicted.conflicts, ["app.txt"]);
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("explicit conflict resolution is bound to the inspected main revision", async t => {
  const { root, changes } = await fixture(t);
  await writeFile(path.join(root, "app.txt"), "ONE\ntwo\nmain third\n"); git(root, "add", "."); git(root, "commit", "-qm", "main changed");
  const target = git(root, "rev-parse", "HEAD");
  changes.writes[0].content = Buffer.from("ONE\ntwo\nresolved third\n");
  const resolved = await worktreeGit.prepareLocalWorktreeCommit(root, {}, changes, "fix: resolved task", target);
  assert.equal(resolved.status, "prepared");
  if (resolved.status !== "prepared") return;
  assert.equal(git(root, "show", `${resolved.commit}:app.txt`), "ONE\ntwo\nresolved third");
  await assert.rejects(worktreeGit.prepareLocalWorktreeCommit(root, {}, changes, "fix: stale resolution", changes.gitBase), /changed|stale/i);
});

test("local preparation carries adds deletes and executable mode without unrelated staged additions", async t => {
  const { root, changes } = await fixture(t);
  changes.writes.push({ path: "run.sh", content: Buffer.from("#!/bin/sh\necho task\n"), executable: true });
  changes.deletes.push("delete.txt");
  await writeFile(path.join(root, "unrelated.txt"), "not this task\n"); git(root, "add", "unrelated.txt");
  const candidate = await prepare(root, changes);
  assert.equal(candidate.status, "prepared");
  if (candidate.status !== "prepared") return;
  assert.match(git(root, "ls-tree", candidate.commit, "run.sh"), /^100755 blob/);
  assert.equal(git(root, "ls-tree", candidate.commit, "delete.txt", "unrelated.txt"), "");
});

test("local preparation rejects detached HEAD, nested project roots and inherited dirty base edits", async t => {
  const { root, base, changes } = await fixture(t);
  await assert.rejects(prepare(root, { ...changes, uncommittedPaths: ["app.txt"] }), /uncommitted/i);
  await mkdir(path.join(root, "nested"));
  await assert.rejects(prepare(path.join(root, "nested"), changes), /root/i);
  git(root, "checkout", "--detach", "-q", base);
  await assert.rejects(prepare(root, changes), /main/i);
});

async function install(root: string, candidate: worktreeGit.LocalWorktreeCandidate, operationId = "11111111-1111-4111-8111-111111111111") {
  assert.equal(typeof worktreeGit.installLocalWorktreeCommit, "function", "local integration must install a verified task commit");
  return worktreeGit.installLocalWorktreeCommit(root, {}, candidate, operationId);
}

test("installation commits only the task and keeps staged, unstaged and untracked work", async t => {
  const { root, changes } = await fixture(t);
  await writeFile(path.join(root, "other.txt"), "staged\n"); git(root, "add", "other.txt");
  await writeFile(path.join(root, "other.txt"), "unstaged\n");
  await writeFile(path.join(root, "draft.txt"), "untracked\n");
  const candidate = await prepare(root, changes);
  assert.equal(candidate.status, "prepared"); if (candidate.status !== "prepared") return;
  const result = await install(root, candidate);
  assert.equal(result.commit, git(root, "rev-parse", "HEAD"));
  assert.equal(git(root, "show", "HEAD:other.txt"), "original");
  assert.equal(git(root, "show", ":other.txt"), "staged");
  assert.equal(await readFile(path.join(root, "other.txt"), "utf8"), "unstaged\n");
  assert.equal(await readFile(path.join(root, "draft.txt"), "utf8"), "untracked\n");
  assert.equal(await readFile(path.join(root, "app.txt"), "utf8"), "one\ntwo\nTHREE\n");
  assert.equal(git(root, "diff", "--name-only", "--cached"), "other.txt");
  assert.deepEqual(await install(root, candidate), result, "retry must return the same commit");
});

test("installation refuses a stale candidate without modifying main or dirty files", async t => {
  const { root, changes } = await fixture(t);
  const candidate = await prepare(root, changes);
  assert.equal(candidate.status, "prepared"); if (candidate.status !== "prepared") return;
  await writeFile(path.join(root, "other.txt"), "new main\n"); git(root, "add", "other.txt"); git(root, "commit", "-qm", "new main");
  const head = git(root, "rev-parse", "HEAD");
  await assert.rejects(install(root, candidate), /changed|stale/i);
  assert.equal(git(root, "rev-parse", "HEAD"), head);
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("installation protects overlapping uncommitted edits and leaves the candidate unpublished", async t => {
  const { root, base, changes } = await fixture(t);
  const candidate = await prepare(root, changes);
  assert.equal(candidate.status, "prepared"); if (candidate.status !== "prepared") return;
  await writeFile(path.join(root, "app.txt"), "someone else's work\n"); git(root, "add", "app.txt");
  const index = await readFile(path.join(root, ".git/index"));
  await assert.rejects(install(root, candidate), /uncommitted|overwrite|protected/i);
  assert.equal(git(root, "rev-parse", "HEAD"), base);
  assert.deepEqual(await readFile(path.join(root, ".git/index")), index);
  assert.equal(await readFile(path.join(root, "app.txt"), "utf8"), "someone else's work\n");
});

test("a retry cannot reuse an operation ID for another contribution", async t => {
  const { root, changes } = await fixture(t);
  const first = await prepare(root, changes);
  assert.equal(first.status, "prepared"); if (first.status !== "prepared") return;
  await install(root, first);
  changes.gitBase = first.commit;
  changes.writes[0].content = Buffer.from("one\ntwo\nFOUR\n");
  const second = await prepare(root, changes);
  assert.equal(second.status, "prepared"); if (second.status !== "prepared") return;
  await assert.rejects(install(root, second), /operation.*different|operation.*revision/i);
  assert.equal(git(root, "rev-parse", "HEAD"), first.commit);
});

test("an interrupted installation resumes the same commit without losing staged changes", async t => {
  const { root, changes } = await fixture(t);
  await writeFile(path.join(root, "other.txt"), "staged\n"); git(root, "add", "other.txt");
  await writeFile(path.join(root, "other.txt"), "unstaged\n");
  const candidate = await prepare(root, changes);
  assert.equal(candidate.status, "prepared"); if (candidate.status !== "prepared") return;
  const rename = filesystem.rename;
  const fault = t.mock.method(filesystem, "rename", async (source, target) => {
    if (String(target) === path.join(root, ".git/index")) throw new Error("simulated interruption installing index");
    return rename(source, target);
  });
  await assert.rejects(install(root, candidate), /simulated interruption/);
  fault.mock.restore();
  assert.equal(git(root, "rev-parse", "HEAD"), candidate.commit, "the ref advanced before the interruption");
  const recovered = await install(root, candidate);
  assert.equal(recovered.commit, candidate.commit);
  assert.equal(git(root, "show", ":other.txt"), "staged");
  assert.equal(await readFile(path.join(root, "other.txt"), "utf8"), "unstaged\n");
  assert.equal(git(root, "rev-list", "--count", "HEAD"), "2", "recovery must not create another task commit");
});

test("recovery refuses to overwrite files changed after an interrupted installation", async t => {
  const { root, changes } = await fixture(t);
  const candidate = await prepare(root, changes);
  assert.equal(candidate.status, "prepared"); if (candidate.status !== "prepared") return;
  const rename = filesystem.rename;
  const fault = t.mock.method(filesystem, "rename", async (source, target) => {
    if (String(target) === path.join(root, ".git/index")) throw new Error("simulated interruption");
    return rename(source, target);
  });
  await assert.rejects(install(root, candidate), /simulated interruption/);
  fault.mock.restore();
  await writeFile(path.join(root, "app.txt"), "later writer\n");
  await assert.rejects(install(root, candidate), /changed|inspection/i);
  assert.equal(await readFile(path.join(root, "app.txt"), "utf8"), "later writer\n");
});

test("installation rejects a candidate that lies about its tree or changed paths", async t => {
  const { root, changes } = await fixture(t);
  const candidate = await prepare(root, changes);
  assert.equal(candidate.status, "prepared"); if (candidate.status !== "prepared") return;
  await assert.rejects(install(root, { ...candidate, paths: [] }), /candidate/i);
  await assert.rejects(install(root, { ...candidate, tree: candidate.targetCommit }), /candidate/i);
});

test("installation handles deletion of the last file in a nested directory", async t => {
  const { root, changes } = await fixture(t);
  await mkdir(path.join(root, "nested"));
  await writeFile(path.join(root, "nested/last.txt"), "last\n"); git(root, "add", "nested"); git(root, "commit", "-qm", "nested file");
  changes.gitBase = git(root, "rev-parse", "HEAD");
  changes.deletes.push("nested/last.txt");
  const candidate = await prepare(root, changes);
  assert.equal(candidate.status, "prepared"); if (candidate.status !== "prepared") return;
  await install(root, candidate);
  assert.equal(git(root, "ls-tree", "-r", "HEAD", "nested"), "");
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("verified worktree integration runs checks, commits only the task, and deletes its worktree", async t => {
  const { root } = await fixture(t);
  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), "jb-integration-worktrees-"));
  t.after(() => rm(worktreeRoot, { recursive: true, force: true }));
  const project = { id: path.basename(root), path: root, name: "Fixture" } as ProjectRecord;
  const worktree = await worktrees.createProjectWorktree(project, { name: "Task" }, worktreeRoot);
  await writeFile(path.join(worktree.path, "app.txt"), "verified change\n");
  await writeFile(path.join(root, "other.txt"), "unrelated staged\n"); git(root, "add", "other.txt");
  assert.equal(typeof worktrees.integrateProjectWorktree, "function", "a verified finish operation must connect commit installation to worktree cleanup");
  const result = await worktrees.integrateProjectWorktree(project, worktree.id, {
    operationId: "22222222-2222-4222-8222-222222222222", title: "feat: verified task", check: `node -e "if(require('fs').readFileSync('app.txt','utf8')!=='verified change\\n')process.exit(1)"`,
  }, worktreeRoot);
  assert.equal(result.status, "committed");
  assert.equal(result.commit, git(root, "rev-parse", "HEAD"));
  assert.equal(result.worktreeDeleted, true);
  assert.equal(git(root, "show", "HEAD:other.txt"), "original");
  assert.equal(git(root, "show", ":other.txt"), "unrelated staged");
  await assert.rejects(readFile(path.join(worktree.path, "app.txt")), { code: "ENOENT" });
  assert.deepEqual(await worktrees.integrateProjectWorktree(project, worktree.id, {
    operationId: "22222222-2222-4222-8222-222222222222", title: "feat: verified task", check: `node -e "if(require('fs').readFileSync('app.txt','utf8')!=='verified change\\n')process.exit(1)"`,
  }, worktreeRoot), result);
});

test("verification sees committed binary assets as well as task text", async t => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "asset.bin"), Buffer.from([0, 1, 2, 3])); git(root, "add", "asset.bin"); git(root, "commit", "-qm", "asset");
  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), "jb-binary-verification-"));
  t.after(() => rm(worktreeRoot, { recursive: true, force: true }));
  const project = { id: path.basename(root), path: root, name: "Fixture" } as ProjectRecord;
  const worktree = await worktrees.createProjectWorktree(project, { name: "Asset check" }, worktreeRoot);
  await writeFile(path.join(worktree.path, "app.txt"), "changed\n");
  const result = await worktrees.integrateProjectWorktree(project, worktree.id, { operationId: "55555555-5555-4555-8555-555555555555", title: "fix: asset check", check: `node -e "if(require('fs').readFileSync('asset.bin').length!==4)process.exit(1)"` }, worktreeRoot);
  assert.equal(result.status, "committed");
});

test("failed verification never commits or deletes a worktree", async t => {
  const { root, base } = await fixture(t);
  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), "jb-integration-failure-"));
  t.after(() => rm(worktreeRoot, { recursive: true, force: true }));
  const project = { id: path.basename(root), path: root, name: "Fixture" } as ProjectRecord;
  const worktree = await worktrees.createProjectWorktree(project, { name: "Failing task" }, worktreeRoot);
  await writeFile(path.join(worktree.path, "app.txt"), "failing change\n");
  assert.equal(typeof worktrees.integrateProjectWorktree, "function");
  const result = await worktrees.integrateProjectWorktree(project, worktree.id, {
    operationId: "33333333-3333-4333-8333-333333333333", title: "feat: failing task", check: "node -e 'process.exit(7)'",
  }, worktreeRoot);
  assert.equal(result.status, "verification-failed");
  assert.equal(result.checkExitCode, 7);
  assert.equal(git(root, "rev-parse", "HEAD"), base);
  assert.equal(await readFile(path.join(worktree.path, "app.txt"), "utf8"), "failing change\n");
});

test("one operation ID cannot launch verification for two projects concurrently", async t => {
  const roots = [await fixture(t), await fixture(t)];
  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), "jb-integration-identity-"));
  t.after(() => rm(worktreeRoot, { recursive: true, force: true }));
  const tasks = [];
  for (const { root } of roots) {
    const project = { id: path.basename(root), path: root, name: "Fixture" } as ProjectRecord;
    const worktree = await worktrees.createProjectWorktree(project, { name: "Task" }, worktreeRoot);
    await writeFile(path.join(worktree.path, "app.txt"), "task\n");
    tasks.push({ project, worktree });
  }
  const results = await Promise.allSettled(tasks.map(({ project, worktree }) => worktrees.integrateProjectWorktree(project, worktree.id, {
    operationId: "44444444-4444-4444-8444-444444444444", title: "feat: task", check: "node -e 'setTimeout(() => {}, 200)'",
  }, worktreeRoot)));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(roots.reduce((count, { root }) => count + Number(git(root, "rev-list", "--count", "HEAD")), 0), 3);
});

test("a prepared digest changes when task bytes or executable mode change", async t => {
  const { root, changes } = await fixture(t);
  const first = await prepare(root, changes);
  changes.writes[0].executable = true;
  const second = await prepare(root, changes);
  assert.notEqual(first.digest, second.digest);
});
