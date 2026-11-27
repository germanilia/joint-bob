import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";

/* A delete writes its tombstone before removing the transcript, and a peer's tombstone reaches this
   node before file sync removes its copy. On 2026-11-27 a Mac browser reconnecting to a conversation
   just deleted on the Homeserver found that file, and the open failed with a raw
   "Conversation record was deleted" error toast on every reconnect. It is now refused as not found. */

function piTranscript(sessionId: string, cwd: string): string {
  const at = "2026-01-01T00:00:00.000Z";
  return [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: at, cwd }),
    JSON.stringify({ type: "message", id: `${sessionId}-1`, parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "question" }], timestamp: Date.parse(at) } }),
    JSON.stringify({ type: "message", id: `${sessionId}-2`, parentId: `${sessionId}-1`, timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: Date.parse(at) } }),
  ].join("\n") + "\n";
}

test("reopening a deleted conversation whose transcript is still on disk is refused as not found", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-deleted-transcript-"));
  const previous = {
    JOINT_BOB_DATA_DIR: process.env.JOINT_BOB_DATA_DIR,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    MASTER_BOB_ADMIN_USERNAME: process.env.MASTER_BOB_ADMIN_USERNAME,
    MASTER_BOB_INITIAL_PASSWORD: process.env.MASTER_BOB_INITIAL_PASSWORD,
    JOINT_BOB_TEST_ENGINE_LOG: process.env.JOINT_BOB_TEST_ENGINE_LOG,
    NODE_ENV: process.env.NODE_ENV,
    HOME: process.env.HOME,
  };
  process.env.JOINT_BOB_DATA_DIR = path.join(root, "data");
  process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
  process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
  process.env.MASTER_BOB_INITIAL_PASSWORD = "Initial-password-1";
  process.env.NODE_ENV = "test";
  process.env.JOINT_BOB_TEST_ENGINE_LOG = path.join(root, "engine.log");
  process.env.HOME = path.join(root, "home");
  let server: Server | undefined;
  const sockets: WebSocket[] = [];
  try {
    const settings = await import(`../src/settings.ts?deleted-transcript=${Date.now()}`);
    const projectPath = path.join(root, "project");
    const sessionRoot = path.join(root, "home", ".pi", "sessions");
    await Promise.all([mkdir(projectPath, { recursive: true }), mkdir(sessionRoot, { recursive: true })]);
    settings.updateSettings({
      pi: { executable: "pi", configPath: path.join(root, "pi-agent"), sessionPath: sessionRoot },
      claude: { executable: "claude", configPath: path.join(root, "claude-config"), sessionPath: path.join(root, "claude-projects") },
    });
    const sessionId = randomUUID();
    const transcriptPath = path.join(sessionRoot, `${sessionId}.jsonl`);
    await writeFile(transcriptPath, piTranscript(sessionId, projectPath));

    const { installStubHarnessRuntimes } = await import("./stub-harness-runtime.js");
    await installStubHarnessRuntimes();
    const module = await import(`../src/server.ts?deleted-transcript=${Date.now()}`);
    server = module.server;
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "Initial-password-1" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0];
    const { csrfToken } = await login.json() as { csrfToken: string };
    const headers = { Cookie: cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" };
    assert.equal((await fetch(`${baseUrl}/api/auth/change-password`, {
      method: "POST", headers, body: JSON.stringify({ currentPassword: "Initial-password-1", newPassword: "Changed-password-2" }) })).status, 204);
    const created = await fetch(`${baseUrl}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Deleted", path: projectPath }) });
    const { project } = await created.json() as { project: { id: string } };

    // Opened the way the page reconnects to a listed conversation: its path and session id.
    const open = (): Promise<{ code: number; reason: string; messages: Array<Record<string, unknown>> }> => {
      const url = new URL(`/ws?projectId=${project.id}&sessionPath=${encodeURIComponent(transcriptPath)}&sessionId=${sessionId}`, baseUrl);
      url.protocol = "ws:";
      const socket = new WebSocket(url, { origin: baseUrl, headers: { Cookie: cookie } });
      sockets.push(socket);
      const messages: Array<Record<string, unknown>> = [];
      return new Promise((resolve, reject) => {
        socket.on("message", (raw) => {
          const message = JSON.parse(raw.toString()) as Record<string, unknown>;
          messages.push(message);
          if (message.type === "ready") socket.close();
        });
        socket.once("close", (code, reason) => resolve({ code, reason: reason.toString(), messages }));
        socket.once("error", reject);
      });
    };
    const first = await open();
    assert.ok(first.messages.some((message) => message.type === "ready"), `the conversation opened: ${JSON.stringify(first.messages)}`);

    assert.equal((await fetch(`${baseUrl}/api/projects/${project.id}/sessions?engine=pi&sessionId=${sessionId}`, { method: "DELETE", headers })).status, 204);
    // The transcript a delete has not removed yet, or this node's copy of a peer's deleted conversation.
    await writeFile(transcriptPath, piTranscript(sessionId, projectPath));

    const reopened = await open();
    assert.deepEqual(reopened.messages.filter((message) => message.type === "error"), [], "no error reaches the page as a toast");
    assert.equal(reopened.code, 1008, `expected a refusal, got ${reopened.code} (${reopened.reason})`);
    assert.equal(reopened.reason, "Conversation not found");
  } finally {
    for (const socket of sockets) socket.terminate();
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
