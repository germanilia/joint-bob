import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from './dev-nodes.js';
import { addNodeMembers } from './team-members-fixture.js';

const BOT_TOKEN = '424242:fixture-team-agent-token-abcdefghij';

test('a Telegram agent assigned to a team lends it its bot, coordinates it, and gets the bot back', { timeout: 120_000 }, async () => {
  const calls: { method: string; body: any }[] = [];
  const bot = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    const method = request.url!.split('/').at(-1)!;
    calls.push({ method, body: body ? JSON.parse(body) : {} });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, result: method === 'getMe' ? { id: 4242, username: 'team_agent_bot', can_read_all_group_messages: true } : true }));
  });
  await new Promise<void>(resolve => bot.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-telegram-agent-'));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const env = await seedDevEnvironment(root, 1), node = env.nodes[0];
    server = await startDevNode(env, node, { JOINT_BOB_TELEGRAM_API: `http://127.0.0.1:${(bot.address() as { port: number }).port}` });
    const auth = await signIn(env, node);
    const call = (method: string, route: string, body?: unknown) => api<any>(node, auth, method as any, route, body);
    const cluster = await call('POST', '/clusters', { name: 'Agent team' });
    const team = (await call('POST', '/assistant-teams', { clusterId: cluster.body.snapshot.body.clusterId })).body.team;
    const settings = { harnessId: 'pi', provider: 'dev-environment', modelId: 'dev-model', reasoning: 'off' };
    // Two ordinary members first; the third seeded conversation becomes the Telegram agent.
    await addNodeMembers(call, node.projects.map(p => p.id), team.id, [{ role: 'qa' }, { role: 'designer' }], 'qa', settings);
    const sessions: { projectId: string; id: string; harnessId: string }[] = [];
    for (const project of node.projects) for (const entry of (await call('GET', `/projects/${project.id}/sessions`)).body.sessions) sessions.push({ projectId: project.id, ...entry });
    const source = sessions[2];
    const agent = (await call('POST', '/personal-assistants', { projectId: source.projectId, engine: source.harnessId, sessionId: source.id, name: 'Lead Bob', instructions: 'Coordinate.', executionSettings: settings })).body.assistant;
    const telegram = `/personal-assistants/${agent.id}/telegram`;
    assert.equal((await call('POST', telegram, { token: BOT_TOKEN })).status, 201);

    const choices = await call('GET', `${telegram}/team`);
    assert.equal(choices.body.teamId, null);
    assert.deepEqual(choices.body.teams.map((item: any) => item.id), [team.id]);

    calls.length = 0;
    const assigned = await call('PUT', `${telegram}/team`, { teamId: team.id });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    assert.equal(assigned.body.teamId, team.id);
    const hook = calls.find(entry => entry.method === 'setWebhook')!;
    assert.match(hook.body.url, new RegExp(`/teamtelegram-${team.id}$`), 'the bot now delivers to the team');
    assert.ok(hook.body.allowed_updates.includes('callback_query'), 'inquiry buttons reach the team');
    const menu = calls.find(entry => entry.method === 'setMyCommands')!;
    assert.deepEqual(menu.body.commands.map((item: any) => item.command), ['qa', 'designer', 'lead_bob'], 'one command per role');

    const members = await call('GET', `/assistant-teams/${team.id}/agents`);
    assert.deepEqual(members.body.agents.map((item: any) => item.role), ['qa', 'designer', 'lead_bob']);
    assert.equal(members.body.coordinatorRole, 'lead_bob', 'the Telegram agent coordinates');
    const teamBot = await call('GET', `/assistant-teams/${team.id}/telegram`);
    assert.equal(teamBot.body.connected, true); assert.equal(teamBot.body.botUsername, 'team_agent_bot');
    assert.equal(JSON.stringify([assigned.body, teamBot.body]).includes(BOT_TOKEN), false, 'the token never comes back');

    calls.length = 0;
    const released = await call('PUT', `${telegram}/team`, { teamId: null });
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.doesNotMatch(calls.find(entry => entry.method === 'setWebhook')!.body.url, /teamtelegram-/, 'the bot answers on its own again');
    assert.equal((await call('GET', `/assistant-teams/${team.id}/telegram`)).body.connected, false);
    assert.equal((await call('GET', `/assistant-teams/${team.id}/agents`)).body.agents.length, 3, 'the team keeps its members');
  } finally {
    if (server) await stopDevNode(server);
    bot.closeAllConnections(); bot.close();
    await rm(root, { recursive: true, force: true });
  }
});
