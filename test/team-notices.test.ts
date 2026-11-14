import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { fixture } from './assistant-team-fixture.js';
import { getClusterNode } from '../src/cluster.js';
import { getOrCreateClusterIdentity } from '../src/cluster-identity.js';
import { ensureMembershipSchema } from '../src/cluster-membership.js';
import { addSharingMember, createSharingCluster } from '../src/cluster-sharing-policy.js';
import { clusterV2Database } from '../src/cluster-v2-store.js';
import { markPeerUnreachable, peerAway, resetPeerAvailability } from '../src/peer-presence.js';
import { listTeamRequests, runBrowserTeamAssignment } from '../src/assistant-teams/assignments.js';
import { flushTeamNotices, watchTeamRequest } from '../src/server/team-notices.js';

/** A machine of the person's cluster that records what the host sends it: the real signed post goes to a real address. */
async function homeMachine() {
  const received: Array<{ path: string; authorization: string | undefined; body: any }> = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      received.push({ path: request.url ?? '', authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ applied: 1 }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const close = () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  try {
    const nodeId = randomUUID(), clusterId = randomUUID(), local = await getClusterNode(), db = await clusterV2Database();
    getOrCreateClusterIdentity(db, local.id);
    ensureMembershipSchema(db);
    createSharingCluster(db, { id: clusterId, name: 'Notice fixture' }, local.id); // this machine manages it and is its first member
    addSharingMember(db, clusterId, local.id, nodeId, 1);
    db.prepare('INSERT INTO cluster_v2_membership_nodes VALUES(?,?,?,?,?,NULL)').run(clusterId, nodeId, 'Laptop', `http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'laptop-key');
    return { nodeId, received, close };
  } catch (error) { await close(); throw error; }
}

test('the host tells a member\'s machine its request ended, skips it while it is away, and tells it when it returns', async () => {
  const f = await fixture(), laptop = await homeMachine();
  const ended = async (text: string) => {
    await assert.rejects(runBrowserTeamAssignment(f.member, 'qa', `subject-${randomUUID()}`, randomUUID(), text)); // the fixture host cannot start a member: stopped
    return (await listTeamRequests(f.member)).find(request => request.text === text)!;
  };
  const owed = (rootId: string) => (f.db.prepare('SELECT state FROM assistant_team_notices WHERE root_id=?').all(rootId) as Array<{ state: string }>).map(row => row.state);
  try {
    // Reachable: told at once, over a signed request naming the team and carrying the request.
    const first = await ended('Check the first thing');
    await watchTeamRequest({ ...f.member, homeNodeId: laptop.nodeId }, f.team.id, first.id);
    assert.equal(laptop.received.length, 1);
    assert.equal(laptop.received[0].path, '/api/cluster/v2/assistant-teams/notice');
    assert.ok(laptop.received[0].authorization, 'signed');
    assert.equal(laptop.received[0].body.teamId, f.team.id);
    assert.equal(laptop.received[0].body.request.id, first.id);
    assert.deepEqual(owed(first.id), ['sent']);

    // Away: nothing is sent to it, and the word waits on disk.
    markPeerUnreachable(laptop.nodeId);
    assert.equal(peerAway(laptop.nodeId), true);
    const second = await ended('Check the second thing');
    await watchTeamRequest({ ...f.member, homeNodeId: laptop.nodeId }, f.team.id, second.id);
    await flushTeamNotices();
    assert.equal(laptop.received.length, 1, 'nothing is sent to a machine that is away');
    assert.deepEqual(owed(second.id), ['pending']);

    // Back: the same word goes out once it answers again, and not before.
    resetPeerAvailability();
    assert.equal(peerAway(laptop.nodeId), false);
    await flushTeamNotices({ home: randomUUID() });
    assert.equal(laptop.received.length, 1, 'a different machine returning does not send it');
    await flushTeamNotices({ home: laptop.nodeId });
    assert.equal(laptop.received.length, 2);
    assert.equal(laptop.received[1].body.request.id, second.id);
    assert.deepEqual(owed(second.id), ['sent']);
    await flushTeamNotices({ home: laptop.nodeId });
    assert.equal(laptop.received.length, 2, 'said once');
  } finally { await laptop.close(); }
});
