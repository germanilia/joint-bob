import assert from "node:assert/strict";
import test from "node:test";
import { editorTab, openAutomationRow, signInToApp } from "./automation-editor-driver.js";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("automation history shows opening feedback and opens the requested conversation without waiting for the project list", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const projectId = node.projects[0].id;
  await signInToApp(page, node.url, environment.username, environment.password);
  const { id, session } = await page.evaluate(async (projectId) => {
    const { api } = await import("/app/api.js");
    const { automation } = await api("/api/automations", { method: "POST", body: JSON.stringify({
      name: "Log errors", trigger: "webhook", target: { kind: "project", projectId }, context: "Check the logs",
    }) });
    const { sessions } = await api(`/api/projects/${projectId}/sessions`);
    return { id: automation.id, session: sessions.find(({ path }) => !path.startsWith("draft:")) };
  }, projectId);
  assert.ok(session?.id, "the fixture has a saved conversation");
  const sessionId = "f9734e77-165d-46a0-b0d8-56f3df70c907";
  await page.route(`**/api/automations/${id}/history`, (route) => route.fulfill({ json: {
    runs: [], calls: [
      { id: 2, at: new Date().toISOString(), status: "delivered", detail: "Missing conversation", sender: null, sessionId },
      { id: 1, at: new Date().toISOString(), status: "delivered", detail: "Saved conversation", sender: null, sessionId: session.id },
    ],
  } }));
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route(`**/api/projects/${projectId}/sessions?sessionId=${sessionId}`, async (route) => {
    received.resolve();
    await release.promise;
    await route.continue();
  });

  await page.getByTestId("workspace-automations-button").click();
  await openAutomationRow(page, "Log errors");
  await editorTab(page, "history");
  const missingRow = page.locator(".automation-history-row", { hasText: "Missing conversation" });
  const open = missingRow.getByTestId("automation-call-open");
  await open.click();
  await received.promise;
  try {
    assert.equal(await open.textContent(), "Opening…");
    assert.equal(await open.isDisabled(), true);
  } finally {
    release.resolve();
  }
  const error = missingRow.getByRole("status");
  await error.waitFor();
  assert.match(await error.innerText(), /conversation.*no longer available/i);
  assert.equal(await open.isEnabled(), true);
  assert.equal(await open.textContent(), "Open conversation");

  const saved = page.locator(".automation-history-row", { hasText: "Saved conversation" }).getByTestId("automation-call-open");
  if (!await saved.isVisible()) await page.getByTestId("automation-calls-page-next").click();
  const receivedList = Promise.withResolvers<void>();
  const releaseList = Promise.withResolvers<void>();
  await page.route(`**/api/projects/${projectId}/sessions`, async (route) => {
    receivedList.resolve();
    await releaseList.promise;
    await route.continue();
  });
  try {
    await saved.click();
    await receivedList.promise;
    await page.waitForFunction(async ({ projectId, sessionId }) => {
      const { state } = await import("/app/state.js");
      const { activeConversationReady } = await import("/app/socket.js");
      return state.activeProjectId === projectId && state.activeSessionId === sessionId && activeConversationReady();
    }, { projectId, sessionId: session.id }, { timeout: 10_000 });
  } finally {
    releaseList.resolve();
  }
});
