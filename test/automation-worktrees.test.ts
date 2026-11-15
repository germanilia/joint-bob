import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { getClusterNode } from "../src/cluster.js";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { ensureConversationRecord, setConversationWorktree } from "../src/conversation-records.js";
import { DatabaseSync } from "node:sqlite";
import { resolveDataDirectory } from "../src/data-directory.js";
import { closeBackgroundTaskReaders } from "../src/background-tasks.js";
import { withAutomationWorktree } from "../src/server/automation-worktree.js";
import { cronStore } from "../src/cron.js";
import { deleteProjectWorktree, listProjectWorktrees, markWorktreeConversation } from "../src/project-worktrees.js";
import { dispatchCronTasks } from "../src/server/cron.js";
import { flags, server } from "../src/server/state.js";
import { acceptWebhookCall, webhookDeliveryPending } from "../src/server/webhooks.js";
import { addProject } from "../src/store.js";
import { createWebhook, webhookInputSchema } from "../src/webhooks.js";
import { automationRunOf } from "../src/automation-executions.js";

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail("automation did not reach the expected state");
}

test("a completed automation never deletes a worktree still used by a background task", async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-automation-background-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = await addProject("Background automation", path.join(root, "project"), { writeInstructions: false });
  const local = await getClusterNode();
  const sessionId = randomUUID();
  const supervisor = new DatabaseSync(path.join(resolveDataDirectory(), "supervisor.db"));
  supervisor.exec("CREATE TABLE IF NOT EXISTS supervisor_tasks(id TEXT PRIMARY KEY, identity TEXT NOT NULL, status TEXT NOT NULL)");
  try {
    await assert.rejects(withAutomationWorktree({ projectId: project.id, name: "Background", runInWorktree: true }, randomUUID(), async worktree => {
      await ensureConversationRecord(project.id, "pi", sessionId, local.id);
      await markWorktreeConversation(project.id, worktree!.id, "pi", sessionId);
      await setConversationWorktree(project.id, "pi", sessionId, worktree!, local.id);
      supervisor.prepare("INSERT INTO supervisor_tasks(id,identity,status) VALUES(?,?,'running')").run(sessionId, JSON.stringify([project.id, sessionId]));
    }), /still has active work; it was retained/);
    assert.equal((await listProjectWorktrees(project.id)).length, 1);
  } finally {
    supervisor.prepare("DELETE FROM supervisor_tasks WHERE id=?").run(sessionId);
    closeBackgroundTaskReaders();
    supervisor.close();
    for (const tree of await listProjectWorktrees(project.id)) await deleteProjectWorktree(project.id, tree.id);
  }
});

for (const source of ["webhook", "scheduled"] as const) {
  for (const fail of [false, true]) {
    test(`${source} runs use fresh origin main worktrees and remove them after ${fail ? "failure" : "completion"}`, async context => {
      const root = await mkdtemp(path.join(os.tmpdir(), "jb-automation-worktrees-"));
      context.after(() => rm(root, { recursive: true, force: true }));
      const origin = path.join(root, "origin.git");
      execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
      const projectPath = path.join(root, "project");
      execFileSync("git", ["clone", "-q", origin, projectPath]);
      const git = (...args: string[]) => execFileSync("git", ["-C", projectPath, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args]);
      await writeFile(path.join(projectPath, "source.txt"), "origin main\n");
      git("add", "source.txt"); git("commit", "-qm", "initial"); git("push", "-q", "origin", "main");
      await writeFile(path.join(projectPath, "source.txt"), "unpublished main\n");
      git("add", "source.txt"); git("commit", "-qm", "local only");
      await writeFile(path.join(projectPath, "source.txt"), "dirty project\n");
      const project = await addProject("Automation", projectPath, { writeInstructions: false });
      const local = await getClusterNode();
      const pinnedSessionId = randomUUID();
      await ensureConversationRecord(project.id, "pi", pinnedSessionId, local.id);
      const endpoint = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await once(endpoint, "listening");
      context.mock.method(server, "address", () => endpoint.address());
      const previousReady = flags.startupReady;
      flags.startupReady = true;
      let active: { socket: WebSocket; sessionId: string; worktreeId: string | null; bypassGuardian: string | null; prompt: { requestId: string; message: string } } | undefined;
      endpoint.on("connection", (socket, request) => {
        const url = new URL(request.url!, "http://localhost");
        socket.send(JSON.stringify({ type: "ready", status: { model: { provider: "test", id: "test" }, thinkingLevel: "low" } }));
        socket.on("message", raw => {
          const prompt = JSON.parse(raw.toString());
          active = { socket, sessionId: url.searchParams.get("sessionId")!, worktreeId: url.searchParams.get("worktreeId"), bypassGuardian: url.searchParams.get("bypassGuardian"), prompt };
          socket.send(JSON.stringify({ type: "userMessage", queued: true, requestId: prompt.requestId, queueId: "q" }));
          socket.send(JSON.stringify({ type: "promptStarted", queueId: "q" }));
        });
      });
      const db = await clusterV2Database();
      const hook = source === "webhook" ? createWebhook(db, webhookInputSchema.parse({ name: "Fresh run", bypassGuardian: true, preserveFiles: true, target: { kind: "conversation", projectId: project.id, engine: "pi", sessionId: pinnedSessionId } })).webhook : null;
      const task = source === "scheduled" ? cronStore().create({ projectId: project.id, name: "Fresh run", bypassGuardian: true, prompt: "Check code", engine: "pi", sessionId: pinnedSessionId, ownerNodeId: local.id, enabled: true, schedule: { frequency: "hourly", hour: 0, minute: 0, weekday: 0, timezone: "UTC" } }) : null;
      try {
        const worktreeIds: string[] = [];
        for (let run = 0; run < 2; run++) {
          active = undefined;
          if (hook) acceptWebhookCall(hook, { method: "POST", headers: {}, query: "", body: "Check code" });
          if (task) await dispatchCronTasks(cronStore().runNow(task.id).nextRun);
          await until(() => active !== undefined || Boolean(task && cronStore().get(task.id)!.lastRun?.status === "failed"));
          assert.ok(active, task ? cronStore().get(task.id)!.lastRun?.error ?? "scheduled prompt missing" : "webhook prompt missing");
          assert.ok(active.worktreeId, "the automation socket must select a real project worktree");
          assert.equal(active.bypassGuardian, "1", "isolating a run must preserve its trusted Guardian setting");
          if (source === "scheduled") assert.ok(active.prompt.message.startsWith("[Joint Bob scheduled task]\n"), "worktree instructions must not hide the scheduler marker");
          assert.notEqual(active.sessionId, pinnedSessionId, "an isolated run must not relocate an existing conversation");
          const trees = await listProjectWorktrees(project.id);
          assert.equal(trees.length, 1);
          assert.equal(trees[0].id, active.worktreeId);
          assert.equal(await readFile(path.join(trees[0].path, "source.txt"), "utf8"), "origin main\n");
          worktreeIds.push(trees[0].id);
          // The worktree must survive the started event, until the entire turn settles.
          active.socket.send(JSON.stringify({ type: fail ? "promptFailed" : "promptCompleted", queueId: "q", ...(fail ? { error: "synthetic turn failure" } : {}) }));
          if (hook) await until(() => !webhookDeliveryPending(hook.id));
          if (task) await until(() => ["succeeded", "failed"].includes(cronStore().get(task.id)!.lastRun!.status));
          assert.deepEqual(await listProjectWorktrees(project.id), []);
          await assert.rejects(access(trees[0].path), { code: "ENOENT" });
          if (task) assert.equal(cronStore().get(task.id)!.lastRun!.status, fail ? "failed" : "succeeded");
          if (hook) {
            assert.equal(automationRunOf(db, active.prompt.requestId)?.status, fail ? "failed" : "succeeded");
            if (fail) assert.equal(automationRunOf(db, active.prompt.requestId)?.error, "synthetic turn failure");
          }
        }
        assert.notEqual(worktreeIds[0], worktreeIds[1], "every invocation creates its own worktree");
        assert.equal(await readFile(path.join(projectPath, "source.txt"), "utf8"), "dirty project\n");
      } finally {
        flags.startupReady = previousReady;
        for (const socket of endpoint.clients) socket.terminate();
        await new Promise<void>(resolve => endpoint.close(() => resolve()));
      }
    });
  }
}
