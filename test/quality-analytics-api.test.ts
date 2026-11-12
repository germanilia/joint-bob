import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { openNodeDatabase } from '../src/node-database.js';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from './dev-nodes.js';
import { QualityStore } from '../src/quality-analytics.js';

test('retired Quality endpoints cannot collect and Done feedback is stored without inference', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jb-quality-retired-'));
  const environment = await seedDevEnvironment(root, 1), node = environment.nodes[0];
  const db = openNodeDatabase(path.join(node.dataDir, 'node.db'));
  new QualityStore(db).setEnabled(true); // A saved old switch must not restart collection.
  const server = await startDevNode(environment, node);
  try {
    const session = await signIn(environment, node);
    for (const [method, endpoint, body] of [['GET', '/quality-analytics', undefined], ['PUT', '/quality-analytics/settings', { enabled: true }], ['POST', '/quality-analytics/retry', {}]] as const) {
      const response = await api(node, session, method, endpoint, body);
      assert.equal(response.status, 404, `${method} ${endpoint}`);
    }
    const project = node.projects[0], conversationId = 'retired-quality-feedback';
    const feedback = { rating: 'bad', description: 'Keep this exact feedback for the scheduled review.' };
    const done = await api(node, session, 'PUT', `/projects/${project.id}/sessions/done`, { engine: 'pi', sessionId: conversationId, done: true, feedback });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const row = db.prepare("SELECT name FROM name_overrides WHERE scope='session_feedback' AND key=?").get(conversationId) as { name: string };
    const stored = JSON.parse(row.name);
    assert.deepEqual(stored.feedback, feedback);
    assert.equal(stored.source, 'manual');
    assert.equal(stored.status, 'complete', 'Done does not queue a built-in learning agent');
    assert.equal((db.prepare('SELECT count(*) count FROM quality_jobs').get() as { count: number }).count, 0, 'the old enabled flag is ignored');
    const reopened = await api(node, session, 'PUT', `/projects/${project.id}/sessions/done`, { engine: 'pi', sessionId: conversationId, done: false });
    assert.equal(reopened.status, 200);
    assert.equal(db.prepare("SELECT 1 FROM name_overrides WHERE scope='session_feedback' AND key=?").get(conversationId), undefined);
  } finally { db.close(); await stopDevNode(server); await rm(root, { recursive: true, force: true }); }
});
