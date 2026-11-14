import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { api } from './dev-nodes.js';
import { startTeamHubFixture } from './team-hub-fixture.js';
import type { BobMessage } from '../src/control-center/bob-store.js';
import { mentionsTeam, teamIntentShapes } from '../src/server/control-center-team.js';
import { parseOrganizeIntent } from '../src/server/control-center-organize.js';

test('team intents fit their shapes, and a message speaks of a team by the word, its cluster or a member\'s role', () => {
  assert.deepEqual(parseOrganizeIntent('{"intent":"team-assign","team":"t1","role":"qa","message":"check the sign-in page"}'), { intent: 'team-assign', team: 't1', role: 'qa', message: 'check the sign-in page' });
  assert.deepEqual(parseOrganizeIntent('{"intent":"team-status","team":"t1","role":null}'), { intent: 'team-status', team: 't1', role: null });
  assert.equal(parseOrganizeIntent('{"intent":"team-assign","team":"t1","role":"qa","message":""}'), null);
  assert.equal(teamIntentShapes.length, 4);
  const teams = [{ id: 't1', name: 'Contigos', host: 'EC2', roles: ['qa', 'marketing'], coordinator: 'qa' }];
  assert.equal(mentionsTeam('ask the team what is stuck', []), true);
  assert.equal(mentionsTeam('have QA check the sign-in', teams), true, 'a member by its role');
  assert.equal(mentionsTeam('what is Contigos working on', teams), true, 'the cluster by its name');
  assert.equal(mentionsTeam('write a note about the qatar trip', teams), false, 'a word that merely contains a role');
  assert.equal(mentionsTeam('create a project called Billing', teams), false);
});

// Bob runs on the member's own machine; the team runs on the host. Bob's agent is stood in for: what it answers is intent.json.
test('Bob, on a cluster member\'s machine, reports on a team hosted elsewhere, sends it work after a press, and brings the answer back', { timeout: 240_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'team-bob-'));
  const { member, memberAuth, team, requests, stop } = await startTeamHubFixture({ answer: 'BOB_TEAM_ANSWER', memberEnv: { JOINT_BOB_TEST_AUTOMATION_DIR: directory } });
  const say = async (text: string, intent: unknown): Promise<BobMessage> => {
    await writeFile(path.join(directory, 'organize.json'), JSON.stringify(intent));
    const reply = await api<{ reply: BobMessage }>(member, memberAuth, 'POST', '/control-center/bob/message', { message: text });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    return reply.body.reply;
  };
  const messages = async () => (await api<{ messages: BobMessage[] }>(member, memberAuth, 'GET', '/control-center/bob/messages')).body.messages;
  try {
    // Reading needs no button.
    const status = await say('what is the team working on?', { intent: 'team-status', team: team.id, role: null });
    assert.equal(status.importance, 'fyi', status.text);
    assert.match(status.text, /lead \(coordinator\), qa/);
    assert.match(status.text, /No requests yet/);
    assert.match(status.text, /hosted on/);

    // Work waits for the person's button, and names the machine it will run on.
    const offer = await say('tell the team to have qa check the sign-in page', { intent: 'team-assign', team: team.id, role: 'qa', message: 'Check the sign-in page' });
    assert.equal(offer.importance, 'needs-you');
    assert.match(offer.text, /Send this to qa on the .* team \(hosted on .*\)\?/);
    assert.deepEqual(offer.actions.map(action => action.id), ['team.run', 'organize.cancel']);
    assert.equal(requests.length, 0, 'nothing runs before the button');
    const unknown = await say('tell the team\'s designer to draw it', { intent: 'team-assign', team: team.id, role: 'designer', message: 'Draw it' });
    assert.match(unknown.text, /has no member called designer\. Its members are lead, qa/);

    const pressed = await api<{ messages: BobMessage[] }>(member, memberAuth, 'POST', '/control-center/bob/action', { messageId: offer.id, actionId: 'team.run' });
    assert.equal(pressed.status, 200, JSON.stringify(pressed.body));
    assert.match(pressed.body.messages[0].text, /^Sent to qa on the .* team \(request \w{6}\)\. I'll bring its answer here when it is done\.$/);

    // The host runs it as the person; Bob posts what came back.
    let answered: BobMessage | undefined;
    for (let i = 0; i < 300 && !answered; i++) {
      answered = (await messages()).find(message => /answered:/.test(message.text));
      if (!answered) await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(answered, JSON.stringify((await messages()).map(message => message.text)));
    assert.match(answered.text, /qa on the .* team answered:\n\nBOB_TEAM_ANSWER/);
    assert.match(JSON.stringify(requests), /Check the sign-in page/);

    // And the same request is now in the team's status, done.
    const again = await say('what is the team doing now?', { intent: 'team-status', team: team.id, role: 'qa' });
    assert.match(again.text, /1 done/);
  } finally { await stop(); }
});
