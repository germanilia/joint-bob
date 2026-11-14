import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from './dev-nodes.js';
import { DEFAULT_GUARDIAN_SETTINGS } from '../src/guardian/rules.js';
import { PRODUCTION_RULE } from '../src/guardian/production-rule.js';
import { openNodeDatabase } from '../src/node-database.js';
import { setClusterSubscriptionPool } from '../src/provider-profiles/pool-sharing.js';

test('a team turn in a cluster with a subscription pool runs on the pool instead of being refused', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-pool-'));
  let child: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const env = await seedDevEnvironment(root, 1); const node = env.nodes[0];
    await writeFile(path.join(env.home, '.pi', 'models.json'), JSON.stringify({ providers: { 'dev-environment': { baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', apiKey: 'synthetic', models: [{ id: 'dev-model' }] } } }));
    child = await startDevNode(env, node);
    let output = ''; for (const stream of [child.stdout!, child.stderr!]) stream.on('data', chunk => { output += chunk; });
    const auth = await signIn(env, node);
    const call = (method: string, route: string, body?: unknown) => api<any>(node, auth, method as any, route, body);
    const cluster = await call('POST', '/clusters', { name: 'Pool team fixture' });
    const created = await call('POST', '/assistant-teams', { clusterId: cluster.body.snapshot.body.clusterId });
    assert.equal(created.status, 201, JSON.stringify(created.body)); const team = created.body.team;
    const { addNodeMembers } = await import('./team-members-fixture.js');
    await addNodeMembers(call, node.projects.map((p: any) => p.id), team.id, [{ role: 'qa' }], 'qa', { harnessId: 'pi', provider: 'dev-environment', modelId: 'dev-model', reasoning: 'off' });
    assert.equal((await call('PUT', '/guardian', { settings: { ...DEFAULT_GUARDIAN_SETTINGS, enabled: true, rules: [PRODUCTION_RULE] } })).status, 200);
    // Contigos-style rule: the cluster mandates one pool for everything shared with it.
    const db = openNodeDatabase(path.join(node.dataDir, 'node.db'));
    try {
      setClusterSubscriptionPool(db, team.hostNodeId, team.clusterId, team.hostNodeId,
        { poolId: randomUUID(), name: 'Shared', fallbackModels: {}, members: [{ profileId: randomUUID(), provider: 'pi', label: 'Pi', position: 0 }] }, 1);
    } finally { db.close(); }
    const turn = await call('POST', `/assistant-teams/${team.id}/agents/qa/turn`, { subjectId: 'alpha', requestId: randomUUID(), message: 'Check the pool' });
    assert.equal(turn.status, 409, 'the fixture pool member has no login, so the turn cannot finish');
    assert.match(output, /Cluster pool host has not authorized this profile/, 'the turn went through the cluster pool');
    assert.doesNotMatch(output, /requires pool-aware execution/, 'a team turn is never refused for lacking pool-aware execution');
  } finally {
    if (child) await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});
