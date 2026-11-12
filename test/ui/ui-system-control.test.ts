import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { api, signIn } from "../dev-nodes.js";

test("a Bob card opens system control with unlimited defaults and saves instructions and limits", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t, root => ({ JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log") }));
  const auth = await signIn(environment, node);
  const project = node.projects.find(project => project.name === "Internal Assistant")!;
  const listed = await api<{ sessions: Array<{ id: string; conversationId: string; path: string; title: string; harnessId: string }> }>(node, auth, "GET", `/projects/${project.id}/sessions`);
  assert.equal(listed.status, 200);
  const session = listed.body.sessions.find(session => session.harnessId === "pi")!;
  assert.ok(session, JSON.stringify(listed.body));
  const conversationId = session.conversationId ?? session.id;
  // Seed a board card for a real listed conversation. Board eligibility is tested separately;
  // this journey exercises the card action, real conversation connection and persisted settings.
  await page.route("**/api/control-center/board", route => route.fulfill({ json: {
    projects: [{ id: project.id, name: project.name, color: null }],
    cards: [{ projectId: project.id, projectName: project.name, conversationId, sessionId: session.id,
      path: session.path, title: "System control fixture", column: "review", harnessId: "pi", agentId: "pi", agentLabel: "Pi",
      executionNodeId: null, updatedAt: new Date().toISOString(), turnRunning: false, backgroundRunning: false,
      summary: null, autoRespondActive: false, controlledBy: null, pendingReviews: [], reviewCheck: null, snooze: null }],
  } }));
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.waitForFunction(async () => (await import("/app/state.js")).state.preferencesLoaded && !document.body.classList.contains("booting"));
  await page.getByTestId("projects-open-control-center-button").click();
  await page.getByTestId("control-tab-live").click();
  const card = page.getByTestId("control-center-card").and(page.locator(`[data-key="${project.id}:${conversationId}"]`));
  await card.getByRole("button", { name: "Let Bob control", exact: true }).click();
  await page.getByTestId("auto-respond-dialog").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("auto-respond-system-control").isChecked(), true);
  assert.equal(await page.getByTestId("auto-respond-limit").inputValue(), "");
  assert.equal(await page.getByTestId("auto-respond-max-minutes").inputValue(), "");
  assert.equal(await page.getByTestId("auto-respond-instructions").isHidden(), true);
  assert.equal(await page.locator("body.view-control").count(), 1, "opening control never leaves Bob's view");
  await page.getByTestId("auto-respond-system-instructions").fill("Cover the feature with tests and check it works.");
  await page.getByTestId("auto-respond-limit").fill("3");
  await page.getByTestId("auto-respond-max-minutes").fill("15");
  await page.getByTestId("auto-respond-save-button").click();
  await page.waitForFunction(async () => {
    const { state } = await import("/app/state.js");
    return state.autoRespond?.systemControl?.maxMinutes === 15 && state.autoRespond.maxResponses === 3;
  });
  await page.evaluate(async () => { await (await import("/app/auto-respond.js")).openAutoRespond({ system: true }); });
  assert.equal(await page.getByTestId("auto-respond-system-instructions").inputValue(), "Cover the feature with tests and check it works.");
  assert.equal(await page.getByTestId("auto-respond-limit").inputValue(), "3");
  assert.equal(await page.getByTestId("auto-respond-max-minutes").inputValue(), "15");
  await page.getByTestId("auto-respond-enabled").uncheck();
  await page.getByTestId("auto-respond-save-button").click();
  await page.waitForFunction(async () => !(await import("/app/state.js")).state.autoRespond);
  assert.deepEqual(errors, []);
});
