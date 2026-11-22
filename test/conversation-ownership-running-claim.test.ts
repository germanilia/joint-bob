import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const engine = "claude" as const;
const localNodeId = "11111111-1111-4111-8111-111111111111";
const peerNodeId = "22222222-2222-4222-8222-222222222222";

function conflict(sessionId: string, ownerNodeId = localNodeId, transferToNodeId = peerNodeId) {
  return { engine, sessionId, ownerNodeId, epoch: 1, status: "conflict" as const, transferToNodeId };
}

test("only a node named in a conflict claims it, and never over a newer record", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-conflict-claim-"));
  const previous = process.env.JOINT_BOB_DATA_DIR;
  process.env.JOINT_BOB_DATA_DIR = dataDir;
  try {
    const ownership = await import(`../src/conversation-ownership.ts?claim=${Date.now()}-${Math.random()}`);
    // The node named second in the conflict record is a contender too.
    const record = conflict("session-claim", peerNodeId, localNodeId);
    await ownership.compareAndSetConversationOwnership(undefined, record, peerNodeId);
    const claimed = await ownership.claimConflictForRunningNode(record, localNodeId);
    assert.deepEqual(claimed, { engine, sessionId: record.sessionId, ownerNodeId: localNodeId, epoch: 2, status: "owned", transferToNodeId: null });
    assert.deepEqual(await ownership.getConversationOwnership(engine, record.sessionId), claimed);

    // A takeover that landed after the caller's read wins.
    const raced = conflict("session-raced");
    await ownership.compareAndSetConversationOwnership(undefined, raced, localNodeId);
    const takeover = await ownership.takeConversationOwnership(engine, raced.sessionId, peerNodeId);
    assert.deepEqual(await ownership.claimConflictForRunningNode(raced, localNodeId), takeover);

    await assert.rejects(ownership.claimConflictForRunningNode(conflict("session-other"), "33333333-3333-4333-8333-333333333333"), /named in the conflict/);
  } finally {
    if (previous === undefined) delete process.env.JOINT_BOB_DATA_DIR; else process.env.JOINT_BOB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("the node running a conflicted conversation takes it unless the other node runs it too", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-conflict-running-"));
  const previous = process.env.JOINT_BOB_DATA_DIR;
  process.env.JOINT_BOB_DATA_DIR = dataDir;
  const dashboard: Server = createServer((request, response) => {
    const runId = String(request.url).split("/").at(-1);
    response.end(JSON.stringify({ runs: [{ runId, status: "running", tasks: [] }] }));
  });
  await new Promise<void>((resolve) => dashboard.listen(0, "127.0.0.1", resolve));
  try {
    const address = dashboard.address();
    assert.ok(address && typeof address !== "string");
    const ownership = await import("../src/conversation-ownership.js");
    const { recordConversationWork } = await import("../src/conversation-work.js");
    const { applyRuntimeLeaseSnapshot, conversationRuntimeDatabase } = await import("../src/conversation-runtime.js");
    const { buildRuntimeLeaseSnapshot } = await import("../src/server/maintenance.js");
    const runLocally = (sessionId: string) => {
      const summary = { runId: sessionId, status: "running" as const, tasks: [] };
      recordConversationWork({ engine, sessionId, summary, descriptor: { runId: sessionId, stateUrl: `http://127.0.0.1:${address.port}/state/${sessionId}`, summary } });
    };

    // Running only here: this node takes the conflict and advertises the run.
    // The conflict names the peer as owner, which used to hide the run entirely.
    const solo = conflict("session-solo", peerNodeId, localNodeId);
    await ownership.compareAndSetConversationOwnership(undefined, solo, peerNodeId);
    runLocally(solo.sessionId);

    // Running on both nodes: a genuine split, left for the person to settle.
    const both = conflict("session-both");
    await ownership.compareAndSetConversationOwnership(undefined, both, localNodeId);
    runLocally(both.sessionId);
    const now = new Date();
    applyRuntimeLeaseSnapshot(conversationRuntimeDatabase(), peerNodeId, now.toISOString(), [{
      engine, sessionId: both.sessionId, ownerNodeId: peerNodeId, ownershipEpoch: 1, runId: "peer-run",
      updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 15_000).toISOString(),
    }]);

    const leases = await buildRuntimeLeaseSnapshot(localNodeId);
    assert.deepEqual(await ownership.getConversationOwnership(engine, solo.sessionId),
      { engine, sessionId: solo.sessionId, ownerNodeId: localNodeId, epoch: 2, status: "owned", transferToNodeId: null });
    assert.equal(leases.find((lease) => lease.sessionId === solo.sessionId)?.ownershipEpoch, 2);
    assert.deepEqual(await ownership.getConversationOwnership(engine, both.sessionId), both);
  } finally {
    await new Promise<void>((resolve) => dashboard.close(() => resolve()));
    if (previous === undefined) delete process.env.JOINT_BOB_DATA_DIR; else process.env.JOINT_BOB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});
