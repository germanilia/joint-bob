import assert from "node:assert/strict";
import test from "node:test";
import { TakebackWindow } from "../src/server/takeback-window.js";

test("a decline wins until the deadline and survives a late completion check", () => {
  const window = new TakebackWindow(1000);
  assert.equal(window.result(1000), "pending");
  assert.equal(window.decline(30_999), true);
  assert.equal(window.result(31_000), "declined");
});

test("silence permits the transfer at the deadline, not before", () => {
  const window = new TakebackWindow(1000);
  assert.equal(window.result(30_999), "pending");
  assert.equal(window.decline(31_000), false);
  assert.equal(window.result(31_000), "elapsed");
});
