import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getClusterNode } from "../src/cluster.js";
import { enableAutoRespond, getAutoRespond, recordAutoResponse, stopAutoRespond } from "../src/conversation-auto-respond.js";
import { ensureConversationRecord } from "../src/conversation-records.js";
import { observeAutoResponder } from "../src/server/auto-respond-recovery.js";
import { server, webSocketServer as ws } from "../src/server/state.js";

test("a timed out recovery socket cannot invalidate a decision already running on another connection", { timeout: 16_000 }, async context => {
  const projectId = randomUUID();
  const conversationId = randomUUID();
  const local = await getClusterNode();
  await ensureConversationRecord(projectId, "pi", conversationId, local.id);
  const decision = await enableAutoRespond(projectId, conversationId, {
    harnessId: "pi", provider: "openai-codex", modelId: "fixture", thinkingLevel: "low",
    instructions: "Check the work.", stopInstructions: "Stop when verified.", maxResponses: 2, useTools: false,
  }, null, "fixture-account");
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  let connections = 0;
  const reattached = Promise.withResolvers<void>();
  ws.on("connection", socket => {
    if (++connections === 2) {
      socket.send(JSON.stringify({ type: "ready", autoRespond: { status: "active" } }));
      reattached.resolve();
    }
    // The first connection opens, but never reports ready.
  });
  const nativeSetTimeout = globalThis.setTimeout;
  context.mock.method(globalThis, "setTimeout", ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => nativeSetTimeout(callback, ms === 30_000 ? 100 : ms, ...args)) as typeof setTimeout);
  const recovery = observeAutoResponder(decision);
  try {
    await reattached.promise;
    const current = await getAutoRespond(projectId, conversationId);
    assert.equal(current?.retry, null, "observer transport errors are not decision failures");
    assert.equal((await recordAutoResponse(projectId, conversationId, decision.revision, "last-answer"))?.responses, 1);
  } finally {
    await stopAutoRespond(projectId, conversationId, "user-stopped", "fixture finished");
    for (const socket of ws.clients) socket.terminate();
    await Promise.all([recovery, new Promise<void>(resolve => ws.close(() => resolve())), new Promise<void>(resolve => server.close(() => resolve()))]);
  }
});
