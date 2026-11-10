import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from './dev-nodes.js';
import { addNodeMembers } from './team-members-fixture.js';

test('deleting an assistant removes it from its team and passes the coordinator on', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-assistant-delete-'));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const env = await seedDevEnvironment(root, 1), node = env.nodes[0];
    server = await startDevNode(env, node);
    const auth = await signIn(env, node);
    const call = (method: string, route: string, body?: unknown) => api<any>(node, auth, method as any, route, body);
    const cluster = await call('POST', '/clusters', { name: 'Delete team' });
    const team = (await call('POST', '/assistant-teams', { clusterId: cluster.body.snapshot.body.clusterId })).body.team;
    const settings = { harnessId: 'pi', provider: 'dev-environment', modelId: 'dev-model', reasoning: 'off' };
    const picked = await addNodeMembers(call, node.projects.map(p => p.id), team.id, [{ role: 'lead' }, { role: 'qa' }], 'lead', settings);
    const before = (await call('GET', `/assistant-teams/${team.id}/agents`)).body;
    assert.equal(before.coordinatorRole, 'lead');

    const removed = await fetch(`${node.url}/api/personal-assistants/${picked.lead.id}`, { method: 'DELETE', headers: { Cookie: auth.cookie, 'x-csrf-token': auth.csrfToken } });
    assert.equal(removed.status, 204);
    const after = (await call('GET', `/assistant-teams/${team.id}/agents`)).body;
    assert.deepEqual(after.agents.map((agent: any) => agent.role), ['qa'], 'the deleted member left the team');
    assert.equal(after.coordinatorRole, 'qa', 'the first remaining member coordinates');
    assert.ok(after.revision > before.revision, 'the team revision moved');
    assert.equal((await call('GET', `/assistant-teams/${team.id}/available-assistants`)).body.assistants.some((a: any) => a.id === picked.lead.id), false);
  } finally {
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
