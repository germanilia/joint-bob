import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { serverArgs } from "./server-entry.js";

interface StartedNode { baseUrl: string; child: ChildProcess; homeDir: string; output: () => string; }

async function startNode(root: string): Promise<StartedNode> {
  const homeDir = path.join(root, "home");
  await mkdir(homeDir, { recursive: true });
  let output = "";
  const child = spawn(process.execPath, serverArgs(process.env), {
    cwd: path.resolve("."),
    env: { ...process.env, PORT: "0", HOME: homeDir, PI_WEB_DATA_DIR: path.join(root, "data"), MASTER_BOB_ADMIN_USERNAME: "admin", MASTER_BOB_INITIAL_PASSWORD: "initial-password" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { output += chunk; });
  child.stderr?.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    const match = output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
    if (match && (await fetch(`http://127.0.0.1:${match[1]}/api/health`)).ok) return { baseUrl: `http://127.0.0.1:${match[1]}`, child, homeDir, output: () => output };
    if (child.exitCode !== null) throw new Error(output);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(output);
}

async function stopNode(node: StartedNode): Promise<void> {
  if (node.child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => node.child.once("exit", () => resolve()));
  node.child.kill("SIGTERM");
  await exited;
}

async function session(node: StartedNode): Promise<Record<string, string>> {
  const login = await fetch(`${node.baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }) });
  const body = await login.json() as { csrfToken: string };
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error(node.output());
  const headers = { Cookie: cookie, "X-CSRF-Token": body.csrfToken, "Content-Type": "application/json" };
  await fetch(`${node.baseUrl}/api/auth/change-password`, { method: "POST", headers, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }) });
  return headers;
}

async function isMissing(filePath: string): Promise<boolean> {
  try { await access(filePath); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}

test("ticket API creates Git-free workspaces and removes them on archive and delete", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ticket-api-"));
  let node: StartedNode | undefined;
  try {
    node = await startNode(root);
    const headers = await session(node);
    const homePath = path.join(node.homeDir, "JointBob");
    const saved = await fetch(`${node.baseUrl}/api/settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        pi: { executable: "", configPath: "", sessionPath: "" },
        claude: { executable: "", configPath: "", sessionPath: "" },
        projects: { homePath },
      }),
    });
    assert.equal(saved.status, 200, node.output());

    const missingModeSource = path.join(node.homeDir, "needs-import-choice");
    await mkdir(missingModeSource);
    const missingMode = await fetch(`${node.baseUrl}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Needs choice", type: "work", synced: true, sourcePath: missingModeSource }),
    });
    assert.equal(missingMode.status, 400, node.output());
    assert.equal((await lstat(missingModeSource)).isDirectory(), true);

    const importSource = path.join(node.homeDir, "existing-project");
    await mkdir(path.join(importSource, ".git"), { recursive: true });
    await mkdir(path.join(importSource, "node_modules", "fixture"), { recursive: true });
    await writeFile(path.join(importSource, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(path.join(importSource, "node_modules", "fixture", "index.js"), "export {};\n");
    const imported = await fetch(`${node.baseUrl}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Imported", type: "work", synced: true, sourcePath: importSource, importMode: "move-link" }),
    });
    assert.equal(imported.status, 201, node.output());
    const importedProject = (await imported.json() as { project: { id: string; path: string; macPath: string } }).project;
    assert.equal(importedProject.path, path.join(homePath, "work", "imported"));
    assert.equal(importedProject.macPath, importSource);
    assert.equal((await lstat(importSource)).isSymbolicLink(), true);
    assert.equal(await realpath(importSource), await realpath(importedProject.path));
    assert.equal(await readFile(path.join(importedProject.path, ".git", "HEAD"), "utf8"), "ref: refs/heads/main\n");
    assert.equal(await readFile(path.join(importedProject.path, "node_modules", "fixture", "index.js"), "utf8"), "export {};\n");
    assert.equal(await isMissing(path.join(importedProject.path, "AGENTS.md")), true);
    const projects = await fetch(`${node.baseUrl}/api/projects`, { headers });
    assert.equal(projects.status, 200, node.output());
    const projectList = await projects.json() as { projects: Array<{ id: string; syncStatus: { state: string; message?: string } }> };
    // This machine shares with nobody, so the imported project has nowhere to be sent.
    assert.deepEqual(projectList.projects.find((candidate) => candidate.id === importedProject.id)?.syncStatus, { state: "unavailable", remainingFiles: 0, remainingBytes: 0, message: "This project is not shared with another machine", engine: "none" });

    const created = await fetch(`${node.baseUrl}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "No Git", type: "personal", synced: true }),
    });
    assert.equal(created.status, 201, node.output());
    const project = (await created.json() as { project: { id: string; path: string } }).project;
    const duplicateImport = await fetch(`${node.baseUrl}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Duplicate", type: "personal", synced: true, sourcePath: project.path, importMode: "move" }),
    });
    assert.equal(duplicateImport.status, 409, node.output());
    assert.equal((await lstat(project.path)).isDirectory(), true);
    const ignore = await readFile(path.join(homePath, ".gitignore"), "utf8");
    assert.match(ignore, /^\/projects\/$/m);
    assert.match(ignore, /^\/tickets\/$/m);
    const create = async (title: string) => {
      const createdTask = await fetch(`${node!.baseUrl}/api/projects/${project.id}/tasks`, {
        method: "POST", headers, body: JSON.stringify({ title, description: "" }),
      });
      assert.equal(createdTask.status, 201, node!.output());
      return (await createdTask.json() as { task: { id: string; description: string; worktreePath: string | null; worktreeBranch: string | null; status: string } }).task;
    };

    const archivedTask = await create("Archive me");
    assert.equal(archivedTask.description, "");
    assert.equal(archivedTask.worktreeBranch, null);
    assert.equal(archivedTask.worktreePath, path.join(homePath, "tickets", project.id, archivedTask.id));

    const rejectedHomeChange = await fetch(`${node.baseUrl}/api/settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        pi: { executable: "", configPath: "", sessionPath: "" },
        claude: { executable: "", configPath: "", sessionPath: "" },
        projects: { homePath: path.join(node.homeDir, "OtherHome") },
      }),
    });
    assert.equal(rejectedHomeChange.status, 409, node.output());
    assert.deepEqual(await rejectedHomeChange.json(), {
      error: "Archive or delete board cards before changing the Joint Bob home folder",
    });

    const settings = await fetch(`${node.baseUrl}/api/settings`, { headers });
    assert.equal(settings.status, 200, node.output());
    assert.equal((await settings.json() as { projects: { homePath: string } }).projects.homePath, homePath);

    const archived = await fetch(`${node.baseUrl}/api/projects/${project.id}/tasks/${archivedTask.id}/archive`, { method: "POST", headers });
    assert.equal(archived.status, 200, node.output());
    const archivedBody = await archived.json() as { task: { status: string; worktreePath: string | null } };
    assert.equal(archivedBody.task.status, "done");
    assert.equal(archivedBody.task.worktreePath, null);
    assert.equal(await isMissing(archivedTask.worktreePath!), true);

    const deletedTask = await create("Delete me");
    assert.equal(deletedTask.worktreePath, path.join(homePath, "tickets", project.id, deletedTask.id));
    assert.equal((await fetch(`${node.baseUrl}/api/projects/${project.id}/tasks/${deletedTask.id}`, { method: "DELETE", headers })).status, 204, node.output());
    assert.equal(await isMissing(deletedTask.worktreePath!), true);
    const listed = await fetch(`${node.baseUrl}/api/projects/${project.id}/tasks`, { headers });
    assert.equal(listed.status, 200, node.output());
    const tasks = await listed.json() as { tasks: Array<{ id: string }> };
    assert.equal(tasks.tasks.some((task) => task.id === deletedTask.id), false);
  } finally {
    if (node) await stopNode(node);
    await rm(root, { recursive: true, force: true });
  }
});
