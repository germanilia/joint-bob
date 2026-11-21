import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

const hookScript = new URL('../bin/joint-bob-guardian.mjs', import.meta.url).pathname;

function runHook(url: string): Promise<{ permissionDecision: string; permissionDecisionReason: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookScript], { env: { ...process.env, JOINT_BOB_GUARDIAN_URL: url, JOINT_BOB_GUARDIAN_TOKEN: 't' } });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', reject);
    child.on('close', () => resolve(JSON.parse(out).hookSpecificOutput));
    child.stdin.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'make release' } }));
  });
}

const answer = (res: http.ServerResponse) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ verdict: { action: 'block', reason: 'answered' } })); };

test('the hook waits for a slow answer and carries the server\'s decision', async (t) => {
  const server = http.createServer((req, res) => { req.resume(); setTimeout(() => answer(res), 1500); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const decision = await runHook(`http://127.0.0.1:${(server.address() as AddressInfo).port}/check`);
  assert.deepEqual([decision.permissionDecision, decision.permissionDecisionReason], ['deny', 'answered']);
});

test('the hook retries while Joint Bob restarts instead of blocking at once', async (t) => {
  const probe = http.createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise(resolve => probe.close(resolve));
  const pending = runHook(`http://127.0.0.1:${port}/check`);
  await new Promise(resolve => setTimeout(resolve, 2500));
  const server = http.createServer((req, res) => { req.resume(); answer(res); });
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  t.after(() => server.close());
  const decision = await pending;
  assert.equal(decision.permissionDecisionReason, 'answered', 'the call waited for the server instead of failing with "fetch failed"');
});
