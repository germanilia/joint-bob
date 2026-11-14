import assert from "node:assert/strict";
import test from "node:test";
import { earlierConversations } from "../src/server/control-center-board.js";
import type { BoardCard } from "../src/control-center/board.js";
import type { SessionSummary } from "../src/types.js";

const session = (id: string, extra: Partial<SessionSummary> = {}) => ({ id, path: `/p/${id}`, harnessId: "pi", agentLabel: "Pi", title: `Title ${id}`, updatedAt: `2026-11-1${id}T10:00:00Z`, ...extra }) as SessionSummary;

// The Inbox lists every conversation: the board's three groups, then Earlier for all the others.
test("Earlier lists what is not on the board, newest first, without scheduled runs, drafts and read-only copies", () => {
  const groups = [
    { projectId: "dak", projectName: "Dak", sessions: [session("1"), session("2"), session("3", { cronTaskId: "c" }), session("4", { draft: true }), session("5", { readOnly: true })] },
    { projectId: "contigos", projectName: "Contigos", sessions: [session("6", { doneAt: "2026-11-12T00:00:00Z" }), session("7", { conversationId: "conv-7" })] },
  ];
  const onBoard = [{ projectId: "dak", conversationId: "2" }] as BoardCard[];
  const earlier = earlierConversations(groups, onBoard);
  assert.deepEqual(earlier.map((row) => `${row.projectName}/${row.conversationId}`), ["Contigos/conv-7", "Contigos/6", "Dak/1"]);
  assert.equal(earlier.find((row) => row.conversationId === "6")!.done, true);
  assert.equal(earlier.find((row) => row.conversationId === "1")!.done, false);
});
