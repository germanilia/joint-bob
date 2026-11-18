import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogMasker, maskLogText, registerLogSecrets } from '../scripts/log-masking.mjs';

test('stream masking waits for the longest overlapping secret at every chunk boundary', () => {
  registerLogSecrets(['synthetic-overlap', 'synthetic-overlap-long']);
  const secret = 'synthetic-overlap-long';
  for (let split = 1; split < secret.length; split++) {
    const masker = createLogMasker();
    const output = masker.write('before ' + secret.slice(0, split)) + masker.write(secret.slice(split) + ' after\n') + masker.end();
    assert.equal(output, 'before *** after\n', `split ${split}`);
  }
});

test('credential field masking preserves valid JSON and ordinary log content', () => {
  const output = maskLogText('{"password":"synthetic password with spaces","status":"failed"}');
  assert.deepEqual(JSON.parse(output), { password: '***', status: 'failed' });
  assert.equal(maskLogText('healthy operation completed\n'), 'healthy operation completed\n');
  assert.deepEqual(JSON.parse(maskLogText('{"taskToken":true,"otherToken":false,"missingToken":null}')), { taskToken: true, otherToken: false, missingToken: null });
  assert.equal(maskLogText('{"tokens":{"input":10},"tokenUsage":20}'), '{"tokens":{"input":10},"tokenUsage":20}');
  registerLogSecrets(['deliberate-synthetic-credential']);
  assert.equal(maskLogText('matched'), 'matched', 'a final ordinary character is not a leaked credential');
});

test('masking handles UTF-8 split bytes, JSON escaping and URL encoding', () => {
  registerLogSecrets(['synthetic-סוד-🔑', 'synthetic"quoted\ncredential', 'synthetic/encoded+credential']);
  const secret = Buffer.from('synthetic-סוד-🔑');
  for (let split = 1; split < secret.length; split++) {
    const masker = createLogMasker();
    assert.equal(masker.write(secret.subarray(0, split)) + masker.write(secret.subarray(split)) + masker.end(), '***');
  }
  assert.equal(maskLogText('value=synthetic\\"quoted\\ncredential'), 'value=***');
  assert.equal(maskLogText('value=synthetic%2Fencoded%2Bcredential'), 'value=***');
});

test('running log streams pick up rotated secrets and keep masking old values', () => {
  const masker = createLogMasker();
  registerLogSecrets(['synthetic-before-rotation']);
  assert.equal(masker.write('synthetic-before-rotation\n'), '***\n');
  registerLogSecrets(['synthetic-after-rotation']);
  assert.equal(masker.write('synthetic-after-rotation synthetic-before-rotation\n'), '*** ***\n');
  assert.equal(masker.end(), '');
});
