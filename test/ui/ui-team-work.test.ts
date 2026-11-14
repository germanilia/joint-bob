import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeUiFixture } from './native-ui-fixture.js';
import { api, signIn } from '../dev-nodes.js';

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
  await page.getByTestId('control-tab-live').click();
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
  assert.ok(!options.some(option => /create team on this host/.test(option)), 'the cluster already has a team, on another machine');
  await page.getByTestId('team-select').selectOption('remote:remote-team');
  await page.getByTestId('team-assistants-view').getByText(/Hosted on Contigos EC2/).waitFor();
  assert.match(await page.getByTestId('team-assistants-view').innerText(), /coordinator \(lead\) — Bob/);
  await page.getByTestId('control-tab-live').click();
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
  assert.ok(!options.some(option => /create team on this host/.test(option)), options.join(' | '));
  unreachable = [];
  await page.reload();
  await page.waitForFunction(() => !document.body.classList.contains('booting'));
  // The control center comes back by itself after a reload, and the team list fills again.
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="team-select"] option')].some(option => /create team on this host/.test(option.textContent ?? '')));
});
