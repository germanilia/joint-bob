import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";

const source = (await readFile("public/app/reviews.js", "utf8")).replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
const session = { id: "conversation", path: "pi:conversation", harnessId: "pi", title: "Conversation", executionNodeId: "remote" };

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function client() {
  const state = {
    activeProjectId: "project", activeSessionId: null as string | null, activeSessionPath: "", harnesses: [{ id: "pi" }],
    sessionNodes: [{ id: "remote", local: false, online: false }, { id: "local", local: true, online: true, mapped: true }],
  };
  const requests: Array<{ body: { peerId: string; sessionId: string; sessionPath: string; sessionName: string }; reply: ReturnType<typeof deferred> }> = [];
  const messages: string[] = [], errors: string[] = [];
  const control = { addEventListener() {} };
  const { openListedSession } = runInNewContext(`${source}\n({ openListedSession })`, {
    state, console,
    elements: { markAllReviewedButton: control, markAllPendingReviewedButton: control, closePendingReviewsButton: control },
    document: { querySelectorAll: () => [] }, attachDigitShortcuts() {},
    loadSessionNodes: async () => {}, rememberRecentSession() {},
    sessionDisplayTitle: (item: typeof session) => item.title,
    openSession: (sessionPath: string) => { state.activeSessionPath = sessionPath; },
    reconcileTranscriptConflict: async () => false,
    toast: Object.assign((message: string) => messages.push(message), { error: (message: string) => errors.push(message) }),
    api: (endpoint: string, options: { body: string }) => {
      assert.equal(endpoint, "/api/projects/project/sessions/take-ownership");
      const reply = deferred();
      requests.push({ body: JSON.parse(options.body), reply });
      return reply.promise;
    },
  });
  return { state, requests, messages, errors, open: openListedSession as (item: typeof session) => Promise<void> };
}

function complete(request: ReturnType<typeof client>["requests"][number], sessionPath = session.path) {
  request.reply.resolve({ sessionPath, pendingPeerIds: [] });
}

test("reopening a conversation during automatic takeover sends only one transfer", async () => {
  const page = client();
  const first = page.open(session);
  await setImmediate();
  const repeated = page.open(session);
  await setImmediate();
  assert.equal(page.requests.length, 1, "a repeated opening must not send the duplicate request that gets a 409");
  assert.deepEqual(page.requests[0].body, { peerId: "local", sessionId: "conversation", sessionPath: "pi:conversation", sessionName: "Conversation" });
  complete(page.requests[0]);
  await Promise.all([first, repeated]);
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.messages, ["Switched to this node"]);
  assert.equal(page.state.activeSessionPath, session.path);

  const later = page.open(session);
  await setImmediate();
  assert.equal(page.requests.length, 2, "a completed transfer must not block a later explicit opening");
  complete(page.requests[1]);
  await later;
});

test("a failed takeover remains visible once and allows a later retry", async () => {
  const page = client();
  const first = page.open(session);
  await setImmediate();
  const repeated = page.open(session);
  await setImmediate();
  assert.equal(page.requests.length, 1);
  page.requests[0].reply.reject(new Error("History differs between machines"));
  await Promise.all([first, repeated]);
  assert.deepEqual(page.errors, ["History differs between machines"]);
  assert.deepEqual(page.messages, []);

  const retry = page.open(session);
  await setImmediate();
  assert.equal(page.requests.length, 2, "a failed transfer must release its in-flight guard");
  complete(page.requests[1]);
  await retry;
  assert.deepEqual(page.messages, ["Switched to this node"]);
});

test("in-flight transfers do not block other conversations or returning to the first", async () => {
  const page = client();
  const other = { ...session, id: "other", path: "pi:other" };
  const first = page.open(session);
  await setImmediate();
  const second = page.open(other);
  await setImmediate();
  assert.equal(page.requests.length, 2);
  const returning = page.open(session);
  await setImmediate();
  assert.equal(page.requests.length, 2, "returning to a pending conversation reuses its transfer");
  assert.equal(page.state.activeSessionId, session.id);
  assert.equal(page.state.activeSessionPath, session.path);
  complete(page.requests[1], other.path);
  await second;
  assert.equal(page.state.activeSessionPath, session.path, "the other transfer must not reopen a conversation the user left");
  complete(page.requests[0]);
  await Promise.all([first, returning]);
  assert.deepEqual(page.messages, ["Switched to this node"]);
  assert.deepEqual(page.errors, []);
});
