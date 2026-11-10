import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from './dev-nodes.js';
import { addClusterLocalMember } from '../src/cluster-accounts.js';
import { ManagedMcpStore } from '../src/mcp/store.js';

test('team MCP: host approval, per-role CAS, live Pi tool call, revocation and private isolation', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-mcp-'));
  const requests: any[] = [];
  const provider = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const request = JSON.parse(body); requests.push(request);
    const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'dev-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const latestUser = request.messages.findLastIndex((m: any) => m.role === 'user');
    const currentMessages = request.messages.slice(latestUser);
    if (JSON.stringify(currentMessages).includes('USE_SHARED_MCP') && !currentMessages.some((m: any) => m.role === 'tool')) {
      const tool = request.tools?.find((t: any) => t.function.name === 'mcp__team_fixture__inspect');
      if (tool) { res.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-call', type: 'function', function: { name: tool.function.name, arguments: '{}' } }] }, null)); res.write(chunk({}, 'tool_calls')); res.end('data: [DONE]\n\n'); return; }
    }
    res.write(chunk({ role: 'assistant', content: JSON.stringify(currentMessages).includes('Fixture result') ? 'MCP_RESULT_CONFIRMED' : 'NO_MCP_AVAILABLE' }, null));
    res.write(chunk({}, 'stop')); res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  let child: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const env = await seedDevEnvironment(root, 1), node = env.nodes[0];
    const seeded = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
      const {createLocalUser,authenticate,changePassword}=await import('./src/auth.ts');
      const {getClusterNode}=await import('./src/cluster.ts'); await getClusterNode();
      const people=['mcphuman','mcpoutsider'].map(username=>{ const user=createLocalUser({username,email:username+'@example.test'});
      const session=authenticate(username,user.oneTimePassword);
      changePassword(session,user.oneTimePassword,'Synthetic-member-password-123!'); return user.user; }); console.log(JSON.stringify(people));
    `], { env: { ...process.env, HOME: env.home, NODE_ENV: 'test', JOINT_BOB_DATA_DIR: node.dataDir } });
    const [human] = JSON.parse(seeded.stdout.trim().split('\n').at(-1)!);
    await mkdir(path.join(env.home, '.pi'), { recursive: true });
    await writeFile(path.join(env.home, '.pi', 'models.json'), JSON.stringify({ providers: { 'dev-environment': { baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`, api: 'openai-completions', apiKey: 'synthetic', models: [{ id: 'dev-model' }] } } }));
    child = await startDevNode(env, node); const owner = await signIn(env, node);
    const cluster = await api<any>(node, owner, 'POST', '/clusters', { name: 'MCP fixture' });
    const created = await api<any>(node, owner, 'POST', '/assistant-teams', { clusterId: cluster.body.snapshot.body.clusterId });
    assert.equal(created.status, 201, JSON.stringify(created.body)); const team = created.body.team;
    const db = new DatabaseSync(path.join(node.dataDir, 'node.db'));
    try { addClusterLocalMember(db, team.clusterId, human.accountId); } finally { db.close(); }
    const member = await signIn({ ...env, username: 'mcphuman', password: 'Synthetic-member-password-123!' }, node);
    const outsider = await signIn({ ...env, username: 'mcpoutsider', password: 'Synthetic-member-password-123!' }, node);
    const fixture = path.resolve('test/managed-mcp-fixture.mjs');
    const privateName = 'private_sentinel', name = 'team_fixture';
    assert.equal((await api(node, owner, 'POST', '/resources/mcp/managed', { mcpServers: {
      [name]: { command: process.execPath, args: [fixture] }, [privateName]: { command: process.execPath, args: [fixture] },
    } })).status, 200);
    const resources = `/assistant-teams/${team.id}/agents/qa/resources`;
    const first = await api<any>(node, member, 'GET', resources);
    assert.deepEqual(first.body.mcpServers, []); assert.equal(first.body.ownerMcpServers, undefined);
    assert.equal((await api(node, outsider, 'GET', resources)).status, 403);
    assert.equal((await api(node, outsider, 'PUT', `/assistant-teams/${team.id}/mcp-shares/${name}`, { enabled: true, expectedRevision: 1 })).status, 403);
    assert.equal((await api(node, member, 'PUT', `/assistant-teams/${team.id}/mcp-shares/${name}`, { enabled: true, expectedRevision: 1 })).status, 403);
    assert.equal((await api(node, member, 'PUT', resources, { expectedRevision: 1, disabledSkills: [], mcpServerNames: [name] })).status, 400);
    const share = await api<any>(node, owner, 'PUT', `/assistant-teams/${team.id}/mcp-shares/${name}`, { enabled: true, expectedRevision: 1 });
    assert.equal(share.status, 200, JSON.stringify(share.body));
    assert.equal((await api(node, owner, 'PUT', `/assistant-teams/${team.id}/mcp-shares/${privateName}`, { enabled: true, expectedRevision: 1 })).status, 409);
    const visible = await api<any>(node, member, 'GET', resources);
    assert.deepEqual(visible.body.mcpServers.map((s: any) => s.name), [name]);
    assert.doesNotMatch(JSON.stringify(visible.body), /private_sentinel|command|args|token/);
    const selected = await api<any>(node, member, 'PUT', resources, { expectedRevision: 2, disabledSkills: [], mcpServerNames: [name] });
    assert.equal(selected.status, 200, JSON.stringify(selected.body));
    assert.equal((await api(node, member, 'PUT', resources, { expectedRevision: 2, disabledSkills: [], mcpServerNames: [] })).status, 409);
    const product = await api<any>(node, member, 'GET', `/assistant-teams/${team.id}/agents/product/resources`);
    assert.equal(product.body.mcpServers[0].enabled, false);
    const configured = await api<any>(node, owner, 'PUT', `/assistant-teams/${team.id}/agents/qa`, { expectedRevision: 3, name: 'QA', instructions: 'Fixture', allowTerminal: false, executionSettings: { harnessId: 'pi', provider: 'dev-environment', modelId: 'dev-model', reasoning: 'off' } });
    assert.equal(configured.status, 200, JSON.stringify(configured.body));
    const { DEFAULT_GUARDIAN_SETTINGS } = await import('../src/guardian/rules.js');
    const { PRODUCTION_RULE } = await import('../src/guardian/production-rule.js');
    assert.equal((await api(node, owner, 'PUT', '/guardian', { settings: { ...DEFAULT_GUARDIAN_SETTINGS, enabled: true, rules: [PRODUCTION_RULE] } })).status, 200);
    const storeBefore = new ManagedMcpStore(node.dataDir, team.executorAccountId);
    assert.equal(storeBefore.sharedWith(name, team.id), true, JSON.stringify({ shares: storeBefore.shares(), servers: Object.keys(storeBefore.servers()) }));
    const turn = `/assistant-teams/${team.id}/agents/qa/turn`;
    const called = await api<any>(node, member, 'POST', turn, { subjectId: 'mcp', requestId: randomUUID(), message: 'USE_SHARED_MCP' });
    assert.equal(called.status, 200, JSON.stringify(called.body)); assert.match(called.body.text, /MCP_RESULT_CONFIRMED/, JSON.stringify(requests.map(r => r.tools?.map((t: any) => t.function.name))));
    assert.ok(requests.some(r => r.tools?.some((t: any) => t.function.name === 'mcp__team_fixture__inspect')));
    assert.ok(requests.every(r => !r.tools?.some((t: any) => t.function.name.includes(privateName))));
    const revoke = await api<any>(node, owner, 'PUT', `/assistant-teams/${team.id}/mcp-shares/${name}`, { enabled: false, expectedRevision: 4 });
    assert.equal(revoke.status, 200, JSON.stringify(revoke.body));
    const after = await api<any>(node, member, 'POST', turn, { subjectId: 'mcp', requestId: randomUUID(), message: 'USE_SHARED_MCP' });
    assert.equal(after.status, 200, JSON.stringify(after.body)); assert.match(after.body.text, /NO_MCP_AVAILABLE/);
    const store = new ManagedMcpStore(node.dataDir, team.executorAccountId);
    assert.equal(store.sharedWith(name, team.id), false);
    // Removing and reinstalling an identical private definition must not resurrect an old grant.
    store.remove(name);
    store.install({ [name]: { command: process.execPath, args: [fixture] } });
    assert.equal(store.sharedWith(name, team.id), false);
    store.setTeamShare(name, team.id, true);
    await writeFile(path.join(store.directory, 'servers.json'), JSON.stringify({ ...store.servers(), [name]: { command: process.execPath, args: [fixture, 'replacement'] } }));
    assert.equal(store.sharedWith(name, team.id), false, 'definition replacement invalidates the digest-bound grant');
  } finally { if (child) await stopDevNode(child); await new Promise<void>(resolve => provider.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
