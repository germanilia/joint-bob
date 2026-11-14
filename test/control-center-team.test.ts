import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { api, type SeededNode, type SignedIn } from './dev-nodes.js';
import { startTeamHubFixture } from './team-hub-fixture.js';
import type { BobMessage } from '../src/control-center/bob-store.js';
import { teamIntentShapes } from '../src/server/control-center-team.js';
import { handleBobOrganize, parseOrganizeIntent } from '../src/server/control-center-organize.js';
import { DEFAULT_BOB_SETTINGS } from '../src/control-center/bob-store.js';
import { openNodeDatabase } from '../src/node-database.js';

test('team intents fit their shapes', () => {
  assert.deepEqual(parseOrganizeIntent('{"intent":"team-assign","team":"t1","role":"qa","message":"check the sign-in page"}'), { intent: 'team-assign', team: 't1', role: 'qa', message: 'check the sign-in page' });
  assert.deepEqual(parseOrganizeIntent('{"intent":"team-status","team":"t1","role":null}'), { intent: 'team-status', team: 't1', role: null });
  assert.equal(parseOrganizeIntent('{"intent":"team-assign","team":"t1","role":"qa","message":""}'), null);
  assert.equal(teamIntentShapes.length, 4);
});

// Words are not what makes a message about a team: the decision model's answer is. A message full of team words that the model
// took for something else never reaches the team step, so it is answered as anything else is.
test('a message the decision model did not take for a team never reaches the team step, whatever its words', async () => {
  const session = { id: 's', userId: 'u', accountId: 'a', username: 'person', homeNodeId: null, isRemoteLogin: false, email: null, role: 'admin', csrfToken: '', mustChangePassword: false } as const;
  const turn = { session, message: 'tell the team to have qa and the designer check the sign-in page', recentChat: [], project: null, options: [], settings: DEFAULT_BOB_SETTINGS };
  const decision = { kind: 'other', size: 'short', projectId: null, autoRespond: false, confidence: 0.97, kindConfidence: 0.97, team: false, teamConfidence: 0.97 } as const;
  assert.equal(await handleBobOrganize(turn as never, decision, { images: [], files: [] }), null);
});

/**
 * A stand-in decision model. A message is "about a team" when the model says so: here, when its words are the stand-in's own
 * marker, so nothing in Joint Bob matches words. It also records what it was told of the person's teams.
 */
async function decisionModel(): Promise<{ server: Server; url: string; seen: Array<{ message: string; teams: unknown }> }> {
  const seen: Array<{ message: string; teams: unknown }> = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body) as { state: string; questions: Record<string, { criteria: Record<string, string> }> };
      const state = JSON.parse(parsed.state) as { user_message: string; assistant_teams?: unknown };
      if (parsed.questions.team) seen.push({ message: state.user_message, teams: state.assistant_teams });
      const choose = (choice: string) => ({ type: 'choice', choice, confidence: 0.97 });
      const answers: Record<string, unknown> = {};
      for (const [id, question] of Object.entries(parsed.questions)) {
        if (id === 'kind') answers[id] = choose('other');
        else if (id === 'size') answers[id] = choose('short');
        else if (id === 'team') answers[id] = choose(state.user_message.startsWith('[team]') ? 'yes' : 'no');
        else answers[id] = choose('no' in question.criteria ? 'no' : 'none' in question.criteria ? 'none' : Object.keys(question.criteria)[0]);
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ answers }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/systemone`, seen };
}

/** Bob on the member's machine: the decision model is the stand-in above, and what Bob's agent "answers" is organize.json. */
async function bobOnMember(options: { answer?: string; hold?: () => Promise<void> } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'team-bob-'));
  const model = await decisionModel();
  const fixture = await startTeamHubFixture({ answer: options.answer, hold: options.hold, memberEnv: { JOINT_BOB_TEST_AUTOMATION_DIR: directory, JOINT_BOB_TYPESAFE_ENDPOINT: model.url, JOINT_BOB_TEST_ENGINE_LOG: path.join(directory, 'engine.log') } });
  const { member, memberAuth } = fixture;
  const account = await api<{ account: { id: string } }>(member, memberAuth, 'POST', '/secrets/accounts', { label: 'decision', provider: 'custom', variables: [{ name: 'TYPESAFE_AI_API_KEY', kind: 'value', value: 'test-key' }] });
  for (const project of member.projects as Array<{ id: string }>) assert.equal((await api(member, memberAuth, 'PUT', `/secrets/scopes/project/${project.id}`, { accountIds: [account.body.account.id] })).status, 200);
  const stop = async () => { await fixture.stop(); await new Promise(resolve => model.server.close(resolve)); };
  const say = async (auth: SignedIn, text: string, intent: unknown): Promise<BobMessage> => {
    await writeFile(path.join(directory, 'organize.json'), JSON.stringify(intent));
    const reply = await api<{ reply: BobMessage }>(member, auth, 'POST', '/control-center/bob/message', { message: text });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    return reply.body.reply;
  };
  const messages = async (auth: SignedIn) => (await api<{ messages: BobMessage[] }>(member, auth, 'GET', '/control-center/bob/messages')).body.messages;
  const eventually = async (auth: SignedIn, match: RegExp, what: string): Promise<BobMessage> => {
    for (let i = 0; i < 300; i++) {
      const found = (await messages(auth)).find(message => match.test(message.text));
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`Bob never said: ${what}: ${JSON.stringify((await messages(auth)).map(message => message.text.slice(0, 120)))}`);
  };
  const notices = () => { const db = openNodeDatabase(path.join(fixture.host.dataDir, 'node.db')); try { return db.prepare('SELECT root_id, state FROM assistant_team_notices').all().map(row => ({ ...row }) as { root_id: string; state: string }); } finally { db.close(); } };
  const markNoticesSent = () => { const db = openNodeDatabase(path.join(fixture.host.dataDir, 'node.db')); try { db.prepare("UPDATE assistant_team_notices SET state='sent'").run(); } finally { db.close(); } };
  const follows = (node: SeededNode) => { const db = openNodeDatabase(path.join(node.dataDir, 'node.db')); try { return db.prepare('SELECT request_id, state FROM bob_team_follows').all() as Array<{ request_id: string; state: string }>; } finally { db.close(); } };
  return { ...fixture, directory, say, messages, eventually, follows, notices, markNoticesSent, model, stop };
}

// Bob runs on the member's machine; the team runs on the host.
test('Bob, on a cluster member\'s machine, is told by the decision model that a message is about a team, reports on it, sends it work after a press, and brings the answer back', { timeout: 240_000 }, async () => {
  const bob = await bobOnMember({ answer: 'BOB_TEAM_ANSWER' });
  const { member, memberAuth, team, requests } = bob;
  try {
    // Reading needs no button.
    const status = await bob.say(memberAuth, '[team] where do things stand?', { intent: 'team-status', team: team.id, role: null });
    // The first message the model sees already carries the team and its roles; they are kept on disk for the next start.
    assert.deepEqual(bob.model.seen[0].teams, [{ name: 'Hub fixture', roles: ['lead', 'qa'] }], 'the model is told of the team the first time it looks');
    assert.equal(status.importance, 'fyi', status.text);
    assert.match(status.text, /lead \(coordinator\), qa/);
    assert.match(status.text, /No requests yet/);
    assert.match(status.text, /hosted on/);

    // Work waits for the person's button, and names the machine it will run on.
    const offer = await bob.say(memberAuth, '[team] have qa check the sign-in page', { intent: 'team-assign', team: team.id, role: 'qa', message: 'Check the sign-in page' });
    assert.equal(offer.importance, 'needs-you');
    assert.match(offer.text, /Send this to qa on the .* team \(hosted on .*\)\?/);
    assert.deepEqual(offer.actions.map(action => action.id), ['team.run', 'organize.cancel']);
    assert.equal(requests.length, 0, 'nothing runs before the button');
    const unknown = await bob.say(memberAuth, '[team] have the designer draw it', { intent: 'team-assign', team: team.id, role: 'designer', message: 'Draw it' });
    assert.match(unknown.text, /has no member called designer\. Its members are lead, qa/);

    const pressed = await api<{ messages: BobMessage[] }>(member, memberAuth, 'POST', '/control-center/bob/action', { messageId: offer.id, actionId: 'team.run' });
    assert.equal(pressed.status, 200, JSON.stringify(pressed.body));
    assert.match(pressed.body.messages[0].text, /^Sent to qa on the .* team \(request \w{6}\)\. I'll bring its answer here when it is done/);
    assert.equal(bob.follows(member).length, 1, 'the promise is on disk');

    // The host tells this machine when it ends; Bob posts what came back. No one polls.
    const answered = await bob.eventually(memberAuth, /answered:/, 'qa answered');
    assert.match(answered.text, /qa on the .* team answered:\n\nBOB_TEAM_ANSWER/);
    assert.match(JSON.stringify(requests), /Check the sign-in page/);
    assert.deepEqual(bob.follows(member).map(row => row.state), ['done']);
    // It was the host's own notice that told this machine: the host's record of it is sent (this machine never restarted, so it asked no one).
    assert.deepEqual(bob.notices().map(row => row.state), ['sent']);

    // And the same request is now in the team's status, done.
    const again = await bob.say(memberAuth, '[team] and now?', { intent: 'team-status', team: team.id, role: 'qa' });
    assert.match(again.text, /1 done/);
  } finally { await bob.stop(); }
});

// The same gate with a team that really exists: Bob's agent for arranging work is never asked, whatever the words say.
test('with a team in the person\'s cluster, a message the decision model did not take for it still never starts the team step', { timeout: 240_000 }, async () => {
  const bob = await bobOnMember();
  const { memberAuth } = bob;
  try {
    // What Bob's agent would answer is missing, so if the team step started it would say it could not work out what to do.
    await rm(path.join(bob.directory, 'organize.json'), { force: true });
    await api(bob.member, memberAuth, 'POST', '/control-center/bob/message', { message: 'tell the team to have qa and lead check the sign-in page' });
    const said = (await bob.messages(memberAuth)).map(message => `${message.via ?? ''} ${message.text}`);
    assert.ok(said.length >= 1, 'the message was heard');
    assert.equal(said.some(line => /Organize ·|Team ·|could not work out what to change/.test(line)), false, said.join(' | '));
  } finally { await bob.stop(); }
});

// What Bob promised survives a restart of the person's machine: the answer comes when the machine is back.
test('a restart of the machine Bob runs on does not lose the answer he promised', { timeout: 300_000 }, async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const bob = await bobOnMember({ answer: 'ANSWER_AFTER_RESTART', hold: () => held });
  const { member, memberAuth, team, requests } = bob;
  try {
    const offer = await bob.say(memberAuth, '[team] have qa take its time', { intent: 'team-assign', team: team.id, role: 'qa', message: 'Take your time' });
    await api(member, memberAuth, 'POST', '/control-center/bob/action', { messageId: offer.id, actionId: 'team.run' });
    for (let i = 0; i < 300 && requests.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(requests.length, 1, 'the member is working');
    assert.deepEqual(bob.follows(member).map(row => row.state), ['following']);
    // This machine goes away, and the work ends while it is gone.
    const memberAfter = bob.restart('member');
    release();
    const auth = await memberAfter;
    // On its return the answer is brought, from what was kept on disk.
    const answered = await bob.eventually(auth, /answered:/, 'the answer after the restart');
    assert.match(answered.text, /ANSWER_AFTER_RESTART/);
    assert.deepEqual(bob.follows(member).map(row => row.state), ['done']);
    assert.equal((await bob.messages(auth)).filter(message => /answered:/.test(message.text)).length, 1, 'said once');
  } finally { release(); await bob.stop(); }
});

// The other way a machine learns of the end: it asks. Here the host's own notice is made to look lost, so only the question can bring it.
test('a machine that comes back asks its hosts, so an answer whose notice was lost still arrives', { timeout: 300_000 }, async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const bob = await bobOnMember({ answer: 'ANSWER_BY_ASKING', hold: () => held });
  const { member, memberAuth, host, hostAuth, team, requests } = bob;
  try {
    const offer = await bob.say(memberAuth, '[team] have qa take its time', { intent: 'team-assign', team: team.id, role: 'qa', message: 'Take your time' });
    await api(member, memberAuth, 'POST', '/control-center/bob/action', { messageId: offer.id, actionId: 'team.run' });
    for (let i = 0; i < 300 && requests.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(requests.length, 1, 'the member is working');
    await bob.down('member');
    release();
    // The host finishes with this machine away: the notice waits, then is made to look as if it had been sent and lost.
    for (let i = 0; i < 300; i++) {
      const state = (await api<any>(host, hostAuth, 'GET', `/team-hub/${team.id}/requests`)).body.requests?.[0]?.state;
      if (state === 'done') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.deepEqual(bob.notices().map(row => row.state), ['pending'], 'the host keeps what it owes an absent machine');
    bob.markNoticesSent();
    const auth = await bob.up('member');
    const answered = await bob.eventually(auth, /answered:/, 'the answer, asked for on the way back');
    assert.match(answered.text, /ANSWER_BY_ASKING/);
    assert.deepEqual(bob.follows(member).map(row => row.state), ['done']);
  } finally { release(); await bob.stop(); }
});

// The host restarting while it works does not leave the person waiting for ever either.
test('a restart of the team\'s host does not leave Bob waiting for ever', { timeout: 300_000 }, async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const bob = await bobOnMember({ answer: 'ANSWER_AFTER_HOST_RESTART', hold: () => held });
  const { member, memberAuth, team, requests } = bob;
  try {
    const offer = await bob.say(memberAuth, '[team] have qa take its time', { intent: 'team-assign', team: team.id, role: 'qa', message: 'Take your time' });
    await api(member, memberAuth, 'POST', '/control-center/bob/action', { messageId: offer.id, actionId: 'team.run' });
    for (let i = 0; i < 300 && requests.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(requests.length, 1, 'the member is working');
    const hostAfter = bob.restart('host');
    release();
    await hostAfter;
    // The turn the restart interrupted is gone with it: the host says so when it is back, and Bob tells the person once, plainly.
    const end = await bob.eventually(memberAuth, /stopped without a result/, 'that the request stopped');
    assert.match(end.text, /^qa on the .* team stopped without a result: what it already did stays done\. Ask me to run it again/);
    assert.deepEqual(bob.follows(member).map(row => row.state), ['done']);
    assert.equal((await bob.messages(memberAuth)).filter(message => /stopped without a result/.test(message.text)).length, 1, 'said once');
  } finally { release(); await bob.stop(); }
});
