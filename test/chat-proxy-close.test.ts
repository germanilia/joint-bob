// A conversation that runs on another machine reaches the page through this node's proxy (src/server/chat.ts). When the
// link to that machine dropped, the page's socket was closed with no reason, so the page kept saying it was opening the
// conversation and retried without saying why.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import test, { after, before } from "node:test";
import { environment, temporaryRoot } from "./queued-prompt-harness.js";

let root: string, previous: NodeJS.ProcessEnv;
let chat: typeof import("../src/server/chat.js");

before(async () => {
  root = await temporaryRoot("joint-bob-proxy-close-");
  previous = { ...process.env };
  Object.assign(process.env, environment(root));
  chat = await import("../src/server/chat.js");
});

after(async () => {
  chat.sessionWatcher.close();
  process.env = previous;
  await rm(root, { recursive: true, force: true });
});

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  closed: Array<number | string | undefined> | undefined;
  close(code?: number, reason?: string): void { this.closed = [code, reason]; this.readyState = 3; }
  send(): void {}
  terminate(): void { this.closed ??= ["terminated"]; }
}

function proxied() {
  const page = new FakeSocket(), owner = new FakeSocket();
  chat.proxySocket(page as never, owner as never);
  owner.emit("open");
  return { page, owner };
}

test("a dropped link to the machine running the conversation tells the page why", () => {
  const { page, owner } = proxied();
  owner.emit("close", 1006, Buffer.alloc(0));
  assert.deepEqual(page.closed, [1011, chat.LOST_EXECUTION_NODE]);
});

test("the owner's own reason reaches the page unchanged, and a close without a status stays without one", () => {
  const refused = proxied();
  refused.owner.emit("close", 1008, Buffer.from("Conversation not found"));
  assert.deepEqual(refused.page.closed, [1008, "Conversation not found"]);
  const plain = proxied();
  plain.owner.emit("close", 1005, Buffer.alloc(0));
  assert.deepEqual(plain.page.closed, [undefined, undefined]);
});

test("a page that goes away closes the owner's socket without the page-side reason", () => {
  const { page, owner } = proxied();
  page.emit("close", 1006, Buffer.alloc(0));
  assert.deepEqual(owner.closed, [undefined, undefined]);
});
