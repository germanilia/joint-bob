import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getClusterNode } from "../src/cluster.js";
import { cancelQueuedPrompt, enqueuePrompt, projectHasQueuedPrompts } from "../src/prompt-queue.js";
import { importProject, registerProjectAliases } from "../src/store.js";

// Listings skip the per-conversation queue lookups (five queries each) for a project with nothing queued.
test("a project reports queued prompts only while one of its conversations has some, also through an alias", async () => {
  await getClusterNode();
  const metadata = { messageText: "m", promptSuffix: "", displaySuffix: "", attachmentPaths: [], settings: null };
  const projectId = `queue-check-${randomUUID()}`;
  const key = `${projectId}:${randomUUID()}`;
  assert.equal(projectHasQueuedPrompts(projectId), false);

  const queued = enqueuePrompt(key, "m", "m", metadata);
  assert.equal(projectHasQueuedPrompts(projectId), true);
  assert.equal(projectHasQueuedPrompts(`${projectId}x`), false, "a project whose ID starts the same way is not counted");
  assert.equal(projectHasQueuedPrompts(projectId.slice(0, -1)), false, "nor one whose ID is a prefix");

  await importProject({ id: projectId, name: "Queue check", path: "/remote/queue-check", createdAt: "2026-01-01", updatedAt: "2026-01-01" }, `/tmp/${projectId}`);
  const aliasId = `${projectId}-alias`;
  await registerProjectAliases(projectId, [aliasId]);
  assert.equal(projectHasQueuedPrompts(aliasId), true, "an alias reads its project's queue");

  cancelQueuedPrompt(key, queued.id);
  assert.equal(projectHasQueuedPrompts(projectId), false);
});
