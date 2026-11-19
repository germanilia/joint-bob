import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { openNodeDatabase } from "../../src/node-database.js";
import { nativeUiFixture } from "./native-ui-fixture.js";

async function openWizard(t: Parameters<typeof nativeUiFixture>[0]) {
  const { page, node, environment } = await nativeUiFixture(t, root => ({ JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log") }));
  const project = node.projects.find(project => project.name === "Joint Bob")!;
  await page.goto(`${node.url}/?projectId=${project.id}`, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor();
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByTestId("session-create-button").click();
  await page.locator("#newSessionNameDialog[open]").waitFor();
  return { page, node, project };
}

test("the wizard defaults to a worktree but lets this conversation use the project folder", { timeout: 90_000 }, async t => {
  const { page, node } = await openWizard(t);
  assert.equal(await page.getByTestId("new-session-worktree-select").inputValue(), "new");
  const newWorktreeToggle = page.locator("#newSessionNewWorktree");
  const hasToggle = await newWorktreeToggle.count();
  if (hasToggle) await newWorktreeToggle.uncheck();
  await page.getByTestId("new-session-next-button").click();
  await page.getByTestId("new-session-next-button").click();
  if (!hasToggle) await page.getByTestId("new-session-worktree-select").selectOption("");
  const connected = page.waitForEvent("websocket", { predicate: socket => new URL(socket.url()).searchParams.get("sessionPath") === "new" });
  await page.getByTestId("new-session-name-start-button").click();
  const socket = await connected;
  const url = new URL(socket.url());
  assert.equal(url.searchParams.get("worktree"), "project", "the form sends its explicit opt-out to the server");
  await page.getByText("Ready for your first message", { exact: true }).waitFor();
  assert.equal(await page.locator("#messageInput:focus").count(), 1);
  const database = openNodeDatabase(path.join(node.dataDir, "node.db"));
  try {
    const record = database.prepare("SELECT worktree, worktree_at FROM conversation_records WHERE session_id = ?").get(url.searchParams.get("sessionId"))!;
    assert.equal(record.worktree, null);
    assert.ok(record.worktree_at, "the choice is persisted before the conversation becomes ready");
  } finally { database.close(); }
});

test("typing starts right away while the default worktree is being created", { timeout: 90_000 }, async t => {
  const { page, project } = await openWizard(t);
  const { promise: worktreeGate, resolve: finishWorktree } = Promise.withResolvers<void>();
  await page.route(`**/api/projects/${project.id}/worktrees`, async (route) => {
    if (route.request().method() === "POST") await worktreeGate;
    await route.continue();
  });
  try {
    await page.getByTestId("new-session-next-button").click();
    await page.getByTestId("new-session-next-button").click();
    await page.getByTestId("new-session-name-start-button").click();
    await page.getByText("You can send messages now. They will wait until the worktree is ready.").waitFor();
    assert.equal(await page.locator("#messageInput:focus").count(), 1);
    await page.keyboard.type("First draft");
    finishWorktree();
    await page.getByText("Ready for your first message", { exact: true }).waitFor();
    await page.keyboard.type(" continued");
    assert.equal(await page.getByTestId("chat-message-input").inputValue(), "First draft continued");
  } finally { finishWorktree(); }
});
