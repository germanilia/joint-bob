import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from './dev-nodes.js';
import { signedNodeRequest } from './signed-node-request.js';
import { DEFAULT_GUARDIAN_SETTINGS } from '../src/guardian/rules.js';
import { PRODUCTION_RULE } from '../src/guardian/production-rule.js';

// A team lives on one machine. A member of its cluster steers it from their own machine, over the signed machine channel.
test('a cluster member steers a team hosted on another machine: sees it, sends it work, reads the answer', { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-hub-'));
  const requests: any[] = [];
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    requests.push(JSON.parse(raw || '{}'));
    const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: 'hub', object: 'chat.completion.chunk', created: 0, model: 'dev-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(chunk({ role: 'assistant', content: 'HUB_TEAM_ANSWER' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const url = `http://127.0.0.1:${(provider.address() as any).port}`;
    const hostEnv = await seedDevEnvironment(path.join(root, 'host'), 1), host = hostEnv.nodes[0];
    const memberEnv = await seedDevEnvironment(path.join(root, 'member'), 1, { username: 'secondhuman' }), member = memberEnv.nodes[0];
    await writeFile(path.join(hostEnv.home, '.pi', 'models.json'), JSON.stringify({ providers: { 'dev-environment': { baseUrl: `${url}/v1`, api: 'openai-completions', apiKey: 'synthetic', models: [{ id: 'dev-model' }] } } }));
    children.push(await startDevNode(hostEnv, host)); children.push(await startDevNode(memberEnv, member));
    const hostAuth = await signIn(hostEnv, host), memberAuth = await signIn(memberEnv, member);
    // The host serves a relay the member machine uses, then the member joins the host's cluster.
    assert.equal((await fetch(`${host.url}/api/relay/serving`, { method: 'PUT', headers: { Cookie: hostAuth.cookie, 'x-csrf-token': hostAuth.csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, origin: `http://localhost:${host.port}`, environment: 'test', requestsEnabled: true, maxMachines: 10, monthlyCapGb: 0, alertTopic: '' }) })).status, 204);
    const token = await api<any>(host, hostAuth, 'POST', '/relay/serving/tokens', { label: 'member' });
    assert.equal((await api(member, memberAuth, 'POST', '/relays', { link: token.body.link })).status, 201);
    const cluster = await api<any>(host, hostAuth, 'POST', '/clusters', { name: 'Hub fixture' });
    const clusterId = cluster.body.snapshot.body.clusterId;
    const invitation = await api<any>(host, hostAuth, 'POST', `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
    assert.equal((await api(member, memberAuth, 'POST', '/clusters/join', { link: invitation.body.link, requestId: randomUUID() })).status, 201);
    const created = await api<any>(host, hostAuth, 'POST', '/assistant-teams', { clusterId });
    assert.equal(created.status, 201, JSON.stringify(created.body)); const team = created.body.team;
    // The host's signed account snapshot for the member's home, delivered explicitly (no replication polling).
    const snapshot = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
      const {accountSnapshotFor}=await import('./src/user-replication.ts');const {clusterV2Database}=await import('./src/cluster-v2-store.ts');
      console.log(JSON.stringify(accountSnapshotFor(await clusterV2Database(),${JSON.stringify(member.nodeId)},${JSON.stringify(host.nodeId)})));
    `], { env: { ...process.env, HOME: memberEnv.home, NODE_ENV: 'test', JOINT_BOB_DATA_DIR: member.dataDir } });
    assert.equal((await signedNodeRequest(memberEnv, member, host, 'POST', '/api/cluster/v2/accounts', JSON.parse(snapshot.stdout.trim().split('\n').at(-1)!))).status, 200);
    assert.equal((await api(host, hostAuth, 'PUT', '/guardian', { settings: { ...DEFAULT_GUARDIAN_SETTINGS, enabled: true, rules: [PRODUCTION_RULE] } })).status, 200);
    const { addNodeMembers } = await import('./team-members-fixture.js');
    await addNodeMembers((method, route, body) => api<any>(host, hostAuth, method as any, route, body), host.projects.map((p: any) => p.id), team.id,
      [{ role: 'lead', instructions: 'The coordinator' }, { role: 'qa', instructions: 'Checks things' }], 'lead', { harnessId: 'pi', provider: 'dev-environment', modelId: 'dev-model', reasoning: 'off' });

    // The member's own machine lists the team that the host runs, with who is on it.
    const listed = await api<any>(member, memberAuth, 'GET', '/team-hub?fresh=1');
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const remote = listed.body.teams.find((entry: any) => entry.id === team.id);
    assert.ok(remote, JSON.stringify(listed.body));
    assert.equal(remote.local, false, 'the team is not on the member machine');
    assert.equal(remote.hostNodeId, host.nodeId);
    assert.deepEqual(remote.members.map((entry: any) => entry.role), ['lead', 'qa']);
    assert.equal(remote.coordinatorRole, 'lead');

    // Work sent from the member machine starts on the host, as that person, and its answer is read back.
    const sent = await api<any>(member, memberAuth, 'POST', `/team-hub/${team.id}/assign`, { role: 'qa', message: 'Check the sign-in page' });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.request.assignments[0].role, 'qa');
    let view: any;
    for (let i = 0; i < 400; i++) {
      view = (await api<any>(member, memberAuth, 'GET', `/team-hub/${team.id}/requests`)).body.requests.find((entry: any) => entry.id === sent.body.request.id);
      if (view?.state === 'done' || view?.state === 'stopped') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(view?.state, 'done', JSON.stringify(view));
    assert.equal(view.assignments[0].result, 'HUB_TEAM_ANSWER');
    assert.match(JSON.stringify(requests), /Check the sign-in page/, 'the member ran on the host with the person\'s words');

    // Nothing to cancel or retry once it is done, and the host says so plainly.
    const cancelled = await api<any>(member, memberAuth, 'POST', `/team-hub/${team.id}/cancel`, { ref: view.shortId });
    assert.equal(cancelled.status, 409, JSON.stringify(cancelled.body));
    assert.match(cancelled.body.error, /done/);
    // A role that is not on the team is refused by the host, not invented.
    assert.equal((await api<any>(member, memberAuth, 'POST', `/team-hub/${team.id}/assign`, { role: 'nobody', message: 'x' })).status, 404);
    // The host's own people steer it through the same hub, with nothing remote in between.
    const own = await api<any>(host, hostAuth, 'GET', '/team-hub?fresh=1');
    assert.equal(own.body.teams.find((entry: any) => entry.id === team.id)?.local, true);
  } finally {
    await Promise.all(children.map(stopDevNode));
    await new Promise(resolve => provider.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
