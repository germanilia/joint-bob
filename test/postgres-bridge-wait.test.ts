import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { waitForAnswer } from "../src/postgres/connection.js";

/* The PostgreSQL worker raises a shared signal and then notifies. A notify can land after the caller
   has already read that answer and is waiting for the next one; on 2026-11-11 such a late notify
   woke the wait with no answer yet, and every later call of that node read the answer before its
   own. A wake-up with the signal down must count for nothing. */

function notifier(script: string): { signal: Int32Array; worker: Worker } {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(`
    const { workerData } = require("node:worker_threads");
    const signal = workerData;
    const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    ${script}
  `, { eval: true, workerData: signal });
  return { signal, worker };
}

test("a notify that arrives before the signal is raised does not end the wait", async () => {
  const { signal, worker } = notifier(`
    sleep(50); Atomics.notify(signal, 0);
    sleep(300); Atomics.store(signal, 0, 1); Atomics.notify(signal, 0);
  `);
  const started = Date.now();
  assert.equal(waitForAnswer(signal, 10_000), true);
  assert.equal(Atomics.load(signal, 0), 1, "the wait ended on the raised signal, not on the stray notify");
  assert.ok(Date.now() - started >= 250, "the stray notify at 50 ms was ignored");
  await worker.terminate();
});

test("only stray notifies and no answer end in a timeout", async () => {
  const { signal, worker } = notifier(`for (let i = 0; i < 20; i++) { sleep(20); Atomics.notify(signal, 0); }`);
  const started = Date.now();
  assert.equal(waitForAnswer(signal, 600), false);
  assert.ok(Date.now() - started >= 550);
  await worker.terminate();
});

test("a signal raised before the wait starts answers at once", () => {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(signal, 0, 1);
  assert.equal(waitForAnswer(signal, 10_000), true);
});
