import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { startSupervisor } from '../scripts/joint-bob-supervisor.mjs';

// Removing built-in output masking must expose the synthetic fixtures below.
test('service logging masks saved secrets, short values, objects and raw writes without Guardian', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jb-log-'));
  try {
    const script = path.join(root, 'probe.mjs');
    await writeFile(script, `
      const { installServiceLogging } = await import(${JSON.stringify(pathToFileURL(path.resolve('src/logging.ts')).href)});
      installServiceLogging();
      const { saveSecretAccount } = await import(${JSON.stringify(pathToFileURL(path.resolve('src/secrets.ts')).href)});
      await saveSecretAccount({ label: 'synthetic', provider: 'custom', variables: [
        { name: 'CUSTOM_VALUE', kind: 'value', value: 'synthetic-logger-secret' },
        { name: 'SHORT_VALUE', kind: 'value', value: 'q7!' }
      ] });
      console.log('message', 'synthetic-logger-secret', { value: 'q7!' });
      console.warn(new Error('synthetic-logger-secret'));
      process.stderr.write('raw synthetic-logger-');
      process.stderr.write('secret\\n');
      process.stdout.write('tail synthetic-logger-');
    `);
    const child = spawn(process.execPath, ['--import', 'tsx', script], {
      env: { PATH: process.env.PATH, HOME: root, NODE_ENV: 'test', PI_WEB_DATA_DIR: path.join(root, 'data') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise(resolve => child.once('close', resolve));
    const output = stdout + stderr;
    assert.equal(code, 0, 'isolated logger probe must exit cleanly');
    assert.ok(!output.includes('synthetic-logger-secret'), 'secret must not reach service output');
    assert.ok(!output.includes('q7!'), 'short saved secret must also be masked');
    assert.ok(output.includes('tail synthetic-logger-'), 'ordinary trailing text must survive stream end');
    assert.ok(output.includes('raw ***\n'), 'raw writes must use the same masker');
    assert.ok(output.includes('message ***'), 'ordinary log text must remain useful');
    await writeFile(script, `
      const { installServiceLogging } = await import(${JSON.stringify(pathToFileURL(path.resolve('src/logging.ts')).href)});
      installServiceLogging();
      const { registerStoredSecretsForLogging } = await import(${JSON.stringify(pathToFileURL(path.resolve('src/secrets.ts')).href)});
      registerStoredSecretsForLogging();
      console.log('after restart synthetic-logger-secret q7!');
    `);
    const restarted = spawn(process.execPath, ['--import', 'tsx', script], {
      env: { PATH: process.env.PATH, HOME: root, NODE_ENV: 'test', PI_WEB_DATA_DIR: path.join(root, 'data') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let restartedOutput = '';
    restarted.stdout.on('data', chunk => { restartedOutput += chunk; });
    restarted.stderr.on('data', chunk => { restartedOutput += chunk; });
    assert.equal(await new Promise(resolve => restarted.once('close', resolve)), 0);
    assert.ok(restartedOutput.includes('after restart *** ***'));
    assert.ok(!restartedOutput.includes('synthetic-logger-secret'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('task logger masks custom environment values across chunks on both streams before disk', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jb-log-'));
  const runtime = await startSupervisor({ dataDirectory: path.join(root, 'state'), app: {
    executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: root, env: {},
  }});
  const control = (body: unknown) => new Promise<any>((resolve, reject) => {
    const request = http.request({ socketPath: runtime.socketPath, path: '/control', method: 'POST', headers: {
      authorization: `Bearer ${runtime.token}`, 'content-type': 'application/json',
    }}, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => { assert.equal(response.statusCode, 200); resolve(JSON.parse(data).result); });
    });
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
  try {
    const id = randomUUID();
    const accountFiles = path.join(root, 'state', 'secret-files', '8a50c6f1-dd2e-44ac-8b93-6423acf27e1b');
    await mkdir(accountFiles, { recursive: true, mode: 0o700 });
    const secretFile = path.join(accountFiles, 'CUSTOM_FILE');
    await writeFile(secretFile, 'synthetic-file-secret', { mode: 0o600 });
    const unrelated = path.join(root, 'unrelated');
    await writeFile(unrelated, 'synthetic-unrelated-content', { mode: 0o600 });
    const linked = path.join(accountFiles, 'LINKED_FILE');
    await symlink(unrelated, linked);
    await control({ action: 'start', id, identity: 'synthetic-review', name: 'masking test',
      executable: process.execPath, args: ['-e', `
        process.stdout.write('stdout ' + process.env.CUSTOM_VALUE.slice(0, 12));
        process.stderr.write('stderr ' + process.env.CUSTOM_VALUE.slice(0, 12));
        setTimeout(() => {
          process.stdout.write(process.env.CUSTOM_VALUE.slice(12) + '\\n');
          process.stderr.write(process.env.CUSTOM_VALUE.slice(12) + '\\n');
          console.log(require('fs').readFileSync(process.env.CUSTOM_FILE, 'utf8'));
          console.log('short=' + process.env.SHORT_VALUE);
          console.log('unrelated fixture: synthetic-unrelated-content');
          process.stdout.write('partial ' + process.env.CUSTOM_VALUE.slice(0, 12));
        }, 50);
      `], cwd: root, env: {
        CUSTOM_VALUE: 'synthetic-task-secret', SHORT_VALUE: 'q7!', CUSTOM_FILE: secretFile,
        OUTSIDE_FILE: unrelated, LINKED_FILE: linked,
        JOINT_BOB_SECRET_ENV_NAMES: JSON.stringify(['CUSTOM_VALUE', 'SHORT_VALUE', 'CUSTOM_FILE', 'OUTSIDE_FILE', 'LINKED_FILE']),
      },
    });
    const deadline = Date.now() + 10000;
    while ((await control({ action: 'task', id })).status !== 'completed') {
      assert.ok(Date.now() < deadline, 'synthetic task did not finish');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const persisted = await readFile(path.join(root, 'state', 'background-tasks', `${id}.log`), 'utf8');
    assert.ok(!persisted.includes('synthetic-task-secret'), 'task secret must never reach disk');
    assert.ok(!persisted.includes('synthetic-file-secret'), 'secret file contents must never reach disk');
    assert.ok(!persisted.includes('q7!'), 'short task secrets must be masked');
    assert.ok(persisted.includes('unrelated fixture: synthetic-unrelated-content'), 'task input must not register arbitrary files or follow symlinks');
    assert.ok(persisted.includes('partial '), 'ordinary output must survive stream end');
    assert.ok(persisted.includes('stdout '), 'stdout should preserve nonsecret output');
    assert.ok(persisted.includes('stderr '), 'stderr should preserve nonsecret output');
    assert.ok(persisted.split('***').length >= 5, 'both streams and file credentials must be replaced');
    const result = await control({ action: 'output', id, offset: 0, limit: 65536 });
    assert.ok(!Buffer.from(result.chunk, 'base64').toString().includes('synthetic-task-secret'));
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
