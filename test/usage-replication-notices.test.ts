import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// A twin replicates a usage record for every model call: about twenty batches a minute on
// 2026-11-22, each telling every page on both machines that its projects and conversations
// changed, so every page fetched five lists again to update cost badges.
test("usage from another machine reaches the pages at most once per interval, other changes at once", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-usage-notices-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const { broadcastReplicationInvalidations, USAGE_ANNOUNCE_MS } = await import("../src/server/realtime.js");
  const { watchClients } = await import("../src/server/state.js");
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const received: string[] = [];
  const page = { readyState: 1, OPEN: 1, send: (data: string) => received.push((JSON.parse(data) as { type: string }).type) };
  watchClients.set("project-a", new Set([page as never]));
  t.after(() => watchClients.delete("project-a"));
  const event = (entityType: string, key: string) => ({ entityType, operation: "upsert", entityKey: key, payload: { projectId: "project-a" } });

  for (let call = 0; call < 20; call += 1) broadcastReplicationInvalidations([event("model.usage", `usage-${call}`)] as never);
  assert.deepEqual(received, [], "usage waits for the interval");
  t.mock.timers.tick(USAGE_ANNOUNCE_MS);
  assert.deepEqual(received.sort(), ["projectsChanged", "sessionsChanged"], "twenty batches, one notice of each kind");

  received.length = 0;
  broadcastReplicationInvalidations([event("model.usage", "usage-late")] as never);
  broadcastReplicationInvalidations([event("conversation.record", "record"), event("usage.difficulty", "difficulty")] as never);
  assert.deepEqual(received, ["sessionsChanged"], "a changed conversation is announced at once");
  t.mock.timers.tick(USAGE_ANNOUNCE_MS);
  assert.deepEqual(received, ["sessionsChanged", "projectsChanged"], "the notice already sent covers the usage waiting for it");

  received.length = 0;
  t.mock.timers.tick(USAGE_ANNOUNCE_MS);
  assert.deepEqual(received, [], "nothing more without new usage");
});
