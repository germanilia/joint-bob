import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { WebSocketServer } from "ws";
import { getClusterNode } from "../src/cluster.js";
import { ensureConversationRecord } from "../src/conversation-records.js";
import { cronStore } from "../src/cron.js";
import { queuedCronPrompt } from "../src/server/cron.js";
import { server } from "../src/server/state.js";
import { sessionTitleOverrides, setSessionTitle } from "../src/names.js";
import { webhookConversationTitle } from "../src/webhook-title.js";
import { cronInputSchema } from "../src/cron.js";

const responderConfig = { harnessId: "pi", provider: "test", modelId: "reviewer", thinkingLevel: "high" as const, instructions: "Drive until verified", stopInstructions: "All checks pass", maxResponses: 7, useTools: true };

test("schedules persist independent auto-reply settings and reject invalid limits", async () => {
  const task = cronStore().create({ projectId: "project", name: "Auto", prompt: "Build", engine: "pi", creatorAccountId: "creator", sessionId: null, ownerNodeId: (await getClusterNode()).id, enabled: false, schedule: { frequency: "hourly", hour: 0, minute: 0, weekday: 0, timezone: "UTC" }, autoRespond: responderConfig });
  assert.deepEqual(cronStore().get(task.id)!.autoRespond, { ...responderConfig, providerProfileId: null });
  const { id: _id, nextRun: _nextRun, lastRun: _lastRun, ...input } = task;
  assert.equal(cronInputSchema.safeParse({ ...input, autoRespond: { ...responderConfig, maxResponses: 0 } }).success, false);
});

test("scheduled auto-reply waits for its stopping condition after the first turn completes", async context => {
  const endpoint = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(endpoint, "listening");
  context.mock.method(server, "address", () => endpoint.address());
  const node = await getClusterNode(), sessionId = randomUUID();
  await ensureConversationRecord("project", "pi", sessionId, node.id);
  const task = cronStore().create({ projectId: "project", name: "Auto", prompt: "Build", engine: "pi", creatorAccountId: "creator", sessionId, ownerNodeId: node.id, enabled: true, schedule: { frequency: "hourly", hour: 0, minute: 0, weekday: 0, timezone: "UTC" }, autoRespond: responderConfig });
  const run = cronStore().claim(task.id, node.id, task.nextRun)!;
  let firstComplete = false, settled = false;
  let finishResponder: () => void = () => {};
  endpoint.on("connection", socket => {
    socket.send(JSON.stringify({ type: "ready", status: { model: { provider: "test", id: "agent" }, thinkingLevel: "low" } }));
    socket.on("message", raw => {
      const request = JSON.parse(raw.toString());
      assert.deepEqual(request.scheduledAutoRespond, task.autoRespond);
      socket.send(JSON.stringify({ type: "userMessage", queued: true, requestId: run.id, queueId: "q" }));
      socket.send(JSON.stringify({ type: "promptStarted", queueId: "q" }));
      socket.send(JSON.stringify({ type: "promptCompleted", queueId: "q" }));
      firstComplete = true;
      finishResponder = () => socket.send(JSON.stringify({ type: "autoRespond", state: { status: "stopped", stopKind: "stop-instruction", sourcePromptId: "q" } }));
    });
  });
  try {
    const execution = queuedCronPrompt(task, run, sessionId).then(() => { settled = true; });
    while (!firstComplete) await new Promise(resolve => setTimeout(resolve, 10));
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(settled, false, "schedule remains in progress through auto-replies");
    finishResponder();
    await execution;
  } finally {
    for (const socket of endpoint.clients) socket.terminate();
    await new Promise<void>(resolve => endpoint.close(() => resolve()));
  }
});

test("scheduled executor queues its model and reasoning with the prompt so a busy conversation never fails", async (context) => {
  const endpoint = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(endpoint, "listening");
  context.mock.method(server, "address", () => endpoint.address());
  const nativeSetTimeout = globalThis.setTimeout, nativeClearTimeout = globalThis.clearTimeout;
  const startupTimer = {} as NodeJS.Timeout;
  let startupTimerActive = true, expireStartupTimer = () => undefined;
  context.mock.method(globalThis, "setTimeout", ((callback: () => void, milliseconds?: number, ...args: unknown[]) => {
    if (milliseconds === 30_000) {
      expireStartupTimer = () => { if (startupTimerActive) callback(...args); };
      return startupTimer;
    }
    return nativeSetTimeout(callback, milliseconds, ...args);
  }) as typeof setTimeout);
  context.mock.method(globalThis, "clearTimeout", ((timer: NodeJS.Timeout) => {
    if (timer === startupTimer) startupTimerActive = false;
    else nativeClearTimeout(timer);
  }) as typeof clearTimeout);
  const node = await getClusterNode(), sessionId = randomUUID();
  await ensureConversationRecord("project", "pi", sessionId, node.id);
  const task = cronStore().create({ projectId: "project", name: "Report", prompt: "Report", engine: "pi", model: { provider: "zai", modelId: "glm-5.3-flash", reasoning: "low" }, sessionId, ownerNodeId: node.id, enabled: true, schedule: { frequency: "hourly", hour: 0, minute: 0, weekday: 0, timezone: "UTC" } });
  const run = cronStore().claim(task.id, node.id, task.nextRun)!;
  const requests: unknown[] = [];
  endpoint.on("connection", socket => {
    // A conversation already mid-turn: the executor must never send a bare
    // setModel here, because configuring a live session throws "session is busy".
    socket.send(JSON.stringify({ type: "ready", status: { model: { provider: "zai", id: "glm-5.3-flash" }, thinkingLevel: "high", isStreaming: true } }));
    socket.on("message", raw => {
      const request = JSON.parse(raw.toString());
      requests.push(request);
      if (request.type === "prompt") {
        const queueId = randomUUID();
        socket.send(JSON.stringify({ type: "userMessage", queued: true, requestId: run.id, queueId }));
        nativeSetTimeout(() => {
          expireStartupTimer();
          socket.send(JSON.stringify({ type: "promptStarted", queueId }));
          socket.send(JSON.stringify({ type: "promptCompleted", queueId }));
        }, 50);
      }
    });
  });
  try {
    await queuedCronPrompt(task, run, sessionId);
    assert.deepEqual(requests, [
      { type: "prompt", message: "[Joint Bob scheduled task]\nReport", requestId: run.id, queueSettings: { harnessId: "pi", provider: "zai", modelId: "glm-5.3-flash", reasoning: "low" } },
    ]);
  } finally {
    for (const socket of endpoint.clients) socket.terminate();
    await new Promise<void>(resolve => endpoint.close(() => resolve()));
  }
});

test("new scheduled conversations resolve dates before binding remaining placeholders", async (context) => {
  const endpoint = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(endpoint, "listening");
  context.mock.method(server, "address", () => endpoint.address());
  const node = await getClusterNode(), sessionId = randomUUID();
  await ensureConversationRecord("project", "pi", sessionId, node.id);
  const task = cronStore().create({ projectId: "project", name: "Report [date] - [SUMMARY]", prompt: "Summarize failures", engine: "pi", sessionId: null, ownerNodeId: node.id, enabled: true, schedule: { frequency: "hourly", hour: 0, minute: 0, weekday: 0, timezone: "UTC" } });
  const run = cronStore().claim(task.id, node.id, task.nextRun)!;
  let message = "", template: string | undefined;
  endpoint.on("connection", socket => {
    template = webhookConversationTitle("project", sessionId);
    socket.send(JSON.stringify({ type: "ready", status: { model: { provider: "test", id: "test" }, thinkingLevel: "low" } }));
    socket.on("message", raw => {
      const request = JSON.parse(raw.toString());
      message = request.message;
      socket.send(JSON.stringify({ type: "userMessage", queued: true, requestId: run.id, queueId: "q" }));
      socket.send(JSON.stringify({ type: "promptStarted", queueId: "q" }));
      socket.send(JSON.stringify({ type: "promptCompleted", queueId: "q" }));
    });
  });
  try {
    await queuedCronPrompt(task, { ...run, dueAt: Date.parse("2026-11-14T03:00:00Z") }, sessionId);
    assert.equal(template, "Report 2026-11-14 - [SUMMARY]");
    assert.equal((await sessionTitleOverrides())[sessionId], "Report 2026-11-14 - [SUMMARY]");
    assert.doesNotMatch(message, /\[date\]/);
    assert.match(message, /JOINT_BOB_WEBHOOK_TITLE_CLI/);
    assert.match(message, /\[Joint Bob scheduled task\]\nSummarize failures/);
  } finally {
    for (const socket of endpoint.clients) socket.terminate();
    await new Promise<void>(resolve => endpoint.close(() => resolve()));
  }
});

test("scheduled date titles use the due date and timezone without agent work or overwriting renames", async context => {
  const endpoint = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(endpoint, "listening");
  context.mock.method(server, "address", () => endpoint.address());
  const node = await getClusterNode();
  const cases = [
    { timezone: "UTC", dueAt: "2026-11-14T23:30:00Z", expected: "deploy to prod - 2026-11-14 / 2026-11-14", pinned: false, renamed: false },
    { timezone: "Asia/Jerusalem", dueAt: "2026-11-14T23:30:00Z", expected: "deploy to prod - 2026-11-15 / 2026-11-15", pinned: false, renamed: false },
    { timezone: "America/Los_Angeles", dueAt: "2027-01-01T00:30:00Z", expected: "deploy to prod - 2026-12-31 / 2026-12-31", pinned: false, renamed: false },
    { timezone: "UTC", dueAt: "2026-11-14T23:30:00Z", expected: "My conversation", pinned: true, renamed: true },
    { timezone: "UTC", dueAt: "2026-11-14T23:30:00Z", expected: "My conversation", pinned: false, renamed: true },
  ];
  endpoint.on("connection", socket => {
    socket.send(JSON.stringify({ type: "ready", status: { model: { provider: "test", id: "test" }, thinkingLevel: "low" } }));
    socket.on("message", raw => {
      const request = JSON.parse(raw.toString());
      assert.equal(request.message, "[Joint Bob scheduled task]\nDeploy");
      socket.send(JSON.stringify({ type: "userMessage", queued: true, requestId: request.requestId, queueId: "q" }));
      socket.send(JSON.stringify({ type: "promptStarted", queueId: "q" }));
      socket.send(JSON.stringify({ type: "promptCompleted", queueId: "q" }));
    });
  });
  try {
    for (const fixture of cases) {
      const sessionId = randomUUID();
      await ensureConversationRecord("project", "pi", sessionId, node.id);
      if (fixture.renamed) await setSessionTitle(sessionId, "My conversation");
      const task = cronStore().create({ projectId: "project", name: "deploy to prod - [date] / [date]", prompt: "Deploy", engine: "pi", sessionId: fixture.pinned ? sessionId : null, ownerNodeId: node.id, enabled: true, schedule: { frequency: "daily", hour: 5, minute: 0, weekday: 0, timezone: fixture.timezone } });
      const run = cronStore().claim(task.id, node.id, task.nextRun)!;
      await queuedCronPrompt(task, { ...run, dueAt: Date.parse(fixture.dueAt) }, sessionId);
      assert.equal((await sessionTitleOverrides())[sessionId], fixture.expected);
      assert.equal(webhookConversationTitle("project", sessionId), undefined, "date-only titles need no agent completion");
    }
  } finally {
    for (const socket of endpoint.clients) socket.terminate();
    await new Promise<void>(resolve => endpoint.close(() => resolve()));
  }
});

test("scheduled executor applies reasoning to the default model and settles cancellation", async (context) => {
  const endpoint = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(endpoint, "listening");
  context.mock.method(server, "address", () => endpoint.address());
  const node = await getClusterNode(), sessionId = randomUUID();
  await ensureConversationRecord("project", "claude", sessionId, node.id);
  const task = cronStore().create({ projectId: "project", name: "Report", prompt: "Report", engine: "claude", reasoning: "high", sessionId, ownerNodeId: node.id, enabled: true, schedule: { frequency: "hourly", hour: 0, minute: 0, weekday: 0, timezone: "UTC" } });
  const run = cronStore().claim(task.id, node.id, task.nextRun)!;
  endpoint.on("connection", socket => {
    socket.send(JSON.stringify({ type: "ready", status: { model: { provider: "anthropic", id: "claude-opus-5" }, thinkingLevel: "low" } }));
    socket.on("message", raw => {
      const request = JSON.parse(raw.toString());
      assert.equal(request.type, "prompt");
      assert.deepEqual(request.queueSettings, { harnessId: "claude", provider: "anthropic", modelId: "claude-opus-5", reasoning: "high" });
      assert.equal(request.requestId, run.id);
      const queueId = randomUUID();
      socket.send(JSON.stringify({ type: "userMessage", queued: true, requestId: run.id, queueId }));
      socket.send(JSON.stringify({ type: "queuedPromptCancelled", queueId }));
      // Close later so broken code reports a lost connection rather than the
      // cancellation, without leaving a thirty-second readiness timeout alive.
      const close = setTimeout(() => socket.close(), 100);
      socket.once("close", () => clearTimeout(close));
    });
  });
  try {
    await assert.rejects(queuedCronPrompt(task, run, sessionId), /Scheduled prompt was cancelled/);
  } finally {
    for (const socket of endpoint.clients) socket.terminate();
    await new Promise<void>(resolve => endpoint.close(() => resolve()));
  }
});
