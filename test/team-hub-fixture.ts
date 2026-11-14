import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from './dev-nodes.js';
import { signedNodeRequest } from './signed-node-request.js';
import { DEFAULT_GUARDIAN_SETTINGS } from '../src/guardian/rules.js';
import { PRODUCTION_RULE } from '../src/guardian/production-rule.js';

/**
 * Two real nodes in one cluster: a host that runs a team of two members (lead and qa, answering through a synthetic provider)
 * and a member's own machine, which reaches the host through the host's relay. The team's answer is `answer`.
 */
export async function startTeamHubFixture(options: { answer?: string; memberEnv?: Record<string, string>; hold?: () => Promise<void> } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-hub-'));
  const requests: any[] = [];
  const provider: Server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    requests.push(JSON.parse(raw || '{}'));
    await options.hold?.();
    const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: 'hub', object: 'chat.completion.chunk', created: 0, model: 'dev-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(chunk({ role: 'assistant', content: options.answer ?? 'HUB_TEAM_ANSWER' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  const stop = async () => {
    await Promise.all(children.map(stopDevNode));
    await new Promise(resolve => provider.close(resolve));
    await rm(root, { recursive: true, force: true });
  };
  try {
    const url = `http://127.0.0.1:${(provider.address() as any).port}`;
    const hostEnv = await seedDevEnvironment(path.join(root, 'host'), 1), host = hostEnv.nodes[0];
    const memberEnv = await seedDevEnvironment(path.join(root, 'member'), 1, { username: 'secondhuman' }), member = memberEnv.nodes[0];
    await writeFile(path.join(hostEnv.home, '.pi', 'models.json'), JSON.stringify({ providers: { 'dev-environment': { baseUrl: `${url}/v1`, api: 'openai-completions', apiKey: 'synthetic', models: [{ id: 'dev-model' }] } } }));
    let hostNode = await startDevNode(hostEnv, host), memberNode = await startDevNode(memberEnv, member, options.memberEnv);
    children.push(hostNode, memberNode);
    let hostOutput = ''; const listen = (node: typeof hostNode) => { for (const stream of [node.stdout!, node.stderr!]) stream.on('data', chunk => { hostOutput += chunk; }); };
    listen(hostNode);
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
    // The member's signed account snapshot, delivered explicitly (no replication polling).
    const snapshot = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
      const {accountSnapshotFor}=await import('./src/user-replication.ts');const {clusterV2Database}=await import('./src/cluster-v2-store.ts');
      console.log(JSON.stringify(accountSnapshotFor(await clusterV2Database(),${JSON.stringify(member.nodeId)},${JSON.stringify(host.nodeId)})));
    `], { env: { ...process.env, HOME: memberEnv.home, NODE_ENV: 'test', JOINT_BOB_DATA_DIR: member.dataDir } });
    assert.equal((await signedNodeRequest(memberEnv, member, host, 'POST', '/api/cluster/v2/accounts', JSON.parse(snapshot.stdout.trim().split('\n').at(-1)!))).status, 200);
    assert.equal((await api(host, hostAuth, 'PUT', '/guardian', { settings: { ...DEFAULT_GUARDIAN_SETTINGS, enabled: true, rules: [PRODUCTION_RULE] } })).status, 200);
    const { addNodeMembers } = await import('./team-members-fixture.js');
    await addNodeMembers((method, route, body) => api<any>(host, hostAuth, method as any, route, body), host.projects.map((p: any) => p.id), team.id,
      [{ role: 'lead', instructions: 'The coordinator' }, { role: 'qa', instructions: 'Checks things' }], 'lead', { harnessId: 'pi', provider: 'dev-environment', modelId: 'dev-model', reasoning: 'off' });
    // A machine going away and coming back, as an update does: stopped, then started again on the same data. The person signs in again.
    const down = async (which: 'host' | 'member') => {
      const old = which === 'host' ? hostNode : memberNode;
      await stopDevNode(old); children.splice(children.indexOf(old), 1);
    };
    const up = async (which: 'host' | 'member') => {
      const fresh = which === 'host' ? await startDevNode(hostEnv, host) : await startDevNode(memberEnv, member, options.memberEnv);
      children.push(fresh);
      if (which === 'host') { hostNode = fresh; listen(fresh); return signIn(hostEnv, host); }
      memberNode = fresh; return signIn(memberEnv, member);
    };
    const restart = async (which: 'host' | 'member') => { await down(which); return up(which); };
    return { root, host, member, hostEnv, memberEnv, hostAuth, memberAuth, team, clusterId, requests, hostOutput: () => hostOutput, down, up, restart, stop };
  } catch (error) { await stop(); throw error; }
}
