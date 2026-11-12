// Backups before the retention sweep deletes: with the owner's setting on, a conversation that goes
// for its age is first stored as an archive in a folder or an S3 bucket, a backup that cannot be
// made keeps the conversation, and a backup goes when it is older than the setting's days.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test, { after } from "node:test";
import { promisify } from "node:util";
import type { RetentionSwitches } from "../src/server/conversation-retention.js";

const run = promisify(execFile);
const DAY = 86_400_000, HOUR = 3_600_000;
const exists = (file: string) => access(file).then(() => true, () => false);
const off: RetentionSwitches = { full: false, includeUnrecorded: false, includeScheduled: false, includeTickets: false, leftovers: false, backgroundRuns: false };
const full: RetentionSwitches = { ...off, full: true };

// The sweep loads the server's delete route, and with it the watcher of transcript folders: on Linux an open one keeps the process alive.
after(async () => {
  const { sessionWatcher } = await import("../src/server/chat.js");
  sessionWatcher.close();
});

async function build() {
  const { resolveDataDirectory } = await import("../src/data-directory.js");
  const root = resolveDataDirectory();
  const sessionRoot = path.join(root, "claude-sessions"), piRoot = path.join(root, "pi-sessions");
  const settings = await import("../src/settings.js");
  settings.updateSettings({
    pi: { executable: "pi", configPath: path.join(root, "pi-config"), sessionPath: piRoot },
    claude: { executable: "claude", configPath: path.join(root, "claude-config"), sessionPath: sessionRoot },
  });
  const { addProject } = await import("../src/store.js");
  const { claudeProjectDir } = await import("../src/session-paths.js");
  const { getClusterNode } = await import("../src/cluster.js");
  const { ensureConversationRecord, listConversationRecords } = await import("../src/conversation-records.js");
  const { clearHarnessSessionCache } = await import("../src/harnesses.js");
  const retention = await import("../src/server/conversation-retention.js");
  const backups = await import("../src/server/conversation-backup.js");
  const local = await getClusterNode();

  const project = async (name: string) => {
    const projectPath = path.join(root, name);
    await mkdir(projectPath, { recursive: true });
    const record = await addProject(name, projectPath, { writeInstructions: false });
    const directory = claudeProjectDir(projectPath, sessionRoot);
    await mkdir(directory, { recursive: true });
    /** A Claude transcript last written `age` ago, on record unless told otherwise, with a session folder when asked. */
    const transcript = async (age: number, options: { said?: string; folder?: boolean; record?: boolean } = {}): Promise<{ id: string; file: string; content: string; extra: Record<string, string> }> => {
      const id = randomUUID(), file = path.join(directory, `${id}.jsonl`), at = new Date(Date.now() - age);
      const content = [
        JSON.stringify({ type: "summary", summary: "not what the person wrote" }),
        JSON.stringify({ type: "user", uuid: randomUUID(), sessionId: id, cwd: projectPath, timestamp: at.toISOString(), message: { role: "user", content: options.said ?? `Written ${Math.round(age / DAY)} days ago` } }),
        JSON.stringify({ type: "assistant", uuid: randomUUID(), sessionId: id, timestamp: at.toISOString(), message: { role: "assistant", content: [{ type: "text", text: "x".repeat(4000) }] } }),
      ].join("\n") + "\n";
      await writeFile(file, content);
      const extra: Record<string, string> = {};
      if (options.folder) {
        extra[path.join(directory, id, "subagents", "agent-a1.jsonl")] = JSON.stringify({ type: "user", sessionId: id, message: { role: "user", content: "a sub-agent's task" } }) + "\n";
        extra[path.join(directory, id, "tool-results", "toolu_01.txt")] = "the output of a tool\n";
        for (const [name, text] of Object.entries(extra)) { await mkdir(path.dirname(name), { recursive: true }); await writeFile(name, text); await utimes(name, at, at); }
      }
      await utimes(file, at, at);
      if (options.record !== false) await ensureConversationRecord(record.id, "claude", id, local.id);
      return { id, file, content, extra };
    };
    return { record, projectPath, directory, transcript };
  };
  const sweep = async (switches: RetentionSwitches, now = Date.now()): Promise<number> => {
    clearHarnessSessionCache();
    return retention.sweepConversationRetention(now, switches);
  };
  const recorded = async (projectId: string): Promise<Set<string>> => new Set((await listConversationRecords(projectId)).map((entry) => entry.sessionId));
  /** Backups that exist now, by the session they hold. */
  const kept = (): Map<string, Record<string, unknown>> => new Map(backups.conversationBackupRows().filter((row) => row.removed_at === null).map((row) => [String(row.session_id), row]));
  const unpack = async (archive: string): Promise<{ folder: string; manifest: Record<string, any> }> => {
    const folder = await mkdtemp(path.join(root, "unpacked-"));
    await run("tar", ["-xzf", archive, "-C", folder]);
    return { folder, manifest: JSON.parse(await readFile(path.join(folder, "conversation.json"), "utf8")) };
  };
  return { root, sessionRoot, local, project, sweep, recorded, kept, unpack, retention, backups, settings, clearHarnessSessionCache };
}

let built: ReturnType<typeof build> | undefined;
const fixture = (): ReturnType<typeof build> => built ??= build();

test("backups are off until the owner turns them on, and a sweep then deletes as it always did", { timeout: 120_000 }, async () => {
  const f = await fixture();
  const { hasSecretAccessKey, defaultFolder, ...setting } = f.settings.getSettings().conversationBackup;
  assert.deepEqual(setting, { destination: "off", keepDays: 30, folder: "", s3: { bucket: "", region: "", prefix: "", endpoint: "", credentials: "keys", accessKeyId: "", profile: "" } });
  assert.equal(hasSecretAccessKey, false);
  assert.equal(defaultFolder, path.join(f.root, "conversation-backups"));
  assert.equal(await f.backups.ConversationBackups.open(), undefined);
  const plain = await f.project("off-project");
  const old = await plain.transcript(45 * DAY);
  assert.equal(await f.sweep(full), 1);
  assert.equal(await exists(old.file), false);
  assert.deepEqual(f.backups.conversationBackupRows(), []);
  assert.equal(await exists(defaultFolder), false, "nothing is written anywhere while backups are off");
  const status = await f.backups.conversationBackupStatus();
  assert.deepEqual(status, { destination: "off", where: "", keepDays: 30, kept: { backups: 0, bytes: 0 }, nextRemovalAt: null, problem: null });
  await assert.rejects(f.backups.checkBackupDestination(), /Choose a folder or S3 first/);
});

test("with backups to a folder, each old conversation is archived whole before it is deleted", { timeout: 180_000 }, async () => {
  const f = await fixture();
  const { setSessionTitle } = await import("../src/names.js");
  const folder = path.join(f.root, "my backups");
  f.settings.updateSettings({ conversationBackup: { destination: "folder", folder } });
  assert.equal(await f.backups.checkBackupDestination(), folder);
  const home = await f.project("Folder Project");
  const titled = await home.transcript(45 * DAY, { folder: true });
  await setSessionTitle(titled.id, "Fix the login page!");
  const untitled = await home.transcript(50 * DAY, { said: "  please   rename the\nexport button " });
  const unrecorded = await home.transcript(60 * DAY, { record: false });
  const recent = await home.transcript(5 * DAY);
  const before = Date.now();

  // The dry run says where backups go before anything is deleted.
  f.clearHarnessSessionCache();
  const preview = await f.retention.previewConversationRetention(full);
  assert.equal(preview.backup.destination, "folder");
  assert.equal(preview.backup.where, folder);
  assert.equal(preview.backup.keepDays, 30);
  assert.deepEqual([...preview.conversations.expired].sort(), [`claude:${titled.id}`, `claude:${untitled.id}`].sort());

  assert.equal(await f.sweep({ ...full, includeUnrecorded: true }), 3);
  for (const gone of [titled, untitled, unrecorded]) {
    assert.equal(await exists(gone.file), false, "deleted after its backup");
    for (const extra of Object.keys(gone.extra)) assert.equal(await exists(extra), false);
  }
  assert.equal(await exists(recent.file), true);
  assert.deepEqual([...await f.recorded(home.record.id)], [recent.id]);

  const kept = f.kept();
  assert.deepEqual([...kept.keys()].sort(), [titled.id, untitled.id, unrecorded.id].sort());
  const day = new Date(before).toISOString().slice(0, 10);
  const projectFolder = path.join(folder, `Folder-Project_${home.record.id}`);
  assert.equal(kept.get(titled.id)!.location, path.join(projectFolder, `${day}_claude_${titled.id}_Fix-the-login-page.tar.gz`));
  assert.equal(kept.get(untitled.id)!.location, path.join(projectFolder, `${day}_claude_${untitled.id}_please-rename-the-export-button.tar.gz`));
  assert.equal(kept.get(titled.id)!.title, "Fix the login page!");
  assert.equal(kept.get(untitled.id)!.title, "please rename the export button");
  assert.deepEqual([...new Set([...kept.values()].map((row) => `${row.destination}:${row.reason}:${row.project_name}`))], ["folder:expired:Folder Project"]);
  assert.deepEqual((await readdir(projectFolder)).sort(), [...kept.values()].map((row) => path.basename(String(row.location))).sort());
  assert.deepEqual(await readdir(path.join(folder, ".staging")), [], "nothing is left in staging");
  if (process.platform !== "win32") {
    assert.equal((await stat(String(kept.get(titled.id)!.location))).mode & 0o777, 0o600, "an archive is for the owner only");
    assert.equal((await stat(projectFolder)).mode & 0o777, 0o700);
  }

  // The archive holds every file at the path it had under the agent's folder, and says what it is.
  const relative = (file: string): string => path.relative(f.sessionRoot, file).split(path.sep).join("/");
  const unpacked = await f.unpack(String(kept.get(titled.id)!.location));
  assert.equal(await readFile(path.join(unpacked.folder, "files/claude", relative(titled.file)), "utf8"), titled.content);
  for (const [extra, text] of Object.entries(titled.extra)) assert.equal(await readFile(path.join(unpacked.folder, "files/claude", relative(extra)), "utf8"), text);
  const manifest = unpacked.manifest;
  assert.equal(manifest.format, 1);
  assert.equal(manifest.reason, "expired");
  assert.deepEqual(manifest.project, { id: home.record.id, name: "Folder Project", path: home.projectPath });
  assert.deepEqual(manifest.machine, { id: f.local.id, name: f.local.name });
  assert.equal(manifest.title, "Fix the login page!");
  assert.equal(manifest.conversationId, titled.id);
  assert.deepEqual(manifest.segments, [{ engine: "claude", sessionId: titled.id }]);
  assert.deepEqual(manifest.agentFolders, { claude: f.sessionRoot });
  assert.deepEqual(manifest.files.map((file: { name: string }) => file.name).sort(), [titled.file, ...Object.keys(titled.extra)].map((file) => `files/claude/${relative(file)}`).sort());
  assert.equal(manifest.files.find((file: { name: string }) => file.name.endsWith(`${titled.id}.jsonl`)).bytes, Buffer.byteLength(titled.content));
  assert.equal(manifest.records.length, 1, "the record goes into the backup");
  assert.equal(manifest.records[0].session_id, titled.id);
  assert.ok(Math.abs(Date.parse(manifest.lastActivityAt) - (before - 45 * DAY)) < HOUR);
  const loose = await f.unpack(String(kept.get(unrecorded.id)!.location));
  assert.deepEqual(loose.manifest.records, [], "a transcript without a record is backed up all the same");
  assert.equal(await readFile(path.join(loose.folder, "files/claude", relative(unrecorded.file)), "utf8"), unrecorded.content);

  const status = await f.backups.conversationBackupStatus();
  assert.equal(status.where, folder);
  assert.equal(status.kept.backups, 3);
  assert.equal(status.kept.bytes, [...kept.values()].reduce((sum, row) => sum + Number(row.bytes), 0));
  assert.equal(status.problem, null);
  assert.ok(Math.abs(Date.parse(status.nextRemovalAt!) - (before + 30 * DAY)) < HOUR);
});

test("a backup goes when it is older than the owner's days, and with 0 it is kept", { timeout: 120_000 }, async () => {
  const f = await fixture();
  const kept = [...f.kept().values()];
  assert.equal(kept.length, 3, "the backups of the test before");
  const now = Date.now();
  const projectFolder = path.dirname(String(kept[0].location));

  assert.equal(await f.backups.removeExpiredBackups(now + 29 * DAY), 0);
  f.settings.updateSettings({ conversationBackup: { keepDays: 0 } });
  assert.equal(await f.backups.removeExpiredBackups(now + 400 * DAY), 0, "0 days keeps every backup");
  assert.equal((await f.backups.conversationBackupStatus()).nextRemovalAt, null);
  for (const row of kept) assert.equal(await exists(String(row.location)), true);

  // The owner moved one archive away to keep it: its row goes quietly with the others.
  f.settings.updateSettings({ conversationBackup: { keepDays: 30 } });
  const moved = path.join(f.root, "kept-by-hand.tar.gz");
  const { rename } = await import("node:fs/promises");
  await rename(String(kept[0].location), moved);
  // A sweep that deletes nothing still removes old backups.
  assert.equal(await f.sweep(off, now + 31 * DAY), 0);
  for (const row of kept) assert.equal(await exists(String(row.location)), false);
  assert.equal(await exists(moved), true, "an archive outside the place it was written to is never touched");
  assert.equal(await exists(projectFolder), false, "the project's folder goes with its last backup");
  assert.equal(f.kept().size, 0);
  assert.equal(f.backups.conversationBackupRows().length, 3, "a removed backup stays on record for a while");
  assert.deepEqual((await f.backups.conversationBackupStatus()).kept, { backups: 0, bytes: 0 });
  await f.backups.removeExpiredBackups(now + 31 * DAY + 91 * DAY);
  assert.deepEqual(f.backups.conversationBackupRows(), []);
});

test("a conversation that cannot be backed up stays, with the reason kept for the owner", { timeout: 120_000 }, async () => {
  const f = await fixture();
  const blocker = path.join(f.root, "a-file-in-the-way");
  await writeFile(blocker, "not a folder");
  f.settings.updateSettings({ conversationBackup: { destination: "folder", folder: path.join(blocker, "backups") } });
  const home = await f.project("Blocked Project");
  const first = await home.transcript(45 * DAY), second = await home.transcript(46 * DAY), empty = await home.transcript(47 * DAY);
  // An empty conversation has nothing to back up: its record goes whatever the destination does.
  await rm(empty.file);

  // (An empty conversation is given an hour to get its first message, so this sweep looks from two hours on.)
  assert.equal(await f.sweep(full, Date.now() + 2 * HOUR), 1, "only the empty one went");
  assert.equal(await exists(first.file), true);
  assert.equal(await exists(second.file), true);
  assert.deepEqual([...await f.recorded(home.record.id)].sort(), [first.id, second.id].sort());
  const problem = (await f.backups.conversationBackupStatus()).problem;
  assert.match(problem!.message, /^Conversation claude:[0-9a-f-]{36} in Blocked Project could not be backed up: .*Nothing more is deleted for its age until a backup succeeds\.$/);
  assert.ok(Date.now() - Date.parse(problem!.at) < HOUR);
  await assert.rejects(f.backups.checkBackupDestination());
  assert.equal(f.kept().size, 0);

  // A folder something else reads or moves is refused, and so nothing is deleted.
  for (const [unsafe, why] of [[path.join(f.sessionRoot, "backups"), /cannot lie in, or hold, .* transcript folder/], [path.join(home.projectPath, "backups"), /cannot lie inside the project Blocked Project/], [path.dirname(f.sessionRoot), /cannot lie in, or hold, .* transcript folder/]] as const) {
    f.settings.updateSettings({ conversationBackup: { folder: unsafe } });
    await assert.rejects(f.backups.checkBackupDestination(), why);
    assert.equal(await f.sweep(full), 0);
    assert.equal(await exists(first.file), true);
    assert.match((await f.backups.conversationBackupStatus()).problem!.message, why);
  }
  assert.equal(await exists(path.join(f.sessionRoot, "backups")), false);
  assert.equal(await exists(path.join(home.projectPath, "backups")), false);

  // Switched off, the problem holds nothing up and is not shown; switched on again it is still there.
  f.settings.updateSettings({ conversationBackup: { destination: "off" } });
  assert.equal((await f.backups.conversationBackupStatus()).problem, null);
  f.settings.updateSettings({ conversationBackup: { destination: "folder" } });
  assert.notEqual((await f.backups.conversationBackupStatus()).problem, null);

  // The owner names a folder that works. Checking a place that is typed but not saved proves nothing about the saved one;
  // checking the saved one ends the problem. Both conversations then go, each after its backup.
  const folder = path.join(f.root, "working-backups");
  assert.equal(await f.backups.checkBackupDestination({ ...f.settings.getSettings().conversationBackup, folder }), folder);
  assert.notEqual((await f.backups.conversationBackupStatus()).problem, null);
  f.settings.updateSettings({ conversationBackup: { folder } });
  assert.equal(await f.backups.checkBackupDestination(), folder);
  assert.equal((await f.backups.conversationBackupStatus()).problem, null);
  assert.equal(await f.sweep(full), 2);
  assert.equal(await exists(first.file), false);
  assert.equal(await exists(second.file), false);
  assert.deepEqual([...f.kept().keys()].sort(), [first.id, second.id].sort());
  assert.equal((await f.backups.conversationBackupStatus()).problem, null);
});

test("a backup that already holds the conversation as it is now is not made twice", { timeout: 120_000 }, async () => {
  const f = await fixture();
  const { projectHarnessFiles } = await import("../src/server/conversation-delete.js");
  const home = await f.project("Twice Project");
  const one = await home.transcript(45 * DAY);
  const request = async () => ({
    reason: "expired" as const, project: { id: home.record.id, name: "Twice Project", path: home.projectPath },
    engine: "claude", sessionId: one.id, conversationId: one.id, segments: [{ engine: "claude" as const, sessionId: one.id }], files: await projectHarnessFiles(home.record.id),
  });
  const store = (await f.backups.ConversationBackups.open())!;
  const first = (await store.save(await request()))!;
  assert.equal(first.reused, false);
  const again = (await store.save(await request()))!;
  assert.deepEqual({ id: again.id, location: again.location, reused: again.reused }, { id: first.id, location: first.location, reused: true });
  // Written to since: the earlier backup no longer holds it all, and a second archive is kept beside the first.
  await writeFile(one.file, one.content + JSON.stringify({ type: "user", message: { role: "user", content: "one more thing" } }) + "\n");
  const third = (await store.save(await request()))!;
  assert.equal(third.reused, false);
  assert.notEqual(third.location, first.location);
  assert.equal(await exists(first.location), true);
  assert.equal(await exists(third.location), true);
  // A conversation with no file on this machine has nothing to back up.
  assert.equal(await store.save({ ...await request(), sessionId: randomUUID(), segments: [{ engine: "claude", sessionId: randomUUID() }] }), undefined);
  await rm(one.file);
});

test("a conversation a person deletes is not backed up", { timeout: 120_000 }, async () => {
  const f = await fixture();
  const { deleteLocalConversation } = await import("../src/server/routes/sessions.js");
  const home = await f.project("Person Project");
  const mine = await home.transcript(2 * DAY);
  const before = f.backups.conversationBackupRows().length;
  f.clearHarnessSessionCache();
  await deleteLocalConversation(home.record, "claude", mine.id);
  assert.equal(await exists(mine.file), false);
  assert.equal(f.backups.conversationBackupRows().length, before);
});

test("what an earlier delete left behind is backed up before the box removes it", { timeout: 120_000 }, async () => {
  const f = await fixture();
  // The node's own database, whichever kind this node keeps it in.
  const { retentionDatabase } = await import("../src/server/conversation-delete.js");
  const db = retentionDatabase();
  const home = await f.project("Leftover Project");
  const left = await home.transcript(90 * DAY, { folder: true });
  // Another machine deleted it before the complete delete existed; this machine still has its files.
  db.prepare("DELETE FROM conversation_records WHERE session_id = ?").run(left.id);
  db.prepare("INSERT INTO conversation_record_tombstones (project_id, engine, session_id, updated_at, origin_node_id) VALUES (?, 'claude', ?, '2026-01-01T00:00:00.000Z', ?)").run(home.record.id, left.id, randomUUID());
  db.prepare("INSERT INTO conversation_deletes_earlier (engine, session_id, made_here) VALUES ('claude', ?, 0)").run(left.id);

  // Start-up takes nothing of it while backups are on, box ticked or not: only the hourly check, which backs up first, may.
  const { removeAllDeletedTranscripts } = await import("../src/server/deleted-transcripts.js");
  f.settings.updateSettings({ conversationRetentionScope: { leftovers: true } });
  try {
    await removeAllDeletedTranscripts();
    assert.equal(await exists(left.file), true, "start-up removed a left-behind file that had no backup");
    assert.equal(f.kept().has(left.id), false);
  } finally { f.settings.updateSettings({ conversationRetentionScope: { leftovers: false } }); }

  // The destination refuses: the files stay where they are.
  const working = f.settings.getSettings().conversationBackup.folder;
  f.settings.updateSettings({ conversationBackup: { folder: path.join(f.root, "a-file-in-the-way", "backups") } });
  await f.sweep({ ...off, leftovers: true });
  assert.equal(await exists(left.file), true);
  for (const extra of Object.keys(left.extra)) assert.equal(await exists(extra), true);
  assert.match((await f.backups.conversationBackupStatus()).problem!.message, /What was left of conversation claude:.* could not be backed up/);

  f.settings.updateSettings({ conversationBackup: { folder: working } });
  await f.sweep({ ...off, leftovers: true });
  assert.equal(await exists(left.file), false);
  for (const extra of Object.keys(left.extra)) assert.equal(await exists(extra), false);
  const row = f.kept().get(left.id)!;
  assert.equal(row.reason, "leftover");
  const unpacked = await f.unpack(String(row.location));
  const relative = (file: string): string => path.relative(f.sessionRoot, file).split(path.sep).join("/");
  assert.equal(await readFile(path.join(unpacked.folder, "files/claude", relative(left.file)), "utf8"), left.content);
  assert.equal(unpacked.manifest.files.length, 3);
  assert.equal(unpacked.manifest.project.name, "Leftover Project");
});

interface Stored { key: string; body: Buffer }

/** A stand-in for an S3-compatible service: keeps what is put, forgets what is deleted, refuses when told to. */
async function bucket(): Promise<{ endpoint: string; objects: Map<string, Buffer>; puts: Stored[]; deletes: string[]; refuse: (status?: number) => void; close: () => Promise<void> }> {
  const objects = new Map<string, Buffer>(), puts: Stored[] = [], deletes: string[] = [];
  let refusing: number | undefined;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const key = decodeURIComponent(new URL(request.url!, "http://service").pathname.slice(1));
      if (!/^AWS4-HMAC-SHA256 Credential=AKIATESTKEY\d*\//.test(String(request.headers.authorization))) { response.writeHead(403).end("<Error><Code>InvalidAccessKeyId</Code></Error>"); return; }
      if (request.method === "PUT") puts.push({ key, body: Buffer.concat(chunks) });
      if (request.method === "DELETE") deletes.push(key);
      if (refusing) { response.writeHead(refusing).end("<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>"); return; }
      if (request.method === "PUT") { objects.set(key, Buffer.concat(chunks)); response.writeHead(200).end(); return; }
      if (request.method === "DELETE") { objects.delete(key); response.writeHead(204).end(); return; }
      response.writeHead(405).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, objects, puts, deletes, refuse: (status) => { refusing = status; }, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

test("with backups to S3, the archive is uploaded before the delete, a refusal keeps the conversation, and old backups are deleted from the bucket", { timeout: 180_000 }, async () => {
  const f = await fixture();
  const { readTarGzEntries } = await import("../src/tar-archive.js");
  const { settingsDatabase } = await import("../src/settings-store.js");
  const service = await bucket();
  try {
    // A bucket needs everything it takes to reach it before it can be chosen.
    assert.throws(() => f.settings.updateSettings({ conversationBackup: { destination: "s3" } }), /need a bucket/);
    assert.throws(() => f.settings.updateSettings({ conversationBackup: { destination: "s3", s3: { bucket: "team-backups" } } }), /need the bucket's region/);
    assert.throws(() => f.settings.updateSettings({ conversationBackup: { destination: "s3", s3: { bucket: "team-backups", region: "eu-west-1", accessKeyId: "AKIATESTKEY1" } } }), /need an access key ID and its secret key, or a profile/);
    assert.equal(f.settings.getSettings().conversationBackup.destination, "folder", "a save that is refused changes nothing");
    const saved = f.settings.updateSettings({ conversationBackup: { destination: "s3", s3: { bucket: "team-backups", region: "eu-west-1", prefix: "/joint-bob/conversations/", endpoint: `${service.endpoint}/`, accessKeyId: "AKIATESTKEY1", secretAccessKey: "a secret nobody reads back" } } });
    assert.deepEqual(saved.conversationBackup.s3, { bucket: "team-backups", region: "eu-west-1", prefix: "joint-bob/conversations", endpoint: service.endpoint, credentials: "keys", accessKeyId: "AKIATESTKEY1", profile: "" });
    assert.equal(saved.conversationBackup.hasSecretAccessKey, true);
    assert.equal(JSON.stringify(f.settings.getSettings()).includes("a secret nobody reads back"), false, "the secret key is never part of the settings");
    const stored = settingsDatabase().prepare("SELECT key, value, is_secret FROM node_settings WHERE key LIKE 'conversationBackup%' ORDER BY key").all() as Array<{ key: string; value: string; is_secret: number }>;
    assert.deepEqual(stored.map((row) => [row.key, row.is_secret]), [["conversationBackup", 0], ["conversationBackup.s3SecretAccessKey", 1]]);
    assert.equal(stored.some((row) => row.value.includes("a secret nobody reads back")), false, "and it is stored encrypted");
    assert.equal(f.settings.conversationBackupSecretAccessKey(), "a secret nobody reads back");

    const base = `team-backups/joint-bob/conversations/${f.local.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || f.local.id}`;
    assert.equal(await f.backups.checkBackupDestination(), `s3://${base}`);
    assert.equal(service.objects.size, 0, "the check removes what it wrote");
    assert.equal(service.puts.length, 1);
    assert.equal(service.deletes.length, 1);

    const home = await f.project("Bucket Project");
    const first = await home.transcript(45 * DAY, { folder: true }), second = await home.transcript(46 * DAY);
    // The bucket refuses: one upload is tried, both conversations stay, nothing is left in staging.
    service.refuse(403);
    assert.equal(await f.sweep(full), 0);
    assert.equal(service.puts.length, 2, "one upload was tried, not one for each conversation");
    assert.equal(await exists(first.file), true);
    assert.equal(await exists(second.file), true);
    assert.match((await f.backups.conversationBackupStatus()).problem!.message, /could not be backed up: Writing .* in bucket team-backups was refused: 403 AccessDenied \(Access Denied\)\. Nothing more is deleted/);
    assert.deepEqual(await f.backups.stagedBackups(), []);

    service.refuse(undefined);
    const now = Date.now();
    assert.equal(await f.sweep(full), 2);
    assert.equal(await exists(first.file), false);
    assert.equal(await exists(second.file), false);
    const rows = [first, second].map((entry) => f.kept().get(entry.id)!);
    const day = new Date(now).toISOString().slice(0, 10);
    assert.deepEqual(rows.map((row) => row.location), [first, second].map((entry) => `s3://${base}/Bucket-Project_${home.record.id}/${day}_claude_${entry.id}_Written-${entry === first ? 45 : 46}-days-ago.tar.gz`));
    assert.equal(service.objects.size, 2);
    assert.deepEqual(await f.backups.stagedBackups(), []);
    // What lies in the bucket is the archive: it reads back with every file of the conversation.
    const key = String(rows[0].location).slice("s3://".length);
    const copy = path.join(f.root, "from-bucket.tar.gz");
    await writeFile(copy, service.objects.get(key)!);
    assert.equal(Number(rows[0].bytes), service.objects.get(key)!.length);
    assert.deepEqual((await readTarGzEntries(copy)).map((entry) => entry.name).sort(), ["conversation.json", ...[first.file, ...Object.keys(first.extra)].map((file) => `files/claude/${path.relative(f.sessionRoot, file).split(path.sep).join("/")}`)].sort());
    assert.equal((await f.backups.conversationBackupStatus()).problem, null);

    // Past the owner's days: a bucket that refuses the delete keeps the backup on record; one that takes it loses the object.
    // The backups in folders that the tests before left are old by then as well: the bucket's refusal does not hold them up.
    const inFolders = f.backups.conversationBackupRows().filter((row) => row.removed_at === null && row.destination === "folder");
    assert.ok(inFolders.length > 0);
    service.refuse(403);
    const deletesBefore = service.deletes.length;
    assert.equal(await f.backups.removeExpiredBackups(now + 31 * DAY), inFolders.length);
    for (const row of inFolders) assert.equal(await exists(String(row.location)), false);
    assert.equal(service.deletes.length, deletesBefore + 1, "one delete was tried in the bucket, not one for each backup");
    assert.match((await f.backups.conversationBackupStatus()).problem!.message, /is past its 30 days and could not be removed: Deleting .* was refused: 403 AccessDenied/);
    assert.deepEqual([...f.kept().keys()].sort(), [first.id, second.id].sort());
    service.refuse(undefined);
    assert.equal(await f.backups.removeExpiredBackups(now + 31 * DAY), 2);
    assert.equal(service.objects.size, 0);
    assert.equal(f.kept().size, 0);
    assert.equal((await f.backups.conversationBackupStatus()).problem, null, "the problem ends when the backups could be removed");

    // A profile instead of keys needs no secret saved here.
    const profile = f.settings.updateSettings({ conversationBackup: { s3: { credentials: "profile", profile: "sela" } } });
    assert.equal(profile.conversationBackup.s3.credentials, "profile");
    assert.throws(() => f.settings.updateSettings({ conversationBackup: { s3: { profile: "--debug" } } }), /not a usable AWS profile name/);
    assert.throws(() => f.settings.updateSettings({ conversationBackup: { s3: { bucket: "Not_A_Bucket" } } }), /not a bucket name/);
    assert.throws(() => f.settings.updateSettings({ conversationBackup: { s3: { endpoint: "ftp://example.test" } } }), /http or https address/);
    assert.throws(() => f.settings.updateSettings({ conversationBackup: { folder: "relative/folder" } }), /absolute path/);
    assert.throws(() => f.settings.updateSettings({ conversationBackup: { keepDays: -1 } }), /0 to 3650 days/);
  } finally {
    f.settings.updateSettings({ conversationBackup: { destination: "off" } });
    await service.close();
  }
});
