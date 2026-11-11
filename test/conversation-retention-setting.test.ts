// The machine setting that says how far the retention sweep may reach: six boxes, all off until
// the owner ticks them, saved in one row, admin only like the number of days beside it.
import assert from "node:assert/strict";
import test from "node:test";
import { listAuditEvents } from "../src/audit.js";
import { defaultConversationRetentionScope } from "../src/conversation-retention.js";
import { settingsSchema } from "../src/server/schemas.js";
import { getSettings, PERSONAL_SETTING_KEYS, personalSettings, updateSettings } from "../src/settings.js";
import { settingsDatabase } from "../src/settings-store.js";

const off = defaultConversationRetentionScope();

test("every box is off on a machine that never saved the setting", () => {
  assert.deepEqual(off, { full: false, includeUnrecorded: false, includeScheduled: false, includeTickets: false, leftovers: false, backgroundRuns: false });
  assert.deepEqual(getSettings().conversationRetentionScope, off);
});

test("a save changes the boxes it names and keeps the others, and leaving the setting out keeps them all", async () => {
  assert.deepEqual(updateSettings({ conversationRetentionScope: { full: true, includeTickets: true } }).conversationRetentionScope, { ...off, full: true, includeTickets: true });
  assert.deepEqual(updateSettings({ conversationRetentionScope: { backgroundRuns: true, includeTickets: false } }).conversationRetentionScope, { ...off, full: true, backgroundRuns: true });
  // A save of something else, as the page sends when another field changed, keeps what is saved.
  assert.deepEqual(updateSettings({ conversationRetentionDays: 41 }).conversationRetentionScope, { ...off, full: true, backgroundRuns: true });
  assert.deepEqual(getSettings().conversationRetentionScope, { ...off, full: true, backgroundRuns: true });
  const stored = settingsDatabase().prepare("SELECT value FROM node_settings WHERE key = 'conversationRetentionScope'").get() as { value: string };
  assert.deepEqual(JSON.parse(stored.value), { ...off, full: true, backgroundRuns: true }, "one row in node_settings");

  // Three saves so far: two changed the boxes, the one that changed the days did not.
  const saves = (await listAuditEvents(50)).filter((event) => event.eventType === "settings.updated").map((event) => event.details as Record<string, unknown>);
  assert.equal(saves.length, 3);
  assert.equal(saves.filter((details) => details.conversationRetentionScopeChanged === true).length, 2);
  assert.equal(saves.filter((details) => details.conversationRetentionScopeChanged === false && details.conversationRetentionDaysChanged === true).length, 1);
  assert.equal(JSON.stringify(saves).includes("backgroundRuns"), false, "the audit row says that the boxes changed, not which");
  updateSettings({ conversationRetentionScope: off, conversationRetentionDays: 40 });
  assert.deepEqual(getSettings().conversationRetentionScope, off);
});

test("a box the setting does not have, or a value that is no yes or no, is refused", () => {
  assert.equal(settingsSchema.safeParse({ conversationRetentionScope: { full: true } }).success, true);
  assert.equal(settingsSchema.safeParse({ conversationRetentionScope: {} }).success, true);
  assert.equal(settingsSchema.safeParse({ conversationRetentionScope: { full: true, everything: true } }).success, false, "an unknown box");
  assert.equal(settingsSchema.safeParse({ conversationRetentionScope: { full: "yes" } }).success, false);
  assert.equal(settingsSchema.safeParse({ conversationRetentionScope: true }).success, false);
  // The same holds for a caller that does not go through the route.
  assert.throws(() => updateSettings({ conversationRetentionScope: { everything: true } as never }), /unknown or invalid box/);
  assert.throws(() => updateSettings({ conversationRetentionScope: { full: "yes" } as never }), /unknown or invalid box/);
  assert.deepEqual(getSettings().conversationRetentionScope, off, "a refused save changes nothing");
});

test("it is the machine's setting: no person's own settings carry it", () => {
  assert.equal((PERSONAL_SETTING_KEYS as readonly string[]).includes("conversationRetentionScope"), false);
  assert.equal("conversationRetentionScope" in personalSettings(), false, "a member is not shown it and cannot send it");
});

test("the sweep reads the saved boxes, and a box that depends on the first counts only with it", async () => {
  const { retentionSwitches } = await import("../src/server/conversation-retention.js");
  assert.deepEqual(retentionSwitches(), off);
  updateSettings({ conversationRetentionScope: { includeUnrecorded: true, includeScheduled: true, includeTickets: true, leftovers: true } });
  assert.deepEqual(retentionSwitches(), { ...off, leftovers: true }, "without the first box the three that widen it are off");
  updateSettings({ conversationRetentionScope: { full: true } });
  assert.deepEqual(retentionSwitches(), { full: true, includeUnrecorded: true, includeScheduled: true, includeTickets: true, leftovers: true, backgroundRuns: false }, "seen at the next read");
  updateSettings({ conversationRetentionScope: off });
  assert.deepEqual(retentionSwitches(), off);
});
