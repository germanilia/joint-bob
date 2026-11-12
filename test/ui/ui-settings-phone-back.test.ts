// The phone's Back inside Settings climbs one level: an open list sheet, then the section, then Settings itself.
// Settings is a modal <dialog>, so Android's Back is a "close request" (CloseWatcher), not a history step: before
// this, Back inside a section closed all of Settings. Desktop Chrome sends the same close request for Escape, which
// is what this test presses; every level is opened with a real click, because a CloseWatcher made without a user
// gesture is grouped with the one below it and both would close together.
import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

const mobileView = (page: Page) => page.locator("#settingsForm").getAttribute("data-mobile-view");
const settingsOpen = (page: Page) => page.locator("#settingsDialog").evaluate((dialog) => (dialog as HTMLDialogElement).open);
const openSheets = (page: Page) => page.locator("#settingsDialog .choice-scrim:not([hidden])").count();

test("Back inside a Settings section on a phone returns to the Settings list, then to the app", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByTestId("phone-tab-settings").click();
  await page.locator("#settingsDialog[open]").waitFor();
  await page.locator("#settingsForm[data-ready='true']").waitFor();
  assert.equal(await mobileView(page), "menu");

  await page.getByTestId("settings-tab-git").click();
  assert.equal(await mobileView(page), "panel");
  assert.equal(await page.locator("#settingsPanel-git .settings-section-title").isVisible(), true, "the section shows its big title");

  // A row's words open its list as a sheet; Back closes only the sheet.
  const row = page.locator("#settingsPanel-git label", { has: page.locator("#settingsGitReviewerHarness") });
  await page.waitForFunction(() => (document.querySelector("#settingsGitReviewerHarness") as HTMLSelectElement).options.length > 1);
  await row.click({ position: { x: 24, y: 20 } });
  await page.locator("#settingsDialog .choice-scrim:not([hidden])").waitFor();
  await page.keyboard.press("Escape");
  await page.locator("#settingsDialog .choice-scrim:not([hidden])").waitFor({ state: "detached" }).catch(() => undefined);
  assert.equal(await openSheets(page), 0, "the sheet closed");
  assert.equal(await mobileView(page), "panel", "the section stays open under its sheet");
  assert.equal(await settingsOpen(page), true);

  // Back in the section: the Settings list, with Settings still open.
  await page.locator("#settingsPanel-git .settings-section-title").click();
  await page.keyboard.press("Escape");
  await page.locator("#settingsForm[data-mobile-view='menu']").waitFor();
  assert.equal(await settingsOpen(page), true, "Back in a section must not close Settings");
  assert.equal(await page.getByTestId("settings-tab-git").isVisible(), true);

  // Another section and its own back button, then Back on the list leaves Settings.
  await page.getByTestId("settings-tab-account").click();
  assert.equal(await mobileView(page), "panel");
  await page.getByTestId("settings-back-button").click();
  assert.equal(await mobileView(page), "menu");
  await page.keyboard.press("Escape");
  await page.locator("#settingsDialog:not([open])").waitFor({ state: "attached" });
  assert.equal(await page.getByTestId("phone-tab-settings").isVisible(), true, "the app is back");
});

// Browsers without CloseWatcher (iOS Safari) send Back to history. The app keeps placeholder history steps topped up on
// every tap (layout.js), and its popstate handler closes what lies on top first: the list sheet, then the section, then
// Settings — the same three levels. CloseWatcher is removed before the app loads, every level is opened with a real
// click, and Back is a real history step.
test("without CloseWatcher, history Back climbs the same levels: sheet, section, Settings, and a conversation's sheet", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.addInitScript(() => { delete (window as unknown as { CloseWatcher?: unknown }).CloseWatcher; });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(node.url);
  assert.equal(await page.evaluate(() => "CloseWatcher" in window), false);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByTestId("phone-tab-settings").click();
  await page.locator("#settingsDialog[open]").waitFor();
  await page.locator("#settingsForm[data-ready='true']").waitFor();

  await page.getByTestId("settings-tab-git").click();
  assert.equal(await mobileView(page), "panel");
  const row = page.locator("#settingsPanel-git label", { has: page.locator("#settingsGitReviewerHarness") });
  await page.waitForFunction(() => (document.querySelector("#settingsGitReviewerHarness") as HTMLSelectElement).options.length > 1);
  await row.click({ position: { x: 24, y: 20 } });
  await page.locator("#settingsDialog .choice-scrim:not([hidden])").waitFor();

  await page.goBack();
  await page.waitForFunction(() => !document.querySelector("#settingsDialog .choice-scrim:not([hidden])"));
  assert.equal(await mobileView(page), "panel", "Back closed only the sheet");
  assert.equal(await settingsOpen(page), true);

  await page.locator("#settingsPanel-git .settings-section-title").click();
  await page.goBack();
  await page.locator("#settingsForm[data-mobile-view='menu']").waitFor();
  assert.equal(await settingsOpen(page), true, "Back in a section must not close Settings");

  await page.getByTestId("settings-tab-git").click();
  assert.equal(await mobileView(page), "panel");
  await page.goBack();
  await page.locator("#settingsForm[data-mobile-view='menu']").waitFor();
  await page.goBack();
  await page.locator("#settingsDialog:not([open])").waitFor({ state: "attached" });
  assert.equal(await page.getByTestId("phone-tab-settings").isVisible(), true, "the app is back");

  // A conversation's ⋯ sheet closes first; the conversation stays until the next Back.
  await page.getByTestId("phone-tab-projects").click();
  await page.locator(".project-card").first().click();
  await page.locator("#sessionList .session-card").first().click();
  await page.locator("body.view-chat").waitFor();
  await page.getByTestId("focus-controls-button").click();
  await page.locator("#focusControls:not([hidden])").waitFor();
  await page.goBack();
  await page.locator("#focusControls").waitFor({ state: "hidden" });
  assert.equal(await page.locator("body.view-chat").count(), 1, "Back closed the sheet, not the conversation");
  await page.goBack();
  await page.locator("body.view-sessions").waitFor();
});
