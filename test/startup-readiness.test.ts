import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { appVersion } from "../src/changelog.js";
import { serverArgs } from "./server-entry.js";

/** Stands where an older release's sync tool listened and records every request, so a test can show nothing asks it. */
async function listenerAtOldSyncAddress(): Promise<{ port: number; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = [];
  const server = createServer((request, response) => { requests.push(`${request.method} ${request.url}`); response.statusCode = 500; response.end("failed"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as { port: number }).port, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function unusedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Port probe did not bind a TCP port");
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function startServer(dataDir: string, port: number, extraEnv: NodeJS.ProcessEnv = {}): { child: ChildProcess; output: () => string } {
  let output = "";
  const child = spawn(process.execPath, serverArgs(process.env), {
    env: {
      ...process.env,
      HOME: path.join(dataDir, "home"),
      PI_WEB_DATA_DIR: dataDir,
      MASTER_BOB_ADMIN_USERNAME: "admin",
      MASTER_BOB_INITIAL_PASSWORD: "initial-password",
      PORT: String(port),
      ...extraEnv,
    },
  });
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk; });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk; });
  return { child, output: () => output };
}

async function waitForHealth(port: number, status: number): Promise<Response> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.status === status) return response;
    } catch { /* Server is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Health did not return ${status}`);
}


async function waitForOutput(output: () => string, text: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (output().includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Server did not log: ${text}`);
}

async function adminHeaders(port: number): Promise<Record<string, string>> {
  const baseUrl = `http://127.0.0.1:${port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }) });
  const body = await login.json() as { csrfToken: string };
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Missing session cookie");
  const headers = { Cookie: cookie, "X-CSRF-Token": body.csrfToken, "Content-Type": "application/json" };
  await fetch(`${baseUrl}/api/auth/change-password`, { method: "POST", headers, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }) });
  return headers;
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const stopped = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.kill("SIGTERM");
  await stopped;
}

async function writeSyncedProject(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "projects.json"), JSON.stringify({
    projects: [{
      id: "project-1",
      name: "Synced project",
      path: path.join(dataDir, "project"),
      syncFolderId: "folder-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
  }));
}

test("startup stages use static diagnostic labels and readiness waits on no sync tool", async () => {
  const source = await readFile(new URL("../src/server/maintenance.ts", import.meta.url), "utf8");
  assert.match(source, /import \{ measureOperation \} from "\.\/performance-diagnostics\.js"/);
  assert.match(source, /await measureOperation\("startup\.agentResources", \(\) => reconcileManagedAgentResources\(\)\);\s+flags\.startupReady = true;/);
  assert.doesNotMatch(source, /startup[.-]syncthing|reconcileSyncthingProjectFolders/, "startup reconciles no external sync tool");
});

const serverTest = { timeout: 60_000 };

// A project record from an older release still names the folder its sync tool used, and the service
// environment may still carry that tool's address. Startup asks it nothing and reaches ready.
test("a node with a project from an older release reaches ready without asking the old sync tool", serverTest, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-startup-ready-"));
  const old = await listenerAtOldSyncAddress();
  let child: ChildProcess | undefined;
  try {
    await writeSyncedProject(root);
    const port = await unusedPort();
    const address = `http://127.0.0.1:${old.port}`;
    const started = startServer(root, port, { JOINT_BOB_SYNCTHING_URL: address, JOINT_BOB_SYNCTHING_API_KEY: "x", PI_MOBILE_WEB_SYNCTHING_URL: address, PI_MOBILE_WEB_SYNCTHING_API_KEY: "x" });
    child = started.child;
    const ready = await waitForHealth(port, 200);
    assert.deepEqual(await ready.json(), { status: "ok", version: appVersion(), release: "development" });
    assert.notEqual((await fetch(`http://127.0.0.1:${port}/api/cluster/v2/transcripts?projectId=project-1`)).status, 503, "a ready node serves peers");

    const headers = await adminHeaders(port);
    const projects = await (await fetch(`http://127.0.0.1:${port}/api/projects`, { headers })).json() as { projects: Array<{ id: string; syncStatus?: { state: string; message?: string } }> };
    assert.deepEqual(projects.projects.find((project) => project.id === "project-1")?.syncStatus, { state: "unavailable", remainingFiles: 0, remainingBytes: 0, message: "This project is not shared with another machine", engine: "none" });
    // The periodic check (run now) and skill sharing ask it nothing either.
    const check = await fetch(`http://127.0.0.1:${port}/api/settings/sync-check/run`, { method: "POST", headers });
    assert.equal(check.status, 200, started.output());
    const view = await fetch(`http://127.0.0.1:${port}/api/resources/skills/sharing`, { headers });
    assert.equal(view.status, 200, started.output());
    assert.equal("legacy" in (await view.json() as Record<string, unknown>), false, "skill sharing reports no legacy sync state");
    assert.deepEqual(old.requests, []);
    assert.doesNotMatch(started.output(), /Startup reconciliation failed|Syncthing/);
  } finally {
    if (child) await stopServer(child);
    await old.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a node whose agent resources cannot be reconciled stays starting and asks peers to retry", serverTest, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-startup-gate-"));
  let child: ChildProcess | undefined;
  try {
    await writeSyncedProject(root);
    // A file where the agent resources folder belongs makes every reconciliation attempt fail.
    const blocker = path.join(root, "home", "JointBob", ".agent-resources");
    await mkdir(path.dirname(blocker), { recursive: true });
    await writeFile(blocker, "not a folder\n");
    const port = await unusedPort();
    const started = startServer(root, port);
    child = started.child;
    await waitForOutput(started.output, "Startup reconciliation failed, retrying");

    const starting = await waitForHealth(port, 503);
    assert.deepEqual(await starting.json(), { status: "starting", version: appVersion(), release: "development" });
    const peerWhileStarting = await fetch(`http://127.0.0.1:${port}/api/cluster/v2/transcripts?projectId=project-1`);
    assert.equal(peerWhileStarting.status, 503, "peers are asked to retry while the node starts");
    assert.equal(peerWhileStarting.headers.get("retry-after"), "5");

    await rm(blocker);
    const ready = await waitForHealth(port, 200);
    assert.deepEqual(await ready.json(), { status: "ok", version: appVersion(), release: "development" });
    assert.notEqual((await fetch(`http://127.0.0.1:${port}/api/cluster/v2/transcripts?projectId=project-1`)).status, 503, "a ready node serves peers again");
  } finally {
    if (child) await stopServer(child);
    await rm(root, { recursive: true, force: true });
  }
});
