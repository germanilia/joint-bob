import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nativeUiFixture } from './native-ui-fixture.js';
import { api, signIn } from '../dev-nodes.js';

async function openTeams(page: any, environment: any, node: any) {
  const loading = new Set<unknown>();
  page.on('request', (request: any) => { if (/\/api\/(clusters|team-hub\?fresh=1)$/.test(request.url())) loading.add(request); });
  for (const end of ['requestfinished', 'requestfailed']) page.on(end, (request: any) => loading.delete(request));
  await page.goto(node.url);
  await page.locator('#loginDialog[open]').waitFor();
  await page.locator('#loginUsernameInput').fill(environment.username);
  await page.locator('#loginPasswordInput').fill(environment.password);
  await page.locator('#loginSubmitButton').click();
  await page.waitForFunction(() => !document.body.classList.contains('booting') && document.querySelectorAll('#projectList .list-row').length > 0);
  await page.getByTestId('projects-open-control-center-button').click();
  await page.getByTestId('control-tab-assistants').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="team-select"] option').length > 1);
  // The page asks for the team list several times as it boots, and a late answer clears the picker's choice
  // (loadTeams reads the choice before it waits). Choose a team only after they have all landed.
  do { await page.waitForTimeout(1_000); } while (loading.size);
}

/** What the person is looking at: which page, team and tab. */
const screen = (page: any) => page.evaluate(() => ({
  url: location.href,
  body: ['view-control', 'team-context-active'].filter(name => document.body.classList.contains(name)),
  team: (document.querySelector('[data-testid="team-select"]') as HTMLSelectElement).value,
  tab: document.querySelector('.team-workspace-tabs [aria-selected="true"]')?.getAttribute('data-testid'),
}));

/** Waits for the notice, then watches for longer than two polls: same screen, no request for the team, no error toast. */
async function assertGoneInPlace(page: any, teamId: string, before: unknown) {
  await page.getByTestId('team-gone').waitFor({ state: 'visible' });
  const later: string[] = [];
  const watch = (request: any) => { if (request.url().includes(teamId)) later.push(`${request.method()} ${new URL(request.url()).pathname}`); };
  page.on('request', watch);
  await page.waitForTimeout(9_000);
  page.off('request', watch);
  assert.deepEqual(later, [], 'polling stopped');
  assert.deepEqual(await screen(page), before, 'the person stays on the same screen');
  assert.equal(await page.getByTestId('team-gone').count(), 1, 'one notice');
  assert.equal(await page.getByTestId('team-gone').isVisible(), true);
  assert.deepEqual(await page.locator('.toast-error').allInnerTexts(), [], 'no error toast');
}

// Deleted through the app, which ends the page's update stream; and removed with no announcement, which only the poll can see.
for (const how of ['deleted through the app', 'removed without telling the app'] as const) {
  test(`an open team ${how} is reported once, in place`, { timeout: 120_000 }, async t => {
    const { page, environment, node } = await nativeUiFixture(t);
    const auth = await signIn(environment, node);
    const cluster = await api<any>(node, auth, 'POST', '/clusters', { name: 'Gone team' });
    const created = await api<any>(node, auth, 'POST', '/assistant-teams', { clusterId: cluster.body.snapshot.body.clusterId });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const teamId = created.body.team.id;
    await openTeams(page, environment, node);
    const polled = page.waitForResponse((response: any) => response.url().endsWith(`/api/team-hub/${teamId}/requests`) && response.ok());
    await page.getByTestId(`team-sidebar-item-${teamId}`).click();
    await polled;
    assert.equal(await page.getByTestId('team-gone').isVisible(), false);
    const before = await screen(page);

    if (how === 'deleted through the app') {
      const removed = await fetch(`${node.url}/api/assistant-teams/${teamId}`, { method: 'DELETE', headers: { Cookie: auth.cookie, 'x-csrf-token': auth.csrfToken } });
      assert.ok(removed.ok, `delete answered ${removed.status}`);
    } else {
      // The disposable fixture node's own database.
      const db = new DatabaseSync(path.join(node.dataDir, 'node.db'));
      db.exec('PRAGMA busy_timeout=5000');
      assert.equal(db.prepare('DELETE FROM assistant_teams WHERE id=?').run(teamId).changes, 1);
      db.close();
    }
    await assertGoneInPlace(page, teamId, before);
  });
}

test('a team on another machine is called gone only once its cluster could be asked', { timeout: 120_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  const auth = await signIn(environment, node);
  const cluster = await api<any>(node, auth, 'POST', '/clusters', { name: 'Contigos' });
  const clusterId = cluster.body.snapshot.body.clusterId;
  const remote = { id: 'remote-team', clusterId, clusterName: 'Contigos', hostNodeId: 'ec2-node', hostName: 'Contigos EC2', local: false, coordinatorRole: 'lead',
    members: [{ role: 'lead', name: 'Bob', coordinator: true, ready: true, uses: [] }] };
  let hub: { teams: unknown[]; unreachable: string[] } = { teams: [remote], unreachable: [] };
  let deleted = false;
  const answer = (route: any, ok: object) => route.fulfill(deleted ? { status: 404, json: { error: 'No such team among your clusters' } } : { json: ok });
  await page.route(/\/api\/team-hub(\?fresh=1)?$/, (route: any) => route.fulfill({ json: hub }));
  await page.route('**/api/team-hub/remote-team/requests', (route: any) => answer(route, { requests: [] }));
  await page.route('**/api/team-hub/remote-team/proposals', (route: any) => answer(route, { proposals: [] }));
  await openTeams(page, environment, node);
  await page.getByTestId('team-sidebar-item-remote-team').click();
  await page.getByText(/No requests yet/).waitFor();
  const before = await screen(page);

  // Its host cannot be reached: the 404 proves nothing, so the failure shows as before and polling goes on.
  hub = { teams: [], unreachable: [clusterId] };
  deleted = true;
  await page.locator('.toast-error').first().waitFor();
  assert.equal(await page.getByTestId('team-gone').isVisible(), false, 'not called gone while unconfirmed');

  hub = { teams: [], unreachable: [] };
  await page.getByTestId('team-gone').waitFor({ state: 'visible' });
  for (const close of await page.getByTestId('toast-close-button').all()) await close.click();
  await page.waitForFunction(() => !document.querySelector('.toast-error'));
  await assertGoneInPlace(page, 'remote-team', before);
});
