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

function client({ presence = async () => {}, ready = () => false, confirm = async () => true }: { presence?: () => Promise<void>; ready?: () => boolean; confirm?: () => Promise<boolean> } = {}) {
  const state = {
    activeProjectId: "project", activeSessionId: null as string | null, activeSessionPath: "", harnesses: [{ id: "pi" }], localNodeId: "local",
    sessionNodes: [{ id: "remote", local: false, online: false }, { id: "local", local: true, online: true, mapped: true }],
  };
  const requests: Array<{ body: { peerId: string; sessionId: string; sessionPath: string; sessionName: string }; reply: ReturnType<typeof deferred> }> = [];
  const messages: string[] = [], errors: string[] = [], keptView: boolean[] = [], opened: Array<{ path: string; node: unknown }> = [];
  const control = { addEventListener() {} };
  const { openListedSession } = runInNewContext(`${source}\n({ openListedSession })`, {
    state, console,
    elements: { markAllReviewedButton: control, markAllPendingReviewedButton: control, closePendingReviewsButton: control },
    document: { querySelectorAll: () => [] }, attachDigitShortcuts() {},
    loadSessionNodes: presence, rememberRecentSession() {},
    activeConversationReady: ready, startOpenTiming() {}, noteOpenTiming() {},
    sessionDisplayTitle: (item: typeof session) => item.title,
    openSession: (sessionPath: string, ...rest: unknown[]) => {
      state.activeSessionPath = sessionPath; keptView.push(rest[3] === true);
      opened.push({ path: sessionPath, node: (state as { activeNodeId?: unknown }).activeNodeId });
    },
    confirmAction: confirm,
    reconcileTranscriptConflict: async () => false,
    toast: Object.assign((message: string) => messages.push(message), { error: (message: string) => errors.push(message) }),
    api: (endpoint: string, options: { body: string }) => {
      assert.equal(endpoint, "/api/projects/project/sessions/take-ownership");
      const reply = deferred();
      requests.push({ body: JSON.parse(options.body), reply });
      return reply.promise;
    },
  });
  return { state, requests, messages, errors, keptView, opened, open: openListedSession as (item: typeof session, options?: { keepView: boolean }) => Promise<void> };
}

function complete(request: ReturnType<typeof client>["requests"][number], sessionPath = session.path) {
  request.reply.resolve({ sessionPath, pendingPeerIds: [] });
}

test("an offline conversation does not move unless the person confirms", async () => {
  const decision = deferred();
  let prompts = 0;
  const page = client({ confirm: async () => { prompts++; return await decision.promise as boolean; } });
  const opening = page.open(session);
  await setImmediate();
  await page.open(session);
  assert.equal(prompts, 1);
  assert.equal(page.requests.length, 0);
  assert.deepEqual(page.opened.map(({ node }) => node), ["remote", "remote"]);
  decision.resolve(false);
  await opening;
  assert.equal(page.requests.length, 0);
});

test("reopening a conversation during confirmed takeover sends only one transfer", async () => {
  const page = client();
  const first = page.open(session);
  await setImmediate();
  const repeated = page.open(session);
  await setImmediate();
  assert.equal(page.requests.length, 1, "a repeated opening must not send the duplicate request that gets a 409");
  assert.deepEqual(page.requests[0].body, { peerId: "local", offlineOwnerNodeId: "remote", sessionId: "conversation", sessionPath: "pi:conversation", sessionName: "Conversation" });
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

test("a conversation reopened on page load stays behind the view, through the takeover from an offline machine", async () => {
  const page = client();
  const restored = page.open(session, { keepView: true });
  await setImmediate();
  complete(page.requests[0]);
  await restored;
  assert.deepEqual(page.messages, ["Switched to this node"]);
  assert.deepEqual(page.keptView, [true, true], "neither restore nor reopening after confirmation may switch to the chat");
  const clicked = page.open(session);
  await setImmediate();
  complete(page.requests[1]);
  await clicked;
  assert.deepEqual(page.keptView.slice(2), [false, true], "a conversation the person opens is shown; the takeover after it keeps the view");
});

test("a conversation on another machine is asked for before that machine's presence answers", async () => {
  const answer = deferred();
  const page = client({ presence: () => answer.promise as Promise<void> });
  const opening = page.open(session);
  await setImmediate();
  assert.deepEqual(page.opened, [{ path: session.path, node: "remote" }], "the socket goes to the owner without waiting for the check");
  answer.resolve(undefined);
  await setImmediate();
  assert.deepEqual(page.opened.map(({ node }) => node), ["remote"], "do not route locally before ownership is confirmed");
  complete(page.requests[0]);
  await opening;
  assert.deepEqual(page.opened.map(({ node }) => node), ["remote", "local"]);
  assert.deepEqual(page.messages, ["Switched to this node"]);
});

test("a conversation that already answered is not taken over on a late offline answer", async () => {
  const page = client({ ready: () => true });
  await page.open(session);
  assert.deepEqual(page.opened.map(({ node }) => node), ["remote"]);
  assert.equal(page.requests.length, 0, "a stored or late presence answer must not move a reachable conversation");
  assert.deepEqual(page.messages, []);
});
