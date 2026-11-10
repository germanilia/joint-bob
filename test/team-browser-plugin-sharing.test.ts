import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from './dev-nodes.js';
import { addClusterLocalMember } from '../src/cluster-accounts.js';

const exec = promisify(execFile);
test('team browser profile is host-local and role-selected; private inventory, revocation and incompatible plugins fail closed', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-browser-plugin-'));
  let child: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const env = await seedDevEnvironment(root, 1), node = env.nodes[0];
    const seeded = await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
      const {createLocalUser,authenticate,changePassword}=await import('./src/auth.ts');
      const {getClusterNode}=await import('./src/cluster.ts'); await getClusterNode();
      const user=createLocalUser({username:'browsermember',email:'member@example.test'});
      const session=authenticate('browsermember',user.oneTimePassword);
      changePassword(session,user.oneTimePassword,'Synthetic-member-password-123!'); console.log(JSON.stringify(user.user));
    `], { env: { ...process.env, HOME: env.home, NODE_ENV: 'test', JOINT_BOB_DATA_DIR: node.dataDir } });
    const human = JSON.parse(seeded.stdout.trim().split('\n').at(-1)!);
    child = await startDevNode(env, node); const owner = await signIn(env, node);
    const cluster = await api<any>(node, owner, 'POST', '/clusters', { name: 'Browser plugin fixture' });
    const created = await api<any>(node, owner, 'POST', '/assistant-teams', { clusterId: cluster.body.snapshot.body.clusterId });
    assert.equal(created.status, 201, JSON.stringify(created.body)); const team = created.body.team;
    const db = new DatabaseSync(path.join(node.dataDir, 'node.db'));
    addClusterLocalMember(db, team.clusterId, human.accountId);
    const member = await signIn({ ...env, username: 'browsermember', password: 'Synthetic-member-password-123!' }, node);
    const privateId = randomUUID(), now = new Date().toISOString();
    db.prepare('INSERT INTO browser_profiles (id,projectId,label,createdAt,updatedAt,stateEncrypted,persistent) VALUES (?,?,?,?,?,?,1)')
      .run(privateId, team.projectId, 'private_inventory_sentinel', now, now, '');
    const resources = `/assistant-teams/${team.id}/agents/qa/resources`;
    const before = await api<any>(node, member, 'GET', resources);
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.doesNotMatch(JSON.stringify(before.body), /private_inventory_sentinel/);
    assert.equal(before.body.ownerPlugins, undefined);
    assert.equal((await api(node, member, 'PUT', `/assistant-teams/${team.id}/agents/qa/browser`, { expectedRevision: 1, profileId: privateId })).status, 403);
    assert.equal((await api(node, member, 'POST', `/assistant-teams/${team.id}/browser-profiles`, { expectedRevision: 1, label: 'No' })).status, 403);
    const newProfile = await api<any>(node, owner, 'POST', `/assistant-teams/${team.id}/browser-profiles`, { expectedRevision: 1, label: 'Human sign-in' });
    assert.equal(newProfile.status, 200, JSON.stringify(newProfile.body));
    const profileId = newProfile.body.profile.id;
    assert.equal((await api(node, member, 'PUT', `/assistant-teams/${team.id}/agents/qa/browser`, { expectedRevision: 1, profileId })).status, 409);
    assert.equal((await api(node, member, 'PUT', `/assistant-teams/${team.id}/agents/qa/browser`, { expectedRevision: 2, profileId: randomUUID() })).status, 403);
    const attach = await api<any>(node, member, 'PUT', `/assistant-teams/${team.id}/agents/qa/browser`, { expectedRevision: 2, profileId });
    assert.equal(attach.status, 200, JSON.stringify(attach.body));
    const active = await api<any>(node, member, 'GET', resources);
    assert.deepEqual(active.body.browserProfiles.map((p: any) => p.label), ['Human sign-in']);
    assert.doesNotMatch(JSON.stringify(active.body), /private_inventory_sentinel|stateEncrypted|cookie|password/);
    assert.equal(db.prepare('SELECT count(*) n FROM browser_profile_grants WHERE profileId=? AND scope=\'conversation\'').get(profileId)!.n, 0);
    assert.equal(db.prepare('SELECT stateEncrypted FROM browser_profiles WHERE id=?').get(profileId)!.stateEncrypted, '');
    const plugin = path.join(root, 'team-plugin'), privatePlugin = path.join(root, 'private-plugin');
    for (const [directory, name] of [[plugin, 'shared-skill'], [privatePlugin, 'private-skill']]) {
      await mkdir(path.join(directory, '.claude-plugin'), { recursive: true }); await mkdir(path.join(directory, 'skills', name), { recursive: true });
      await writeFile(path.join(directory, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: path.basename(directory) }));
      await writeFile(path.join(directory, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture\n---\nFixture`);
    }
    const settings = await api<any>(node, owner, 'GET', '/settings');
    const configured = await api<any>(node, owner, 'PUT', '/settings', { ...settings.body, resources: { ...settings.body.resources, plugins: [plugin] } });
    assert.equal(configured.status, 200, JSON.stringify(configured.body));
    assert.equal((await api(node, member, 'PUT', `/assistant-teams/${team.id}/plugin-shares/${path.basename(plugin)}`, { enabled: true, expectedRevision: 3 })).status, 403);
    assert.equal((await api(node, owner, 'PUT', `/assistant-teams/${team.id}/plugin-shares/${path.basename(privatePlugin)}`, { enabled: true, expectedRevision: 3 })).status, 404);
    const share = await api<any>(node, owner, 'PUT', `/assistant-teams/${team.id}/plugin-shares/${path.basename(plugin)}`, { enabled: true, expectedRevision: 3 });
    assert.equal(share.status, 200, JSON.stringify(share.body));
    const visible = await api<any>(node, member, 'GET', resources);
    assert.deepEqual(visible.body.plugins.map((p: any) => p.name), ['team-plugin']);
    assert.doesNotMatch(JSON.stringify(visible.body), /private-plugin|private-skill/);
    assert.equal((await api(node, member, 'PUT', `/assistant-teams/${team.id}/agents/qa/plugins`, { expectedRevision: 4, names: ['private-plugin'] })).status, 400);
    const choose = await api<any>(node, member, 'PUT', `/assistant-teams/${team.id}/agents/qa/plugins`, { expectedRevision: 4, names: ['team-plugin'] });
    assert.equal(choose.status, 200, JSON.stringify(choose.body));
    const loader = await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
      const {piSessionHooks}=await import('./src/pi-service.ts');
      const {loadSkills}=await import('./src/pi-sdk.ts');
      const projectId=${JSON.stringify(team.projectId)}, conversationId=${JSON.stringify(`team-${team.id}-qa`)};
      const resource=await piSessionHooks({projectId,conversationId,cwd:${JSON.stringify(root)}}).resources(conversationId);
      const skills=loadSkills({cwd:${JSON.stringify(root)},agentDir:${JSON.stringify(env.home)},skillPaths:resource.skillRoots,includeDefaults:false});
      console.log(JSON.stringify({roots:resource.skillRoots,skills:skills.skills.map(s=>s.name),extensions:resource.extensions,packagesFile:resource.packagesFile}));
    `], { env: { ...process.env, HOME: env.home, NODE_ENV: 'test', JOINT_BOB_DATA_DIR: node.dataDir } });
    const loaded = JSON.parse(loader.stdout.trim().split('\n').at(-1)!);
    assert.ok(loaded.roots.some((value: string) => value.endsWith('/team-plugin/skills')), JSON.stringify(loaded));
    assert.ok(loaded.skills.includes('shared-skill'), JSON.stringify(loaded));
    assert.ok(!loaded.skills.includes('private-skill'));
    assert.deepEqual(loaded.extensions, []); assert.equal(loaded.packagesFile, '');
    const minted = await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
      const {browserAgentEnvironment}=await import('./src/browser-agent.ts');
      console.log(browserAgentEnvironment(${JSON.stringify(team.projectId)},'pi','fixture-team-topic',[],${JSON.stringify(team.id)}).JOINT_BOB_BROWSER_TOKEN);
    `], { env: { ...process.env, HOME: env.home, NODE_ENV: 'test', JOINT_BOB_DATA_DIR: node.dataDir } });
    const token = minted.stdout.trim().split('\n').at(-1)!;
    const agentCall = await fetch(`${node.url}/api/browser/agent`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ operation: 'status' }) });
    assert.equal(agentCall.status, 403, await agentCall.text()); // No live assignment; host account token does not impersonate a member.
    // Unsupported Claude-only commands are never reported as a working Pi plugin.
    await writeFile(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'team-plugin', commands: './commands' }));
    const unsupported = await api<any>(node, member, 'GET', resources);
    assert.match(unsupported.body.plugins[0].status, /Claude-only/);
    const rejected = await api<any>(node, member, 'PUT', `/assistant-teams/${team.id}/agents/product/plugins`, { expectedRevision: 5, names: ['team-plugin'] });
    assert.equal(rejected.status, 400);
    // Original share revoked: saved role selection cannot create an enduring conversation grant.
    db.prepare('DELETE FROM browser_profile_grants WHERE profileId=? AND scope=\'project\'').run(profileId);
    const after = await api<any>(node, member, 'GET', resources);
    assert.deepEqual(after.body.browserProfiles, []);
    assert.equal((await api(node, member, 'PUT', `/assistant-teams/${team.id}/agents/product/browser`, { expectedRevision: 5, profileId })).status, 403);
    const selected = db.prepare('SELECT profile_id FROM assistant_team_browser_selection WHERE team_id=? AND role=?').get(team.id, 'qa') as { profile_id: string };
    assert.equal(selected.profile_id, profileId);
    db.close();
  } finally { if (child) await stopDevNode(child); await rm(root, { recursive: true, force: true }); }
});
