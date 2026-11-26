import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getClusterNode } from "../src/cluster.js";
import { ensureConversationRecord } from "../src/conversation-records.js";
import { cancelQueuedPrompt, enqueuePrompt, listQueuedPrompts, projectHasQueuedPrompts, queuedPromptCandidates } from "../src/prompt-queue.js";
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

// A listing asks only the conversations that can have queued prompts; whichever it asks, the prompts come from listQueuedPrompts.
test("a listing is told which conversations may have queued prompts: the one queued for, and a segment of it", async () => {
  const node = await getClusterNode();
  const metadata = { messageText: "m", promptSuffix: "", displaySuffix: "", attachmentPaths: [], settings: null };
  const projectId = `queue-candidates-${randomUUID()}`;
  await importProject({ id: projectId, name: "Queue candidates", path: "/remote/queue-candidates", createdAt: "2026-01-01", updatedAt: "2026-01-01" }, `/tmp/${projectId}`);
  const conversation = randomUUID(), laterSegment = randomUUID(), other = randomUUID(), lone = randomUUID();
  assert.equal(queuedPromptCandidates(projectId)(conversation), false, "nothing is queued in the project");

  await ensureConversationRecord(projectId, "claude", conversation, node.id, undefined, { conversationId: conversation, segmentIndex: 0 });
  await ensureConversationRecord(projectId, "pi", laterSegment, node.id, undefined, { conversationId: conversation, segmentIndex: 1 });
  await ensureConversationRecord(projectId, "claude", other, node.id);
  enqueuePrompt(`${projectId}:${laterSegment}`, "m", "m", metadata);
  enqueuePrompt(`${projectId}:${lone}`, "m", "m", metadata);

  const may = queuedPromptCandidates(projectId);
  for (const id of [conversation, laterSegment, other, lone, randomUUID()]) {
    const prompts = listQueuedPrompts(`${projectId}:${id}`).length;
    if (prompts) assert.equal(may(id), true, "a conversation with queued prompts is always asked");
  }
  assert.equal(listQueuedPrompts(`${projectId}:${conversation}`).length, 1, "a prompt queued through a segment belongs to its conversation");
  assert.equal(may(conversation), true);
  assert.equal(may(laterSegment), true);
  assert.equal(may(lone), true, "a conversation without a record is found by its own id");
  assert.equal(may(other), false, "a conversation with nothing queued is not asked");
  assert.equal(queuedPromptCandidates(`${projectId}x`)(lone), false, "another project's queue is not read");
});
