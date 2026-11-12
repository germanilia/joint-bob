import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("command settings preserve identity and drafts, expose scoped sharing and read-only received commands", { timeout: 240_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().waitFor();
  await page.evaluate(async () => (await import("/app/settings.js")).openSettings("commands"));
  await page.locator('#settingsForm[data-ready="true"]').waitFor();
  await page.getByTestId("add-saved-command").click();
  const id = await page.locator(".saved-command-row").getAttribute("data-command-id");
  assert.match(id!, /^[0-9a-f-]{36}$/);
  // A row still empty is a draft: it is not saved, so it cannot be shared yet.
  await page.getByTestId("saved-command-share").click();
  await page.locator(".toast", { hasText: "Give the command a name and a prompt before sharing it." }).waitFor();
  assert.equal(await page.getByTestId("command-share-dialog").count(), 0, "a draft command cannot be shared");
  // The draft is ignored, so other changes still save while it waits.
  const saveLine = page.getByTestId("settings-save-state");
  await page.getByTestId("settings-end-conversation-enabled").click();
  await page.locator('[data-testid="settings-save-state"]:is([data-state="saved"], [data-state="failed"])').waitFor();
  assert.equal(await saveLine.getAttribute("data-state"), "saved", `an empty draft row must not stop other changes saving: ${await saveLine.innerText()}`);
  // Half a command does not save, so Share says why instead of sharing.
  await page.getByTestId("saved-command-name").fill("Share review");
  await page.getByTestId("saved-command-share").click();
  await page.locator(".toast", { hasText: "Fix the command first: Saved commands need a name and prompt" }).waitFor();
  assert.equal(await page.getByTestId("command-share-dialog").count(), 0, "an unsaved command cannot be shared");
  await page.getByTestId("settings-save-state").getByText("Not saved: Saved commands need a name and prompt", { exact: true }).waitFor();
  await page.getByTestId("saved-command-prompt").fill("Review carefully");
  await page.locator('[data-testid="settings-save-state"][data-state="saved"]').waitFor();
  assert.equal(await page.getByTestId("saved-command-prompt").inputValue(), "Review carefully");
  assert.equal(await page.getByTestId("saved-command-name").inputValue(), "Share review", "saving keeps the draft on the page");
  await page.getByTestId("settings-cancel-button").click();
  await page.locator("#settingsDialog[open]").waitFor({ state: "hidden" });
  let refreshes = 0;
  const opaque = "owner/account/preset";
  await page.route("**/api/commands/sharing", async (route) => {
    refreshes++;
    await route.fulfill({ json: {
      commands: [{ id: opaque, presetId: id, kind: "local", name: "Share review", prompt: "Review carefully", clusterIds: [], nodeIds: [], workspaceIds: [], projectIds: [], conversations: [] }, { id: "received", kind: "received", name: "Peer command", prompt: "Peer prompt", receivedFromName: "Test peer" }],
      clusters: [{ id: "cluster", name: "Team" }], nodes: [{ nodeId: "peer", name: "Peer" }], workspaces: [{ id: "workspace", label: "Work" }], projects: [{ id: "project", name: "Project" }],
    } });
  });
  await page.route("**/api/projects/project/sessions", (route) => route.fulfill({ json: { sessions: [{ conversationId: "conversation", title: "Thread" }] } }));
  let saved: unknown;
  await page.route("**/api/commands/*/sharing", async (route) => {
    assert.equal(decodeURIComponent(new URL(route.request().url()).pathname), `/api/commands/${opaque}/sharing`);
    saved = route.request().postDataJSON(); await route.fulfill({ json: { ok: true } });
  });
  await page.evaluate(async () => (await import("/app/settings.js")).openSettings("commands"));
  assert.equal(await page.locator(".saved-command-row").getAttribute("data-command-id"), id);
  await page.getByTestId("received-commands-list").getByText("Peer command").waitFor();
  assert.match(await page.getByTestId("received-commands-list").innerText(), /From Test peer · Read only/);
  assert.equal(await page.getByTestId("received-commands-list").locator("input,textarea,button").count(), 0);
  const before = refreshes;
  const refreshed = page.waitForResponse((response) => response.url().endsWith("/api/commands/sharing"));
  await page.getByTestId("received-commands-refresh").click();
  await refreshed;
  assert.ok(refreshes > before);
  // Share saves the command's latest edit first, so what is shared is what the page shows.
  const savedEdit = page.waitForRequest((request) => request.method() === "PUT" && new URL(request.url()).pathname === "/api/settings"
    && (request.postDataJSON() as { conversationCommands: { presets: Array<{ prompt: string }> } }).conversationCommands.presets.some((preset) => preset.prompt === "Unsaved edit"));
  await page.getByTestId("saved-command-prompt").fill("Unsaved edit");
  await page.getByTestId("saved-command-share").click();
  await savedEdit;
  await page.getByTestId("command-share-dialog").waitFor();
  await page.getByTestId("command-share-cancel").click();
  await page.getByTestId("command-share-dialog").waitFor({ state: "detached" });
  await page.getByTestId("saved-command-prompt").fill("Review carefully");
  // Sharing leaves other settings on the page as they are; Share saves them with the command.
  await page.locator("#settingsStartConversationPrompt").fill("Keep unsaved settings", { force: true });
  await page.getByTestId("saved-command-share").click();
  await page.getByTestId("command-share-dialog").waitFor();
  for (const field of ["clusterIds", "nodeIds", "workspaceIds", "projectIds"]) await page.getByTestId(`command-share-${field}`).check();
  await page.getByTestId("command-share-conversation-project").selectOption("project");
  await page.getByTestId("command-share-conversations").check();
  await page.getByTestId("command-share-save").click();
  await page.getByTestId("command-share-dialog").waitFor({ state: "detached" });
  assert.deepEqual(saved, { clusterIds: ["cluster"], nodeIds: ["peer"], workspaceIds: ["workspace"], projectIds: ["project"], conversations: [{ projectId: "project", conversationId: "conversation" }] });
  assert.equal(await page.locator("#settingsStartConversationPrompt").inputValue(), "Keep unsaved settings");
  const stored = await page.evaluate(async () => (await (await fetch("/api/settings")).json()).conversationCommands);
  assert.equal(stored.start.prompt, "Keep unsaved settings", "Share saved what was still waiting");
  assert.deepEqual(stored.presets.map((preset: { id: string; prompt: string }) => [preset.id, preset.prompt]), [[id, "Review carefully"]], "the command keeps its identity");
});
