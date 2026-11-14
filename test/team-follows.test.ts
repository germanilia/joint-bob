import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fixture } from './assistant-team-fixture.js';
import { bobDatabase, listBobMessages } from '../src/control-center/bob-store.js';
import { getClusterNode } from '../src/cluster.js';
import { listTeamRequests, runBrowserTeamAssignment, type TeamRequestView } from '../src/assistant-teams/assignments.js';
import { applyTeamNotice, closeTeamFollow, followTeamRequest, resumeTeamFollows } from '../src/server/team-follows.js';
import { flushTeamNotices, watchTeamRequest } from '../src/server/team-notices.js';

const view = (id: string, state: TeamRequestView['state'], result: string | null = null): TeamRequestView => ({
  id, shortId: id.slice(0, 6), text: 'Check it', requestedBy: 'x', chatId: 'browser', createdAt: new Date().toISOString(), browser: true, state,
  assignments: [{ role: 'qa', state: state === 'done' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'running', delegated: false, reason: null, conversationId: null, result }],
});
const ref = (hostNodeId: string, teamId = 'team-1') => ({ clusterId: randomUUID(), hostNodeId, teamId });
const said = async (accountId: string) => listBobMessages(await bobDatabase(), accountId, { limit: 50 }).map(message => message.text);
const rows = async () => (await bobDatabase()).prepare('SELECT request_id, state FROM bob_team_follows ORDER BY created_at').all() as Array<{ request_id: string; state: string }>;

test('only the machine that hosts the team can say a followed request ended, and it is said once', async () => {
  const accountId = `person-${randomUUID()}`, host = randomUUID(), request = `request-${randomUUID()}`;
  await followTeamRequest(accountId, ref(host), 'qa on the Contigos team', request);
  assert.equal(await applyTeamNotice(randomUUID(), view(request, 'done', 'FORGED')), 0, 'another machine cannot settle it');
  assert.equal(await applyTeamNotice(host, view(request, 'running')), 0, 'a request that is still running is not ended');
  assert.deepEqual((await said(accountId)), [], 'nothing said yet');
  assert.equal(await applyTeamNotice(host, view(request, 'done', 'THE ANSWER')), 1);
  assert.equal(await applyTeamNotice(host, view(request, 'done', 'THE ANSWER')), 0, 'a second notice, or a pull that learns the same, changes nothing');
  assert.deepEqual(await said(accountId), ['qa on the Contigos team answered:\n\nTHE ANSWER']);
});

test('a request the person stopped is closed without a word, and one that stopped on its own says why', async () => {
  const accountId = `person-${randomUUID()}`, host = randomUUID(), stopped = `request-${randomUUID()}`, cancelled = `request-${randomUUID()}`, mine = `request-${randomUUID()}`;
  for (const request of [stopped, cancelled, mine]) await followTeamRequest(accountId, ref(host), 'qa on the team', request);
  await closeTeamFollow(accountId, mine);
  assert.equal(await applyTeamNotice(host, view(mine, 'done', 'LATE')), 0, 'the person closed it');
  assert.equal(await applyTeamNotice(host, view(cancelled, 'cancelled')), 1, 'someone else cancelled it: settled');
  assert.deepEqual(await said(accountId), [], 'and nothing is said of a cancellation');
  assert.equal(await applyTeamNotice(host, view(stopped, 'stopped')), 1);
  assert.match((await said(accountId))[0], /^qa on the team stopped without a result\./);
});

test('what was followed for two weeks is dropped, and what is followed is kept on disk', async () => {
  const accountId = `person-${randomUUID()}`, old = `request-${randomUUID()}`, fresh = `request-${randomUUID()}`;
  const db = await bobDatabase();
  await followTeamRequest(accountId, ref(randomUUID()), 'old', old);
  db.prepare('UPDATE bob_team_follows SET created_at=? WHERE request_id=?').run(new Date(Date.now() - 15 * 24 * 3600_000).toISOString(), old);
  await followTeamRequest(accountId, ref(randomUUID()), 'new', fresh);
  assert.deepEqual((await rows()).filter(row => [old, fresh].includes(row.request_id)).map(row => [row.request_id, row.state]), [[fresh, 'following']]);
});

test('a host that cannot be asked leaves the follow where it is, and a team on this machine settles it from what it knows', async () => {
  const f = await fixture(), accountId = f.member.accountId, here = (await getClusterNode()).id;
  // The host is not reachable (it is not one of this machine's peers): the follow waits.
  const away = `request-${randomUUID()}`;
  await followTeamRequest(accountId, ref(randomUUID(), f.team.id), 'qa on a team far away', away);
  const quiet = console.warn; console.warn = () => undefined;
  try { await resumeTeamFollows(); } finally { console.warn = quiet; }
  assert.equal((await rows()).find(row => row.request_id === away)?.state, 'following');
  // A team here: its request ends (the fixture host cannot start a member), and asking settles the follow with no notice involved.
  await assert.rejects(runBrowserTeamAssignment(f.member, 'qa', 'subject', randomUUID(), 'inspect the outage'));
  const [request] = await listTeamRequests(f.member);
  assert.equal(request.state, 'stopped');
  await followTeamRequest(accountId, { clusterId: f.team.clusterId, hostNodeId: here, teamId: f.team.id }, 'qa on this machine', request.id);
  await resumeTeamFollows({ hostNodeId: here, teamId: f.team.id });
  assert.equal((await rows()).find(row => row.request_id === request.id)?.state, 'done');
  assert.ok((await said(accountId)).some(text => /^qa on this machine stopped without a result: its machine or model was not ready; nothing ran\./.test(text)));
  assert.equal((await rows()).find(row => row.request_id === away)?.state, 'following', 'the far one is untouched');
});

test('a machine that cannot be reached keeps its notice, and a request on this very machine owes no notice', async () => {
  const f = await fixture(), here = (await getClusterNode()).id, away = randomUUID();
  await assert.rejects(runBrowserTeamAssignment(f.member, 'qa', 'subject', randomUUID(), 'inspect the outage'));
  const [request] = await listTeamRequests(f.member);
  const db = f.db;
  const notices = () => (db.prepare('SELECT home_node_id, state FROM assistant_team_notices WHERE root_id=?').all(request.id) as Array<{ home_node_id: string; state: string }>).map(row => ({ ...row }));
  await flushTeamNotices(); // makes the table, as the server does at start
  await watchTeamRequest({ ...f.member, homeNodeId: here }, f.team.id, request.id);
  assert.deepEqual(notices(), [], 'a person on the host sees the change itself');
  await watchTeamRequest({ ...f.member, homeNodeId: away }, f.team.id, request.id);
  assert.deepEqual(notices(), [{ home_node_id: away, state: 'pending' }], 'the request ended, but that machine cannot be reached: it is owed the word');
  await flushTeamNotices();
  assert.deepEqual(notices(), [{ home_node_id: away, state: 'pending' }], 'still owed, and kept on disk');
});

test('the host\'s notice and a machine\'s own question arriving together settle it once', async () => {
  const accountId = `person-${randomUUID()}`, host = randomUUID(), request = `request-${randomUUID()}`;
  await followTeamRequest(accountId, ref(host), 'qa on the team', request);
  const counts = await Promise.all([1, 2, 3, 4].map(() => applyTeamNotice(host, view(request, 'done', 'ONCE'))));
  assert.equal(counts.reduce((sum, count) => sum + count, 0), 1);
  assert.deepEqual(await said(accountId), ['qa on the team answered:\n\nONCE']);
});
