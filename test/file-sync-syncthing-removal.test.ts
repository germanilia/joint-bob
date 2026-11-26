import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { ensureControlSchema } from "../src/file-sync/control.js";
import { removeSyncthing, syncthingReleased, syncthingRemoved, WAITING_FOR_SYNCTHING, type RemovalDeps } from "../src/file-sync/syncthing-removal.js";

/* The one-time removal of what earlier releases set up for Syncthing (syncthing-removal.ts). Every
   request goes to a stand-in `fetch`, every system command to a stand-in `run`, and the home folder
   is a throwaway one: no daemon is asked, no service is touched, and nothing of this machine's own
   Syncthing is read or deleted (home, configPaths, env, run and processes are always given). */

const URL_ = "http://127.0.0.1:8384";
const KEY = "stored-key";
const LOCAL = "LOCAL-DEVICE";

interface Folder { id: string; label?: string; path?: string; devices?: Array<{ deviceID: string }> }
interface Device { deviceID: string; name: string }

/** A Syncthing that holds `folders` and knows `devices`; a DELETE removes one unless its id is in `stuck`. */
class Daemon {
  requests: Array<{ method: string; url: string; key: string | null }> = [];
  stuck = new Set<string>();
  devices: Device[] = [{ deviceID: LOCAL, name: "this-machine" }];
  /** Replaces the daemon's answer: a status to send, or an error to throw. */
  answer?: (method: string, url: URL) => Response | Error | undefined;
  constructor(public folders: Folder[]) {}

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    this.requests.push({ method, url: url.href, key: new Headers(init?.headers).get("x-api-key") });
    const forced = this.answer?.(method, url);
    if (forced instanceof Error) throw forced;
    if (forced) return forced;
    if (method === "GET" && url.pathname === "/rest/config/folders") return Response.json(this.folders);
    if (method === "GET" && url.pathname === "/rest/config/devices") return Response.json(this.devices);
    if (method === "GET" && url.pathname === "/rest/system/status") return Response.json({ myID: LOCAL });
    if (method === "DELETE" && url.pathname.startsWith("/rest/config/folders/")) {
      const id = decodeURIComponent(url.pathname.slice("/rest/config/folders/".length));
      if (!this.stuck.has(id)) this.folders = this.folders.filter((folder) => folder.id !== id);
      return new Response("");
    }
    if (method === "DELETE" && url.pathname.startsWith("/rest/config/devices/")) {
      const id = decodeURIComponent(url.pathname.slice("/rest/config/devices/".length));
      this.devices = this.devices.filter((device) => device.deviceID !== id);
      return new Response("");
    }
    return new Response("not found", { status: 404 });
  };

  made(method: string): string[] { return this.requests.filter((request) => request.method === method).map((request) => new URL(request.url).pathname); }
}

interface Fixture {
  db: DatabaseSync;
  daemon: Daemon;
  logs: string[];
  home: string;
  /** System commands asked for, as one line each. */
  commands: string[];
  /** Commands that fail: matched against the line. */
  failing: RegExp[];
  /** The exit status a failing command reports. */
  exitCode: number;
  /** Command lines `ps` would list. */
  running: string[];
  forgotten: number;
  deps: (overrides?: Partial<RemovalDeps>) => RemovalDeps;
  /** The same database as a later start of the node sees it. */
  restart: () => DatabaseSync;
}

async function setup(t: TestContext, folders: Folder[] = []): Promise<Fixture> {
  const home = await mkdtemp(path.join(os.tmpdir(), "syncthing-removal-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "node.db");
  const open = (): DatabaseSync => {
    const db = new DatabaseSync(file);
    ensureControlSchema(db);
    t.after(() => { if (db.isOpen) db.close(); });
    return db;
  };
  const fixture: Fixture = {
    db: open(), daemon: new Daemon(folders), logs: [], home, commands: [], failing: [], exitCode: 1, running: [], forgotten: 0,
    deps: (overrides = {}) => ({
      db: fixture.db, stored: () => ({ endpoint: URL_, apiKey: KEY }), forget: () => { fixture.forgotten++; },
      configPaths: [], env: {}, home, platform: "linux", fetch: fixture.daemon.fetch,
      run: async (command, args) => {
        const line = [command, ...args].join(" ");
        fixture.commands.push(line);
        if (fixture.failing.some((pattern) => pattern.test(line))) throw Object.assign(new Error(`${command} failed`), { code: fixture.exitCode });
      },
      processes: async () => fixture.running,
      log: (message) => { fixture.logs.push(message); },
      ...overrides,
    }),
    restart: () => { fixture.db.close(); fixture.db = open(); return fixture.db; },
  };
  return fixture;
}

const UNREACHABLE = "Joint Bob cannot ask the Syncthing set up on this machine for its folders. If it still holds folders named after Joint Bob projects, remove them there: built-in sync moves those files now";
const UNIT = ".config/systemd/user/joint-bob-syncthing.service";
const AGENT = "Library/LaunchAgents/com.joint-bob.syncthing.plist";
const DOWNLOAD = ".local/share/joint-bob/runtime/syncthing-v2.1.3";

async function put(home: string, relative: string, text = "x"): Promise<string> {
  const file = path.join(home, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}

// ---- step 1: Joint Bob's folders leave the local Syncthing ----

test("a machine with no trace of a Syncthing has nothing to let go of or remove: done, and marked for good", async (t) => {
  const { db, daemon, logs, deps } = await setup(t);
  assert.deepEqual([syncthingReleased(db), syncthingRemoved(db)], [false, false]);
  assert.equal(await removeSyncthing(deps({ stored: () => ({}) })), "done");
  assert.deepEqual([syncthingReleased(db), syncthingRemoved(db), daemon.requests, logs], [true, true, [], []]);
  // The same with no `stored` at all.
  const bare = await setup(t);
  assert.equal(await removeSyncthing(bare.deps({ stored: undefined })), "done");
  assert.deepEqual([syncthingRemoved(bare.db), bare.daemon.requests, bare.logs], [true, [], []]);
});

test("half a connection is a trace of a Syncthing Joint Bob cannot ask: idle, not marked, nothing requested or removed", async (t) => {
  for (const partial of [() => ({ endpoint: URL_ }), () => ({ apiKey: KEY })]) {
    const { db, daemon, logs, home, commands, deps } = await setup(t, [{ id: "joint-bob-alpha" }]);
    const unit = await put(home, UNIT), download = await put(home, `${DOWNLOAD}/bin/syncthing`);
    assert.equal(await removeSyncthing(deps({ stored: partial })), "idle");
    assert.deepEqual([syncthingReleased(db), daemon.requests, daemon.folders.length, logs, commands], [false, [], 1, [UNREACHABLE], []]);
    assert.ok(existsSync(unit) && existsSync(download), "what it installed stays until its folders are known to be out");
  }
  for (const env of [{ JOINT_BOB_SYNCTHING_URL: URL_ }, { JOINT_BOB_SYNCTHING_API_KEY: KEY }]) {
    const { db, daemon, logs, deps } = await setup(t);
    assert.equal(await removeSyncthing(deps({ stored: () => ({}), env })), "idle");
    assert.deepEqual([syncthingReleased(db), daemon.requests, logs], [false, [], [UNREACHABLE]]);
  }
});

test("only the folders Joint Bob made are taken out; the person's own stay, and it is done once", async (t) => {
  const own: Folder[] = [{ id: "photos", label: "Photos" }, { id: "joint-bobby", label: "Looks alike" }, { id: "my-joint-bob-notes" }];
  const { db, daemon, logs, deps } = await setup(t, [
    { id: "joint-bob-alpha", label: "Alpha" }, own[0], { id: "joint-bob-tickets-alpha" }, own[1], { id: "joint-bob-worktrees/alpha b" }, own[2],
  ]);
  assert.equal(await removeSyncthing(deps()), "done");
  assert.deepEqual(daemon.made("DELETE"), ["/rest/config/folders/joint-bob-alpha", "/rest/config/folders/joint-bob-tickets-alpha", "/rest/config/folders/joint-bob-worktrees%2Falpha%20b"]);
  assert.deepEqual(daemon.folders, own, "folders the person made are untouched");
  assert.deepEqual(daemon.made("GET").slice(0, 2), ["/rest/config/folders", "/rest/config/folders"], "a fresh list confirms they are gone");
  assert.ok(daemon.requests.every((request) => request.key === KEY && request.url.startsWith(`${URL_}/rest/`)));
  assert.deepEqual([syncthingReleased(db), syncthingRemoved(db)], [true, true]);
  assert.deepEqual(logs, ["Joint Bob took its 3 folder(s) out of this machine's Syncthing; built-in sync moves those files now, and the files stay where they are"]);
  // Marked: a second call asks nothing, even if such a folder were there again.
  daemon.folders.push({ id: "joint-bob-later" });
  const before = daemon.requests.length;
  assert.equal(await removeSyncthing(deps()), "done");
  assert.equal(daemon.requests.length, before);
  assert.equal(daemon.folders.length, 4);
});

test("a folder the daemon does not let go of keeps it waiting, unmarked, and the next call tries again", async (t) => {
  const { db, daemon, logs, home, deps } = await setup(t, [{ id: "joint-bob-alpha", label: " Alpha " }, { id: "joint-bob-beta" }, { id: "photos" }]);
  const download = await put(home, `${DOWNLOAD}/bin/syncthing`);
  daemon.stuck.add("joint-bob-alpha");
  assert.equal(await removeSyncthing(deps()), "waiting");
  assert.equal(syncthingReleased(db), false);
  assert.deepEqual(daemon.folders.map((folder) => folder.id), ["joint-bob-alpha", "photos"]);
  assert.deepEqual(logs, ["Syncthing on this machine still holds 1 Joint Bob folder(s), the first being “Alpha”; built-in sync waits for it to let go"]);
  assert.ok(existsSync(download), "nothing it installed goes while a folder is still held");
  // A DELETE the daemon refuses outright reads the same: the fresh list decides.
  daemon.answer = (method) => method === "DELETE" ? new Response("no", { status: 500 }) : undefined;
  assert.equal(await removeSyncthing(deps()), "waiting");
  assert.equal(syncthingReleased(db), false);
  daemon.answer = undefined;
  daemon.stuck.clear();
  assert.equal(await removeSyncthing(deps()), "done");
  assert.deepEqual([daemon.folders.map((folder) => folder.id), syncthingReleased(db), existsSync(download)], [["photos"], true, false]);
});

test("no daemon listening is idle, not done: nothing writes now, and it is asked again at the next start", async (t) => {
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "EADDRNOTAVAIL"]) {
    const { db, daemon, logs, deps } = await setup(t, [{ id: "joint-bob-alpha" }]);
    daemon.answer = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
    assert.equal(await removeSyncthing(deps()), "idle", code);
    assert.deepEqual([syncthingReleased(db), daemon.requests.length, logs], [false, 1, []], code);
    // Running again later: its folders go then.
    daemon.answer = undefined;
    assert.equal(await removeSyncthing(deps()), "done", code);
    assert.deepEqual(daemon.folders, [], code);
  }
  // Node's own errors carry the code on the error itself.
  const direct = await setup(t);
  direct.daemon.answer = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  assert.equal(await removeSyncthing(direct.deps()), "idle");
});

test("a daemon that refuses the key, fails or does not answer in time keeps it waiting", async (t) => {
  const answers: Array<[string, () => Response | Error]> = [
    ["401", () => new Response("Not Authorized", { status: 401 })],
    ["403", () => new Response("Forbidden", { status: 403 })],
    ["500", () => new Response("oops", { status: 500 })],
    ["timeout", () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })],
    ["reset", () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) })],
    ["not a list", () => Response.json({ error: "nope" })],
  ];
  for (const [name, answer] of answers) {
    const { db, daemon, logs, deps } = await setup(t, [{ id: "joint-bob-alpha" }]);
    daemon.answer = answer;
    assert.equal(await removeSyncthing(deps()), "waiting", name);
    assert.deepEqual([syncthingReleased(db), daemon.made("DELETE")], [false, []], name);
    assert.equal(logs.length, 1, name);
    assert.match(logs[0], /^Joint Bob could not ask this machine's Syncthing for its folders \(.+\); projects it may still sync wait for built-in sync until it answers$/, name);
  }
  const refused = await setup(t);
  refused.daemon.answer = answers[0][1];
  await removeSyncthing(refused.deps());
  assert.match(refused.logs[0], /\(Syncthing answered 401\)/);
});

test("the fresh list failing after the deletes is waiting, not done", async (t) => {
  const { db, daemon, deps } = await setup(t, [{ id: "joint-bob-alpha" }]);
  let lists = 0;
  daemon.answer = (method, url) => method === "GET" && url.pathname === "/rest/config/folders" && ++lists === 2 ? new Response("oops", { status: 500 }) : undefined;
  assert.equal(await removeSyncthing(deps()), "waiting");
  assert.equal(syncthingReleased(db), false);
  assert.deepEqual(daemon.made("DELETE"), ["/rest/config/folders/joint-bob-alpha"]);
  daemon.answer = undefined;
  assert.equal(await removeSyncthing(deps()), "done");
});

test("a Syncthing on another machine is never called, and is not counted as let go: idle, not marked", async (t) => {
  for (const endpoint of ["http://192.168.1.20:8384", "https://syncthing.example.com", "http://100.101.2.3:8384", "http://127.0.0.1.example.com:8384", "not a url"]) {
    const { db, daemon, logs, deps } = await setup(t, [{ id: "joint-bob-alpha" }]);
    assert.equal(await removeSyncthing(deps({ stored: () => ({ endpoint, apiKey: KEY }) })), "idle", endpoint);
    assert.deepEqual([daemon.requests, daemon.folders.length, syncthingReleased(db), logs], [[], 1, false, [UNREACHABLE]], endpoint);
  }
  // Through the environment too.
  const { db, daemon, deps } = await setup(t, [{ id: "joint-bob-alpha" }]);
  assert.equal(await removeSyncthing(deps({ stored: () => ({}), env: { JOINT_BOB_SYNCTHING_URL: "http://10.0.0.5:8384", JOINT_BOB_SYNCTHING_API_KEY: KEY } })), "idle");
  assert.deepEqual([daemon.requests, syncthingReleased(db)], [[], false]);
  // Every spelling of this machine is.
  for (const endpoint of ["http://localhost:8384", "http://[::1]:8384", "https://127.0.0.1:8384"]) {
    const local = await setup(t, [{ id: "joint-bob-alpha" }]);
    assert.equal(await removeSyncthing(local.deps({ stored: () => ({ endpoint, apiKey: KEY }) })), "done", endpoint);
    assert.deepEqual([local.daemon.folders, new URL(local.daemon.requests[0].url).origin], [[], new URL(endpoint).origin], endpoint);
  }
});

test("the connection comes from the stored settings, the environment, or Syncthing's own config.xml", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "syncthing-removal-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = async (name: string, gui: string): Promise<string> => {
    const file = path.join(dir, name);
    await writeFile(file, `<configuration version="37">\n  <folder id="joint-bob-alpha" label="Alpha" path="/x"></folder>\n  ${gui}\n</configuration>\n`);
    return file;
  };
  const asked = async (overrides: Partial<RemovalDeps>): Promise<{ outcome: string; origin?: string; key?: string | null; emptied: boolean; marked?: boolean; logs?: string[] }> => {
    const { db, daemon, logs, deps } = await setup(t, [{ id: "joint-bob-alpha" }]);
    const outcome = await removeSyncthing(deps({ stored: () => ({}), ...overrides }));
    const first = daemon.requests[0];
    return { outcome, ...(first ? { origin: new URL(first.url).origin, key: first.key } : {}), emptied: syncthingReleased(db) && daemon.folders.length === 0, ...(first ? {} : { marked: syncthingReleased(db), logs }) };
  };

  assert.deepEqual(await asked({ stored: () => ({ endpoint: "http://127.0.0.1:8385", apiKey: "from-settings" }) }), { outcome: "done", origin: "http://127.0.0.1:8385", key: "from-settings", emptied: true });
  // A saved connection read asynchronously counts the same.
  assert.deepEqual(await asked({ stored: async () => ({ endpoint: "http://127.0.0.1:8385", apiKey: "from-settings" }) }), { outcome: "done", origin: "http://127.0.0.1:8385", key: "from-settings", emptied: true });
  assert.deepEqual(await asked({ env: { JOINT_BOB_SYNCTHING_URL: " http://localhost:8386 ", JOINT_BOB_SYNCTHING_API_KEY: " from-env " } }), { outcome: "done", origin: "http://localhost:8386", key: "from-env", emptied: true });
  const plain = await config("plain.xml", "<gui><address>127.0.0.1:8384</address><apikey>k</apikey></gui>");
  assert.deepEqual(await asked({ configPaths: [plain] }), { outcome: "done", origin: "http://127.0.0.1:8384", key: "k", emptied: true });

  // The environment wins over the stored settings, which win over config.xml; each fills what the others lack.
  assert.deepEqual(await asked({ stored: () => ({ endpoint: "http://127.0.0.1:8385", apiKey: "from-settings" }), env: { JOINT_BOB_SYNCTHING_URL: "http://127.0.0.1:8386" }, configPaths: [plain] }),
    { outcome: "done", origin: "http://127.0.0.1:8386", key: "from-settings", emptied: true });
  assert.deepEqual(await asked({ stored: () => ({ endpoint: "http://127.0.0.1:8385" }), configPaths: [plain] }), { outcome: "done", origin: "http://127.0.0.1:8385", key: "k", emptied: true });

  // config.xml as Syncthing writes it: TLS, every interface, the default address, a full URL.
  const tls = await config("tls.xml", '<gui enabled="true" tls="true" debugging="false">\n    <address>0.0.0.0:8443</address>\n    <apikey>tls-key</apikey>\n    <theme>default</theme>\n  </gui>');
  assert.deepEqual(await asked({ configPaths: [tls] }), { outcome: "done", origin: "https://127.0.0.1:8443", key: "tls-key", emptied: true });
  const v6 = await config("v6.xml", "<gui><address>[::]:8390</address><apikey>k6</apikey></gui>");
  assert.deepEqual(await asked({ configPaths: [v6] }), { outcome: "done", origin: "http://127.0.0.1:8390", key: "k6", emptied: true });
  const byDefault = await config("default.xml", "<gui><address>default</address><apikey>kd</apikey></gui>");
  assert.deepEqual(await asked({ configPaths: [byDefault] }), { outcome: "done", origin: "http://127.0.0.1:8384", key: "kd", emptied: true });
  const full = await config("full.xml", "<gui><address>http://127.0.0.1:8391/</address><apikey>kf</apikey></gui>");
  assert.deepEqual(await asked({ configPaths: [full] }), { outcome: "done", origin: "http://127.0.0.1:8391", key: "kf", emptied: true });

  // The first readable file with a usable GUI counts: a missing file, one with its GUI off and one without a key are passed over.
  const off = await config("off.xml", '<gui enabled="false"><address>127.0.0.1:8001</address><apikey>off</apikey></gui>');
  const keyless = await config("keyless.xml", "<gui><address>127.0.0.1:8002</address></gui>");
  assert.deepEqual(await asked({ configPaths: [path.join(dir, "missing.xml"), off, keyless, plain, tls] }), { outcome: "done", origin: "http://127.0.0.1:8384", key: "k", emptied: true });
  // A configuration that is there but cannot be used (interface off, no key) is a Syncthing Joint Bob cannot ask: idle, not marked.
  assert.deepEqual(await asked({ configPaths: [path.join(dir, "missing.xml"), off, keyless] }), { outcome: "idle", emptied: false, marked: false, logs: [UNREACHABLE] });
  for (const file of [off, keyless]) assert.deepEqual(await asked({ configPaths: [file] }), { outcome: "idle", emptied: false, marked: false, logs: [UNREACHABLE] });
  // So is one whose interface is not on this machine's loopback.
  const remote = await config("remote.xml", "<gui><address>192.168.1.20:8384</address><apikey>kr</apikey></gui>");
  assert.deepEqual(await asked({ configPaths: [remote] }), { outcome: "idle", emptied: false, marked: false, logs: [UNREACHABLE] });
  // No configuration on disk at all: no trace, done for good.
  assert.deepEqual(await asked({ configPaths: [path.join(dir, "missing.xml")] }), { outcome: "done", emptied: false, marked: true, logs: [] });
});

// ---- step 2: what Joint Bob installed goes ----

test("the service Joint Bob installed is stopped and removed with its download once it syncs nothing", async (t) => {
  const { db, daemon, logs, home, commands, deps } = await setup(t, [{ id: "joint-bob-alpha" }]);
  const unit = await put(home, UNIT), binary = await put(home, `${DOWNLOAD}/bin/syncthing`), node = await put(home, ".local/share/joint-bob/runtime/node-v24.22.1/bin/node");
  assert.equal(await removeSyncthing(deps()), "done");
  assert.deepEqual(commands, ["systemctl --user disable --now joint-bob-syncthing.service", "systemctl --user daemon-reload"]);
  assert.deepEqual([existsSync(unit), existsSync(binary), existsSync(path.dirname(path.dirname(binary))), existsSync(node)], [false, false, false, true], "the unit and the Syncthing download go; the Node runtime beside it stays");
  assert.deepEqual(logs.slice(1), [
    "Joint Bob stopped and removed the Syncthing service it installed on this machine",
    `Joint Bob deleted the copy of Syncthing it had downloaded: ${path.join(home, DOWNLOAD)}`,
  ]);
  assert.deepEqual(daemon.made("GET").filter((pathname) => pathname !== "/rest/config/folders"), [], "a Syncthing that was just removed is not asked for its machines");
  assert.equal(syncthingRemoved(db), true);
});

test("on macOS the launch agent is stopped only while it is loaded, then its file goes", async (t) => {
  const loaded = await setup(t);
  const plist = await put(loaded.home, AGENT);
  assert.equal(await removeSyncthing(loaded.deps({ platform: "darwin" })), "done");
  const target = `gui/${os.userInfo().uid}/com.joint-bob.syncthing`;
  assert.deepEqual(loaded.commands, [`launchctl print ${target}`, `launchctl bootout ${target}`]);
  assert.deepEqual([existsSync(plist), syncthingRemoved(loaded.db)], [false, true]);

  // Exit status 113 is launchctl's "no such service here".
  const unloaded = await setup(t);
  const stale = await put(unloaded.home, AGENT);
  unloaded.failing.push(/launchctl print/);
  unloaded.exitCode = 113;
  assert.equal(await removeSyncthing(unloaded.deps({ platform: "darwin" })), "done");
  assert.deepEqual(unloaded.commands, [`launchctl print ${target}`], "an agent that is not loaded needs no stopping");
  assert.deepEqual([existsSync(stale), syncthingRemoved(unloaded.db)], [false, true]);
  // Any other failure (a session launchctl cannot reach) says nothing about whether the agent runs: everything stays.
  const unreachable = await setup(t);
  const kept = await put(unreachable.home, AGENT), copy = await put(unreachable.home, `${DOWNLOAD}/bin/syncthing`);
  unreachable.failing.push(/launchctl print/);
  unreachable.exitCode = 112;
  assert.equal(await removeSyncthing(unreachable.deps({ platform: "darwin" })), "done");
  assert.deepEqual([unreachable.commands, existsSync(kept), existsSync(copy), syncthingRemoved(unreachable.db)], [[`launchctl print ${target}`], true, true, false]);
  assert.equal(unreachable.logs.at(-1), "Joint Bob could not stop the Syncthing service it installed on this machine (launchctl failed); it tries again at its next start");
  // A Linux unit file on a Mac (or the reverse) is not looked at.
  const other = await setup(t);
  const unit = await put(other.home, UNIT);
  assert.equal(await removeSyncthing(other.deps({ platform: "darwin" })), "done");
  assert.deepEqual([other.commands, existsSync(unit)], [[], true]);
});

test("a service that still syncs the person's own folders is left running, with its download", async (t) => {
  const { db, daemon, logs, home, commands, deps } = await setup(t, [{ id: "joint-bob-alpha" }, { id: "photos", label: "Photos", path: "/data/photos" }, { id: "notes" }]);
  const unit = await put(home, UNIT), binary = await put(home, `${DOWNLOAD}/bin/syncthing`);
  assert.equal(await removeSyncthing(deps()), "done");
  assert.deepEqual([commands, existsSync(unit), existsSync(binary)], [[], true, true]);
  assert.deepEqual(daemon.folders.map((folder) => folder.id), ["photos", "notes"]);
  assert.equal(logs[1], "Joint Bob no longer uses the Syncthing it installed on this machine, and left it running: it still syncs 2 folder(s) that are not Joint Bob's, the first being “Photos”");
  // Nothing more is to be done here: it is not looked at again.
  assert.equal(syncthingRemoved(db), true);
});

test("a service that cannot be stopped keeps everything, and is tried again only at the next start", async (t) => {
  const fixture = await setup(t, [{ id: "joint-bob-alpha" }]);
  const { daemon, logs, home, commands, failing, deps } = fixture;
  const unit = await put(home, UNIT), binary = await put(home, `${DOWNLOAD}/bin/syncthing`);
  failing.push(/disable --now/);
  assert.equal(await removeSyncthing(deps()), "done", "its folders are out, so projects are taken over all the same");
  assert.deepEqual([syncthingReleased(fixture.db), syncthingRemoved(fixture.db), existsSync(unit), existsSync(binary), fixture.forgotten], [true, false, true, true, 0]);
  assert.equal(logs[1], "Joint Bob could not stop the Syncthing service it installed on this machine (systemctl failed); it tries again at its next start");
  // Asked again while this process runs: nothing is tried a second time.
  const before = [commands.length, daemon.requests.length];
  assert.equal(await removeSyncthing(deps()), "done");
  assert.deepEqual([commands.length, daemon.requests.length], before);
  // The next start tries again, and this time it stops.
  failing.length = 0;
  fixture.restart();
  assert.equal(await removeSyncthing(deps()), "done");
  assert.deepEqual([syncthingRemoved(fixture.db), existsSync(unit), existsSync(binary), fixture.forgotten], [true, false, false, 1]);
});

test("a download a Syncthing still runs from is left in place", async (t) => {
  // The person's own service was pointed at Joint Bob's copy: it stays, and that is final.
  const own = await setup(t);
  const binary = await put(own.home, `${DOWNLOAD}/bin/syncthing`);
  own.running.push("/usr/bin/other --flag", `${binary} serve --no-browser`);
  assert.equal(await removeSyncthing(own.deps()), "done");
  assert.deepEqual([existsSync(binary), syncthingRemoved(own.db)], [true, true]);
  assert.deepEqual(own.logs, [`A Syncthing on this machine runs from the copy Joint Bob downloaded, so the copy was left in place: ${path.join(own.home, DOWNLOAD)}`]);

  // Joint Bob's own service, just stopped, may still be going down: the copy is deleted at the next start.
  const stopping = await setup(t);
  const unit = await put(stopping.home, UNIT), copy = await put(stopping.home, `${DOWNLOAD}/bin/syncthing`);
  stopping.running.push(`${copy} serve --no-browser --no-restart`);
  assert.equal(await removeSyncthing(stopping.deps()), "done");
  assert.deepEqual([existsSync(unit), existsSync(copy), syncthingRemoved(stopping.db)], [false, true, false]);
  stopping.running.length = 0;
  stopping.restart();
  assert.equal(await removeSyncthing(stopping.deps()), "done");
  assert.deepEqual([existsSync(copy), syncthingRemoved(stopping.db)], [false, true]);

  // A path that only starts the same is another program.
  const alike = await setup(t);
  const kept = await put(alike.home, `${DOWNLOAD}/bin/syncthing`);
  alike.running.push(`${path.join(alike.home, DOWNLOAD)}-backup/bin/syncthing serve`);
  assert.equal(await removeSyncthing(alike.deps()), "done");
  assert.equal(existsSync(kept), false);
});

test("the download is found in the runtime folder the environment names", async (t) => {
  const { db, home, deps } = await setup(t);
  const custom = path.join(home, "custom-runtime");
  const binary = await put(custom, "syncthing-v2.0.0/bin/syncthing"), elsewhere = await put(home, `${DOWNLOAD}/bin/syncthing`);
  assert.equal(await removeSyncthing(deps({ env: { JOINT_BOB_RUNTIME_DIR: custom } })), "done");
  assert.deepEqual([existsSync(binary), existsSync(elsewhere), syncthingRemoved(db)], [false, true, true]);
});

test("machines Joint Bob added to a Syncthing that stays leave it once they share no folder; the person's own stay", async (t) => {
  const node = (n: number) => `0000000${n}-aaaa-4bbb-8ccc-dddddddddddd`;
  const { db, daemon, logs, deps } = await setup(t, [
    { id: "joint-bob-alpha", devices: [{ deviceID: LOCAL }, { deviceID: "D-GONE" }] },
    { id: "photos", devices: [{ deviceID: LOCAL }, { deviceID: "D-SHARED" }] },
  ]);
  daemon.devices.push(
    { deviceID: "D-GONE", name: node(1) }, { deviceID: "D-SHARED", name: node(2) }, { deviceID: "D-OTHER", name: node(3).toUpperCase() },
    { deviceID: "D-PHONE", name: "Pixel 9a" }, { deviceID: "D-NAMELESS", name: "" },
  );
  daemon.devices[0] = { deviceID: LOCAL, name: node(9) };
  assert.equal(await removeSyncthing(deps()), "done");
  assert.deepEqual(daemon.devices.map((device) => device.deviceID), [LOCAL, "D-SHARED", "D-PHONE", "D-NAMELESS"],
    "only machines named after a node id that share no folder go: never this machine, one a folder is shared with, or one the person named");
  assert.equal(logs.at(-1), "Joint Bob took the 2 machine(s) it had added out of this machine's Syncthing; none of them shared a folder any more");
  assert.equal(syncthingRemoved(db), true);
});

test("machines are left alone when the folder list did not come from the running Syncthing, or it does not say which machine it is", async (t) => {
  const node = "00000001-aaaa-4bbb-8ccc-dddddddddddd";
  // Released by an earlier release; the daemon is down now, so only its configuration file says what it holds.
  const down = await setup(t);
  const config = await put(down.home, "config.xml", `<configuration><folder id="photos" label="Photos" path="/data/photos"><device id="D-SHARED"></device></folder><device id="D-SHARED" name="${node}"></device><gui><address>127.0.0.1:8384</address><apikey>k</apikey></gui></configuration>`);
  down.daemon.devices.push({ deviceID: "D-SHARED", name: node });
  down.daemon.answer = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }) });
  down.db.prepare("INSERT INTO file_sync_config(key, value) VALUES('syncthingRetired', '\"2026-11-10T19:45:50.550Z\"')").run();
  assert.equal(await removeSyncthing(down.deps({ stored: () => ({}), configPaths: [config] })), "done");
  assert.deepEqual([down.daemon.made("DELETE"), down.daemon.devices.length, syncthingRemoved(down.db)], [[], 2, true]);

  // A status without this machine's id: no machine can be told from it, so none goes.
  const mute = await setup(t);
  mute.daemon.devices.push({ deviceID: "D-GONE", name: node });
  mute.daemon.answer = (method, url) => url.pathname === "/rest/system/status" ? Response.json({}) : undefined;
  assert.equal(await removeSyncthing(mute.deps()), "done");
  assert.deepEqual([mute.daemon.made("DELETE"), syncthingRemoved(mute.db)], [[], true]);
  assert.equal(mute.logs.at(-1), "Joint Bob could not take the machines it had added out of this machine's Syncthing (Syncthing sent no device list); they share no folder with it any more");
});

test("the ignore files and folder markers Syncthing kept in Joint Bob's folders go, and the ignore files' text is kept", async (t) => {
  const { db, daemon, logs, home, deps } = await setup(t, [
    { id: "joint-bob-alpha", path: path.join("~", "legacy") },
    { id: "photos", path: "PLACEHOLDER" },
  ]);
  const root = (name: string) => path.join(home, "projects", name);
  daemon.folders[1].path = root("held");
  const backup = path.join(home, "removed-ignore-files.txt");
  // A project folder with both, one with a marker that holds something else, one the person's own Syncthing still syncs,
  // one outside Joint Bob's folders, and the folder of the Joint Bob share that leaves Syncthing in this very run.
  const alpha = await put(home, "projects/alpha/.stignore", "node_modules\n// mine\n*.secret"), note = await put(home, "projects/alpha/.stfolder/syncthing-folder-a1b2c3.txt", "note");
  const foreign = await put(home, "projects/beta/.stfolder/keep.me"), versions = await put(home, "projects/beta/.stversions/old.txt");
  const held = await put(home, "projects/held/.stignore", "theirs"), heldMarker = await put(home, "projects/held/.stfolder/syncthing-folder-x.txt");
  const outside = await put(home, "elsewhere/.stignore"), nested = await put(home, "projects/alpha/src/.stignore");
  const legacy = await put(home, "legacy/.stignore", "legacy rule\n"), emptyMarker = path.join(home, "legacy/.stfolder");
  await mkdir(emptyMarker);
  const directory = path.join(home, "projects/gamma/.stignore");
  await mkdir(directory, { recursive: true });

  assert.equal(await removeSyncthing(deps({ env: { HOME: home }, roots: () => [root("alpha"), root("beta"), root("held"), root("gamma"), root("missing")], backupFile: backup })), "done");
  assert.deepEqual([alpha, path.dirname(note), legacy, emptyMarker].map((file) => existsSync(file)), [false, false, false, false]);
  assert.deepEqual([foreign, versions, held, heldMarker, outside, nested, directory].map((file) => existsSync(file)), [true, true, true, true, true, true, true],
    "a marker with other content, old versions, a folder Syncthing still holds, and anything outside or below Joint Bob's folders stay");
  assert.equal(await readFile(backup, "utf8"), `// ${alpha}\nnode_modules\n// mine\n*.secret\n\n// ${legacy}\nlegacy rule\n\n`);
  assert.equal(logs.at(-1), `Joint Bob deleted 4 ignore file(s) and folder marker(s) that Syncthing kept in its folders; the text of the ignore files is kept in ${backup}`);
  assert.equal(syncthingRemoved(db), true);
});

test("a folder Syncthing still holds keeps its files when Joint Bob knows it by a link, by another spelling, or twice", async (t) => {
  const { db, daemon, home, deps } = await setup(t, [{ id: "photos", path: "PLACEHOLDER" }, { id: "notes", path: "PLACEHOLDER" }]);
  // The person's Syncthing names the real folders; Joint Bob's projects reach them through links (a project on another disk).
  const real = await put(home, "disk/shared/.stignore", "theirs"), other = await put(home, "disk/notes/.stignore", "theirs too");
  await mkdir(path.join(home, "projects"), { recursive: true });
  await symlink(path.join(home, "disk/shared"), path.join(home, "projects/linked"));
  daemon.folders[0].path = path.join(home, "disk/shared");
  // And the reverse: Syncthing was given the link, Joint Bob the folder behind it.
  await symlink(path.join(home, "disk/notes"), path.join(home, "notes-link"));
  daemon.folders[1].path = path.join(home, "notes-link");
  const free = await put(home, "disk/free/.stignore", "node_modules\n");
  await symlink(path.join(home, "disk/free"), path.join(home, "projects/free"));
  const backup = path.join(home, "backup.txt");
  assert.equal(await removeSyncthing(deps({ backupFile: backup, roots: () => [path.join(home, "projects/linked"), `${path.join(home, "projects/linked")}/`, path.join(home, "disk/notes"), path.join(home, "projects/free"), path.join(home, "disk/free")] })), "done");
  assert.deepEqual([existsSync(real), existsSync(other), existsSync(free)], [true, true, false]);
  assert.equal(await readFile(backup, "utf8"), `// ${path.join(home, "projects/free/.stignore")}\nnode_modules\n\n`, "a folder reached by two paths is cleaned once, under the first");
  assert.equal(syncthingRemoved(db), true);
});

test("a Joint Bob folder inside a folder Syncthing still holds keeps its files: there they are files that person syncs", async (t) => {
  const { db, daemon, home, deps } = await setup(t, [{ id: "code", path: "PLACEHOLDER" }]);
  daemon.folders[0].path = path.join(home, "code");
  const inside = await put(home, "code/app/.stignore"), marker = await put(home, "code/app/.stfolder/syncthing-folder-1.txt"), deep = await put(home, "code/team/app/.stignore");
  const beside = await put(home, "code-review/.stignore"), around = await put(home, ".stignore");
  assert.equal(await removeSyncthing(deps({ roots: () => [path.join(home, "code/app"), path.join(home, "code/team/app"), path.join(home, "code-review"), home] })), "done");
  assert.deepEqual([inside, marker, deep].map((file) => existsSync(file)), [true, true, true]);
  assert.deepEqual([beside, around].map((file) => existsSync(file)), [false, false], "a folder that only starts with the same name, and one around the held folder, are Joint Bob's own");
  assert.equal(syncthingRemoved(db), true);
});

test("a machine an earlier release already took the folders from still has the rest removed, once", async (t) => {
  const fixture = await setup(t, [{ id: "photos", path: "/data/photos" }]);
  const { daemon, home, deps } = fixture;
  fixture.db.prepare("INSERT INTO file_sync_config(key, value) VALUES('syncthingRetired', '\"2026-11-10T19:45:50.550Z\"')").run();
  daemon.devices.push({ deviceID: "D-GONE", name: "00000001-aaaa-4bbb-8ccc-dddddddddddd" });
  const binary = await put(home, `${DOWNLOAD}/bin/syncthing`), ignore = await put(home, "projects/alpha/.stignore");
  assert.equal(syncthingReleased(fixture.db), true);
  assert.equal(await removeSyncthing(deps({ roots: () => [path.join(home, "projects/alpha")] })), "done");
  assert.deepEqual([existsSync(binary), existsSync(ignore), daemon.devices.length, fixture.forgotten, syncthingRemoved(fixture.db)], [false, false, 1, 1, true]);
  assert.deepEqual(daemon.folders.map((folder) => folder.id), ["photos"], "its own folders are never listed for removal again");
  // For good: nothing is asked at the next start.
  fixture.restart();
  const before = daemon.requests.length;
  assert.equal(await removeSyncthing(deps()), "done");
  assert.equal(daemon.requests.length, before);
});

test("the service an earlier installer set up is a trace of a Syncthing too: with nothing to ask and no configuration found, nothing is done", async (t) => {
  // Its configuration is in a folder Joint Bob does not know of, and may list the person's own folders.
  const { db, home, logs, commands, deps } = await setup(t);
  const unit = await put(home, UNIT), binary = await put(home, `${DOWNLOAD}/bin/syncthing`), ignore = await put(home, "projects/alpha/.stignore");
  const options = { stored: () => ({}), roots: () => [path.join(home, "projects/alpha")] };
  assert.equal(await removeSyncthing(deps(options)), "idle");
  assert.deepEqual([syncthingReleased(db), existsSync(unit), existsSync(binary), existsSync(ignore), commands, logs], [false, true, true, true, [], [UNREACHABLE]]);
  // The same on a machine an earlier release marked as let go: what the service still syncs is not known.
  db.prepare("INSERT INTO file_sync_config(key, value) VALUES('syncthingRetired', '\"2026-11-10T19:45:50.550Z\"')").run();
  assert.equal(await removeSyncthing(deps(options)), "done");
  assert.deepEqual([syncthingRemoved(db), existsSync(unit), existsSync(binary), existsSync(ignore), commands], [false, true, true, true, []]);
  assert.equal(logs.at(-1), "Joint Bob cannot tell what the Syncthing on this machine still syncs, so what it had installed for it stays for now; it asks again at its next start");
});

test("a Syncthing that is down, with no configuration found, is not taken for one that holds nothing", async (t) => {
  const fixture = await setup(t);
  const { daemon, home, deps } = fixture;
  fixture.db.prepare("INSERT INTO file_sync_config(key, value) VALUES('syncthingRetired', '\"2026-11-10T19:45:50.550Z\"')").run();
  const binary = await put(home, `${DOWNLOAD}/bin/syncthing`), ignore = await put(home, "projects/alpha/.stignore");
  daemon.answer = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }) });
  const options = { roots: () => [path.join(home, "projects/alpha")] };
  assert.equal(await removeSyncthing(deps(options)), "done");
  assert.deepEqual([existsSync(binary), existsSync(ignore), syncthingRemoved(fixture.db), fixture.forgotten], [true, true, false, 0]);
  // Once it answers, at a later start, the rest goes.
  daemon.answer = undefined;
  fixture.restart();
  assert.equal(await removeSyncthing(deps(options)), "done");
  assert.deepEqual([existsSync(binary), existsSync(ignore), syncthingRemoved(fixture.db), fixture.forgotten], [false, false, true, 1]);
});

test("Syncthing's configuration is also looked for in the folder its environment names", async (t) => {
  const { db, daemon, home, deps } = await setup(t, [{ id: "joint-bob-alpha" }]);
  for (const [name, env] of [["sthome", { STHOME: path.join(home, "sthome") }], ["state", { XDG_STATE_HOME: path.join(home, "state") }], ["config", { XDG_CONFIG_HOME: path.join(home, "config") }]] as const) {
    const folder = name === "sthome" ? path.join(home, "sthome") : path.join(home, name, "syncthing");
    await put(folder, "config.xml", `<configuration><gui><address>127.0.0.1:8384</address><apikey>key-${name}</apikey></gui></configuration>`);
    daemon.requests.length = 0;
    daemon.folders = [{ id: "joint-bob-alpha" }];
    db.prepare("DELETE FROM file_sync_config").run();
    assert.equal(await removeSyncthing(deps({ stored: () => ({}), configPaths: undefined, env })), "done", name);
    assert.deepEqual([daemon.requests[0]?.key, daemon.folders], [`key-${name}`, []], name);
    await rm(folder, { recursive: true });
  }
});

test("a Syncthing that runs but does not answer leaves everything for a later start", async (t) => {
  const fixture = await setup(t);
  const { daemon, home, commands, deps } = fixture;
  fixture.db.prepare("INSERT INTO file_sync_config(key, value) VALUES('syncthingRetired', '\"2026-11-10T19:45:50.550Z\"')").run();
  const unit = await put(home, UNIT), binary = await put(home, `${DOWNLOAD}/bin/syncthing`), ignore = await put(home, "projects/alpha/.stignore");
  daemon.answer = () => new Response("busy", { status: 503 });
  assert.equal(await removeSyncthing(deps({ roots: () => [path.join(home, "projects/alpha")] })), "done");
  assert.deepEqual([existsSync(unit), existsSync(binary), existsSync(ignore), commands, syncthingRemoved(fixture.db)], [true, true, true, [], false]);
  daemon.answer = undefined;
  fixture.restart();
  assert.equal(await removeSyncthing(deps({ roots: () => [path.join(home, "projects/alpha")] })), "done");
  assert.deepEqual([existsSync(unit), existsSync(binary), existsSync(ignore), syncthingRemoved(fixture.db)], [false, false, false, true]);
});

test("a stopped Syncthing's configuration file says which folders are still the person's", async (t) => {
  const { db, home, commands, deps } = await setup(t);
  db.prepare("INSERT INTO file_sync_config(key, value) VALUES('syncthingRetired', '\"2026-11-10T19:45:50.550Z\"')").run();
  const held = path.join(home, "projects/held &amp; kept");
  const config = await put(home, "config.xml", `<configuration version="37">\n  <folder id="photos" label="Photos &amp; more" path="${held}" type="sendreceive">\n    <device id="D1"></device>\n  </folder>\n  <defaults><folder id="" label="" path="~"></folder></defaults>\n</configuration>`);
  const unit = await put(home, UNIT), binary = await put(home, `${DOWNLOAD}/bin/syncthing`);
  const kept = await put(home, "projects/held & kept/.stignore"), gone = await put(home, "projects/alpha/.stignore");
  const logs: string[] = [];
  assert.equal(await removeSyncthing(deps({ stored: () => ({}), configPaths: [config], log: (message) => { logs.push(message); }, roots: () => [path.join(home, "projects/held & kept"), path.join(home, "projects/alpha"), home] })), "done");
  assert.deepEqual([commands, existsSync(unit), existsSync(binary), existsSync(kept), existsSync(gone)], [[], true, true, true, false]);
  assert.equal(logs[0], "Joint Bob no longer uses the Syncthing it installed on this machine, and left it running: it still syncs 1 folder(s) that are not Joint Bob's, the first being “Photos & more”");
  assert.equal(syncthingRemoved(db), true);
});

test("the take-over's waiting text names what it waits for", () => {
  assert.equal(WAITING_FOR_SYNCTHING, "Waiting for Syncthing on this machine to let go of Joint Bob's folders");
});
