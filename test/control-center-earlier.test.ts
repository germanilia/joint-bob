import assert from "node:assert/strict";
import test from "node:test";
import { earlierConversations, pastConversations } from "../src/server/control-center-board.js";
import type { BoardCard } from "../src/control-center/board.js";
import type { SessionSummary } from "../src/types.js";

const session = (id: string, extra: Partial<SessionSummary> = {}) => ({ id, path: `/p/${id}`, harnessId: "pi", agentLabel: "Pi", title: `Title ${id}`, updatedAt: `2026-11-1${id}T10:00:00Z`, ...extra }) as SessionSummary;

// The Inbox lists every conversation: the board's groups, then Earlier for all the others, flagged as scheduled, done, read-only or new.
test("Earlier lists what is not on the board, newest first, with scheduled runs, done ones and read-only copies flagged", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  const groups = [
    { projectId: "dak", projectName: "Dak", sessions: [session("1"), session("2"), session("3", { cronTaskId: "c" }), session("4", { draft: true, updatedAt: "2026-11-18T11:00:00Z" }), session("5", { readOnly: true }), session("8", { draft: true, updatedAt: "2026-11-10T11:00:00Z" })] },
    { projectId: "contigos", projectName: "Contigos", sessions: [session("6", { doneAt: "2026-11-12T00:00:00Z" }), session("7", { conversationId: "conv-7" })] },
  ];
  const onBoard = [{ projectId: "dak", conversationId: "2" }] as BoardCard[];
  const earlier = earlierConversations(groups, onBoard, now);
  assert.deepEqual(earlier.map((row) => `${row.projectName}/${row.conversationId}`).sort(), ["Contigos/6", "Contigos/conv-7", "Dak/1", "Dak/3", "Dak/4", "Dak/5"]);
  assert.deepEqual(earlier.map((row) => row.updatedAt), [...earlier.map((row) => row.updatedAt)].sort().reverse(), "newest first");
  const by = (id: string) => earlier.find((row) => row.conversationId === id)!;
  assert.equal(earlier.length, 6, "an old draft nobody wrote in is the only one left out");
  assert.equal(by("6").done, true);
  assert.equal(by("1").done, false);
  assert.equal(by("3").scheduled, true);
  assert.equal(by("5").readOnly, true);
  assert.equal(by("4").fresh, true);
  assert.equal(by("1").fresh, false);
});

test("Earlier includes conversations beyond the old 2000-row cutoff", () => {
  const sessions = Array.from({ length: 2005 }, (_, index) => session(`archive-${index}`, {
    updatedAt: new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString(),
  }));
  const earlier = earlierConversations([{ projectId: "dak", projectName: "Dak", sessions }], []);
  assert.equal(earlier.length, 2005);
  assert.equal(earlier.at(-1)!.conversationId, "archive-0", "the oldest conversation remains reachable");
});

// The list's Inbox and search: a conversation that was reviewed and never marked done is on no lane of the board and not in Past.
test("the list reads the done conversations and the open ones, each newest first, with where they run", () => {
  const groups = [
    { projectId: "contigos", projectName: "Contigos", sessions: [
      session("1", { doneAt: "2026-11-12T00:00:00Z" }), session("2", { doneAt: "2026-11-13T00:00:00Z" }),
      session("3", { conversationId: "tenant-16", executionNodeId: "homeserver" }), session("4"), session("5", { cronTaskId: "c" }), session("6", { draft: true }), session("7", { readOnly: true }),
    ] },
  ];
  const past = pastConversations(groups, (_projectId, conversationId) => (conversationId === "tenant-16" ? "x".repeat(900) : null));
  assert.deepEqual(past.map((row) => [row.conversationId, row.doneAt]), [["2", "2026-11-13T00:00:00Z"], ["1", "2026-11-12T00:00:00Z"], ["4", null], ["tenant-16", null]]);
  const open = past.find((row) => row.conversationId === "tenant-16")!;
  assert.equal(open.executionNodeId, "homeserver");
  assert.equal(open.sessionId, "3");
  assert.equal(open.summary!.length, 800);
});
