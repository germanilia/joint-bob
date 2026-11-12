import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

// Every dropdown searches with fuzzy matching (docs/superpowers/specs/2026-11-10-ui-redo-paper-design.md):
// a plain <select> opens the shared list (public/app/select-search.js), the message box suggests
// commands after "/" and project files after "@".

async function signIn(page: Page, url: string, username: string, password: string) {
  await page.goto(url);
  await page.getByTestId("login-username-input").fill(username);
  await page.getByTestId("login-password-input").fill(password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card").first().waitFor();
}

async function openIssuesSort(page: Page) {
  await page.locator("#allProjectIssuesButton").click();
  const sort = page.getByTestId("project-issues-sort");
  await sort.waitFor();
  await sort.click();
  return sort;
}

test("a plain dropdown opens a searchable list that marks the matched letters and sets the select", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);
  const sort = await openIssuesSort(page);
  await page.evaluate(() => {
    const select = document.querySelector<HTMLSelectElement>("[data-testid='project-issues-sort']")!;
    select.addEventListener("change", () => { (window as unknown as { sortChanges: number }).sortChanges = ((window as unknown as { sortChanges?: number }).sortChanges ?? 0) + 1; });
  });

  const search = page.getByTestId("select-search-search");
  await search.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), "select-search-search", "the search box takes the keys");
  assert.equal(await page.getByTestId("select-search-option").count(), await sort.locator("option").count(), "every option is listed");

  await search.pressSequentially("rcntupd");
  const options = page.getByTestId("select-search-option");
  assert.ok(await options.count() < await sort.locator("option").count(), "the list narrows");
  assert.equal(await options.first().innerText(), "Recently updated", "the closest match comes first");
  assert.equal(await options.first().locator("mark").count() > 0, true, "the matched letters are marked");

  await search.press("Enter");
  await page.getByTestId("select-search-options").waitFor({ state: "hidden" });
  assert.equal(await sort.inputValue(), "updated-desc");
  assert.equal(await page.evaluate(() => (window as unknown as { sortChanges: number }).sortChanges), 1, "the select reports the change");
  assert.equal(await page.getByTestId("project-issues-sort").evaluate((select) => document.activeElement === select), true, "focus returns to the dropdown");
});

test("Escape closes only the list, and a letter typed on a focused dropdown starts the search", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);
  const sort = await openIssuesSort(page);
  await page.getByTestId("select-search-search").press("Escape");
  await page.getByTestId("select-search-options").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#projectIssuesDialog").evaluate((dialog) => (dialog as HTMLDialogElement).open), true, "the dialog stays open");

  await sort.focus();
  await page.keyboard.press("o");
  assert.equal(await page.getByTestId("select-search-search").inputValue(), "o");
  assert.ok(await page.getByTestId("select-search-option").count() >= 1);
});

test("on a phone the list is a sheet from the bottom that leaves the keyboard down", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(async () => (await import("/app/settings.js")).openSettings("engines"));
  const select = page.locator("#settingsDialog select:visible").first();
  await select.waitFor();
  await select.click();
  const list = page.locator(".searchable-select-popover.sheet");
  await list.waitFor();
  const box = await list.boundingBox();
  assert.ok(box && Math.round(box.y + box.height) >= 843, "the sheet sits on the bottom edge");
  assert.notEqual(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), "select-search-search", "the keyboard stays down");
  await page.locator(".choice-scrim:visible").click({ position: { x: 20, y: 20 } });
  await list.waitFor({ state: "hidden" });
});

test("the message box suggests commands loosely and project files after @", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator(".session-card", { hasText: "Mobile Multi-Agent Threads" }).first().click();
  const input = page.locator("#messageInput:not(:disabled)");
  await input.waitFor({ timeout: 20_000 });

  await input.fill("");
  await input.pressSequentially("/cmpt");
  const command = page.getByTestId("chat-command-autocomplete-option").first();
  await command.waitFor();
  assert.match(await command.innerText(), /\/compact/);
  assert.ok(await command.locator("mark").count() > 0);

  await input.fill("");
  await input.pressSequentially("look at @cfg");
  const file = page.getByTestId("chat-file-autocomplete-option").first();
  await file.waitFor();
  assert.match(await file.innerText(), /config\.ts/);
  await input.press("Enter");
  assert.equal(await input.inputValue(), "look at @config.ts ");
});
