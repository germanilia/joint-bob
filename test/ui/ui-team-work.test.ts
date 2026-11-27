import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeUiFixture, openBobChat } from './native-ui-fixture.js';
import { api, signIn } from '../dev-nodes.js';
import { DEFAULT_GUARDIAN_SETTINGS } from '../../src/guardian/rules.js';
import { PRODUCTION_RULE } from '../../src/guardian/production-rule.js';

async function openTeams(page: any, environment: any, node: any) {
  await page.goto(node.url);
  await page.locator('#loginDialog[open]').waitFor();
  await page.locator('#loginUsernameInput').fill(environment.username);
  await page.locator('#loginPasswordInput').fill(environment.password);
  await page.locator('#loginSubmitButton').click();
  await page.waitForFunction(() => !document.body.classList.contains('booting') && document.querySelectorAll('#projectList .list-row').length > 0);
  await page.getByTestId('projects-open-control-center-button').click();
  await page.getByTestId('control-tab-assistants').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="team-select"] option').length > 0);
}

test('Back to Assistants exits a team without deleting it and keeps navigation stable', { timeout: 120_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  const auth = await signIn(environment, node);
  const cluster = await api<any>(node, auth, 'POST', '/clusters', { name: 'Exit team' });
  const created = await api<any>(node, auth, 'POST', '/assistant-teams', { clusterId: cluster.body.snapshot.body.clusterId });
  assert.equal(created.status, 201);
  await openTeams(page, environment, node);
  await openBobChat(page);
  const tab = page.getByTestId('control-tab-assistants');
  const icon = await tab.locator('svg').innerHTML();
  await page.getByTestId('team-select').selectOption(created.body.team.id);
  await page.getByTestId('team-assistants-view').getByRole('heading', { name: 'Team members', exact: true }).waitFor();
  assert.equal((await tab.innerText()).trim(), 'Assistants');
  assert.equal(await tab.locator('svg').innerHTML(), icon);
  await page.getByRole('button', { name: 'Back to Assistants', exact: true }).click();
  assert.equal(await page.getByTestId('team-select').inputValue(), '');
  assert.equal(await page.getByTestId('team-assistants-view').isVisible(), false);
  assert.equal(await page.locator('body').evaluate(body => body.classList.contains('team-context-active')), false);
  assert.equal(await page.getByRole('button', { name: 'Back to Assistants', exact: true }).isVisible(), false);
  assert.equal((await api(node, auth, 'GET', `/assistant-teams/${created.body.team.id}`)).status, 200, 'closing does not delete the team');
  await openBobChat(page);
  await page.getByTestId('team-select').selectOption(created.body.team.id);
  await page.getByTestId('team-assistants-view').getByRole('heading', { name: 'Team members', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Back to Assistants', exact: true }).click();
  assert.equal(await page.getByTestId('team-select').inputValue(), '');
});

test('Delete team leaves the deleted team: its view closes and it is no longer polled', { timeout: 120_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  const auth = await signIn(environment, node);
  const cluster = await api<any>(node, auth, 'POST', '/clusters', { name: 'Delete team' });
  const created = await api<any>(node, auth, 'POST', '/assistant-teams', { clusterId: cluster.body.snapshot.body.clusterId });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const teamId = created.body.team.id;
  let loading = 0, lastLoad = Date.now();
  const isTeamList = (request: any) => new URL(request.url()).pathname === '/api/team-hub';
  const loaded = (request: any) => { if (isTeamList(request)) { loading--; lastLoad = Date.now(); } };
  page.on('request', (request: any) => { if (isTeamList(request)) { loading++; lastLoad = Date.now(); } });
  page.on('requestfinished', loaded);
  page.on('requestfailed', loaded);
  await openTeams(page, environment, node);
  // Picking a team while the list is still loading loses the pick, so wait for the loads to finish.
  while (loading > 0 || Date.now() - lastLoad < 2_000) await page.waitForTimeout(200);
  await page.getByTestId(`team-sidebar-item-${teamId}`).click();
  await page.getByTestId('team-tab-settings').click();
  await page.getByTestId('team-delete').click();
  await page.getByTestId('confirm-accept-button').click();
  await page.waitForFunction(() => !document.body.classList.contains('team-context-active'));
  const afterDelete: string[] = [];
  page.on('request', (request: any) => { if (request.url().includes(teamId)) afterDelete.push(`${request.method()} ${new URL(request.url()).pathname}`); });
  assert.equal(await page.getByTestId('team-select').inputValue(), '');
  assert.equal((await api(node, auth, 'GET', `/assistant-teams/${teamId}`)).status, 404, 'the team is gone');
  await page.waitForTimeout(5_000); // longer than the work view's 4-second poll
  assert.deepEqual(afterDelete, [], 'nothing keeps asking for the deleted team');
  assert.equal(await page.getByTestId('team-delete').count(), 0, 'no second Delete is offered for it');
});

test('a team on this machine takes work from the app: send it, stop a request, run it again', { timeout: 240_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  const auth = await signIn(environment, node);
  const cluster = await api<any>(node, auth, 'POST', '/clusters', { name: 'Work team' });
  const created = await api<any>(node, auth, 'POST', '/assistant-teams', { clusterId: cluster.body.snapshot.body.clusterId });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { addNodeMembers } = await import('../team-members-fixture.js');
  await addNodeMembers((method, route, body) => api<any>(node, auth, method as any, route, body), node.projects.map((p: any) => p.id), created.body.team.id,
    [{ role: 'lead' }, { role: 'qa' }], 'lead', { harnessId: 'pi', provider: 'dev-environment', modelId: 'dev-model', reasoning: 'off' });
  await openTeams(page, environment, node);
  await page.getByTestId('team-select').selectOption(created.body.team.id);
  await page.getByTestId('team-agent-card').first().waitFor();
  await page.getByTestId('projects-open-control-center-button').click();
  await page.getByTestId('team-work').waitFor({ state: 'visible' });
  assert.deepEqual(await page.getByTestId('team-work-role').locator('option').allInnerTexts(), ['Coordinator — lead (not ready)', 'qa — qa (not ready)'], 'the coordinator and each member, and that this host cannot start them yet');
  await page.getByTestId('team-work-role').selectOption('qa');
  await page.getByTestId('team-work-message').fill('Check the sign-in page');
  await page.getByTestId('team-work-send').click();
  // This host has no production guard, so the member cannot start: the request shows as stopped, with why.
  const row = page.locator('[data-testid="team-work-requests"] article[data-state="stopped"]');
  await row.waitFor();
  assert.match(await row.innerText(), /Check the sign-in page/);
  assert.match(await row.innerText(), /its machine or model was not ready/);
  const id = (await row.locator('strong').innerText()).split(' ')[0];
  await page.getByTestId(`team-work-cancel-${id}`).click();
  await page.locator('[data-testid="team-work-requests"] article[data-state="cancelled"]').waitFor();
  await page.getByTestId(`team-work-retry-${id}`).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="team-work-requests"] article').length === 2);
  assert.equal(await page.getByTestId('team-work-message').inputValue(), '', 'the box is emptied once the work is sent');
});

// A team that another machine of the cluster hosts: the picker offers it, and no second team is offered on this machine.
test('a team hosted on another machine is in the picker and takes work from here', { timeout: 240_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  const auth = await signIn(environment, node);
  const cluster = await api<any>(node, auth, 'POST', '/clusters', { name: 'Contigos' });
  const clusterId = cluster.body.snapshot.body.clusterId;
  const remote = { id: 'remote-team', clusterId, clusterName: 'Contigos', hostNodeId: 'ec2-node', hostName: 'Contigos EC2', local: false, coordinatorRole: 'lead',
    members: [{ role: 'lead', name: 'Bob', coordinator: true, ready: true, uses: ['pi · gpt'] }, { role: 'qa', name: 'QA', coordinator: false, ready: true, uses: ['browser'] }] };
  const done = { id: 'a1b2c3'.padEnd(64, '0'), shortId: 'a1b2c3', text: 'Check the release notes', requestedBy: 'x', chatId: 'browser', createdAt: new Date().toISOString(), browser: true, state: 'done',
    assignments: [{ role: 'qa', state: 'completed', delegated: false, reason: null, conversationId: null, result: 'REMOTE_ANSWER' }] };
  const posts: any[] = [];
  await page.route('**/api/team-hub', route => route.fulfill({ json: { teams: [remote], unreachable: [] } }));
  await page.route('**/api/team-hub/remote-team/requests', route => route.fulfill({ json: { requests: [done] } }));
  await page.route('**/api/team-hub/remote-team/assign', route => { posts.push(route.request().postDataJSON()); return route.fulfill({ json: { request: done } }); });
  await openTeams(page, environment, node);
  const options = await page.getByTestId('team-select').locator('option').allInnerTexts();
  assert.ok(options.includes('Contigos — on Contigos EC2'), options.join(' | '));
  assert.equal(await page.getByTestId('team-new').count(), 0, 'the cluster already has a team, on another machine');
  await page.getByTestId('team-select').selectOption('remote:remote-team');
  await page.getByTestId('team-assistants-view').getByText(/Hosted on Contigos EC2/).waitFor();
  assert.match(await page.getByTestId('team-assistants-view').innerText(), /coordinator \(lead\) — Bob/);
  await page.getByTestId('projects-open-control-center-button').click();
  await page.getByTestId('team-work').waitFor({ state: 'visible' });
  await page.getByText('REMOTE_ANSWER').waitFor();
  await page.getByTestId('team-work-message').fill('Draft the launch post');
  await page.getByTestId('team-work-send').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="team-work-message"]')?.value === '');
  assert.deepEqual(posts, [{ role: null, message: 'Draft the launch post' }], 'with no role chosen, the coordinator gets it');
  await page.getByTestId('team-work-role').selectOption('qa');
  await page.getByTestId('team-work-message').fill('Check it');
  await page.getByTestId('team-work-send').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="team-work-message"]')?.value === '');
  assert.deepEqual(posts.at(-1), { role: 'qa', message: 'Check it' });
});

// A machine that could not be reached may host the cluster's team: no one is offered a second one on this machine meanwhile.
test('no second team is offered for a cluster whose machines could not all be reached', { timeout: 240_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  const auth = await signIn(environment, node);
  const cluster = await api<any>(node, auth, 'POST', '/clusters', { name: 'Contigos' });
  const clusterId = cluster.body.snapshot.body.clusterId;
  let unreachable: string[] = [clusterId];
  await page.route('**/api/team-hub', route => route.fulfill({ json: { teams: [], unreachable } }));
  await openTeams(page, environment, node);
  const options = await page.getByTestId('team-select').locator('option').allInnerTexts();
  assert.equal(await page.getByTestId('team-new').count(), 0, options.join(' | '));
  unreachable = [];
  await page.reload();
  await page.waitForFunction(() => !document.body.classList.contains('booting'));
  // The control center comes back by itself after a reload, and the team list fills again.
  await page.getByTestId('team-new').waitFor({ state: 'attached' });
});

// A team's conversations live in the team's own folder in the Inbox, not mixed into Needs you, Running and To review.
test('a team\'s conversations are in its own Inbox folder, which opens to all of them', { timeout: 240_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  const auth = await signIn(environment, node);
  const cluster = await api<any>(node, auth, 'POST', '/clusters', { name: 'Folder team' });
  const created = await api<any>(node, auth, 'POST', '/assistant-teams', { clusterId: cluster.body.snapshot.body.clusterId });
  const { addNodeMembers } = await import('../team-members-fixture.js');
  await addNodeMembers((method, route, body) => api<any>(node, auth, method as any, route, body), node.projects.map((p: any) => p.id), created.body.team.id,
    [{ role: 'lead' }, { role: 'qa' }], 'lead', { harnessId: 'pi', provider: 'dev-environment', modelId: 'dev-model', reasoning: 'off' });
  // The production guard lets the member start, so its conversation is made (the fixture has no model to answer it).
  assert.equal((await api(node, auth, 'PUT', '/guardian', { settings: { ...DEFAULT_GUARDIAN_SETTINGS, enabled: true, rules: [PRODUCTION_RULE] } })).status, 200);
  const sent = await api<any>(node, auth, 'POST', `/team-hub/${created.body.team.id}/assign`, { role: 'qa', message: 'Folder check' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  // The board says which team a card belongs to: a property, not a name to match.
  let teamCards: any[] = [];
  for (let i = 0; i < 100 && !teamCards.length; i++) {
    const board = (await api<any>(node, auth, 'GET', '/control-center/board?look=1&earlier=1')).body;
    teamCards = [...board.cards, ...(board.earlier ?? [])].filter((card: any) => card.team);
    if (!teamCards.length) await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(teamCards.length >= 1, 'the team conversation is on the board, marked with its team');
  assert.equal(teamCards[0].team.id, created.body.team.id);
  assert.equal(teamCards[0].team.name, 'Folder team');

  await page.goto(node.url);
  await page.locator('#loginDialog[open]').waitFor();
  await page.locator('#loginUsernameInput').fill(environment.username);
  await page.locator('#loginPasswordInput').fill(environment.password);
  await page.locator('#loginSubmitButton').click();
  await page.waitForFunction(() => !document.body.classList.contains('booting'));
  await page.locator('#workspaceInboxButton').click();
  const folder = page.locator('[data-testid="workspace-team-folder"]');
  await folder.waitFor();
  assert.match(await folder.innerText(), /Folder team/);
  const inGroups = await page.locator('[data-testid="workspace-group-row"]').allInnerTexts();
  assert.ok(!inGroups.some(text => /Folder check/.test(text)), 'not mixed into the groups');
  await folder.click();
  await page.locator('[data-testid="workspace-team-page-row"]').first().waitFor();
  assert.match(await page.locator('#workspaceGroupTitle').innerText(), /Folder team team/);
  assert.match(await page.locator('[data-testid="workspace-team-page-row"]').first().innerText(), /qa: Folder check/);
  // Bob's inbox list keeps the same conversations in the team's folder: out of its Inbox scope, listed under the folder.
  const marks = await page.evaluate(async (card) => {
    const m = await import('/app/control-marks.js');
    return { folder: m.folderOf(card), names: m.folderNames([card]) };
  }, teamCards[0]);
  assert.deepEqual(marks, { folder: 'Folder team team', names: ['Folder team team'] });
});

// A team is made by its own button, not by choosing an entry in the Context selector.
test('a team is created with the New team button, and the selector has no create entry', { timeout: 240_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  const auth = await signIn(environment, node);
  await api<any>(node, auth, 'POST', '/clusters', { name: 'Button team' });
  await openTeams(page, environment, node);
  assert.deepEqual(await page.getByTestId('team-select').locator('option').allInnerTexts(), ['Select a team']);
  await page.getByTestId('team-new').click();
  await page.getByTestId('confirm-accept-button').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="team-select"]')?.selectedOptions[0]?.textContent === 'Button team');
  assert.equal(await page.getByTestId('team-new').count(), 0, 'the cluster has its team now');
});
