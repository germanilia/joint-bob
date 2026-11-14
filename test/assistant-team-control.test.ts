import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './assistant-team-fixture.js';
import { recoverTeamWork, readTeamWork, assignmentDatabase, listTeamRequests } from '../src/assistant-teams/assignments.js';
import { saveTeamMembers, listTeamAgents, getTeam, TeamError } from '../src/assistant-teams/store.js';

/** Telegram's send API answers; every other fetch (the decision model) is down. */
function telegramOnly(sends: any[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('/sendMessage')) throw new Error('synthetic outage');
    sends.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, result: { message_id: 7000 + sends.length } });
  };
  return () => { globalThis.fetch = original; };
}
const settle = async (until: () => boolean) => { for (let i = 0; i < 150 && !until(); i++) await new Promise(resolve => setTimeout(resolve, 20)); };

test('the group can ask what the team is doing, stop a request, and run a stopped one again', async () => {
  const f = await fixture(), sends: any[] = [], restore = telegramOnly(sends);
  const say = async (text: string) => { const before = sends.length; await f.message(text); await recoverTeamWork(f.team.id); return before; };
  try {
    // The fixture host has no production guard, so the member cannot start: a stopped request to work with.
    const before = await say('/qa check the sign-in page');
    await settle(() => sends.slice(before).some(send => /runtime is unavailable/.test(send.text)));
    const [first] = await listTeamRequests(f.member);
    assert.equal(first.state, 'stopped');
    assert.match(first.text, /sign-in page/);

    let mark = await say('/status');
    assert.match(sends[mark].text, new RegExp(`1 stopped`));
    assert.match(sends[mark].text, new RegExp(`${first.shortId} · stopped · qa`));
    assert.match(sends[mark].text, /its machine or model was not ready/, 'the reason is shown, not an internal code');

    mark = await say(`/status ${first.shortId}`);
    assert.match(sends[mark].text, /qa: failed/);
    mark = await say('/status qa');
    assert.match(sends[mark].text, /qa: 1 stopped/);
    mark = await say('/help');
    assert.match(sends[mark].text, /\/qa .*\/status.*\/cancel.*\/retry/s);

    mark = await say('/retry');
    await settle(() => sends.slice(mark).some(send => /accepted; queued for qa/.test(send.text)));
    assert.ok(sends.slice(mark).some(send => /running \w{6} again as \w{6}/.test(send.text)), 'the group is told what the retry became');
    assert.ok(sends.slice(mark).some(send => /accepted; queued for qa/.test(send.text)), 'the new request is acknowledged like any other');
    let requests = await listTeamRequests(f.member);
    for (let i = 0; i < 150 && requests[0].state !== 'stopped'; i++) { await new Promise(resolve => setTimeout(resolve, 20)); requests = await listTeamRequests(f.member); }
    assert.equal(requests.length, 2);
    const [newest, oldest] = requests;
    assert.equal(oldest.state, 'cancelled', 'the old request is retired, never replayed');
    assert.equal(newest.state, 'stopped', 'the fixture host still cannot start the member');
    assert.equal(newest.text, first.text);
    assert.notEqual(newest.id, oldest.id);

    mark = await say('/cancel');
    assert.match(sends[mark].text, new RegExp(`cancelled ${newest.shortId} \\(qa\\)`));
    assert.equal((await listTeamRequests(f.member))[0].state, 'cancelled');

    mark = await say('/retry zzzzzz');
    assert.match(sends[mark].text, /No request or role is called zzzzzz/);
    mark = await say(`/retry ${oldest.shortId}`);
    assert.match(sends.slice(mark).map(send => send.text).join('\n'), /running \w{6} again as \w{6}/, 'a cancelled request may be run again on purpose');
  } finally { restore(); }
});

test('an explicit role call does not wait for the decision model', async () => {
  const f = await fixture(), sends: any[] = [], restore = telegramOnly(sends);
  try {
    await f.message('/designer sketch the settings page'); await recoverTeamWork(f.team.id);
    await settle(() => sends.some(send => /runtime is unavailable/.test(send.text)));
    const [work] = await readTeamWork(f.team.id);
    assert.equal(work.reason, 'runtime_unavailable', 'the call went as far as starting the member, with no decision model');
    assert.ok(!sends.some(send => /routing/.test(send.text)), 'no "routing unavailable" dead end');
  } finally { restore(); }
});

test('a request that stopped with an unknown outcome is reported, never silently held', async () => {
  const f = await fixture(), sends: any[] = [], restore = telegramOnly(sends);
  try {
    await f.message('/qa try something'); await recoverTeamWork(f.team.id);
    await settle(() => sends.some(send => /runtime is unavailable/.test(send.text)));
    const db = await assignmentDatabase();
    // Make it look as if the host restarted while the member was working.
    const row = db.prepare('SELECT id, record FROM assistant_team_assignments WHERE team_id=?').get(f.team.id) as { id: string; record: string };
    const assignment = { ...JSON.parse(row.record), state: 'running' };
    db.prepare('UPDATE assistant_team_assignments SET record=? WHERE id=?').run(JSON.stringify(assignment), row.id);
    const work = JSON.parse((db.prepare('SELECT record FROM assistant_team_work WHERE assignment_id=?').get(row.id) as { record: string }).record);
    db.prepare('UPDATE assistant_team_work SET phase=?, record=? WHERE assignment_id=?').run('dispatched', JSON.stringify({ ...work, phase: 'dispatched', reason: null }), row.id);
    sends.length = 0;
    await recoverTeamWork(f.team.id);
    await settle(() => sends.some(send => /stopped without a result/.test(send.text)));
    const notice = sends.find(send => /stopped without a result/.test(send.text));
    assert.ok(notice, 'the group is told');
    assert.match(notice.text, /Send \/retry \w{6}/);
    const count = sends.length;
    await recoverTeamWork(f.team.id);
    assert.equal(sends.length, count, 'the notice is sent once');
  } finally { restore(); }
});

test('the group commands cannot be taken as role names', async () => {
  const f = await fixture();
  const members = await listTeamAgents(f.team.id);
  const revision = (await getTeam(f.team.id)).revision;
  await assert.rejects(saveTeamMembers(f.team.id, [{ role: 'status', assistantId: members[0].assistantId }], null, revision), (error: unknown) => error instanceof TeamError && error.status === 400 && /status/.test(error.message));
});
