import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { openNodeDatabase } from "../../src/node-database.js";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("the wizard defaults to a worktree but lets this conversation use the project folder", { timeout: 90_000 }, async t => {
  const { page, node, environment } = await nativeUiFixture(t, root => ({ JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log") }));
  const project = node.projects.find(project => project.name === "Joint Bob")!;
  await page.goto(`${node.url}/?projectId=${project.id}`, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor();
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByTestId("session-create-button").click();
  await page.locator("#newSessionNameDialog[open]").waitFor();
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
  const database = openNodeDatabase(path.join(node.dataDir, "node.db"));
  try {
    const record = database.prepare("SELECT worktree, worktree_at FROM conversation_records WHERE session_id = ?").get(url.searchParams.get("sessionId"))!;
    assert.equal(record.worktree, null);
    assert.ok(record.worktree_at, "the choice is persisted before the conversation becomes ready");
  } finally { database.close(); }
});
