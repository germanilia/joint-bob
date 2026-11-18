import assert from "node:assert/strict";
import test from "node:test";
import { doneCoversActivity } from "../src/server/sessions-helpers.js";

test("marking a conversation done covers its review up to that moment, and not what it does afterwards", () => {
  assert.equal(doneCoversActivity(undefined, "2026-11-18T19:03:08.108Z"), false, "not marked done: it waits for review");
  assert.equal(doneCoversActivity("2026-11-18T19:10:00.000Z", "2026-11-18T19:03:08.108Z"), true, "marked done after its last answer");
  assert.equal(doneCoversActivity("2026-11-18T19:10:00.000Z", "2026-11-18T19:10:00.000Z"), true);
  assert.equal(doneCoversActivity("2026-11-18T19:10:00.000Z", "2026-11-18T19:20:00.000Z"), false, "it ran again after it was marked done");
  assert.equal(doneCoversActivity("2026-11-18T19:10:00.000Z", undefined), true);
});
