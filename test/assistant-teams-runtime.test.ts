import { seedTeamMembers } from './team-members-fixture.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from './dev-nodes.js';
import { getClusterNode } from '../src/cluster.js';
import { createAdministrator, createLocalUser, localAccountIdForUsername, type AuthSession } from '../src/auth.js';
import { addClusterLocalMember } from '../src/cluster-accounts.js';
import { createMembershipCluster } from '../src/cluster-membership.js';
import { requireClusterMember } from '../src/assistant-teams/access.js';
import { teamDatabase, createTeam, prepareTeamProject, insertTeamAssignment } from '../src/assistant-teams/store.js';
import { runTeamTurn, teamConversation, teamAssignmentDestination, teamQueuedTurn } from '../src/assistant-teams/runtime.js';
import { getPersonalAssistant, getPersonalAssistantSourceHistory, savePersonalAssistant, beginPersonalAssistantTurn } from '../src/personal-assistants.js';
import { DEFAULT_GUARDIAN_SETTINGS } from '../src/guardian/rules.js';
import { PRODUCTION_RULE } from '../src/guardian/production-rule.js';
import { openNodeDatabase } from "../src/node-database.js";

test('picked members with free roles keep their own settings; assignment and machine checks precede execution', async () => {
  const db = await teamDatabase(); const host = await getClusterNode();
  createAdministrator('runtimefixture', 'Synthetic-password-123!', false);
  const account = localAccountIdForUsername('runtimefixture')!;
  const session: AuthSession = { id: randomUUID(), userId: randomUUID(), accountId: account, username: 'runtimefixture', homeNodeId: null, isRemoteLogin: false, email: null, role: 'admin', csrfToken: '', mustChangePassword: false };
  const clusterId = randomUUID();
  createMembershipCluster(db, { nodeId: host.id, name: 'EC2 fixture', url: 'http://127.0.0.1:19001' }, { id: clusterId, name: 'team' });
  addClusterLocalMember(db, clusterId, account);
  const actor = await requireClusterMember(session, clusterId);
  const team = await createTeam(actor, { projectId: await prepareTeamProject(actor), executorAccountId: account });
  const [agents, retry] = await Promise.all([seedTeamMembers(team), seedTeamMembers(team)]);
  assert.deepEqual(agents, retry);
  assert.deepEqual(agents.map(a => a.role).sort(), ['bob', 'designer', 'pr_reviewer', 'product', 'qa', 'support']);
  assert.equal(new Set(agents.map(a => a.assistantId)).size, 6);
  const profiles = await Promise.all(agents.map(a => getPersonalAssistant(account, a.assistantId)));
  for (const profile of profiles) {
    assert.equal(profile!.nodeId, host.id);
    assert.deepEqual(await getPersonalAssistantSourceHistory(account, profile!.id), []);
    assert.equal(await teamConversation(profile!.projectId, profile!.sessionId), null, "an assistant's own conversation is never team work");
  }
  const { getTeam, saveTeamMembers, teamCoordinator } = await import('../src/assistant-teams/store.js');
  assert.equal(await teamCoordinator(await getTeam(team.id)), 'bob');
  const current = agents.map(({ role, assistantId }) => ({ role, assistantId })), revision = (await getTeam(team.id)).revision;
  await assert.rejects(saveTeamMembers(team.id, [...current, { role: 'qa', assistantId: randomUUID() }], 'bob', revision), /unique role/);
  await assert.rejects(saveTeamMembers(team.id, [{ ...current[0], role: 'Bad Role' }], null, revision), /unique role/);
  await assert.rejects(saveTeamMembers(team.id, current, 'nobody', revision), /coordinator/);
  await assert.rejects(saveTeamMembers(team.id, current, 'bob', revision - 1), /Stale/);
  const renamed = current.map(member => member.role === 'qa' ? { ...member, role: 'tester' } : member);
  await saveTeamMembers(team.id, renamed, 'product', revision);
  assert.equal(await teamCoordinator(await getTeam(team.id)), 'product');
  await saveTeamMembers(team.id, current, 'bob', revision + 1);
  await savePersonalAssistant(account, { ...profiles[0]!, instructions: 'Only this role' }, profiles[0]!.id);
  assert.notEqual((await getPersonalAssistant(account, profiles[1]!.id))!.instructions, 'Only this role');
  const second = createLocalUser({ username: 'secondruntime', email: 'second@example.test' }).user;
  addClusterLocalMember(db, clusterId, second.accountId);
  const assignment = { id: randomUUID(), teamId: team.id, rootId: randomUUID(), parentId: null, subjectId: 'subject-a', role: 'qa' as const, requestedBy: second.accountId, sourceMessageId: 'message', destination: { kind: 'group' as const, sourceMessageId: 'message' }, state: 'accepted' as const, requestId: randomUUID() };
  await assert.rejects(runTeamTurn({ assignment, message: 'hello' }), /assignment/i);
  await insertTeamAssignment(assignment);
  const resolved = await teamAssignmentDestination(assignment);
  assert.equal(resolved.member.accountId, second.accountId);
  assert.notEqual(resolved.member.accountId, resolved.team.executorAccountId, 'initiating human is not impersonated executor');
  await beginPersonalAssistantTurn(account, resolved.profile.id, assignment.requestId, `${resolved.destination.engine}:${resolved.destination.sessionId}`, 'hello', 'assistant');
  assert.equal((await teamQueuedTurn(team.projectId, resolved.destination.sessionId, assignment.requestId, second.accountId, account, 'hello'))!.member.accountId, second.accountId);
  await assert.rejects(teamQueuedTurn(team.projectId, resolved.destination.sessionId, assignment.requestId, account, account, 'hello'), /member mismatch/);
  await assert.rejects(teamQueuedTurn(team.projectId, resolved.destination.sessionId, assignment.requestId, second.accountId), /member mismatch/);
  await assert.rejects(teamQueuedTurn(team.projectId, resolved.destination.sessionId, assignment.requestId, second.accountId, account, 'different'), /server-issued/);
  await assert.rejects(runTeamTurn({ assignment: { ...assignment, role: 'bob' }, message: 'hello' }), /assignment/i);
  for (const change of [{ subjectId: null }, { state: 'cancelled' as const }]) {
    const blocked = { ...assignment, ...change, id: randomUUID(), requestId: randomUUID() };
    await insertTeamAssignment(blocked);
    await assert.rejects(runTeamTurn({ assignment: blocked, message: 'must not run' }), /not executable/);
  }
  db.prepare('UPDATE assistant_teams SET host_node_id=? WHERE id=?').run(randomUUID(), team.id);
  await assert.rejects(runTeamTurn({ assignment, message: 'hello' }), /host|machine/i);
  db.prepare('UPDATE assistant_teams SET host_node_id=? WHERE id=?').run(host.id, team.id);
  assert.equal(await teamConversation('private', profiles[0]!.sessionId), null);
});

test('real team HTTP to queue to synthetic provider: subject continuity, isolation and receipts', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-queue-'));
  const requests: any[] = [];
  const provider = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'dev-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const request = requests.at(-1);
    const serialized = JSON.stringify(request.messages);
    const lastUser = JSON.stringify([...request.messages].reverse().find((m: any) => m.role === 'user')?.content ?? '');
    if (serialized.includes('LIVE_BOB_DELEGATION') && !String(lastUser).includes('stored INTERNAL ONLY child results') && !request.messages.some((m: any) => m.role === 'tool')) {
      if (!request.tools?.some((t: any) => t.function.name === 'mcp__joint_bob__team_delegate')) {
        res.write(chunk({ role: 'assistant', content: `MISSING_TEAM_TOOLS:${JSON.stringify(request.tools?.map((t: any) => t.function.name))}` }, null)); res.write(chunk({}, 'stop')); res.end('data: [DONE]\n\n'); return;
      }
      res.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'delegate-fixture', type: 'function', function: { name: 'mcp__joint_bob__team_delegate', arguments: JSON.stringify({ role: 'support', message: 'CHILD_SUPPORT_EVIDENCE' }) } }] }, null));
      res.write(chunk({}, 'tool_calls')); res.end('data: [DONE]\n\n'); return;
    }
    const answer = String(lastUser).includes('stored INTERNAL ONLY child results') ? 'BOB_FINAL_FROM_CHILD' : serialized.includes('LIVE_BOB_DELEGATION') ? 'PREMATURE_ROOT_DO_NOT_PUBLISH' : serialized.includes('CHILD_SUPPORT_EVIDENCE') ? 'CHILD_COMPLETED_EVIDENCE' : 'Team fixture answer';
    res.write(chunk({ role: 'assistant', content: answer }, null));
    res.write(chunk({}, 'stop')); res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  let child: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const env = await seedDevEnvironment(root, 1); const node = env.nodes[0];
    const seedMember = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
      const { createLocalUser, authenticate, changePassword } = await import('./src/auth.ts');
      const { getClusterNode } = await import('./src/cluster.ts'); await getClusterNode();
      const created = createLocalUser({username:'teamhuman',email:'teamhuman@example.test'});
      const session = authenticate('teamhuman', created.oneTimePassword);
      changePassword(session, created.oneTimePassword, 'Synthetic-member-password-123!');
      console.log(JSON.stringify(created.user));
    `], { env: { ...process.env, HOME: env.home, NODE_ENV: 'test', JOINT_BOB_DATA_DIR: node.dataDir } });
    const human = JSON.parse(seedMember.stdout.trim().split('\n').at(-1)!);
    const address = provider.address() as { port: number };
    await writeFile(path.join(env.home, '.pi', 'models.json'), JSON.stringify({ providers: { 'dev-environment': { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'synthetic', models: [{ id: 'dev-model' }] } } }));
    await mkdir(path.join(env.home, '.pi', 'skills', 'private-only'), { recursive: true });
    await writeFile(path.join(env.home, '.pi', 'skills', 'private-only', 'SKILL.md'), '---\nname: private-only\ndescription: PRIVATE_SKILL_MUST_NOT_LEAK\n---\nPrivate instructions.');
    await writeFile(path.join(env.home, '.pi', 'AGENTS.md'), 'PRIVATE_INSTRUCTIONS_MUST_NOT_LEAK');
    child = await startDevNode(env, node); const auth = await signIn(env, node);
    const cluster = await api<any>(node, auth, 'POST', '/clusters', { name: 'Team execution fixture' });
    assert.equal(cluster.status, 201);
    const created = await api<any>(node, auth, 'POST', '/assistant-teams', { clusterId: cluster.body.snapshot.body.clusterId });
    assert.equal(created.status, 201, JSON.stringify(created.body)); const team = created.body.team;
    const membershipDb = openNodeDatabase(path.join(node.dataDir, 'node.db'));
    try { addClusterLocalMember(membershipDb, team.clusterId, human.accountId); } finally { membershipDb.close(); }
    const humanAuth = await signIn({ ...env, username: 'teamhuman', password: 'Synthetic-member-password-123!' }, node);
    // Members are the owner's ordinary assistants, picked in with free role names.
    const settings = { harnessId: 'pi', provider: 'dev-environment', modelId: 'dev-model', reasoning: 'off' };
    const call = (method: string, route: string, body?: unknown) => api<any>(node, auth, method as any, route, body);
    const { addNodeMembers } = await import('./team-members-fixture.js');
    const picked = await addNodeMembers(call, node.projects.map((p: any) => p.id), team.id, [{ role: 'bob', instructions: 'Team bob' }, { role: 'qa', instructions: 'OWN_QA_INSTRUCTIONS' }, { role: 'support', instructions: 'Team support' }], 'bob', settings);
    const agents = await api<any>(node, auth, 'GET', `/assistant-teams/${team.id}/agents`);
    assert.deepEqual(agents.body.agents.map((a: any) => a.role), ['bob', 'qa', 'support']); assert.equal(agents.body.coordinatorRole, 'bob');
    assert.equal(requests.length, 0, 'picking members never runs a model');
    assert.ok(agents.body.agents.every((agent: any) => agent.readiness.some((problem: string) => /production.*guard/i.test(problem))), 'missing production guard blocks effect-capable readiness, including file tools');
    const guard = await api<any>(node, auth, 'PUT', '/guardian', { settings: { ...DEFAULT_GUARDIAN_SETTINGS, enabled: true, rules: [PRODUCTION_RULE] } });
    assert.equal(guard.status, 200, JSON.stringify(guard.body));
    const qa = picked.qa as any;
    const available = await api<any>(node, humanAuth, 'GET', `/assistant-teams/${team.id}/available-assistants`);
    assert.deepEqual(available.body.assistants, [], 'only your own assistants are offered');
    const revision = (await api<any>(node, auth, 'GET', `/assistant-teams/${team.id}`)).body.team.revision;
    const unowned = await api<any>(node, humanAuth, 'PUT', `/assistant-teams/${team.id}/members`, { expectedRevision: revision, coordinatorRole: 'bob', members: [...agents.body.agents.map((a: any) => ({ role: a.role, assistantId: a.assistantId })), { role: 'extra', assistantId: picked.bob.id }] });
    assert.equal(unowned.status, 400, 'one assistant cannot hold two roles');
    const requestId = randomUUID();
    const endpoint = `/assistant-teams/${team.id}/agents/qa/turn`;
    const first = await api<any>(node, humanAuth, 'POST', endpoint, { subjectId: 'alpha', requestId, message: 'First team question' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.text, 'Team fixture answer'); assert.notEqual(first.body.conversationId, qa.sessionId, 'team work gets its own conversation');
    const repeated = await api<any>(node, humanAuth, 'POST', endpoint, { subjectId: 'alpha', requestId, message: 'First team question' });
    assert.deepEqual(repeated.body, first.body); assert.equal(requests.length, 1, 'confirmed receipt is reused');
    const second = await api<any>(node, auth, 'POST', endpoint, { subjectId: 'alpha', requestId: randomUUID(), message: 'Follow up' });
    assert.equal(second.status, 200, JSON.stringify(second.body)); assert.equal(second.body.conversationId, first.body.conversationId);
    const other = await api<any>(node, auth, 'POST', endpoint, { subjectId: 'beta', requestId: randomUUID(), message: 'Different subject' });
    assert.equal(other.status, 200, JSON.stringify(other.body)); assert.notEqual(other.body.conversationId, first.body.conversationId);
    assert.equal(requests.length, 3, 'only accepted turns, never a private classifier or source placeholder');
    const serialized = JSON.stringify(requests);
    assert.match(serialized, /OWN_QA_INSTRUCTIONS/, 'a member brings its own instructions');
    assert.doesNotMatch(serialized, /PRIVATE_SKILL_MUST_NOT_LEAK|PRIVATE_INSTRUCTIONS_MUST_NOT_LEAK/, 'machine skills outside the app still stay out');
    assert.ok(requests.every(request => !(request.tools ?? []).some((tool: any) => /bash|terminal/.test(tool.function?.name))), "the member's own terminal policy applies");
    // Actual Bob Pi tools -> durable child -> stored-result continuation, without an in-memory wait tool.
    const bobRequest = randomUUID();
    const delegated = await api<any>(node, auth, 'POST', `/assistant-teams/${team.id}/agents/bob/turn`, { subjectId: 'delegated', requestId: bobRequest, message: 'LIVE_BOB_DELEGATION' });
    assert.equal(delegated.status, 409, `premature root answer is withheld: ${JSON.stringify(delegated.body)}`);
    assert.doesNotMatch(JSON.stringify(delegated.body), /PREMATURE_ROOT/);
    const db = openNodeDatabase(path.join(node.dataDir, 'node.db'));
    try {
      const deadline = Date.now() + 20000;
      let rootWork: any;
      do {
        rootWork = db.prepare(`SELECT w.record FROM assistant_team_work w JOIN assistant_team_assignments a ON a.id=w.assignment_id WHERE json_extract(a.record,'$.role')='bob' AND json_extract(a.record,'$.subjectId')='delegated'`).get() as any;
        if (rootWork && JSON.parse(rootWork.record).result === 'BOB_FINAL_FROM_CHILD') break;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      assert.equal(rootWork && JSON.parse(rootWork.record).result, 'BOB_FINAL_FROM_CHILD', JSON.stringify(rootWork));
      const childWork = db.prepare(`SELECT w.record FROM assistant_team_work w JOIN assistant_team_assignments a ON a.id=w.assignment_id WHERE json_extract(a.record,'$.parentId') IS NOT NULL`).all() as any[];
      assert.equal(childWork.length, 1); assert.equal(JSON.parse(childWork[0].record).result, 'CHILD_COMPLETED_EVIDENCE'); assert.equal(JSON.parse(childWork[0].record).consumed, true);
      assert.ok(requests.some(r => JSON.stringify(r.messages).includes('CHILD_COMPLETED_EVIDENCE') && JSON.stringify(r.messages).includes('stored INTERNAL ONLY')));
      const attribution = db.prepare('SELECT account_id FROM conversation_message_authors WHERE project_id=? AND conversation_id=? AND account_id=?').get(team.projectId, first.body.conversationId, human.accountId) as { account_id: string };
      const assignment = JSON.parse((db.prepare('SELECT record FROM assistant_team_assignments WHERE request_id=?').get(requestId) as { record: string }).record);
      assert.equal(attribution.account_id, assignment.requestedBy);
      assert.equal(attribution.account_id, human.accountId, 'the queued transcript attributes the actual member');
      assert.notEqual(attribution.account_id, team.executorAccountId, 'the owner account is not impersonated');
      // Real server restart: confirmed receipts are reconciled; missing dispatch receipts are held, not retried.
      await stopDevNode(child); child = undefined;
      const rootState = JSON.parse(rootWork.record);
      rootState.phase = 'dispatched'; rootState.result = null;
      db.prepare('UPDATE assistant_team_work SET phase=?,record=? WHERE assignment_id=?').run('dispatched', JSON.stringify(rootState), rootState.assignmentId);
      const rootAssignment = JSON.parse((db.prepare('SELECT record FROM assistant_team_assignments WHERE id=?').get(rootState.assignmentId) as any).record);
      const uncertain = { ...rootAssignment, id: randomUUID(), role: 'qa', state: 'running', requestId: randomUUID() };
      db.prepare('INSERT INTO assistant_team_assignments VALUES(?,?,?,?)').run(uncertain.id, team.id, uncertain.requestId, JSON.stringify(uncertain));
      db.prepare('INSERT INTO assistant_team_work VALUES(?,?,?)').run(uncertain.id, 'dispatched', JSON.stringify({ ...rootState, assignmentId: uncertain.id }));
      const beforeRestart = requests.length;
      child = await startDevNode(env, node);
      const restartDeadline = Date.now() + 5000;
      while (Date.now() < restartDeadline) {
        const state = db.prepare('SELECT phase FROM assistant_team_work WHERE assignment_id=?').get(uncertain.id);
        if (state?.phase === 'held') break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const restored = JSON.parse((db.prepare('SELECT record FROM assistant_team_work WHERE assignment_id=?').get(rootState.assignmentId) as any).record);
      assert.equal(restored.result, 'BOB_FINAL_FROM_CHILD');
      assert.equal(db.prepare('SELECT phase FROM assistant_team_work WHERE assignment_id=?').get(uncertain.id)?.phase, 'held');
      assert.equal(JSON.parse((db.prepare('SELECT record FROM assistant_team_assignments WHERE id=?').get(uncertain.id) as any).record).state, 'uncertain');
      assert.equal(requests.length, beforeRestart, 'startup does not rerun known or uncertain effects');
      const diagnostic = await api<any>(node, auth, 'GET', `/assistant-teams/${team.id}/assignments`);
      assert.equal(diagnostic.status, 200);
      assert.equal(diagnostic.body.assignments.find((entry: any) => entry.id === uncertain.id).state, 'uncertain');
      assert.equal(diagnostic.body.work.find((entry: any) => entry.assignmentId === uncertain.id).reason, 'dispatch_outcome_unknown');
    } finally { db.close(); }
  } finally {
    if (child) await stopDevNode(child);
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
