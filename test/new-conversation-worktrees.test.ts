import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { api, projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import { openNodeDatabase } from "../src/node-database.js";
import { waitFor } from "./queued-prompt-harness.js";

test("all socket starts honor the worktree default without moving existing conversations or losing opt-outs", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-new-worktrees-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  const sockets: WebSocket[] = [];
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    server = await startDevNode(environment, node, { JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log") });
    const auth = await signIn(environment, node);
    const project = projectNamed(node, "Joint Bob");
    async function open(sessionId: string, sessionPath = "new", extra: Record<string, string> = {}) {
      const url = new URL("/ws", node.url);
      url.protocol = "ws:";
      for (const [key, value] of Object.entries({ projectId: project.id, sessionId, sessionPath, ...extra })) url.searchParams.set(key, value);
      const socket = new WebSocket(url, { origin: node.url, headers: { Cookie: auth.cookie } });
      sockets.push(socket);
      const frames: Array<Record<string, any>> = [];
      return new Promise<Record<string, any>>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Conversation did not become ready")), 30_000);
        socket.on("message", raw => {
          const frame = JSON.parse(raw.toString());
          frames.push(frame);
          if (frame.type === "ready") { clearTimeout(timeout); resolve({ ...frame, socket, frames }); }
          if (frame.type === "error") { clearTimeout(timeout); reject(new Error(frame.error)); }
        });
        socket.on("error", error => { clearTimeout(timeout); reject(error); });
        socket.on("close", (_code, reason) => { clearTimeout(timeout); reject(new Error(`Socket closed: ${reason}`)); });
      });
    }
    async function worktrees() {
      const response = await api<{ worktrees: Array<{ id: string; path: string }> }>(node, auth, "GET", `/projects/${project.id}/worktrees`);
      assert.equal(response.status, 200);
      return response.body.worktrees;
    }
    function recordedWorktree(sessionId: string) {
      const database = openNodeDatabase(path.join(node.dataDir, "node.db"));
      try {
        return database.prepare("SELECT worktree, worktree_at FROM conversation_records WHERE project_id = ? AND session_id = ?").get(project.id, sessionId) as { worktree: string | null; worktree_at: string | null };
      } finally { database.close(); }
    }

    const id = randomUUID();
    const ready = await open(id);
    const created = await worktrees();
    assert.equal(created.length, 1, "a start that bypasses the wizard must still create its own worktree");
    assert.equal(JSON.parse(recordedWorktree(id).worktree!).id, created[0].id);
    ready.socket.send(JSON.stringify({ type: "prompt", message: "Verify execution folder" }));
    await waitFor(ready.frames, () => ready.frames.some((frame: Record<string, any>) => frame.type === "promptCompleted"));
    const header = JSON.parse((await readFile(ready.sessionFile, "utf8")).split("\n")[0]);
    assert.equal(header.cwd, created[0].path, "the harness must actually execute in the worktree");
    await open(id);
    assert.equal((await worktrees()).length, 1, "reopening cannot create another worktree");

    const concurrentId = randomUUID();
    await Promise.all([open(concurrentId), open(concurrentId)]);
    assert.equal((await worktrees()).length, 2, "simultaneous opens of one conversation create only one worktree");

    const optOutId = randomUUID();
    await open(optOutId, "new", { worktree: "project" });
    assert.equal(recordedWorktree(optOutId).worktree, null, "an explicit project-folder choice wins over the default");
    assert.ok(recordedWorktree(optOutId).worktree_at, "the opt-out is durable");
    await open(optOutId);
    assert.equal((await worktrees()).length, 2, "reopening an opted-out conversation must not change its folder");

    const setting = await api(node, auth, "PUT", "/settings", { newConversationWorktree: false });
    assert.equal(setting.status, 200);
    const disabledId = randomUUID();
    await open(disabledId);
    assert.equal((await worktrees()).length, 2, "the Settings opt-out applies to every start path");
    const forcedId = randomUUID();
    await open(forcedId, "new", { worktree: "new" });
    assert.ok(recordedWorktree(forcedId).worktree, "an explicit new-worktree choice wins even when the default is off");
    await api(node, auth, "PUT", "/settings", { newConversationWorktree: true });
    await open(disabledId);
    assert.equal((await worktrees()).length, 3, "turning the default back on must not move an existing conversation");

    const sessions = await api<{ sessions: Array<{ id: string; path: string; draft?: boolean; worktree?: unknown }> }>(node, auth, "GET", `/projects/${project.id}/sessions`);
    const existing = sessions.body.sessions.find(session => !session.draft && !session.worktree && session.id !== disabledId)!;
    assert.ok(existing, "the fixture includes an existing project-folder transcript");
    await open(existing.id, existing.path);
    assert.equal((await worktrees()).length, 3, "existing history stays in the project folder");

    const explicit = await api<{ worktree: { id: string } }>(node, auth, "POST", `/projects/${project.id}/worktrees`, { name: "Chosen worktree" });
    const explicitId = randomUUID();
    await open(explicitId, "new", { worktreeId: explicit.body.worktree.id });
    assert.equal(JSON.parse(recordedWorktree(explicitId).worktree!).id, explicit.body.worktree.id);
    assert.equal((await worktrees()).length, 4, "an explicit worktree is reused instead of creating another");

    const beforeFailure = await readFile(path.join(root, "engine.log"), "utf8");
    await rename(project.path, `${project.path}-unavailable`);
    try {
      await assert.rejects(open(randomUUID()), /Project folder is not available/);
      assert.equal(await readFile(path.join(root, "engine.log"), "utf8"), beforeFailure, "a failed copy never runs a turn in the project folder");
    } finally { await rename(`${project.path}-unavailable`, project.path); }

    for (const socket of sockets) socket.terminate();
    await stopDevNode(server);
    server = await startDevNode(environment, node, { JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log") });
    const restarted = await signIn(environment, node);
    auth.cookie = restarted.cookie;
    auth.csrfToken = restarted.csrfToken;
    await open(disabledId);
    assert.equal((await worktrees()).length, 4, "a project-folder choice survives a server restart");
  } finally {
    for (const socket of sockets) socket.terminate();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
