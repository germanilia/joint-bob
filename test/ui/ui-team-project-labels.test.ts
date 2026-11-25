import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForAssertion } from '../async-assertion.js';
import { api } from '../dev-nodes.js';
import { startTeamHubFixture } from '../team-hub-fixture.js';
import { launchChrome } from './launch-chrome.js';

test('Projects shows the team name on both the host and a cluster member', { timeout: 120_000 }, async t => {
  const { host, member, hostEnv, memberEnv, hostAuth, memberAuth, team, stop } = await startTeamHubFixture();
  t.after(stop);
  const browser = await launchChrome({ headless: true, env: { ...process.env, HOME: hostEnv.home } });
  t.after(() => browser.close());

  const legacy = await api<{ workspace: { id: string } }>(host, hostAuth, 'PUT', '/workspaces', { label: 'Team 12345678-1234-4123-8123-123456' });
  assert.equal(legacy.status, 200);
  const orphan = await api(host, hostAuth, 'POST', '/projects', { name: 'Assistant team', type: legacy.body.workspace.id });
  assert.equal(orphan.status, 201, JSON.stringify(orphan.body));

  const cases = [
    { node: host, environment: hostEnv, auth: hostAuth, label: 'Hub fixture team' },
    { node: member, environment: memberEnv, auth: memberAuth, label: `Hub fixture team · ${host.name}` },
  ];
  const labels = await Promise.all(cases.map(async ({ node, environment, auth }) => {
    const project = await waitForAssertion(async () => {
      const projects = await api<{ projects: { id: string; type: string }[] }>(node, auth, 'GET', '/projects?syncStatus=false');
      assert.equal(projects.status, 200);
      const shared = projects.body.projects.find(entry => entry.id === team.projectId);
      assert.ok(shared, 'the team project has arrived');
      return shared;
    }, 30_000);
    const context = await browser.newContext({ viewport: { width: 1740, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    try {
      await page.goto(node.url);
      await page.locator('#loginDialog[open]').waitFor();
      await page.getByTestId('login-username-input').fill(environment.username);
      await page.getByTestId('login-password-input').fill(environment.password);
      await page.getByTestId('login-submit-button').click();
      await page.getByTestId('project-cluster-filter').waitFor({ state: 'visible' });
      const summary = page.locator(`[data-project-type="${project.type}"]`).getByTestId('project-group-toggle');
      await summary.waitFor();
      assert.equal(await page.locator('[data-project-type="personal"] summary > span').first().innerText(), 'Personal');
      if (node === host) {
        const legacyLabel = page.locator(`[data-project-type="${legacy.body.workspace.id}"] summary > span`).first();
        assert.equal(await legacyLabel.innerText(), 'Assistant team', 'no cluster name available, so no identifier is shown');
      }
      return { text: await summary.locator('span').first().innerText(), title: await summary.getAttribute('title') };
    } finally {
      await context.close();
    }
  }));
  assert.deepEqual(labels, cases.map(({ label }) => ({ text: label, title: label })));
});
