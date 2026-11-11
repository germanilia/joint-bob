import assert from "node:assert/strict";
import test from "node:test";
import type { HarnessSession } from "../src/harnesses/runtime.js";
import { harnessSessionKey, harnessSessions, type SharedHarnessSession } from "../src/server/harness-sessions.js";
import { continueStuckTurn, STUCK_RESTARTS, stuckContinuationPrompt, type StuckDeps } from "../src/server/stuck-conversations.js";

function stoppedTurn(id: string): { shared: SharedHarnessSession; busy: { value: boolean } } {
  const busy = { value: true };
  const session = { id, file: undefined, messages: [], isBusy: () => busy.value, status: () => ({ isStreaming: busy.value, isCompacting: false }) } as unknown as HarnessSession;
  const shared = {
    engine: "pi", projectId: "stuck-project", conversationId: `conversation-${id}`, cwd: "/tmp", session, clients: new Set(), turnInFlight: 0,
    lastLocalEventAt: 0, lastActivityAt: 0, liveEvents: [], idleTimer: null, unsubscribe: () => {}, scheduledTurn: false, watchdogStopping: true,
  } as SharedHarnessSession;
  harnessSessions.set(harnessSessionKey(shared.projectId, shared.engine, id), shared);
  return { shared, busy };
}

function recorder() {
  const continued: Array<{ accountId: string | null; id: string; message: string }> = [];
  const announced: Array<{ conversationId: string; restarted: boolean }> = [];
  const deps: StuckDeps = {
    continueAs: async (accountId, shared, message) => { continued.push({ accountId, id: shared.session.id, message }); },
    announce: async (_projectId, conversationId, restarted) => { announced.push({ conversationId, restarted }); },
  };
  return { continued, announced, deps };
}

test("a stopped stuck turn is told to go on as its account once it lets go, and Bob tells the person", async () => {
  const { continued, announced, deps } = recorder();
  const { shared, busy } = stoppedTurn("held");
  try {
    const running = continueStuckTurn({ shared, accountId: "person-1" }, 5, deps);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(continued.length, 0, "it waits while the stopped turn still holds on");
    busy.value = false;
    await running;
    assert.deepEqual(continued, [{ accountId: "person-1", id: "held", message: stuckContinuationPrompt }]);
    assert.deepEqual(announced, [{ conversationId: "conversation-held", restarted: true }]);
  } finally { harnessSessions.clear(); }
});

test("a zombie turn released by the sweep is told to go on in a fresh session", async () => {
  const { continued, deps } = recorder();
  const { shared } = stoppedTurn("zombie");
  try {
    const running = continueStuckTurn({ shared, accountId: null }, 5, deps);
    harnessSessions.clear();
    await running;
    assert.equal(continued.length, 1);
  } finally { harnessSessions.clear(); }
});

test("a conversation someone wrote to after the stop is left alone", async () => {
  const { continued, announced, deps } = recorder();
  const { shared, busy } = stoppedTurn("answered");
  try {
    busy.value = false;
    shared.watchdogStopping = false;
    await continueStuckTurn({ shared, accountId: "person-1" }, 5, deps);
    assert.deepEqual([continued.length, announced.length], [0, 0]);
  } finally { harnessSessions.clear(); }
});

test("one that keeps getting stuck is restarted a few times, then left to the person", async () => {
  const { continued, announced, deps } = recorder();
  try {
    for (let round = 0; round <= STUCK_RESTARTS; round++) {
      const { shared, busy } = stoppedTurn("looping");
      busy.value = false;
      await continueStuckTurn({ shared, accountId: "person-1" }, 5, deps);
    }
    assert.equal(continued.length, STUCK_RESTARTS);
    assert.deepEqual(announced.at(-1), { conversationId: "conversation-looping", restarted: false });
  } finally { harnessSessions.clear(); }
});
