import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { QualityStore } from '../../src/quality-analytics.js';
import type { Browser } from 'playwright-core';
import { launchChrome } from './launch-chrome.js';
import { seedDevEnvironment, startDevNode, stopDevNode } from '../dev-nodes.js';
import { nativeUiFixture } from './native-ui-fixture.js';

test('Quality Settings shows the local opt-in, coverage, issues and paginated reasons', { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jb-quality-ui-'));
  const environment = await seedDevEnvironment(root, 1), node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  let browser: Browser | undefined;
  try {
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(node.url);
    await page.locator('#loginDialog[open], .project-card').first().waitFor({ timeout: 60000 });
    if (await page.locator('#loginDialog[open]').count()) {
      await page.getByTestId('login-username-input').fill(environment.username);
      await page.getByTestId('login-password-input').fill(environment.password);
      await page.getByTestId('login-submit-button').click();
    }
    await page.locator('#loginDialog[open]').waitFor({ state: 'hidden' });
    await page.locator('.project-card').first().waitFor();
    await page.evaluate(async () => { const { openSettings } = await import('/app/settings.js'); await openSettings('quality'); });
    const panel = page.getByTestId('settings-panel-quality'); await panel.waitFor();
    await page.getByTestId('quality-enabled').waitFor();
    assert.equal(await page.getByTestId('quality-enabled').isChecked(), false);
    assert.match(await panel.innerText(), /Only conversations already available on this machine/);
    assert.match(await page.getByTestId('quality-summary').innerText(), /0 evaluated replies/);
    await page.route('**/api/quality-analytics?*', async route => {
      const url = new URL(route.request().url());
      assert.equal(url.searchParams.get('issue'), 'verification');
      await route.fulfill({ json: { enabled: false, projects: [{ id: 'p', name: 'Fixture project' }], totals: { replies: 1, issues: 1, good: 0, unknown: 0 }, trends: [], issues: [], jobs: [], failures: [], failureGroups: [], sources: [], lastEvaluatedAt: null, feedback: [], versions: [], lessons: [], page: 0, pageSize: 8, total: 1, rows: [{ projectId: 'p', conversationId: 'c', replyId: '1', at: '2025-01-01', harness: 'claude', model: 'fixture', result: { outcome: 'issue', reason: 'Claim was not verified', confidence: .9, issues: [{ type: 'verification', reason: 'No test evidence', lesson: 'Run tests before claiming success', ruleId: '', adoptedAt: '' }] } }] } });
    });
    await page.getByTestId('quality-view').selectOption('rows');
    await page.getByTestId('quality-filters-toggle').click();
    await page.getByTestId('quality-issue-filter').fill('verification');
    await page.getByTestId('quality-refresh').click();
    await page.getByText('Claim was not verified', { exact: true }).waitFor();
    assert.match(await panel.innerText(), /Run tests before claiming success/);
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await panel.evaluate(element => ({ width: element.getBoundingClientRect().width, scroll: element.scrollWidth }));
    assert.ok(bounds.scroll <= bounds.width + 2, JSON.stringify(bounds));
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await stopDevNode(server); await rm(root, { recursive: true, force: true }); }
});

test('Quality explains collection failures and offers working filters and source links', { timeout: 90_000 }, async t => {
  const { page, node, environment } = await nativeUiFixture(t);
  const project = node.projects[0];
  const database = new DatabaseSync(path.join(node.dataDir, 'node.db'));
  try {
    const store = new QualityStore(database);
    for (let i = 0; i < 25; i++) store.jobState(project.id, String(i), 'error', 'Several TypeSafe accounts are saved. Select the system secret in Settings → System AI.');
    for (const model of ['model-one', 'model-two']) store.put({ projectId: project.id, conversationId: model === 'model-two' ? 'thread-based-agent-builder' : 'short-one', replyId: model, at: '2026-11-08T12:00:00Z', harness: 'pi', model, fingerprint: model, result: {
      outcome: 'issue', reason: `Finding for ${model}`, issues: [{ type: 'verification', reason: 'No tests were run', lesson: 'Verify the result', ruleId: '', adoptedAt: '' }], confidence: .9, probabilities: { issue: .9 }, claudeModel: 'claude-evaluator', jevModel: 'jev-evaluator', version: '1', usage: null,
    } });
  } finally { database.close(); }
  await page.goto(node.url);
  await page.getByTestId('login-username-input').fill(environment.username);
  await page.getByTestId('login-password-input').fill(environment.password);
  await page.getByTestId('login-submit-button').click();
  await page.locator('.project-card').first().waitFor();
  await page.evaluate(async () => { const { openSettings } = await import('/app/settings.js'); await openSettings('quality'); });
  await page.getByTestId('quality-summary').getByText('2 evaluated replies', { exact: false }).waitFor();
  assert.equal(await page.getByTestId('quality-retry').isDisabled(), true, 'disabled collection cannot be scanned');
  await page.getByTestId('quality-coverage').getByText('25 conversations', { exact: false }).waitFor();
  assert.equal(await page.getByTestId('quality-coverage').getByText('Several TypeSafe accounts', { exact: false }).count(), 1, 'group repeated setup failures');
  assert.match(await page.getByTestId('quality-coverage').innerText(), /Last evaluated/);
  await page.getByTestId('quality-filters-toggle').click();
  await page.locator('#qualityModel').selectOption('model-two');
  await page.getByTestId('quality-summary').getByText('1 evaluated replies', { exact: false }).waitFor();
  await page.getByTestId('quality-view').selectOption('rows');
  await page.getByText('Finding for model-two', { exact: true }).waitFor();
  const link = page.getByTestId('quality-source-link');
  const url = new URL((await link.getAttribute('href'))!, node.url);
  assert.equal(url.searchParams.get('projectId'), project.id);
  assert.equal(url.searchParams.get('sessionId'), 'thread-based-agent-builder');
  assert.ok((await link.innerText()).includes(project.name));
  const opened = page.waitForEvent('popup');
  await link.click();
  const source = await opened;
  try {
    await source.getByText('We keep re-threading the same builder prompt by hand.', { exact: false }).waitFor();
    await source.getByText('Yes. The thread already stores every turn', { exact: false }).waitFor();
    assert.equal(new URL(source.url()).searchParams.get('sessionId'), 'thread-based-agent-builder');
    assert.equal(await page.getByTestId('settings-panel-quality').isVisible(), true, 'source opens separately, keeping Quality available');
  } finally { await source.close(); }
  let release!: () => void, markHeld!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requestHeld = new Promise<void>(resolve => { markHeld = resolve; });
  await page.route('**/api/quality-analytics?*model=model-one*', async route => {
    const response = await route.fetch(); markHeld(); await held; await route.fulfill({ response });
  });
  try {
    const oldResponse = page.waitForResponse(response => new URL(response.url()).searchParams.get('model') === 'model-one');
    await page.locator('#qualityModel').selectOption('model-one');
    await requestHeld;
    assert.equal(await page.locator('#qualityAnalytics').getAttribute('aria-busy'), 'true');
    await page.locator('#qualityModel').selectOption('model-two');
    await page.locator('#qualityAnalytics[aria-busy="false"]').waitFor();
    release(); await oldResponse;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(await page.getByText('Finding for model-one', { exact: true }).count(), 0, 'late response must not replace the latest filter results');
    assert.equal(await page.getByText('Finding for model-two', { exact: true }).count(), 1);
    assert.equal(await page.getByTestId('quality-load-status').getAttribute('data-state'), 'ready');
    assert.equal(await page.locator('#qualityModel').inputValue(), 'model-two');
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
  await page.setViewportSize({ width: 320, height: 844 });
  const bounds = await page.getByTestId('settings-panel-quality').evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
  assert.ok(bounds.scroll <= bounds.width + 2, JSON.stringify(bounds));
  await page.getByTestId('quality-clear-filters').click();
  await page.getByTestId('quality-summary').getByText('2 evaluated replies', { exact: false }).waitFor();
  await page.getByTestId('quality-system-ai-link').click();
  await page.getByTestId('settings-panel-system-ai').waitFor();
});

test('Quality exposes load failures inline and recovers without presenting stale metrics as current', { timeout: 90_000 }, async t => {
  const { page, node, environment } = await nativeUiFixture(t);
  let status = 502;
  await page.route('**/api/quality-analytics?*', async route => {
    if (status) await route.fulfill({ status, body: '' });
    else await route.continue();
  });
  await page.goto(node.url);
  await page.getByTestId('login-username-input').fill(environment.username);
  await page.getByTestId('login-password-input').fill(environment.password);
  await page.getByTestId('login-submit-button').click();
  await page.locator('.project-card').first().waitFor();
  await page.evaluate(async () => { const { openSettings } = await import('/app/settings.js'); await openSettings('quality'); });
  const loadStatus = page.getByTestId('quality-load-status');
  await loadStatus.getByText('Refresh', { exact: false }).waitFor();
  assert.match(await loadStatus.innerText(), /machine|connection/i);
  assert.equal(await page.getByTestId('quality-enabled').isDisabled(), true, 'unknown server settings must not be editable');
  status = 0;
  await page.getByTestId('quality-refresh').click();
  await page.getByTestId('quality-summary').getByText('0 evaluated replies', { exact: false }).waitFor();
  assert.equal(await page.getByTestId('quality-enabled').isDisabled(), false);
  status = 404;
  await page.getByTestId('quality-refresh').click();
  await loadStatus.getByText('404', { exact: false }).waitFor();
  assert.match(await loadStatus.innerText(), /previous|stale/i);
  assert.match(await loadStatus.innerText(), /update|version|unavailable/i);
  assert.equal(await page.getByTestId('quality-enabled').isDisabled(), true);
  assert.equal(await page.getByTestId('quality-retry').isDisabled(), true);
  await page.setViewportSize({ width: 320, height: 844 });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const errorBounds = await page.getByTestId('settings-panel-quality').evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
  assert.ok(errorBounds.scroll <= errorBounds.width + 2, `phone error state must not overflow: ${JSON.stringify(errorBounds)}`);
  status = 0;
  await page.getByTestId('quality-refresh').click();
  await page.locator('#quality-load-status[data-state="ready"]').waitFor();
  assert.doesNotMatch(await loadStatus.innerText(), /stale|404|502/i);
  assert.equal(await page.getByTestId('quality-enabled').isDisabled(), false);
  assert.equal(await page.getByTestId('quality-retry').isDisabled(), true, 'recovery must not enable collection or paid scanning');
});

test('Quality controls fit a phone without full-width checkboxes or cramped filters', { timeout: 90_000 }, async t => {
  const { page, node, environment } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.getByTestId('login-username-input').fill(environment.username);
  await page.getByTestId('login-password-input').fill(environment.password);
  await page.getByTestId('login-submit-button').click();
  await page.locator('.project-card').first().waitFor();
  await page.evaluate(async () => { const { openSettings } = await import('/app/settings.js'); await openSettings('quality'); });
  await page.getByTestId('quality-summary').getByText('0 evaluated replies', { exact: false }).waitFor();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const toggle = await page.getByTestId('quality-enabled').boundingBox();
    assert.ok(toggle && toggle.width <= 24 && toggle.height <= 24, `checkbox must not stretch: ${JSON.stringify(toggle)}`);
    const label = await page.getByTestId('quality-enabled').locator('..').boundingBox();
    assert.ok(label && toggle.y < label.y + 24, 'checkbox stays beside its label');
    const refresh = await page.getByTestId('quality-refresh').boundingBox();
    assert.ok(refresh && refresh.height >= 44, 'dashboard actions have phone-sized touch targets');
    await page.getByTestId('quality-filters-toggle').click();
    const project = await page.locator('#qualityProject').locator('..').boundingBox(), from = await page.locator('#qualityFrom').locator('..').boundingBox();
    assert.ok(project && from && Math.abs(project.x - from.x) < 2 && from.y > project.y, 'phone filters use full-width rows');
    const panel = await page.getByTestId('settings-panel-quality').evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
    assert.ok(panel.scroll <= panel.width + 2, JSON.stringify(panel));
    const clipped = await page.locator('.quality-filters input, .quality-filters select, .quality-actions button').evaluateAll(controls => controls.filter(control => {
      const bounds = control.getBoundingClientRect();
      return bounds.left < 0 || bounds.right > innerWidth;
    }).map(control => control.id || control.getAttribute('data-testid')));
    assert.deepEqual(clipped, [], `phone controls must stay inside the ${width}px viewport`);
    await page.getByTestId('quality-filters-toggle').click();
  }
});

test('Quality saves inline, reports failures, and never submits unrelated settings', { timeout: 90_000 }, async t => {
  const { page, node, environment } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.getByTestId('login-username-input').fill(environment.username);
  await page.getByTestId('login-password-input').fill(environment.password);
  await page.getByTestId('login-submit-button').click();
  await page.locator('.project-card').first().waitFor();
  await page.evaluate(async () => { const { openSettings } = await import('/app/settings.js'); await openSettings('quality'); });
  const toggle = page.getByTestId('quality-enabled'), status = page.getByTestId('quality-save-status');
  await page.getByTestId('quality-summary').getByText('0 evaluated replies', { exact: false }).waitFor();
  await page.locator('#settingsForm[data-ready="true"]').waitFor();
  const saveLine = page.getByTestId('settings-save-state');
  assert.equal(await page.locator('#settingsForm button[type=submit]').count(), 0, 'Settings has no shared save button; Quality saves inline');
  assert.equal(await saveLine.getAttribute('data-state'), 'idle');
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let fail = true, enabled = false;
  await page.route('**/api/quality-analytics/settings', async route => {
    assert.deepEqual(route.request().postDataJSON(), { enabled: true });
    await pending;
    if (fail) await route.fulfill({ status: 503, json: { error: 'Collection settings unavailable' } });
    else { enabled = true; await route.fulfill({ json: { enabled } }); }
  });
  await page.route('**/api/quality-analytics?*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), enabled } });
  });
  const settingsWrites: string[] = [];
  page.on('request', request => { if (request.method() === 'PUT' && request.url().endsWith('/api/settings')) settingsWrites.push(request.url()); });
  try {
    await toggle.check();
    await status.getByText('Saving', { exact: false }).waitFor();
    assert.equal(await toggle.isDisabled(), true);
    release();
    await status.getByText('Collection settings unavailable', { exact: false }).waitFor();
    assert.equal(await toggle.isChecked(), false);
    await page.locator('#qualityEnabled:enabled').waitFor();
    fail = false;
    await toggle.check();
    await status.getByText('Saved', { exact: false }).waitFor();
    await page.locator('#qualityEnabled:enabled').waitFor();
    assert.equal(await toggle.isChecked(), true);
    await page.getByTestId('quality-filters-toggle').click();
    await page.locator('#qualityModel').press('Enter');
    await page.evaluate(() => document.querySelector<HTMLFormElement>('#settingsForm')!.requestSubmit());
    await page.waitForTimeout(500);
    assert.deepEqual(settingsWrites, [], 'filter Enter must not run the general save');
    assert.equal(await saveLine.getAttribute('data-state'), 'idle', "Quality's own saves never show on the general save line");
    assert.equal(await page.locator('#settingsDialog').evaluate((element: HTMLDialogElement) => element.open), true);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId('settings-tab-account').click();
    // Other sections save as they change, on the line in their head.
    assert.equal(await page.getByTestId('settings-section-head-account').getByTestId('settings-save-state').isVisible(), true, 'other sections show the save line');
    assert.equal(await saveLine.innerText(), 'Changes save as you make them');
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
