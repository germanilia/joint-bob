import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeUiFixture } from './native-ui-fixture.js';

const defaults = { reviewedAt: '2026-11-11', notes: 'Synthetic review notes', categories: [
  { level: '2', description: 'Terminal and git work', candidates: { pi: [{ provider: 'zai', modelId: 'glm-fixture', thinkingLevel: 'medium' }, { provider: 'openai-codex', modelId: 'gpt-6-luna', thinkingLevel: 'medium' }], claude: [{ provider: 'claude', modelId: 'haiku', thinkingLevel: 'medium' }] } },
] };

function view(servesRelay: boolean) {
  return { system: { decision: { model: 'typesafe', typesafeAccountId: null, layaAccountId: null }, operations: { feedback: null, knowledge: null }, quality: { modelId: '' }, profiles: { claude: null, pi: null, kiro: null, 'openai-codex': null }, routing: { enabled: true, shareWithRelay: false } },
    backgroundAgent: { harnessId: '', provider: '', modelId: '', thinkingLevel: '' }, syncCheck: { harnessId: '', provider: '', modelId: '', thinkingLevel: '', enabled: false }, dashboards: { harnessId: '', provider: '', modelId: '', thinkingLevel: '' },
    node: { id: 'synthetic', name: 'Synthetic machine' }, secrets: [], profiles: [], readiness: { decision: 'No system TypeSafe key is available.' },
    routing: { enabled: true, shareWithRelay: false, servesRelay, source: 'No decision credential here: routing asks relay.example when it shares its decision model.', defaults,
 } };
}

test('System AI shows model routing and its defaults, without daily review instructions', { timeout: 120000 }, async t => {
  const { page, node, environment } = await nativeUiFixture(t);
  let servesRelay = true;
  const writes: any[] = [];
  await page.route('**/api/system-ai', async route => {
    if (route.request().method() === 'PUT') writes.push(route.request().postDataJSON());
    await route.fulfill({ json: view(servesRelay) });
  });
  await page.goto(node.url);
  await page.getByTestId('login-username-input').fill(environment.username);
  await page.getByTestId('login-password-input').fill(environment.password);
  await page.getByTestId('login-submit-button').click();
  await page.locator('.project-card').first().waitFor();
  await page.evaluate(async () => { const { openSettings } = await import('/app/settings.js'); await openSettings('system-ai'); });
  const panel = page.getByTestId('settings-panel-system-ai');
  await page.getByTestId('system-ai-routing-enabled').waitFor();
  assert.match(await page.getByTestId('system-ai-routing-source').innerText(), /asks relay\.example/);
  assert.match(await page.getByTestId('system-ai-routing-reviewed').innerText(), /2026-11-11.*Synthetic review notes/s);
  await panel.getByText('Default models, in the order they are tried').click();
  const candidates = await page.getByTestId('system-ai-routing-defaults').innerText();
  assert.match(candidates, /Terminal and git work/);
  assert.match(candidates, /zai · glm-fixture · medium[\s\S]*openai-codex · gpt-6-luna · medium/, 'candidates are listed in the order they are tried');
  assert.equal(await panel.getByText(/review instructions/i).count(), 0, 'no daily review instructions in the app');
  assert.doesNotMatch(await page.getByTestId('system-ai-routing-hint').innerText(), /Homeserver|reviewed daily/);
  // Each change saves on its own through System AI's endpoint.
  await page.getByTestId('system-ai-routing-enabled').uncheck();
  await page.getByTestId('system-ai-routing-share').check();
  const until = Date.now() + 20000;
  while (JSON.stringify(writes.at(-1)?.system.routing) !== JSON.stringify({ enabled: false, shareWithRelay: true }) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(writes.at(-1).system.routing, { enabled: false, shareWithRelay: true });
  await page.locator('[data-testid="settings-save-state"][data-state="saved"]').waitFor();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const bounds = await panel.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    assert.ok(bounds.scroll <= bounds.width + 2, JSON.stringify(bounds));
  }
  servesRelay = false;
  await page.evaluate(async () => { const { openSettings } = await import('/app/settings.js'); await openSettings('quality'); await openSettings('system-ai'); });
  await page.getByTestId('system-ai-routing-enabled').waitFor();
  assert.equal(await page.getByTestId('system-ai-routing-share').count(), 0, 'only a machine that serves a relay can share its decision model');
});
