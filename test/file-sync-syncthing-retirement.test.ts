import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { ensureControlSchema } from "../src/file-sync/control.js";
import { retireSyncthing, syncthingRetired, type RetirementDeps } from "../src/file-sync/syncthing-retirement.js";

/* The one-time clean-up of the folders an older release gave Syncthing (syncthing-retirement.ts).
   Every request goes to a stand-in `fetch`: no daemon is asked, and this machine's own Syncthing
   configuration is never read (configPaths and env are always given). */

const URL_ = "http://127.0.0.1:8384";
const KEY = "stored-key";

interface Folder { id: string; label?: string }

/** A Syncthing that holds `folders`; a DELETE removes one unless its id is in `stuck`. */
class Daemon {
  requests: Array<{ method: string; url: string; key: string | null }> = [];
  stuck = new Set<string>();
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
    if (method === "DELETE" && url.pathname.startsWith("/rest/config/folders/")) {
      const id = decodeURIComponent(url.pathname.slice("/rest/config/folders/".length));
      if (!this.stuck.has(id)) this.folders = this.folders.filter((folder) => folder.id !== id);
      return new Response("");
    }
    return new Response("not found", { status: 404 });
  };

  made(method: string): string[] { return this.requests.filter((request) => request.method === method).map((request) => new URL(request.url).pathname); }
}

function setup(t: TestContext, folders: Folder[] = []): { db: DatabaseSync; daemon: Daemon; logs: string[]; deps: (overrides?: Partial<RetirementDeps>) => RetirementDeps } {
  const db = new DatabaseSync(":memory:");
  ensureControlSchema(db);
  t.after(() => db.close());
  const daemon = new Daemon(folders);
  const logs: string[] = [];
  return {
    db, daemon, logs,
    deps: (overrides = {}) => ({ db, stored: () => ({ endpoint: URL_, apiKey: KEY }), configPaths: [], env: {}, fetch: daemon.fetch, log: (message) => { logs.push(message); }, ...overrides }),
  };
}

const UNREACHABLE = "Joint Bob cannot ask the Syncthing set up on this machine for its folders. If it still holds folders named after Joint Bob projects, remove them there: built-in sync moves those files now";

const refused = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8384"), { code: "ECONNREFUSED" }) });

test("a machine with no connection to a Syncthing anywhere has nothing to let go of: done, and marked", async (t) => {
  const { db, daemon, deps } = setup(t);
  assert.equal(syncthingRetired(db), false);
  assert.equal(await retireSyncthing(deps({ stored: () => ({}) })), "done");
  assert.equal(syncthingRetired(db), true);
  assert.deepEqual(daemon.requests, []);
  // The same with no `stored` at all.
  const bare = setup(t);
  assert.equal(await retireSyncthing(bare.deps({ stored: undefined })), "done");
  assert.deepEqual([syncthingRetired(bare.db), bare.daemon.requests, bare.logs], [true, [], []]);
});

test("half a connection is a trace of a Syncthing Joint Bob cannot ask: idle, not marked, nothing requested, one line logged", async (t) => {
  for (const partial of [() => ({ endpoint: URL_ }), () => ({ apiKey: KEY })]) {
    const { db, daemon, logs, deps } = setup(t, [{ id: "joint-bob-alpha" }]);
    assert.equal(await retireSyncthing(deps({ stored: partial })), "idle");
    assert.deepEqual([syncthingRetired(db), daemon.requests, daemon.folders.length, logs], [false, [], 1, [UNREACHABLE]]);
  }
  for (const env of [{ JOINT_BOB_SYNCTHING_URL: URL_ }, { JOINT_BOB_SYNCTHING_API_KEY: KEY }]) {
    const { db, daemon, logs, deps } = setup(t);
    assert.equal(await retireSyncthing(deps({ stored: () => ({}), env })), "idle");
    assert.deepEqual([syncthingRetired(db), daemon.requests, logs], [false, [], [UNREACHABLE]]);
  }
});

test("only the folders Joint Bob made are taken out; the person's own stay, and it is done once", async (t) => {
  const own: Folder[] = [{ id: "photos", label: "Photos" }, { id: "joint-bobby", label: "Looks alike" }, { id: "my-joint-bob-notes" }];
  const { db, daemon, logs, deps } = setup(t, [
    { id: "joint-bob-alpha", label: "Alpha" }, own[0], { id: "joint-bob-tickets-alpha" }, own[1], { id: "joint-bob-worktrees/alpha b" }, own[2],
  ]);
  assert.equal(await retireSyncthing(deps()), "done");
  assert.deepEqual(daemon.made("DELETE"), ["/rest/config/folders/joint-bob-alpha", "/rest/config/folders/joint-bob-tickets-alpha", "/rest/config/folders/joint-bob-worktrees%2Falpha%20b"]);
  assert.deepEqual(daemon.folders, own, "folders the person made are untouched");
  assert.deepEqual(daemon.made("GET"), ["/rest/config/folders", "/rest/config/folders"], "a fresh list confirms they are gone");
  assert.ok(daemon.requests.every((request) => request.key === KEY && request.url.startsWith(`${URL_}/rest/config/folders`)), "nothing else is asked of the daemon");
  assert.equal(syncthingRetired(db), true);
  assert.deepEqual(logs, ["Joint Bob took its 3 folder(s) out of this machine's Syncthing; built-in sync moves those files now, and the files stay where they are"]);
  // Marked: a second call asks nothing, even if such a folder were there again.
  daemon.folders.push({ id: "joint-bob-later" });
  const before = daemon.requests.length;
  assert.equal(await retireSyncthing(deps()), "done");
  assert.equal(daemon.requests.length, before);
  assert.equal(daemon.folders.length, 4);
});

test("a Syncthing that holds none of Joint Bob's folders is done after one list", async (t) => {
  const { db, daemon, logs, deps } = setup(t, [{ id: "photos" }]);
  assert.equal(await retireSyncthing(deps()), "done");
  assert.deepEqual([daemon.made("GET"), daemon.made("DELETE"), logs, syncthingRetired(db)], [["/rest/config/folders"], [], [], true]);
});

test("a folder the daemon does not let go of keeps it waiting, unmarked, and the next call tries again", async (t) => {
  const { db, daemon, logs, deps } = setup(t, [{ id: "joint-bob-alpha", label: " Alpha " }, { id: "joint-bob-beta" }, { id: "photos" }]);
  daemon.stuck.add("joint-bob-alpha");
  assert.equal(await retireSyncthing(deps()), "waiting");
  assert.equal(syncthingRetired(db), false);
  assert.deepEqual(daemon.folders.map((folder) => folder.id), ["joint-bob-alpha", "photos"]);
  assert.deepEqual(logs, ["Syncthing on this machine still holds 1 Joint Bob folder(s), the first being “Alpha”; built-in sync waits for it to let go"]);
  // A DELETE the daemon refuses outright reads the same: the fresh list decides.
  daemon.answer = (method) => method === "DELETE" ? new Response("no", { status: 500 }) : undefined;
  assert.equal(await retireSyncthing(deps()), "waiting");
  assert.equal(syncthingRetired(db), false);
  daemon.answer = undefined;
  daemon.stuck.clear();
  assert.equal(await retireSyncthing(deps()), "done");
  assert.deepEqual([daemon.folders.map((folder) => folder.id), syncthingRetired(db)], [["photos"], true]);
});

test("no daemon listening is idle, not done: nothing writes now, and it is asked again at the next start", async (t) => {
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "EADDRNOTAVAIL"]) {
    const { db, daemon, logs, deps } = setup(t, [{ id: "joint-bob-alpha" }]);
    daemon.answer = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
    assert.equal(await retireSyncthing(deps()), "idle", code);
    assert.deepEqual([syncthingRetired(db), daemon.requests.length, logs], [false, 1, []], code);
    // Running again later: its folders go then.
    daemon.answer = undefined;
    assert.equal(await retireSyncthing(deps()), "done", code);
    assert.deepEqual(daemon.folders, [], code);
  }
  // Node's own errors carry the code on the error itself.
  const direct = setup(t);
  direct.daemon.answer = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  assert.equal(await retireSyncthing(direct.deps()), "idle");
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
    const { db, daemon, logs, deps } = setup(t, [{ id: "joint-bob-alpha" }]);
    daemon.answer = answer;
    assert.equal(await retireSyncthing(deps()), "waiting", name);
    assert.deepEqual([syncthingRetired(db), daemon.made("DELETE")], [false, []], name);
    assert.equal(logs.length, 1, name);
    assert.match(logs[0], /^Joint Bob could not ask this machine's Syncthing for its folders \(.+\); projects it may still sync wait for built-in sync until it answers$/, name);
  }
  assert.match(await (async () => {
    const { daemon, logs, deps } = setup(t);
    daemon.answer = answers[0][1];
    await retireSyncthing(deps());
    return logs[0];
  })(), /\(Syncthing answered 401\)/);
});

test("the fresh list failing after the deletes is waiting, not done", async (t) => {
  const { db, daemon, deps } = setup(t, [{ id: "joint-bob-alpha" }]);
  let lists = 0;
  daemon.answer = (method) => method === "GET" && ++lists === 2 ? new Response("oops", { status: 500 }) : undefined;
  assert.equal(await retireSyncthing(deps()), "waiting");
  assert.equal(syncthingRetired(db), false);
  assert.deepEqual(daemon.made("DELETE"), ["/rest/config/folders/joint-bob-alpha"]);
  daemon.answer = undefined;
  assert.equal(await retireSyncthing(deps()), "done");
});

test("a Syncthing on another machine is never called, and is not counted as let go: idle, not marked", async (t) => {
  for (const endpoint of ["http://192.168.1.20:8384", "https://syncthing.example.com", "http://100.101.2.3:8384", "http://127.0.0.1.example.com:8384", "not a url"]) {
    const { db, daemon, logs, deps } = setup(t, [{ id: "joint-bob-alpha" }]);
    assert.equal(await retireSyncthing(deps({ stored: () => ({ endpoint, apiKey: KEY }) })), "idle", endpoint);
    assert.deepEqual([daemon.requests, daemon.folders.length, syncthingRetired(db), logs], [[], 1, false, [UNREACHABLE]], endpoint);
  }
  // Through the environment too.
  const { db, daemon, deps } = setup(t, [{ id: "joint-bob-alpha" }]);
  assert.equal(await retireSyncthing(deps({ stored: () => ({}), env: { JOINT_BOB_SYNCTHING_URL: "http://10.0.0.5:8384", JOINT_BOB_SYNCTHING_API_KEY: KEY } })), "idle");
  assert.deepEqual([daemon.requests, syncthingRetired(db)], [[], false]);
  // Every spelling of this machine is.
  for (const endpoint of ["http://localhost:8384", "http://[::1]:8384", "https://127.0.0.1:8384"]) {
    const local = setup(t, [{ id: "joint-bob-alpha" }]);
    assert.equal(await retireSyncthing(local.deps({ stored: () => ({ endpoint, apiKey: KEY }) })), "done", endpoint);
    assert.deepEqual([local.daemon.folders, new URL(local.daemon.requests[0].url).origin], [[], new URL(endpoint).origin], endpoint);
  }
});

test("the connection comes from the stored settings, the environment, or Syncthing's own config.xml", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "syncthing-retirement-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = async (name: string, gui: string): Promise<string> => {
    const file = path.join(dir, name);
    await writeFile(file, `<configuration version="37">\n  <folder id="joint-bob-alpha" label="Alpha" path="/x"></folder>\n  ${gui}\n</configuration>\n`);
    return file;
  };
  const asked = async (overrides: Partial<RetirementDeps>): Promise<{ outcome: string; origin?: string; key?: string | null; emptied: boolean; marked?: boolean; logs?: string[] }> => {
    const { db, daemon, logs, deps } = setup(t, [{ id: "joint-bob-alpha" }]);
    const outcome = await retireSyncthing(deps({ stored: () => ({}), ...overrides }));
    const first = daemon.requests[0];
    return { outcome, ...(first ? { origin: new URL(first.url).origin, key: first.key } : {}), emptied: syncthingRetired(db) && daemon.folders.length === 0, ...(first ? {} : { marked: syncthingRetired(db), logs }) };
  };

  assert.deepEqual(await asked({ stored: () => ({ endpoint: "http://127.0.0.1:8385", apiKey: "from-settings" }) }), { outcome: "done", origin: "http://127.0.0.1:8385", key: "from-settings", emptied: true });
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
