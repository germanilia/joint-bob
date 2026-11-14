import assert from 'node:assert/strict';
import test from 'node:test';
import { api } from './dev-nodes.js';
import { startTeamHubFixture } from './team-hub-fixture.js';

// A team lives on one machine. A member of its cluster steers it from their own machine, over the signed machine channel.
test('a cluster member steers a team hosted on another machine: sees it, sends it work, reads the answer', { timeout: 180_000 }, async () => {
  const { host, member, hostAuth, memberAuth, team, requests, stop } = await startTeamHubFixture();
  try {
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
  } finally { await stop(); }
});
