import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeSessionFilePath } from "../src/claude-service.js";
import { ensureConversationRecord } from "../src/conversation-records.js";
import { clearHarnessSessionCache, listHarnessSessions } from "../src/harnesses.js";
import { earlierConversations, pastConversations } from "../src/server/control-center-board.js";
import type { SessionSummary } from "../src/types.js";

test("an existing conversation stays in Bob's Inbox before the switched harness receives a message", async (t) => {
  const project = { id: randomUUID(), name: "Dak fixture", path: path.join(os.homedir(), randomUUID()) };
  const originalId = randomUUID(), switchedId = randomUUID();
  const originalPath = claudeSessionFilePath(project.path, originalId);
  const switchedPath = path.join(os.homedir(), ".pi/agent/sessions", `${switchedId}.jsonl`);
  t.after(async () => {
    clearHarnessSessionCache(project.id);
    await rm(path.dirname(originalPath), { recursive: true, force: true });
    await rm(switchedPath, { force: true });
  });
  await mkdir(path.dirname(originalPath), { recursive: true });
  await writeFile(originalPath, JSON.stringify({ type: "user", cwd: project.path, message: { role: "user", content: "November 15 Integration Audit" } }) + "\n");
  await ensureConversationRecord(project.id, "claude", originalId, "fixture-node");
  await ensureConversationRecord(project.id, "pi", switchedId, "fixture-node", undefined, { conversationId: originalId, segmentIndex: 1 });
  const idle = await listHarnessSessions(project);
  assert.equal(idle.length, 1);
  assert.equal(idle[0].title, "[Claude] November 15 Integration Audit");
  assert.equal(idle[0].segments?.length, 2);
  const idleGroup = [{ projectId: project.id, projectName: project.name, sessions: idle }];
  const bobIdle = pastConversations(idleGroup, () => null);
  const earlierIdle = earlierConversations(idleGroup, []);

  const timestamp = new Date().toISOString();
  await mkdir(path.dirname(switchedPath), { recursive: true });
  await writeFile(switchedPath, [
    { type: "session", version: 3, id: switchedId, cwd: project.path, timestamp },
    { type: "message", id: "new-message", parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: "continue" }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  clearHarnessSessionCache(project.id);
  const continued = await listHarnessSessions(project);
  const bobContinued = pastConversations([{ projectId: project.id, projectName: project.name, sessions: continued }], () => null);
  assert.equal(bobContinued.length, 1, "the conversation appears after a new message materializes the switched segment");
  assert.equal(bobIdle.length, 1, "the same existing conversation must also be present before that extra message");
  assert.equal(bobIdle[0].conversationId, originalId);
  assert.equal(bobIdle[0].path, `draft:pi:${switchedId}`, "opening still targets the newest segment");
  assert.equal(earlierIdle.length, 1, "the workspace's Earlier list must retain the conversation too");
});

test("empty conversations remain hidden, but done conversations with earlier history remain in Past", () => {
  const entry = { id: "new", path: "draft:pi:new", conversationId: "existing", harnessId: "pi", agentId: "pi", agentLabel: "Pi", title: "Existing", draft: true } as SessionSummary;
  const original = { engine: "claude" as const, sessionId: "original", path: "claude:/original" };
  const latest = { engine: "pi" as const, sessionId: "new", path: entry.path, draft: true };
  const groups = [{ projectId: "project", projectName: "Project", sessions: [
    { ...entry, id: "empty", conversationId: "empty" },
    { ...entry, id: "empty-chain", conversationId: "empty-chain", segments: [{ ...original, draft: true }, latest] },
    { ...entry, doneAt: "2026-11-15T10:00:00Z", segments: [original, latest] },
  ] }];
  assert.deepEqual(pastConversations(groups, () => null).map((row) => [row.conversationId, row.doneAt]), [["existing", "2026-11-15T10:00:00Z"]]);
  assert.deepEqual(earlierConversations(groups, []).map((row) => [row.conversationId, row.done]), [["existing", true]]);
});
