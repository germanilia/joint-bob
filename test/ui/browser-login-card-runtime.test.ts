import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { BrowserRuntime } from "../../src/browser-runtime.js";
import { chromeExecutable } from "./launch-chrome.js";
import { waitForAssertion } from "../async-assertion.js";

const human = { kind: "human" as const, id: "card-owner" };
async function fixture(t: test.TestContext) {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url === "/ready") return void res.end("<h1>Account ready</h1>");
    if (req.url === "/otp") return void res.end('<input autocomplete="one-time-code"><button>Verify</button>');
    if (req.url === "/ambiguous") return void res.end('<form><input type="password"><button>Sign in</button></form>'.repeat(2));
    if (req.url === "/reject") return void res.end('<form onsubmit="event.preventDefault();document.querySelector(\'aside\').textContent=\'Incorrect password\'"><input type="password" autocomplete="current-password"><button>Sign in</button></form><aside role="alert"></aside>');
    if (req.url === "/username") return void res.end('<form action="/password"><label>Email<input type="email" name="email"></label><button>Next</button></form>');
    res.end('<form action="/ready" method="post" onsubmit="console.error(document.querySelector(\'input\').value)"><label>Password<input type="password" autocomplete="current-password" name="password"></label><button>Sign in</button></form>');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const runtime = new BrowserRuntime({ capability: async () => ({ supported: true, available: true, executable: await chromeExecutable(), reason: null }) });
  t.after(async () => { await runtime.close(); server.closeAllConnections(); server.close(); });
  const session = await runtime.create({ projectId: randomUUID(), conversationId: randomUUID(), appNodeId: randomUUID(), engine: "pi", url: `${origin}/username`, profileName: randomUUID() });
  const pending = await waitForAssertion(async () => { const view = await runtime.get(session.id); assert.ok(view.loginRequest); return view; }, 15_000);
  const requestId = pending.loginRequest!.id, expectedPageId = pending.activePageId!;
  const execute = (command: any, actor = human) => runtime.execute(session.id, command, actor) as Promise<any>;
  await execute({ action: "takeControl", loginRequestId: requestId });
  const read = () => execute({ action: "readLoginStep", requestId, expectedPageId });
  const submit = (step: any, values: string[]) => execute({ action: "submitLoginStep", requestId, expectedPageId, expectedOrigin: step.origin, stepId: step.stepId, values });
  return { runtime, session, origin, execute, read, submit, requestId, expectedPageId };
}

test("card follows username/password steps without returning values and requires verified human completion", { timeout: 45_000 }, async t => {
  const f = await fixture(t);
  const first = await f.read();
  assert.equal(first.origin, f.origin); assert.deepEqual(first.fields.map((x: any) => x.type), ["email"]);
  assert.ok(first.stepId); assert.equal(first.submitLabel, "Next");
  await f.submit(first, ["synthetic@example.test"]);
  await waitForAssertion(async () => assert.match((await f.runtime.get(f.session.id)).tabs[0].url, /\/password/), 10_000);
  const second = await f.read(); assert.deepEqual(second.fields.map((x: any) => x.type), ["password"]);
  const result = await f.submit(second, ["SYNTHETIC-CARD-SECRET"]);
  assert.ok(!JSON.stringify(result).includes("SYNTHETIC-CARD-SECRET"));
  await waitForAssertion(async () => assert.match((await f.runtime.get(f.session.id)).tabs[0].url, /\/ready/), 10_000);
  const ready = await f.read(); assert.equal(ready.stepId, null); assert.equal(ready.challenge, false);
  assert.ok((await f.runtime.get(f.session.id)).loginRequest, "missing fields alone must not resume the agent");
  await f.execute({ action: "completeLogin", requestId: f.requestId, expectedPageId: f.expectedPageId });
  assert.equal((await f.runtime.get(f.session.id)).owner, "agent");
  const snapshot = await f.runtime.execute(f.session.id, { action: "snapshot" }, { kind: "agent" });
  assert.ok(!JSON.stringify(snapshot).includes("SYNTHETIC-CARD-SECRET"), "website diagnostics during login must not expose proxy credentials to the agent");
});

test("card rejects stale, replayed and replaced document bindings before filling", { timeout: 45_000 }, async t => {
  const f = await fixture(t);
  const step = await f.read();
  await f.execute({ action: "reload" });
  await assert.rejects(f.submit(step, ["SYNTHETIC-CARD-SECRET"]), /changed|expired/i);
  assert.equal(await f.execute({ action: "evaluate", expression: "document.querySelector('input').value" }), "");
  const moved = await f.read();
  await f.execute({ action: "evaluate", expression: "history.pushState({}, '', '/changed')" });
  await assert.rejects(f.submit(moved, ["SYNTHETIC-CARD-SECRET"]), /changed|expired/i);
  assert.equal(await f.execute({ action: "evaluate", expression: "document.querySelector('input').value" }), "");
  const current = await f.read();
  await f.execute({ action: "evaluate", expression: "document.querySelector('input').outerHTML = document.querySelector('input').outerHTML" });
  await assert.rejects(f.submit(current, ["SYNTHETIC-CARD-SECRET"]), /changed|expired/i);
  const challenged = await f.read();
  await f.execute({ action: "evaluate", expression: "document.body.insertAdjacentHTML('beforeend', '<input id=late-otp autocomplete=one-time-code>')" });
  await assert.rejects(f.submit(challenged, ["SYNTHETIC-CARD-SECRET"]), /changed|expired/i);
  assert.equal(await f.execute({ action: "evaluate", expression: "document.querySelector('input').value" }), "");
  await f.execute({ action: "evaluate", expression: "document.querySelector('#late-otp').remove()" });
  const next = await f.read();
  await f.submit(next, ["synthetic@example.test"]);
  await assert.rejects(f.submit(next, ["SYNTHETIC-CARD-SECRET"]), /changed|expired/i);
});

test("card does not proxy challenges, rejected passwords or ambiguous forms", { timeout: 45_000 }, async t => {
  const f = await fixture(t);
  for (const path of ["/otp", "/ambiguous"]) {
    await f.execute({ action: "navigate", url: f.origin + path });
    const step = await f.read(); assert.equal(step.stepId, null); assert.equal(step.fields.length, 0);
    if (path === "/otp") assert.equal(step.challenge, true);
  }
  await f.execute({ action: "navigate", url: f.origin + "/reject" });
  const step = await f.read(); await f.submit(step, ["SYNTHETIC-CARD-SECRET"]);
  const rejected = await f.read(); assert.equal(rejected.challenge, true); assert.equal(rejected.fields.length, 0);
  assert.ok(!JSON.stringify(rejected).includes("SYNTHETIC-CARD-SECRET"));
});

test("card commands require the controlling human and the current request, page and origin", { timeout: 45_000 }, async t => {
  const f = await fixture(t);
  const step = await f.read();
  await assert.rejects(f.execute({ action: "readLoginStep", requestId: f.requestId, expectedPageId: f.expectedPageId }, { kind: "human", id: "other" }), /controlling human/i);
  await assert.rejects(f.runtime.execute(f.session.id, { action: "readLoginStep", requestId: f.requestId, expectedPageId: f.expectedPageId } as any, { kind: "agent" }), /paused|login required/i);
  await assert.rejects(f.execute({ action: "readLoginStep", requestId: randomUUID(), expectedPageId: f.expectedPageId }), /changed/i);
  await assert.rejects(f.execute({ action: "submitLoginStep", requestId: f.requestId, expectedPageId: f.expectedPageId, stepId: step.stepId, expectedOrigin: "https://other.example", values: ["SYNTHETIC-CARD-SECRET"] }), /changed|expired/i);
  assert.equal(await f.execute({ action: "evaluate", expression: "document.querySelector('input').value" }), "");
});
