import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { signIn } from "../dev-nodes.js";

async function openProject(t: Parameters<typeof nativeUiFixture>[0]) {
  const fixture = await nativeUiFixture(t);
  const { page, environment, node } = fixture;
  const session = await signIn(environment, node);
  const separator = session.cookie.indexOf("=");
  await page.context().addCookies([{ name: session.cookie.slice(0, separator), value: session.cookie.slice(separator + 1), url: node.url }]);
  await page.goto(node.url);
  await page.waitForFunction(async () => (await import("/app/state.js")).state.preferencesLoaded);
  await page.getByText("Internal Assistant", { exact: true }).click();
  await page.getByTestId("session-list-loading-bar").waitFor({ state: "hidden" });
  return fixture;
}

async function newConversation(page: Page) {
  await page.keyboard.press("Control+Alt+Shift+KeyN");
  await page.getByTestId("quick-note-dialog").waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-testid="quick-note-save-button"]')!.disabled).catch(async error => {
    throw new Error(`${error.message}; dialog error: ${await page.locator("#quickNoteError").textContent()}`);
  });
}

test("new conversations always open at project step, including after cancel", { timeout: 120_000 }, async t => {
  const { page } = await openProject(t);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await newConversation(page);
    assert.equal(await page.getByTestId("quick-note-step-1").getAttribute("aria-current"), "step", "a preselected project must not skip step 1");
    assert.equal(await page.getByTestId("quick-note-project-select").isVisible(), true);
    assert.equal(await page.getByTestId("quick-note-project-select").textContent(), "Internal Assistant");
    await page.getByTestId("quick-note-next-button").click();
    await page.getByTestId("quick-note-cancel-button").click();
  }
});

test("Start conversation stays visible on every step and starts from content using defaults", { timeout: 120_000 }, async t => {
  const { page, node } = await openProject(t);
  await newConversation(page);
  const start = page.getByTestId("quick-note-save-button");
  assert.equal(await start.isVisible(), true, "Start must be available without completing the wizard");
  await start.click();
  await page.getByTestId("quick-note-content-input").waitFor({ state: "visible" });
  assert.equal(await page.locator("#quickNoteError").textContent(), "Write what the agent should do.");
  await page.getByTestId("quick-note-content-input").fill("Check defaults without visiting configuration");
  for (const step of [3, 4, 5, 1, 2]) {
    await page.getByTestId(`quick-note-step-${step}`).click();
    assert.equal(await start.isVisible(), true, `Start stays visible at step ${step}`);
  }
  await page.getByTestId("quick-note-cancel-button").click();
  await newConversation(page);
  await page.getByTestId("quick-note-next-button").click();
  await page.getByTestId("quick-note-content-input").fill("Check defaults without visiting configuration");
  const saved = page.waitForResponse(response => response.url() === `${node.url}/api/quick-notes` && response.request().method() === "POST");
  const launched = page.waitForResponse(response => /\/api\/quick-notes\/[^/]+\/start$/.test(response.url()) && response.request().method() === "POST");
  await start.click();
  const noteResponse = await saved;
  assert.equal(noteResponse.status(), 201);
  const { note } = await noteResponse.json();
  assert.equal(note.projectId, node.projects.find(project => project.name === "Internal Assistant")!.id);
  assert.equal(note.title, "Check defaults without visiting configuration");
  assert.equal(note.harnessId, "pi");
  assert.equal(note.modelId, null, "unvisited model step keeps harness default");
  assert.equal(note.thinkingLevel, null, "unvisited thinking choice keeps default");
  assert.equal((await launched).status(), 200);
  await page.getByTestId("quick-note-dialog").waitFor({ state: "hidden" });
});

test("Delete conversation is directly in chat More, confirms and deletes the open conversation", { timeout: 120_000 }, async t => {
  const { page } = await openProject(t);
  const row = page.locator("#sessionList .list-row").filter({ has: page.locator("strong", { hasText: "Makor deployment information" }) }).first();
  await row.locator("button").first().click();
  await page.locator("#sessionTitle").filter({ hasText: "Makor deployment information" }).waitFor();
  await page.getByTestId("chat-more-button").click();
  const remove = page.getByTestId("chat-delete-button");
  assert.equal(await remove.count(), 1, "delete must not be buried in Conversation actions");
  assert.equal(await remove.isVisible(), true);
  await remove.click();
  await page.getByTestId("confirm-cancel-button").click();
  assert.equal(await row.count(), 1, "cancel does not delete");
  await page.getByTestId("chat-more-button").click();
  await remove.click();
  const deleted = page.waitForResponse(response => response.url().includes("/sessions?sessionId=") && response.request().method() === "DELETE");
  await page.getByTestId("confirm-accept-button").click();
  const deleteResponse = await deleted;
  assert.equal(deleteResponse.status(), 204, await deleteResponse.text());
  await row.waitFor({ state: "detached" });
  assert.equal(await page.locator("#sessionTitle").textContent(), "Select a conversation");
});
