import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { serverArgs } from "./server-entry.js";

/* The project sync routes on a real node that shares nothing: a project no other machine holds has
   nothing to wait for and nothing to rescan. What the facade answers for shared projects is
   test/file-sync-facade-dispatch.test.ts. */

interface StartedNode { baseUrl: string; child: ChildProcess; output: () => string }

async function startNode(root: string): Promise<StartedNode> {
  const homeDir = path.join(root, "home");
  await mkdir(homeDir, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: "0", HOME: homeDir, PI_WEB_DATA_DIR: path.join(root, "data"), MASTER_BOB_ADMIN_USERNAME: "admin", MASTER_BOB_INITIAL_PASSWORD: "initial-password" };
  let output = "";
  const child = spawn(process.execPath, serverArgs(process.env), { cwd: path.resolve("."), env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk) => { output += chunk; });
  child.stderr?.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    const match = output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
    if (match && (await fetch(`http://127.0.0.1:${match[1]}/api/health`)).ok) return { baseUrl: `http://127.0.0.1:${match[1]}`, child, output: () => output };
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

test("a project shared with nobody says so in its sync status, and a rescan answers 409", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-facade-rescan-"));
  let node: StartedNode | undefined;
  try {
    node = await startNode(root);
    const headers = await session(node);
    const created = await fetch(`${node.baseUrl}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Shared", type: "personal", synced: true }) });
    assert.equal(created.status, 201, node.output());
    const project = (await created.json() as { project: { id: string } }).project;
    const rescan = (id: string) => fetch(`${node!.baseUrl}/api/projects/${id}/sync/rescan`, { method: "POST", headers });
    const scopedStatus = `${node.baseUrl}/api/projects/${project.id}/sync/status`;
    assert.equal((await fetch(scopedStatus)).status, 401, "sync counts require authentication");
    const scoped = await fetch(scopedStatus, { headers });
    assert.equal(scoped.status, 200);
    // No other machine holds it yet, whatever "synced" asked for: there is nothing to wait for.
    assert.deepEqual(await scoped.json(), { syncStatus: { state: "unavailable", remainingFiles: 0, remainingBytes: 0, message: "This project is not shared with another machine", engine: "none" } });
    for (const query of ["worktreeId=../outside", "worktreeId=", "worktreeId[]=one", "worktreeId=one&worktreeId=two"]) {
      assert.equal((await fetch(`${scopedStatus}?${query}`, { headers })).status, 400, query);
    }
    assert.equal((await fetch(`${node.baseUrl}/api/projects/missing/sync/status`, { headers })).status, 404);

    let answer = await rescan(project.id);
    assert.equal(answer.status, 409, node.output());
    assert.deepEqual(await answer.json(), { error: "This project is not shared with another machine" });
    const local = await fetch(`${node.baseUrl}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Local only", type: "personal", synced: false }) });
    assert.equal(local.status, 201, node.output());
    answer = await rescan((await local.json() as { project: { id: string } }).project.id);
    assert.equal(answer.status, 409);
    assert.deepEqual(await answer.json(), { error: "This project is not shared with another machine" });
    assert.equal((await rescan("missing")).status, 404);
    assert.equal(/Syncthing/i.test(node.output()), false, `the node said nothing of Syncthing: ${node.output()}`);
  } finally {
    if (node) await stopNode(node);
    await rm(root, { recursive: true, force: true });
  }
});
