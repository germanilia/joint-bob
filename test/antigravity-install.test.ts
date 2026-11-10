import assert from 'node:assert/strict';
import test from 'node:test';
import { antigravityRelease, installManagedAntigravity, managedAntigravityExecutable } from '../src/antigravity-install.js';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import adapter from '../src/harnesses/antigravity.harness.js';
import { runHarnessUpdates } from '../src/harness-updater.js';
const execute = promisify(execFile);

test('Antigravity selects official platform assets and requires a checksum', () => {
  for (const platform of ['darwin', 'linux'] as const) for (const arch of ['arm64', 'x64']) {
    const name = `agy_cli_${platform === 'darwin' ? 'mac' : 'linux'}_${arch}.tar.gz`;
    const asset = { name, browser_download_url: `https://github.com/google-antigravity/antigravity-cli/releases/download/1.5.5/${name}`, digest: `sha256:${'a'.repeat(64)}` };
    const release = { tag_name: '1.5.5', assets: [asset] };
    assert.equal(antigravityRelease(release, platform, arch).sha256, 'a'.repeat(64));
    assert.throws(() => antigravityRelease({ ...release, assets: [{ ...asset, digest: null }] }, platform, arch));
    assert.throws(() => antigravityRelease({ ...release, assets: [{ ...asset, browser_download_url: 'https://example.com/binary' }] }, platform, arch));
  }
  assert.throws(() => antigravityRelease({}, 'win32', 'x64'), /Unsupported/);
});

test('managed Antigravity verifies downloads, preserves the old binary and repairs missing installations through the updater', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-install-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = '#!/bin/sh\ncase "$*" in\n--version) echo "1.5.5";;\n"acp --help") echo "ACP";;\n*) exit 19;;\nesac\n';
  await writeFile(path.join(root, 'antigravity'), script, { mode: 0o755 });
  const archive = path.join(root, 'fixture.tar.gz');
  await execute('tar', ['-czf', archive, '-C', root, 'antigravity']);
  const bytes = await readFile(archive);
  const name = `agy_cli_${process.platform === 'darwin' ? 'mac' : 'linux'}_${process.arch}.tar.gz`;
  const url = `https://github.com/google-antigravity/antigravity-cli/releases/download/1.5.5/${name}`;
  let checksum = '0'.repeat(64);
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    if (String(input).endsWith('/releases/latest')) return Response.json({ tag_name: '1.5.5', assets: [{ name, browser_download_url: url, digest: `sha256:${checksum}` }] });
    assert.equal(String(input), url);
    return new Response(bytes);
  });
  const executable = managedAntigravityExecutable();
  assert.equal(adapter.configuration!.defaults(os.homedir()).executable, executable);
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, 'previous');
  await assert.rejects(installManagedAntigravity(), /checksum/);
  assert.equal(await readFile(executable, 'utf8'), 'previous');
  checksum = createHash('sha256').update(bytes).digest('hex');
  assert.equal((await runHarnessUpdates([adapter]))[0].state, 'succeeded');
  assert.equal(await readFile(executable, 'utf8'), script);
  await rm(executable);
  await installManagedAntigravity();
  assert.equal((await execute(executable, ['--version'])).stdout.trim(), '1.5.5');
});
