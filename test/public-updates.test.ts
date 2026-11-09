import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const publicApi = "https://api.github.com/repos/germanilia/joint-bob-releases";
const publicDownloads = "https://github.com/germanilia/joint-bob-releases/releases/latest/download";

test("the default feed checks and downloads anonymously, ignoring old tokens and cached private releases", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "public-updates-"));
  const saved = { JOINT_BOB_DATA_DIR: process.env.JOINT_BOB_DATA_DIR, JOINT_BOB_RELEASE_API: process.env.JOINT_BOB_RELEASE_API };
  process.env.JOINT_BOB_DATA_DIR = directory;
  delete process.env.JOINT_BOB_RELEASE_API;
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  const archive = Buffer.from("synthetic public release");
  const checksum = `${createHash("sha256").update(archive).digest("hex")}  joint-bob.tar.gz\n`;
  const payload = { tag_name: "v99.0.0", assets: [
    { name: "joint-bob.tar.gz", url: `${publicApi}/releases/assets/1` },
    { name: "joint-bob.tar.gz.sha256", url: `${publicApi}/releases/assets/2` },
  ] };
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(new Headers(options.headers).has("Authorization"), false);
    requests.push(url);
    if (url === `${publicApi}/releases/latest` || url === `${publicApi}/releases/tags/v99.0.0`) return Response.json(payload);
    if (url === `${publicApi}/releases/assets/1`) return new Response(archive);
    if (url === `${publicApi}/releases/assets/2`) return new Response(checksum);
    throw new Error(`Unexpected release request: ${url}`);
  });
  const updater = await import(`../src/updater.ts?public=${Date.now()}`);
  const first = await updater.checkForLatestRelease(true);
  assert.equal(first.error, null);
  assert.equal(first.release?.version, "99.0.0");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(directory, "node.db"));
  t.after(() => db.close());
  for (const oldApi of ["https://api.github.com/repos/germanilia/joint-bob", "https://api.github.com/repos/iliagerman/joint-bob"]) {
    db.prepare("UPDATE update_preferences SET latest_json = ?").run(JSON.stringify({ ...first.release, archiveUrl: `${oldApi}/releases/assets/1`, checksumUrl: `${oldApi}/releases/assets/2` }));
    assert.equal(updater.updateStatusView().latest.release, null, "old feed cache cannot offer an old-repository download");
  }
  await writeFile(path.join(directory, "github-update-token"), "invalid expired token\n");
  assert.equal((await updater.checkForLatestRelease(false)).error, null, "a fresh cache from another feed must be refreshed without reading an old credential");
  const release = await updater.releaseForVersion("99.0.0");
  const { downloadFile, parseChecksum, sha256Hex } = await import("../scripts/self-update.mjs");
  assert.equal(sha256Hex(await downloadFile(release.archiveUrl, directory)), parseChecksum(await downloadFile(release.checksumUrl, directory)));
  assert.deepEqual(requests, [
    `${publicApi}/releases/latest`, `${publicApi}/releases/latest`, `${publicApi}/releases/tags/v99.0.0`,
    `${publicApi}/releases/assets/1`, `${publicApi}/releases/assets/2`,
  ]);
});

test("the standalone installer downloads the public feed and verifies its package without GitHub credentials", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "public-installer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = path.join(root, "package");
  const bin = path.join(root, "fake-bin");
  await mkdir(path.join(pkg, "scripts"), { recursive: true });
  await mkdir(path.join(pkg, "bin"));
  await mkdir(bin);
  await writeFile(path.join(pkg, "package.json"), "{}\n");
  await writeFile(path.join(pkg, "scripts/install-service.sh"), "#!/bin/sh\nexit 0\n");
  await writeFile(path.join(pkg, "scripts/install-node-runtime.sh"), "#!/bin/sh\nexit 0\n");
  await writeFile(path.join(pkg, "bin/joint-bob.mjs"), 'import { writeFileSync } from "node:fs"; writeFileSync(process.env.TEST_MARKER, process.argv[2]);\n');
  const archive = path.join(root, "release.tar.gz");
  await execute("tar", ["-czf", archive, "-C", root, "package"]);
  await writeFile(`${archive}.sha256`, `${createHash("sha256").update(await readFile(archive)).digest("hex")}  joint-bob.tar.gz\n`);
  await copyFile("scripts/install.sh", path.join(root, "install.sh"));
  await writeFile(path.join(bin, "curl"), '#!/bin/sh\nset -eu\nprintf "%s\\n" "$2" >> "$TEST_REQUESTS"\ncase "$2" in *.sha256) cp "$TEST_ARCHIVE.sha256" "$4" ;; *) cp "$TEST_ARCHIVE" "$4" ;; esac\n', { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: path.join(root, "home"), PATH: `${bin}:${process.env.PATH}`, JOINT_BOB_INSTALL_DIR: path.join(root, "installed/app"), TEST_ARCHIVE: archive, TEST_REQUESTS: path.join(root, "requests"), TEST_MARKER: path.join(root, "installed-marker") };
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "JOINT_BOB_REF", "MASTER_BOB_REF"]) delete env[name];
  await execute("bash", [path.join(root, "install.sh")], { cwd: root, env });
  assert.equal(await readFile(path.join(root, "installed-marker"), "utf8"), "install");
  assert.deepEqual((await readFile(path.join(root, "requests"), "utf8")).trim().split("\n"), [`${publicDownloads}/joint-bob.tar.gz.sha256`, `${publicDownloads}/joint-bob.tar.gz`]);
});
