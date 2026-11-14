import assert from 'node:assert/strict';
import test from 'node:test';
import { api, signIn } from './dev-nodes.js';
import { startTeamHubFixture } from './team-hub-fixture.js';

// A team lives on one machine. A member of its cluster steers it from their own machine, over the signed machine channel.
test('a cluster member steers a team hosted on another machine: sees it, sends it work, reads the answer', { timeout: 180_000 }, async () => {
  const { host, member, hostEnv, memberEnv, hostAuth, memberAuth, team, requests, stop } = await startTeamHubFixture();
  try {
    // The member's own machine lists the team that the host runs, with who is on it.
    const listed = await api<any>(member, memberAuth, 'GET', '/team-hub?fresh=1');
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(listed.body.unreachable, [], 'every machine of the cluster answered');
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

    // The team's conversation is in the member's own project list, named for who did what rather than for the assistant's instructions.
    const projects = (await api<any>(member, memberAuth, 'GET', '/projects?syncStatus=false')).body.projects;
    const shared = projects.find((entry: any) => entry.name === 'Assistant team');
    assert.ok(shared, 'the team project is shared with the cluster');
    let mine: any;
    for (let i = 0; i < 100 && !mine; i++) { // the conversation record reaches the member machine a moment after the project
      mine = (await api<any>(member, memberAuth, 'GET', `/projects/${shared.id}/sessions`)).body.sessions.find((entry: any) => entry.id === view.assignments[0].conversationId);
      if (!mine) await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(mine, 'the team conversation is listed on the member machine');
    assert.equal(mine.title, 'qa: Check the sign-in page');

    // Nothing to cancel or retry once it is done, and the host says so plainly.
    const cancelled = await api<any>(member, memberAuth, 'POST', `/team-hub/${team.id}/cancel`, { ref: view.shortId });
    assert.equal(cancelled.status, 409, JSON.stringify(cancelled.body));
    assert.match(cancelled.body.error, /done/);
    // A role that is not on the team is refused by the host, not invented.
    assert.equal((await api<any>(member, memberAuth, 'POST', `/team-hub/${team.id}/assign`, { role: 'nobody', message: 'x' })).status, 404);
    // The same person signed in on the team's own machine with their own account (not through their machine) steers it as well.
    const visiting = await signIn(memberEnv, host);
    const visited = await api<any>(host, visiting, 'GET', '/team-hub?fresh=1');
    assert.equal(visited.status, 200, JSON.stringify(visited.body));
    assert.equal(visited.body.teams.find((entry: any) => entry.id === team.id)?.local, true, 'a visitor sees the team on the machine they are signed in to');
    const visitSent = await api<any>(host, visiting, 'POST', `/team-hub/${team.id}/assign`, { role: null, message: 'Visitor request' });
    assert.equal(visitSent.status, 200, JSON.stringify(visitSent.body));
    assert.equal(visitSent.body.request.assignments[0].role, 'lead', 'no role goes to the coordinator');
    // The host's own people steer it through the same hub, with nothing remote in between.
    const own = await api<any>(host, hostAuth, 'GET', '/team-hub?fresh=1');
    assert.equal(own.body.teams.find((entry: any) => entry.id === team.id)?.local, true);
  } finally { await stop(); }
});

// A request that is running on the host is stopped from the member's machine: the turn is told to stop and nothing comes back.
test('a running team request is stopped from another machine, and its late answer is dropped', { timeout: 180_000 }, async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const { member, memberAuth, team, requests, hostOutput, stop } = await startTeamHubFixture({ answer: 'LATE_ANSWER', hold: () => held });
  try {
    const sent = await api<any>(member, memberAuth, 'POST', `/team-hub/${team.id}/assign`, { role: 'qa', message: 'Take your time' });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    for (let i = 0; i < 300 && requests.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(requests.length, 1, 'the member is working: its model call is open');
    const running = (await api<any>(member, memberAuth, 'GET', `/team-hub/${team.id}/requests`)).body.requests[0];
    assert.equal(running.state, 'running');
    const cancelled = await api<any>(member, memberAuth, 'POST', `/team-hub/${team.id}/cancel`, { ref: null });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.request.state, 'cancelled');
    assert.equal(cancelled.body.stopFailures, 0, `the running turn was told to stop: ${hostOutput().split('\n').filter(line => /Could not stop/.test(line)).join(' | ')}`);
    release();
    await new Promise(resolve => setTimeout(resolve, 2000));
    const after = (await api<any>(member, memberAuth, 'GET', `/team-hub/${team.id}/requests`)).body.requests[0];
    assert.equal(after.state, 'cancelled', 'a late answer does not bring a cancelled request back');
    assert.equal(after.assignments[0].result, null);
  } finally { release(); await stop(); }
});
