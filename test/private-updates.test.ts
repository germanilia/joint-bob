import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const apiBase = "https://api.github.com/repos/germanilia/joint-bob";
const fakeToken = "github_pat_fixture_only";

async function fixture(t: any) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "private-updates-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const auth = await import("../scripts/release-auth.mjs");
  return { directory, ...auth };
}

test("update credentials are saved owner-only and never appear in CLI output", async (t) => {
  const { directory, saveReleaseToken } = await fixture(t);
  saveReleaseToken(directory, fakeToken);
  const file = path.join(directory, "github-update-token");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const child = spawn(process.execPath, ["bin/joint-bob.mjs", "update-token"], {
    env: { ...process.env, JOINT_BOB_DATA_DIR: directory }, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  child.stdin.end(`${fakeToken}_rotated\n`);
  assert.equal(await new Promise(resolve => child.on("close", resolve)), 0, output);
  assert.equal((await readFile(file, "utf8")).trim(), `${fakeToken}_rotated`);
  assert.doesNotMatch(output, /github_pat_fixture/);
});

test("invalid update credentials do not overwrite the existing token", async (t) => {
  const { directory, saveReleaseToken } = await fixture(t);
  saveReleaseToken(directory, fakeToken);
  for (const token of ["", "has whitespace", "secret\nInjected: header", "x".repeat(4097)]) {
    assert.throws(() => saveReleaseToken(directory, token), /Invalid GitHub update token/);
  }
  assert.equal((await readFile(path.join(directory, "github-update-token"), "utf8")).trim(), fakeToken);
});

test("private metadata requests authenticate and do not follow redirects", async (t) => {
  const { directory, saveReleaseToken, fetchReleaseResource } = await fixture(t);
  saveReleaseToken(directory, fakeToken);
  const requests: any[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: any) => {
    requests.push({ url, ...options });
    return new Response("{}", { status: 200 });
  });
  await fetchReleaseResource(`${apiBase}/releases/latest`, directory, "application/vnd.github+json", 1000);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.Authorization, `Bearer ${fakeToken}`);
  assert.equal(requests[0].redirect, "manual");
});

test("private downloads use octet-stream and strip credentials on the CDN redirect", async (t) => {
  const { directory, saveReleaseToken, fetchReleaseResource } = await fixture(t);
  saveReleaseToken(directory, fakeToken);
  const requests: any[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: any) => {
    requests.push({ url, ...options });
    return requests.length === 1
      ? new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/fixture/archive?signature=fake" } })
      : new Response("archive");
  });
  const response = await fetchReleaseResource(`${apiBase}/releases/assets/123`, directory, "application/octet-stream", 1000);
  assert.equal(await response.text(), "archive");
  assert.equal(requests[0].headers.Authorization, `Bearer ${fakeToken}`);
  assert.equal(requests[0].headers.Accept, "application/octet-stream");
  assert.equal(requests[1].headers.Authorization, undefined);
  assert.equal(requests[1].redirect, "error");
});

test("credentials never accompany unrelated downloads", async (t) => {
  const { directory, saveReleaseToken, fetchReleaseResource } = await fixture(t);
  saveReleaseToken(directory, fakeToken);
  const headers: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: any) => {
    headers.push(options.headers);
    return new Response("fixture");
  });
  for (const url of ["https://example.invalid/archive", "https://api.github.com/repos/other/repo/releases/assets/1"]) {
    await fetchReleaseResource(url, directory, "application/octet-stream", 1000);
  }
  assert.ok(headers.every(header => header.Authorization === undefined));
});

test("missing private credentials stop before network access", async (t) => {
  const { directory, fetchReleaseResource } = await fixture(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("{}"));
  await assert.rejects(fetchReleaseResource(`${apiBase}/releases/latest`, directory, "application/vnd.github+json", 1000), /update-token/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("private download redirects reject non-GitHub destinations and insecure transport", async (t) => {
  const { directory, saveReleaseToken, fetchReleaseResource } = await fixture(t);
  saveReleaseToken(directory, fakeToken);
  for (const location of ["https://example.invalid/steal", "http://release-assets.githubusercontent.com/archive"]) {
    const fetch = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 302, headers: { location } }));
    await assert.rejects(fetchReleaseResource(`${apiBase}/releases/assets/1`, directory, "application/octet-stream", 1000), /Unexpected release redirect/);
    assert.equal(fetch.mock.callCount(), 1);
    fetch.mock.restore();
  }
});

test("a revoked credential is not retried against the public repository", async (t) => {
  const { directory, saveReleaseToken, fetchReleaseResource } = await fixture(t);
  saveReleaseToken(directory, fakeToken);
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("Unauthorized", { status: 401 }));
  const response = await fetchReleaseResource(`${apiBase}/releases/latest`, directory, "application/vnd.github+json", 1000);
  assert.equal(response.status, 401);
  assert.equal(fetch.mock.callCount(), 1);
});

test("GitHub payloads select repository-scoped API asset URLs, not public download URLs", async () => {
  const { validateReleasePayload } = await import("../src/updater.js");
  const payload = {
    tag_name: "v9.9.9", assets: [
      { name: "joint-bob.tar.gz", url: `${apiBase}/releases/assets/1`, browser_download_url: "https://example.invalid/archive" },
      { name: "joint-bob.tar.gz.sha256", url: `${apiBase}/releases/assets/2`, browser_download_url: "https://example.invalid/checksum" },
    ],
  };
  assert.equal(validateReleasePayload(payload, apiBase).archiveUrl, `${apiBase}/releases/assets/1`);
  payload.assets[0].url = "https://api.github.com/repos/other/repo/releases/assets/1";
  assert.throws(() => validateReleasePayload(payload, apiBase), /missing.*assets/);
});

test("hourly automatic checks use the private feed and ignore cached public releases", async (t) => {
  const { directory, saveReleaseToken } = await fixture(t);
  saveReleaseToken(directory, fakeToken);
  const previous = { data: process.env.JOINT_BOB_DATA_DIR, release: process.env.JOINT_BOB_RELEASE, api: process.env.JOINT_BOB_RELEASE_API };
  process.env.JOINT_BOB_DATA_DIR = directory;
  process.env.JOINT_BOB_RELEASE = "a".repeat(40);
  delete process.env.JOINT_BOB_RELEASE_API;
  t.after(() => {
    for (const [name, value] of Object.entries({ JOINT_BOB_DATA_DIR: previous.data, JOINT_BOB_RELEASE: previous.release, JOINT_BOB_RELEASE_API: previous.api })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const updater = await import(`../src/updater.ts?private=${Date.now()}`);
  updater.setAutoUpdate(true);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(directory, "node.db"));
  t.after(() => db.close());
  const old = { version: "9.9.9", archiveUrl: "https://github.com/iliagerman/joint-bob/releases/download/v9.9.9/joint-bob.tar.gz" };
  db.prepare("UPDATE update_preferences SET latest_json = ?, latest_version = ?, latest_checked_at = ?").run(JSON.stringify(old), old.version, new Date(Date.now() - 61 * 60_000).toISOString());
  assert.equal(updater.updateStatusView().latest.release, null, "old public cache must not survive a feed change");
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("Unauthorized", { status: 401 }));
  let tick: () => void = () => {};
  t.mock.method(globalThis, "setTimeout", () => ({ unref() {} }) as any);
  t.mock.method(globalThis, "setInterval", (callback: () => void, milliseconds: number) => {
    assert.equal(milliseconds, 60 * 60_000);
    tick = callback;
    return { unref() {} } as any;
  });
  updater.startUpdateScheduler();
  tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetch.mock.callCount(), 1, "a check 61 minutes ago is due, not delayed six hours");
  assert.match(updater.updateStatusView().latest.error ?? "", /401/);
  db.prepare("UPDATE update_preferences SET latest_json = ?, latest_version = ?").run(JSON.stringify({ ...old, archiveUrl: `${apiBase}/releases/assets/1`, checksumUrl: `${apiBase}/releases/assets/2` }), old.version);
  assert.equal(updater.updateStatusView().latest.release, null, "a cached version must not hide an authentication error in the Updates panel");
  assert.equal(updater.updateStatusView().updateAvailable, false);
  db.prepare("UPDATE update_preferences SET latest_checked_at = ?").run(new Date(Date.now() - 59 * 60_000).toISOString());
  tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetch.mock.callCount(), 2, "startup/check completion timing must not turn an hourly timer into a two-hour check");
});
