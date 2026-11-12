import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeUiFixture } from './native-ui-fixture.js';

test('Quality disappears from Settings while the Done feedback form remains usable', { timeout: 120_000 }, async t => {
  const { page, node, environment } = await nativeUiFixture(t);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(node.url);
  await page.getByTestId('login-username-input').fill(environment.username);
  await page.getByTestId('login-password-input').fill(environment.password);
  await page.getByTestId('login-submit-button').click();
  await page.locator('#loginDialog[open]').waitFor({ state: 'hidden' });
  await page.evaluate(async () => { const { openSettings } = await import('/app/settings.js'); await openSettings('quality'); });
  assert.equal(await page.getByTestId('settings-tab-quality').count(), 0);
  assert.equal(await page.getByTestId('settings-panel-quality').count(), 0);
  assert.equal(await page.locator('#settingsForm').getAttribute('data-tab'), 'account', 'old deep links fall back to Account');
  await page.evaluate(async () => { const { openSettings } = await import('/app/settings.js'); await openSettings('system-ai'); });
  await page.getByTestId('system-ai-decision-model').waitFor();
  assert.equal(await page.getByTestId('system-ai-quality-model').count(), 0);
  assert.equal(await page.getByTestId('system-ai-feedback-harness').count(), 0);
  await page.evaluate(async () => {
    const { chooseConversationFeedback } = await import('/app/conversation-feedback.js');
    (window as any).testFeedback = chooseConversationFeedback({ title: 'Feedback fixture' });
  });
  await page.getByTestId('conversation-feedback-bad').check();
  await page.getByTestId('conversation-feedback-description').fill('Use this in a later scheduled review.');
  await page.getByTestId('conversation-feedback-submit').click();
  assert.deepEqual(await page.evaluate(() => (window as any).testFeedback), { rating: 'bad', description: 'Use this in a later scheduled review.' });
  assert.deepEqual(errors, []);
});
