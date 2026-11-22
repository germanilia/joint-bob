import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ensureConversationRecordSchema, setWebhookConversationHistory } from "../../src/conversation-records.js";
import { openNodeDatabase } from "../../src/node-database.js";
import { claudeProjectDir } from "../../src/session-paths.js";
import { recordWebhookDelivery } from "../../src/webhooks.js";
import { api, signIn } from "../dev-nodes.js";
import { editorTab, openAutomationRow, openProjectAutomations, signInToApp } from "./automation-editor-driver.js";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("a legacy webhook call opens the original hidden transcript after worktree cleanup", { timeout: 180_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  const project = node.projects.find(item => item.name === "Internal Assistant")!;
  const auth = await signIn(environment, node);
  const created = await api<{ automation: { id: string } }>(node, auth, "POST", "/automations", {
    name: "History fixture", hideFromHistory: true, target: { kind: "project", projectId: project.id, engine: "claude" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const hookId = created.body.automation.id, sessionId = randomUUID(), worktreeId = randomUUID();
  const worktree = path.join(environment.home, "JointBob", "worktrees", project.id, worktreeId);
  const retired = path.join(path.dirname(worktree), ".retired");
  const directory = claudeProjectDir(worktree, path.join(environment.home, ".claude", "projects"));
  await mkdir(retired, { recursive: true });
  await writeFile(path.join(retired, `${worktreeId}.json`), JSON.stringify([worktree]));
  await mkdir(directory, { recursive: true });
  const at = new Date().toISOString(), text = "Original webhook transcript after cleanup";
  await writeFile(path.join(directory, `${sessionId}.jsonl`), JSON.stringify({
    type: "user", uuid: randomUUID(), sessionId, cwd: worktree, timestamp: at, message: { role: "user", content: text },
  }) + "\n");
  const db = openNodeDatabase(path.join(node.dataDir, "node.db"));
  try {
    ensureConversationRecordSchema(db);
    db.prepare("INSERT INTO conversation_records(project_id, engine, session_id, created_at, updated_at, origin_node_id) VALUES (?, 'claude', ?, ?, ?, ?)")
      .run(project.id, sessionId, at, at, node.nodeId);
    setWebhookConversationHistory(db, project.id, sessionId, hookId, true, node.nodeId);
    recordWebhookDelivery(db, hookId, "delivered", `Started conversation ${sessionId}`);
  } finally { db.close(); }
  const ordinary = await api<{ sessions: Array<{ id: string }> }>(node, auth, "GET", `/projects/${project.id}/sessions?all=1`);
  assert.equal(ordinary.body.sessions.some(item => item.id === sessionId), false, "hidden from normal lists");
  await signInToApp(page, node.url, environment.username, environment.password);
  await openProjectAutomations(page);
  await openAutomationRow(page, "History fixture");
  await editorTab(page, "history");
  await page.getByText(`Started conversation ${sessionId}`, { exact: true }).waitFor();
  await page.getByRole("button", { name: "Open conversation", exact: true }).click();
  await page.locator("#messages").getByText(text, { exact: true }).waitFor().catch(async error => {
    throw new Error(`${error.message}\nChat: ${await page.locator("#messages").innerText()}\nEditor: ${await page.getByTestId("automation-status").textContent()}`);
  });
});
