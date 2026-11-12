import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runAsAccount, type ActingAccount } from "../src/account-context.js";
import { runInRuntime, runtimeHome, type RuntimeAccount } from "../src/account-runtime.js";
import { forgetReadyHarnesses, rememberReadyHarnesses } from "../src/harness-readiness.js";
import { listDiscoveredHarnesses } from "../src/harnesses/registry.js";
import { configuredRuntime } from "../src/harnesses/runtime-configuration.js";
import { deletePersonalSettings, getSettings, nodeSettings, personalSettings, seedPersonalSettings, updatePersonalSettings, updateSettings } from "../src/settings.js";
import { save, settingsDatabase } from "../src/settings-store.js";
import { counting, touching } from "./perf-statement-counter.js";

/* getSettings() keeps what the database says between writes (src/settings.ts, storedSettings).
   These tests hold it to that: an answer is never older than the last write, whoever made it;
   nothing that does not come from the database is kept; and every caller still gets an object
   of its own. */

const databaseFile = path.join(process.env.PI_WEB_DATA_DIR!, "node.db");
const COUNTERS = /total_changes|data_version|schema_version/;
const member: ActingAccount = { accountId: "perf-member", userId: "perf-user", username: "member", role: "member", isRemoteLogin: false, homeNodeId: null };
const admin: ActingAccount = { accountId: "perf-admin", userId: "perf-admin-user", username: "admin", role: "admin", isRemoteLogin: false, homeNodeId: null };

/** A second connection to the node's database. `restore` runs before it is closed, so it may still use it. */
function otherConnection(t: { after: (cleanup: () => void) => void }, restore: (other: DatabaseSync) => void = () => undefined): DatabaseSync {
  settingsDatabase();
  const other = new DatabaseSync(databaseFile);
  t.after(() => { try { restore(other); } finally { other.close(); } });
  return other;
}

function store(other: DatabaseSync, key: string, value: string): void {
  other.prepare("INSERT INTO node_settings (key, value, is_secret, updated_at) VALUES (?, ?, 0, 'elsewhere') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

test("a setting changes right after it is written, by this connection or by another", (t) => {
  const other = otherConnection(t);
  assert.equal(getSettings().strictResourceIsolation, true);
  updateSettings({ strictResourceIsolation: false });
  assert.equal(getSettings().strictResourceIsolation, false);
  save(settingsDatabase(), "strictResourceIsolation", "true");
  assert.equal(getSettings().strictResourceIsolation, true);

  store(other, "strictResourceIsolation", "false");
  assert.equal(getSettings().strictResourceIsolation, false, "written by another connection");
  store(other, "conversationHistoryDays", "7");
  assert.equal(getSettings().conversationHistoryDays, 7);
  store(other, "conversationLabels", JSON.stringify(["From elsewhere"]));
  assert.ok(getSettings().conversationLabels.includes("From elsewhere"));
  other.prepare("DELETE FROM node_settings WHERE key = 'conversationHistoryDays'").run();
  assert.equal(getSettings().conversationHistoryDays, 30, "a removed row gives the default again");
  // What the retention sweep may delete: six boxes in one row, all off until ticked.
  const untouched = { full: false, includeUnrecorded: false, includeScheduled: false, leftovers: false, backgroundRuns: false };
  assert.deepEqual(getSettings().conversationRetentionScope, untouched);
  updateSettings({ conversationRetentionScope: { leftovers: true } });
  assert.deepEqual(getSettings().conversationRetentionScope, { ...untouched, leftovers: true });
  store(other, "conversationRetentionScope", JSON.stringify({ full: true, includeScheduled: true }));
  assert.deepEqual(getSettings().conversationRetentionScope, { ...untouched, full: true, includeScheduled: true }, "written by another connection; a box that is not saved is off");
  other.prepare("DELETE FROM node_settings WHERE key = 'conversationRetentionScope'").run();
  assert.deepEqual(getSettings().conversationRetentionScope, untouched, "a removed row turns every box off again");
  // A write to any other table ends the kept answer too. It is simply read again.
  other.exec("CREATE TABLE IF NOT EXISTS perf_unrelated(id TEXT)");
  other.prepare("INSERT INTO perf_unrelated VALUES ('x')").run();
  assert.equal(getSettings().strictResourceIsolation, false);
  store(other, "strictResourceIsolation", "true");
});

test("between writes a read runs no settings query and parses nothing", () => {
  save(settingsDatabase(), "gitPullFileLimit", "1000");
  const first = counting(() => getSettings());
  assert.ok(touching(first, "node_settings") >= 30, `the first read after a write reads the table (${touching(first, "node_settings")} queries)`);
  assert.ok(first.parses >= 3, `and parses what it read (${first.parses} parses)`);

  const repeated = counting(() => { for (let call = 0; call < 50; call++) { getSettings(); nodeSettings(); } });
  assert.equal(touching(repeated, "node_settings"), 0);
  assert.equal(touching(repeated, "relay_serving"), 0);
  assert.equal(repeated.parses, 0);
  assert.deepEqual(repeated.statements.filter((sql) => !COUNTERS.test(sql)), [], "only SQLite's own counters are asked");

  save(settingsDatabase(), "gitPullFileLimit", "900");
  const afterWrite = counting(() => getSettings());
  assert.ok(touching(afterWrite, "node_settings") >= 30);
  assert.equal(afterWrite.result.gitPullFileLimit, 900);
  save(settingsDatabase(), "gitPullFileLimit", "1000");
});

test("every caller owns what it gets, and the fields come in the order they always did", () => {
  const first = getSettings();
  const snapshot = structuredClone(first);
  first.conversationLabels.push("Changed by a caller");
  first.resources.skills.push("/changed/by/a/caller");
  first.conversationCommands.presets.push({ id: "00000000-0000-4000-8000-000000000000", name: "Changed", prompt: "by a caller" });
  first.conversationCommands.start.prompt = "changed";
  first.runtimes.claude.executable = "changed";
  first.runtimeOverrides.pi.configPath = "/changed";
  first.conversationDefaults.claude.modelId = "changed";
  first.conversationLabelIcons.Changed = "x";
  first.remoteTerminal.twins = !first.remoteTerminal.twins;
  first.syncCheck.enabled = !first.syncCheck.enabled;
  first.backgroundAgent.harnessId = "changed";
  first.projects.homePath = "/changed";
  first.strictResourceIsolation = !first.strictResourceIsolation;
  first.conversationBackup.s3.bucket = "changed-by-a-caller";
  first.conversationBackup.destination = "s3";
  delete (first as Partial<typeof first>).dashboards;
  assert.deepEqual(getSettings(), snapshot);
  assert.deepEqual(nodeSettings(), snapshot);

  const again = getSettings();
  assert.notEqual(again, getSettings());
  assert.notEqual(again.conversationLabels, getSettings().conversationLabels);
  // The legacy top-level runtimes are the very objects under `runtimes`, as before.
  for (const id of Object.keys(again.runtimes)) assert.equal((again as unknown as Record<string, unknown>)[id], again.runtimes[id]);
  assert.deepEqual(Object.keys(again), [
    "conversationDefaults", ...Object.keys(again.runtimes), "runtimes", "runtimeOverrides", "kiroEnabled", "projects", "resources", "conversationLabels",
    "conversationLabelIcons", "conversationHistoryDays", "conversationRetentionDays", "conversationRetentionScope", "conversationBackup", "autoCompactThreshold", "shellCommandTimeoutSeconds",
    "subprocessMaxLifetimeMinutes", "conversationCpuLimitCores", "conversationMemoryLimitGb", "digestAttachments", "showProjectsOnOtherNodes",
    "newConversationWorktree", "strictResourceIsolation", "autoActivateSharedSkills", "gitPullFileLimit", "gitPullTimeoutSeconds", "syncCheck",
    "dashboards", "backgroundAgent", "remoteTerminal", "runnerAccess", "conversationCommands", "restartRequired",
  ]);
});

test("the running account's home and its confinement are read on every call", (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "jb-perf-settings-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const person: RuntimeAccount = { key: "account:perf-person", name: "perf-person", home };
  const db = settingsDatabase();
  // The node's own overrides: they apply to the service's runtime and never to a person's.
  save(db, "claude.configPath", "/opt/node-wide/claude");
  save(db, "claude.sessionPath", "/opt/node-wide/claude/projects");
  save(db, "pi.executable", "/opt/node-wide/bin/pi");
  t.after(() => { for (const key of ["claude.configPath", "claude.sessionPath", "pi.executable"]) save(db, key, ""); });

  const asService = getSettings().runtimes;
  assert.equal(asService.claude.configPath, "/opt/node-wide/claude");
  assert.equal(asService.pi.executable, "/opt/node-wide/bin/pi");
  const asPerson = runInRuntime(person, () => getSettings().runtimes);
  assert.equal(asPerson.claude.configPath, path.join(home, ".claude"), "a person's runtime keeps to their own home");
  assert.equal(asPerson.claude.sessionPath, path.join(home, ".claude/projects"));
  assert.equal(asPerson.pi.executable, "/opt/node-wide/bin/pi", "the executable stays the node's");
  assert.deepEqual(getSettings().runtimes, asService, "and the service's answer is not the person's");

  // The runtimes are what configuredRuntime gives, whichever account runs.
  const adapters = listDiscoveredHarnesses().filter((adapter) => adapter.configuration);
  const expected = () => Object.fromEntries(adapters.map((adapter) => [adapter.id, configuredRuntime(adapter.id, adapter.configuration!.defaults(runtimeHome()))]));
  assert.deepEqual(nodeSettings().runtimes, expected());
  runInRuntime(person, () => assert.deepEqual(nodeSettings().runtimes, expected()));
});

test("which agents are signed in decides the default background agent on every call", (t) => {
  t.after(() => forgetReadyHarnesses());
  forgetReadyHarnesses();
  const unknown = getSettings();
  assert.equal(unknown.backgroundAgent.harnessId, "", "nothing is chosen in this data directory");
  rememberReadyHarnesses(["claude"]);
  assert.equal(getSettings().syncCheck.harnessId, "claude");
  assert.equal(getSettings().dashboards.harnessId, "claude");
  rememberReadyHarnesses(["kiro"]);
  assert.equal(getSettings().syncCheck.harnessId, "kiro");
  assert.equal(getSettings().dashboards.harnessId, "kiro");
  forgetReadyHarnesses();
  assert.deepEqual(getSettings().syncCheck, unknown.syncCheck);
});

test("PATH and the home folder are read on every call", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jb-perf-settings-path-"));
  const previous = { PATH: process.env.PATH, HOME: process.env.HOME };
  let savedHome: { value: string } | undefined;
  const other = otherConnection(t, (connection) => {
    process.env.PATH = previous.PATH; process.env.HOME = previous.HOME;
    if (savedHome) store(connection, "projects.homePath", savedHome.value);
    rmSync(root, { recursive: true, force: true });
  });
  savedHome = other.prepare("SELECT value FROM node_settings WHERE key = 'projects.homePath'").get() as { value: string } | undefined;
  const bins = ["first", "second"].map((name) => {
    const bin = path.join(root, name);
    mkdirSync(bin);
    writeFileSync(path.join(bin, "claude"), "#!/bin/sh\n");
    chmodSync(path.join(bin, "claude"), 0o755);
    return bin;
  });
  save(settingsDatabase(), "claude.executable", "");
  process.env.PATH = bins[0];
  assert.equal(getSettings().runtimes.claude.executable, path.join(bins[0], "claude"));
  process.env.PATH = bins[1];
  assert.equal(getSettings().runtimes.claude.executable, path.join(bins[1], "claude"), "no write happened in between");

  other.prepare("DELETE FROM node_settings WHERE key = 'projects.homePath'").run();
  for (const name of ["one", "two"]) {
    process.env.HOME = path.join(root, name);
    assert.equal(getSettings().projects.homePath, path.join(root, name, "JointBob"));
    assert.equal(getSettings().runtimes.claude.configPath, path.join(root, name, ".claude"));
  }
});

test("inside a transaction a read sees what was written, and a rollback leaves nothing behind", () => {
  const db = settingsDatabase();
  const before = getSettings().gitPullTimeoutSeconds;
  db.exec("BEGIN");
  try {
    assert.equal(getSettings().gitPullTimeoutSeconds, before);
    save(db, "gitPullTimeoutSeconds", "777");
    assert.equal(getSettings().gitPullTimeoutSeconds, 777);
    assert.equal(nodeSettings().gitPullTimeoutSeconds, 777);
  } finally { db.exec("ROLLBACK"); }
  assert.equal(getSettings().gitPullTimeoutSeconds, before);
  assert.equal(getSettings().gitPullTimeoutSeconds, before);
});

test("a person's own settings follow every write and are not read again in between", (t) => {
  const other = otherConnection(t);
  const read = () => runAsAccount(member, () => getSettings());
  seedPersonalSettings(member.accountId);
  t.after(() => deletePersonalSettings(member.accountId));
  updatePersonalSettings({ conversationHistoryDays: 3, conversationLabels: ["Mine"] }, member);
  assert.equal(read().conversationHistoryDays, 3);
  assert.ok(read().conversationLabels.includes("Mine"));
  assert.notEqual(getSettings().conversationHistoryDays, 3, "the node's own value is another answer");
  assert.equal(runAsAccount(admin, () => getSettings()).conversationHistoryDays, getSettings().conversationHistoryDays, "the admin's settings are the node's");
  assert.deepEqual(runAsAccount({ ...member, accountId: "perf-stranger" }, () => getSettings()).conversationCommands.presets, [], "an account with nothing saved never sees the node's commands");

  const repeated = counting(() => { for (let call = 0; call < 50; call++) read(); });
  assert.equal(touching(repeated, "account_settings"), 0);
  assert.equal(touching(repeated, "node_settings"), 0);
  assert.equal(repeated.parses, 0);
  assert.deepEqual(repeated.statements.filter((sql) => !COUNTERS.test(sql)), []);

  const mine = read();
  mine.conversationLabels.push("Changed by a caller");
  mine.conversationCommands.presets.push({ id: "00000000-0000-4000-8000-000000000001", name: "Changed", prompt: "by a caller" });
  assert.ok(!read().conversationLabels.includes("Changed by a caller"));
  assert.deepEqual(read().conversationCommands.presets, []);
  assert.deepEqual(personalSettings(member).conversationLabels, read().conversationLabels);

  other.prepare("UPDATE account_settings SET payload = ? WHERE account_id = ?").run(JSON.stringify({ conversationHistoryDays: 5 }), member.accountId);
  assert.equal(read().conversationHistoryDays, 5, "replaced by another connection");
  assert.deepEqual(read().conversationLabels, nodeSettings().conversationLabels, "what the person no longer has is the node's");
  deletePersonalSettings(member.accountId);
  assert.equal(read().conversationHistoryDays, nodeSettings().conversationHistoryDays);
});

test("commands whose ids could not be saved are tried again, not kept as the defaults", (t) => {
  const db = settingsDatabase();
  let saved: { value: string } | undefined;
  const other = otherConnection(t, (connection) => {
    db.exec("PRAGMA busy_timeout = 5000");
    if (saved) store(connection, "conversationCommands", saved.value);
    else connection.prepare("DELETE FROM node_settings WHERE key = 'conversationCommands'").run();
  });
  saved = other.prepare("SELECT value FROM node_settings WHERE key = 'conversationCommands'").get() as { value: string } | undefined;
  // Commands as an older client saved them: no ids. Reading them gives each an id and saves it.
  store(other, "conversationCommands", JSON.stringify({ start: { enabled: false, prompt: "start" }, end: { enabled: false, prompt: "end" }, presets: [{ name: "Legacy", prompt: "do it" }] }));
  db.exec("PRAGMA busy_timeout = 1");
  other.exec("BEGIN IMMEDIATE");
  try {
    // Another writer holds the database: the ids cannot be saved, and the defaults are returned.
    assert.deepEqual(getSettings().conversationCommands.presets, []);
  } finally { other.exec("ROLLBACK"); }
  // Nothing was written meanwhile, by anyone. The next read must still try the save again.
  const settled = getSettings().conversationCommands;
  assert.equal(settled.presets.length, 1);
  assert.equal(settled.presets[0].name, "Legacy");
  assert.match(settled.presets[0].id!, /^[0-9a-f-]{36}$/);
  assert.deepEqual(getSettings().conversationCommands, settled, "the saved id is the one read from now on");
  const stored = JSON.parse((other.prepare("SELECT value FROM node_settings WHERE key = 'conversationCommands'").get() as { value: string }).value) as { presets: Array<{ id: string }> };
  assert.equal(stored.presets[0].id, settled.presets[0].id);
});
