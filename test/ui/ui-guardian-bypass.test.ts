import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("scheduled task and webhook Guardian checkboxes default off and survive editing", { timeout: 120_000 }, async t => {
  const { page, node, environment } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator('[aria-label="Actions for Internal Assistant"]').click();
  await page.getByTestId("project-cron-button").click();
  await page.waitForFunction(() => document.querySelector<HTMLFormElement>("#cronForm")!.elements.namedItem("ownerNodeId") instanceof HTMLSelectElement && (document.querySelector<HTMLSelectElement>('#cronForm [name="ownerNodeId"]')!.options.length > 0));
  await page.locator("#cronNew").click();
  const scheduledBypass = page.getByTestId("cron-bypass-guardian");
  assert.equal(await scheduledBypass.isChecked(), false);
  await page.locator('#cronForm [name="name"]').fill("Trusted daily task");
  await page.locator('#cronForm [name="prompt"]').fill("Summarize local fixtures");
  await page.locator('#cronForm [name="enabled"]').uncheck();
  await scheduledBypass.check();
  await page.getByTestId("cron-save").click();
  await page.getByTestId("cron-edit").click();
  assert.equal(await scheduledBypass.isChecked(), true);
  await scheduledBypass.uncheck();
  await page.getByTestId("cron-save").click();
  await page.getByTestId("cron-edit").click();
  assert.equal(await scheduledBypass.isChecked(), false);
  await page.getByTestId("cron-cancel").click();
  await page.locator("#cronClose").click();

  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-webhooks").click();
  await page.waitForFunction(() => document.querySelector<HTMLSelectElement>("#webhooksProject")!.options.length > 0 && !document.querySelector<HTMLButtonElement>("#webhooksNew")!.disabled);
  await page.getByTestId("webhooks-new-button").click();
  await page.getByTestId("webhooks-name-input").fill("Trusted incoming task");
  await page.getByTestId("webhooks-tab-access").click();
  await page.locator('[data-webhook-panel="access"]:not([inert])').waitFor();
  const webhookBypass = page.getByTestId("webhooks-bypass-guardian-toggle");
  assert.equal(await webhookBypass.isChecked(), false);
  await webhookBypass.check();
  await page.getByTestId("webhooks-save-button").click();
  await page.getByTestId("webhooks-reveal-done-button").click();
  assert.equal(await webhookBypass.isChecked(), true);
  assert.equal(await page.evaluate(async () => {
    const response = await fetch("/api/webhooks");
    const body = await response.json();
    return body.webhooks.find((hook: { name: string }) => hook.name === "Trusted incoming task").bypassGuardian;
  }), true);
});
