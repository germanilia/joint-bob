import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { fixture } from './assistant-team-fixture.js';
import { createLocalUser } from '../src/auth.js';
import { addClusterLocalMember, removeClusterLocalMember } from '../src/cluster-accounts.js';
import { guardTeamSocket } from '../src/server/team-socket-access.js';
import { harnessSessions, type SharedHarnessSession } from '../src/server/harness-sessions.js';

function socketFixture() {
  const socket = new EventEmitter() as EventEmitter & { send: (data: string) => void; close: (code: number) => void };
  const frames: string[] = [], closes: number[] = [];
  socket.send = data => { frames.push(data); };
  socket.close = code => { closes.push(code); socket.emit('close'); };
  return { socket: socket as unknown as WebSocket, frames, closes };
}

test('outbound team snapshot check blocks delivery and detaches before an invalidation notification', async () => {
  const f = await fixture(), client = socketFixture(), ordinary = socketFixture();
  const remaining = createLocalUser({ username: 'remaining', email: 'remaining@example.test' }).user;
  addClusterLocalMember(f.db, f.team.clusterId, remaining.accountId);
  const author = { accountId: f.session.accountId, username: f.session.username, homeNodeId: null, email: null };
  await guardTeamSocket(client.socket, f.team.projectId, author);
  await guardTeamSocket(ordinary.socket, 'ordinary-private-project', author);
  const shared = { projectId: f.team.projectId, engine: 'pi', session: { id: 'fixture' }, clients: new Set([client.socket]), idleTimer: null } as SharedHarnessSession;
  harnessSessions.set('synchronous-revocation-fixture', shared);
  try {
    client.socket.send('before');
    // Do not emit an invalidation or yield: the installed membership already changed.
    removeClusterLocalMember(f.db, f.team.clusterId, f.session.accountId);
    client.socket.send('secret-after-revocation');
    ordinary.socket.send('private-behavior-unchanged');
    assert.deepEqual(client.frames, ['before']);
    assert.deepEqual(client.closes, [1008]);
    assert.equal(shared.clients.size, 0, 'detached without waiting for a network close handshake');
    assert.deepEqual(ordinary.frames, ['private-behavior-unchanged']);
    assert.deepEqual(ordinary.closes, []);
  } finally {
    client.socket.emit('close');
    harnessSessions.delete('synchronous-revocation-fixture');
  }
});
