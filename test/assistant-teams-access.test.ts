import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from './dev-nodes.js';
import { signedNodeRequest } from './signed-node-request.js';
import { getClusterNode } from '../src/cluster.js';
import { createAdministrator, localAccountIdForUsername, upsertReplicatedUser, type AuthSession } from '../src/auth.js';
import { accountIdFor } from '../src/accounts.js';
import { addClusterLocalMember } from '../src/cluster-accounts.js';
import { createMembershipCluster, createMembershipInvitation, prepareMembershipJoin, redeemMembershipInvitation, removeMembershipMember, closeMembershipCluster } from '../src/cluster-membership.js';
import { clusterPublicKeyFingerprint } from '../src/cluster-identity.js';
import { teamDatabase, createTeam, prepareTeamProject, getTeam, saveTeamSettings, insertTeamAssignment, getTeamAssignment, onTeamChange } from '../src/assistant-teams/store.js';
import { requireClusterMember, requireTeamMember, requireTeamExecution, requirePeerClusterMember } from '../src/assistant-teams/access.js';

const status = (code: number) => (error: unknown) => (error as { status: number }).status === code;
function session(accountId: string, username: string, homeNodeId: string | null): AuthSession {
  return { id: randomUUID(), userId: randomUUID(), accountId, username, homeNodeId, isRemoteLogin: !!homeNodeId, email: null, role: homeNodeId ? null : 'admin', csrfToken: 'fixture', mustChangePassword: false };
}

test('signed non-twin membership, equal access, dedicated storage and received revocation', async () => {
  const db = await teamDatabase();
  const host = await getClusterNode();
  createAdministrator('teamfixture', 'Synthetic-password-123!', false);
  const account = localAccountIdForUsername('teamfixture')!;
  const local = session(account, 'teamfixture', null);
  const clusterId = randomUUID();
  createMembershipCluster(db, { nodeId: host.id, name: 'host', url: 'http://127.0.0.1:19001' }, { id: clusterId, name: 'Contigos fixture' });
  addClusterLocalMember(db, clusterId, account);
  const remoteDb = new DatabaseSync(':memory:');
  const home = randomUUID();
  try {
    const invitation = createMembershipInvitation(db, host.id, host.id, clusterId, 1);
    const request = prepareMembershipJoin(remoteDb, { nodeId: home, name: 'independent home', url: 'http://127.0.0.1:19002' }, invitation, clusterPublicKeyFingerprint(invitation.body.manager.publicKey), randomUUID());
    redeemMembershipInvitation(db, host.id, request, invitation.secret);
    const remoteAccount = accountIdFor(home, 'secondfixture');
    upsertReplicatedUser({ homeNodeId: home, username: 'secondfixture', accountId: remoteAccount, passwordHash: Buffer.from('synthetic'), passwordSalt: Buffer.from('synthetic'), mfaRequired: false, clusterIds: [clusterId] });
    const remote = session(remoteAccount, 'secondfixture', home);
    const actor = await requireClusterMember(local, clusterId);
    const stored = db.prepare('SELECT snapshot FROM cluster_v2_membership_snapshots WHERE cluster_id=?').get(clusterId) as { snapshot: string };
    const tampered = JSON.parse(stored.snapshot); tampered.signature = 'A'.repeat(tampered.signature.length);
    db.prepare('UPDATE cluster_v2_membership_snapshots SET snapshot=? WHERE cluster_id=?').run(JSON.stringify(tampered), clusterId);
    await assert.rejects(requireClusterMember(local, clusterId), status(403));
    db.prepare('UPDATE cluster_v2_membership_snapshots SET snapshot=? WHERE cluster_id=?').run(stored.snapshot, clusterId);
    await assert.rejects(prepareTeamProject({ ...actor }), status(403), 'request-shaped actors are not authorization');
    const projectId = await prepareTeamProject(actor);
    await assert.rejects(createTeam(actor, { projectId, executorAccountId: remoteAccount }), status(403));
    const team = await createTeam(actor, { projectId, executorAccountId: account });
    await assert.rejects(createTeam(actor, { projectId, executorAccountId: account }), status(409));
    assert.deepEqual(team.settings, { askThreshold: .8, actThreshold: .95 });
    assert.equal((await requireTeamMember(local, team.id)).teamId, team.id);
    assert.equal((await requireTeamMember(remote, team.id)).teamId, team.id);
    assert.deepEqual(await getTeam(team.id), team);
    assert.equal((await requireTeamExecution(team.id, remoteAccount)).accountId, remoteAccount, 'no online-home request needed');
    await requirePeerClusterMember(home, { clusterId, accountId: remoteAccount, homeNodeId: home, username: 'secondfixture' });
    upsertReplicatedUser({ homeNodeId: home, username: 'secondfixture', accountId: remoteAccount, passwordHash: Buffer.from('synthetic'), passwordSalt: Buffer.from('synthetic'), mfaRequired: false, clusterIds: [] });
    await assert.rejects(requireTeamExecution(team.id, remoteAccount), status(403), 'received visitor departure supersedes a cached peer claim');
    upsertReplicatedUser({ homeNodeId: home, username: 'secondfixture', accountId: remoteAccount, passwordHash: Buffer.from('synthetic'), passwordSalt: Buffer.from('synthetic'), mfaRequired: false, clusterIds: [clusterId] });
    await assert.rejects(requireTeamMember(session(remoteAccount, 'secondfixture', randomUUID()), team.id), status(403));
    await assert.rejects(requireTeamMember(session(accountIdFor(home, 'outsider'), 'outsider', home), team.id), status(403));
    await assert.rejects(requireClusterMember(local, randomUUID()), status(403));
    await assert.rejects(requireTeamMember(local, randomUUID()), status(404));
    await assert.rejects(createTeam(actor, { projectId: 'private-project', executorAccountId: account }), status(409));
    const member = await requireTeamMember(remote, team.id);
    const changes: string[] = []; const stop = onTeamChange(id => changes.push(id));
    const changed = await saveTeamSettings(member, { askThreshold: .7, actThreshold: .9 }, 1);
    stop(); assert.equal(changed.revision, 2); assert.deepEqual(changes, [team.id]);
    await assert.rejects(saveTeamSettings(member, team.settings, 1), status(409));
    await assert.rejects(saveTeamSettings(member, { askThreshold: .9, actThreshold: .9 }, 2), status(400));
    const assignment = { id: randomUUID(), teamId: team.id, rootId: randomUUID(), parentId: null, subjectId: null, role: 'qa' as const, requestedBy: remoteAccount, sourceMessageId: 'fixture-message', destination: { kind: 'group' as const, sourceMessageId: 'fixture-message' }, state: 'accepted' as const, requestId: randomUUID() };
    await insertTeamAssignment(assignment); assert.deepEqual(await getTeamAssignment(assignment.id), assignment);
    removeMembershipMember(db, host.id, host.id, clusterId, home, 1);
    await assert.rejects(requireTeamMember(remote, team.id), status(403));
    await assert.rejects(requireTeamExecution(team.id, remoteAccount), status(403));
    await assert.rejects(saveTeamSettings(member, team.settings, 2), status(403));
    closeMembershipCluster(db, host.id, host.id, clusterId, 1);
    await assert.rejects(requireTeamMember(local, team.id), status(403));
  } finally { remoteDb.close(); }
});

test('HTTP and signed peer facade authenticate the selected cluster and account, never relay proximity', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-api-'));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const envA = await seedDevEnvironment(path.join(root, 'a'), 1);
    const envB = await seedDevEnvironment(path.join(root, 'b'), 1);
    const envC = await seedDevEnvironment(path.join(root, 'c'), 1);
    const a = envA.nodes[0], b = envB.nodes[0], c = envC.nodes[0];
    children.push(await startDevNode(envA, a), await startDevNode(envB, b), await startDevNode(envC, c));
    const sa = await signIn(envA, a), sb = await signIn(envB, b), sc = await signIn(envC, c);
    assert.equal((await fetch(`${a.url}/api/relay/serving`, { method: 'PUT', headers: { Cookie: sa.cookie, 'x-csrf-token': sa.csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, origin: `http://localhost:${a.port}`, environment: 'test', requestsEnabled: true, maxMachines: 10, monthlyCapGb: 0, alertTopic: '' }) })).status, 204);
    for (const [node, login, label] of [[b, sb, 'member'], [c, sc, 'outsider']] as const) {
      const token = await api<{ link: string }>(a, sa, 'POST', '/relay/serving/tokens', { label });
      assert.equal((await api(node, login, 'POST', '/relays', { link: token.body.link })).status, 201);
    }
    for (const [node, login] of [[b, sb], [c, sc]] as const) {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const me = await api<{ relays: Array<{ relayNodeId: string; active: boolean }> }>(node, login, 'GET', '/social/me');
        if (me.body.relays.some(r => r.relayNodeId === a.nodeId && r.active)) break;
        assert.ok(Date.now() < deadline, 'fixture members share the live relay');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    async function cluster(name: string) {
      const created = await api<{ snapshot: { body: { clusterId: string } } }>(a, sa, 'POST', '/clusters', { name });
      assert.equal(created.status, 201);
      const id = created.body.snapshot.body.clusterId;
      const invite = await api<{ link: string }>(a, sa, 'POST', `/clusters/${id}/invitations`, { expectedEpoch: 1 });
      assert.equal((await api(b, sb, 'POST', '/clusters/join', { link: invite.body.link, requestId: randomUUID() })).status, 201);
      return id;
    }
    const clusterId = await cluster('team selected');
    const otherCluster = await cluster('same transport different cluster');
    const created = await api<{ team: { id: string; projectId: string; settings: { askThreshold: number; actThreshold: number } } }>(a, sa, 'POST', '/assistant-teams', { clusterId });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const teamId = created.body.team.id;
    const outsider = await signedNodeRequest(envC, c, a, 'POST', '/api/cluster/v2/assistant-teams/get', {
      member: { clusterId, accountId: accountIdFor(c.nodeId, envC.username), homeNodeId: c.nodeId, username: envC.username }, teamId,
    });
    assert.equal(outsider.status, 403, 'a real same-relay outsider has no team access');
    assert.ok(!a.projects.some(p => p.id === created.body.team.projectId), 'never adopts seeded private projects');
    const claim = { clusterId, accountId: accountIdFor(b.nodeId, envB.username), homeNodeId: b.nodeId, username: envB.username };
    const peer = (operation: string, body: unknown) => signedNodeRequest(envB, b, a, 'POST', `/api/cluster/v2/assistant-teams/${operation}`, body);
    const view = await peer('get', { member: claim, teamId });
    assert.equal(view.status, 200, await view.clone().text());
    const remoteView = await view.json();
    assert.deepEqual(remoteView.team, created.body.team);
    assert.ok(remoteView.snapshotRevision > 0, 'diagnostics identify the installed snapshot revision');
    const localList = await api<{ teams: unknown[] }>(a, sa, 'GET', `/assistant-teams?clusterId=${clusterId}`);
    const peerList = await peer('list', { member: claim });
    assert.equal(peerList.status, 200);
    assert.deepEqual((await peerList.json()).teams, localList.body.teams);
    assert.equal((await peer('create', { member: claim })).status, 409);
    assert.equal((await peer('get', { member: { ...claim, clusterId: otherCluster }, teamId })).status, 403);
    assert.equal((await peer('get', { member: { ...claim, homeNodeId: a.nodeId }, teamId })).status, 403);
    assert.equal((await peer('get', { member: { ...claim, accountId: accountIdFor(a.nodeId, envA.username) }, teamId })).status, 403);
    assert.equal((await peer('get', { member: { ...claim, clusterId: randomUUID() }, teamId })).status, 403);
    assert.equal((await peer('get', { member: claim, teamId: randomUUID() })).status, 404);
    assert.equal((await peer('settings', { member: claim, teamId, settings: { askThreshold: .6, actThreshold: .9 }, expectedRevision: 1 })).status, 200);
    assert.equal((await api(a, sa, 'PUT', `/assistant-teams/${teamId}/settings`, { settings: { askThreshold: .7, actThreshold: .9 }, expectedRevision: 1 })).status, 409);
    assert.equal((await api(a, sa, 'POST', '/assistant-teams', { clusterId, executorAccountId: claim.accountId })).status, 400);
    assert.equal((await fetch(`${a.url}/api/assistant-teams?clusterId=${clusterId}`)).status, 401);
    assert.equal((await fetch(`${a.url}/api/assistant-teams/${teamId}/settings`, { method: 'PUT', headers: { Cookie: sa.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: { askThreshold: .7, actThreshold: .9 }, expectedRevision: 2 }) })).status, 403);
    assert.equal((await fetch(`${a.url}/api/cluster/v2/assistant-teams/get`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member: claim, teamId }) })).status, 401);
  } finally {
    await Promise.all(children.map(child => stopDevNode(child)));
    await rm(root, { recursive: true, force: true });
  }
});
