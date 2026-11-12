import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureManagedHome, managedProjectPath, managedWorkspaceRoot } from "../src/managed-home.js";
import { captureBaseline, copyAllowed } from "../src/task-workspaces.js";

/** A worktree-style copy: the project's allowed files, then the baseline the merge back trusts. */
async function copyWithBaseline(project: string, workspace: string): Promise<string> {
  await cp(project, workspace, { recursive: true, filter: (entry) => copyAllowed(project, entry) });
  await captureBaseline(workspace);
  return workspace;
}

async function missing(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

test("managed homes ignore projects and tickets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-managed-home-"));
  try {
    const home = path.join(root, "JointBob");
    await ensureManagedHome(home);
    const ignore = await readFile(path.join(home, ".gitignore"), "utf8");

    assert.match(ignore, /^\/projects\/$/m);
    assert.match(ignore, /^\/tickets\/$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed project folders are lowercase snake_case", () => {
  const home = path.join(os.tmpdir(), `joint-bob-folder-case-${randomUUID()}`);

  assert.equal(managedProjectPath(home, "personal", "Guitar Player"), path.join(home, "personal", "guitar_player"));
  assert.equal(managedProjectPath(home, "personal", "  Home Assistant Plugins  "), path.join(home, "personal", "home_assistant_plugins"));
  assert.equal(managedProjectPath(home, "client-work", "ACME Portal"), path.join(home, "client-work", "acme_portal"));
  // A hyphenated type id keeps its hyphens; only the case changes.
  assert.equal(managedWorkspaceRoot(home, "Client-Work"), path.join(home, "client-work"));
});

test("managed project paths cannot escape their type root", () => {
  const home = path.join(os.tmpdir(), `joint-bob-managed-project-${randomUUID()}`);
  for (const name of ["../../escape", "..\\..\\escape", "...", "name/child"]) {
    const result = managedProjectPath(home, "personal", name);
    const relative = path.relative(managedWorkspaceRoot(home, "personal"), result);
    assert.notEqual(relative, "");
    assert.equal(path.isAbsolute(relative), false);
    assert.equal(relative.startsWith(".."), false);
  }
});

test("a workspace copy excludes repository metadata, dependencies, builds, logs, and secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-copy-filter-"));
  try {
    const project = path.join(root, "project");
    for (const directory of [".git", "packages/nested/.git", "node_modules/pkg", "dist", "coverage", "logs", ".joint-bob", ".joint-bob-attachments", "src"]) {
      await mkdir(path.join(project, directory), { recursive: true });
    }
    await writeFile(path.join(project, "src", "kept.ts"), "kept\n");
    await writeFile(path.join(project, ".env"), "SECRET=value\n");
    await writeFile(path.join(project, "private.pem"), "secret\n");
    await writeFile(path.join(project, ".git", "config"), "git\n");
    await writeFile(path.join(project, "packages", "nested", ".git", "config"), "nested git\n");
    await writeFile(path.join(project, "node_modules", "pkg", "index.js"), "dependency\n");
    await writeFile(path.join(project, "dist", "bundle.js"), "build\n");
    await writeFile(path.join(project, "coverage", "index.html"), "coverage\n");
    await writeFile(path.join(project, "logs", "run.log"), "log\n");
    await writeFile(path.join(project, ".joint-bob", "state"), "state\n");
    await writeFile(path.join(project, ".joint-bob-attachments", "ticket.txt"), "attachment\n");

    const workspace = await copyWithBaseline(project, path.join(root, "copy"));

    assert.equal(await readFile(path.join(workspace, "src", "kept.ts"), "utf8"), "kept\n");
    for (const excluded of [".git", "packages/nested/.git", "node_modules", "dist", "coverage", "logs", ".joint-bob", ".joint-bob-attachments", ".env", "private.pem"]) {
      assert.equal(await missing(path.join(workspace, excluded)), true, excluded);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a workspace copy captures a baseline content snapshot for merging back", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-copy-baseline-"));
  try {
    const project = path.join(root, "project");
    await mkdir(path.join(project, "src"), { recursive: true });
    await writeFile(path.join(project, "src", "index.ts"), "export const value = 1;\n");
    await writeFile(path.join(project, ".env"), "SECRET=value\n");

    const workspace = await copyWithBaseline(project, path.join(root, "copy"));

    const baseline = path.join(workspace, ".joint-bob-baseline");
    assert.equal(await readFile(path.join(baseline, "src", "index.ts"), "utf8"), "export const value = 1;\n");
    const manifest = JSON.parse(await readFile(path.join(baseline, "manifest.json"), "utf8")) as { files: Record<string, { sha256: string; mode: number }> };
    assert.deepEqual(Object.keys(manifest.files).sort(), ["src/index.ts"], "manifest lists exactly the copied files, secrets excluded");
    assert.equal(manifest.files["src/index.ts"].sha256.length, 64);
    assert.equal(await missing(path.join(baseline, ".env")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
