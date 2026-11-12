import assert from "node:assert/strict";
import test from "node:test";
import { heldBy, isLeased, LEASE_MS, leaseHolder, releaseLease, takeLease } from "../src/control-center/leases.js";

test("a lease keeps Bob out until it is given back or lapses, and only its holder can renew or release it", () => {
  const now = 1_000_000;
  assert.equal(isLeased("p", "c", now), false);
  assert.equal(takeLease("p", "c", "ilia", now), true);
  assert.equal(isLeased("p", "c", now + 1), true);
  assert.equal(takeLease("p", "c", "matan", now + 1), false, "someone else cannot take it while it is held");
  assert.equal(releaseLease("p", "c", "matan"), false);
  assert.deepEqual(heldBy("ilia", now + 1), ["p:c"]);
  assert.equal(takeLease("p", "c", "ilia", now + LEASE_MS - 1), true, "the holder renews it");
  assert.equal(leaseHolder("p", "c", now + LEASE_MS), "ilia");
  assert.equal(isLeased("p", "c", now + 2 * LEASE_MS), false, "it lapses a minute after the last renewal");
  assert.equal(takeLease("p", "c", "matan", now + 2 * LEASE_MS), true, "a lapsed lease can be taken by anyone");
  assert.equal(releaseLease("p", "c", "matan"), true);
  assert.equal(isLeased("p", "c", now + 2 * LEASE_MS), false);
});

test("keeping Bob out holds the conversation without renewal and across restarts, until the person lets him back in", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { isKeptOut, keepBobOut, loadKeptOut } = await import("../src/control-center/leases.js");
  const db = new DatabaseSync(":memory:");
  const now = 5_000_000;
  assert.equal(takeLease("p", "kept", "ilia", now), true);
  assert.equal(keepBobOut(db, "p", "kept", "matan", true, now), false, "someone else cannot keep Bob out of a held conversation");
  assert.equal(keepBobOut(db, "p", "kept", "ilia", true, now), true);
  assert.equal(takeLease("p", "kept", "ilia", now + 1), true, "renewing does not undo it");
  assert.equal(isLeased("p", "kept", now + 10 * LEASE_MS), true, "it does not lapse");
  assert.equal(takeLease("p", "kept", "matan", now + 10 * LEASE_MS), false);
  releaseLease("p", "kept", "ilia");
  loadKeptOut(db);
  assert.equal(isKeptOut("p", "kept"), true, "a restart restores it");
  assert.equal(keepBobOut(db, "p", "kept", "ilia", false, now), true);
  assert.equal(isKeptOut("p", "kept"), false);
  assert.equal(isLeased("p", "kept", now + 2 * LEASE_MS), false, "let back in, the lease lapses like any other");
  releaseLease("p", "kept", "ilia");
  loadKeptOut(db);
  assert.equal(isLeased("p", "kept", now), false);
});
