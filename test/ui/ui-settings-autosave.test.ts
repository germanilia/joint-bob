// Settings has no shared Save button: every change saves on its own, through the request the button
// used to send, and one line in the open section's head says how that went. This suite changes a
// representative field in each section that used to save only through the button, waits for the
// line to say "Saved", reloads, and checks each value came back. It also covers a failure from the
// node (the line and a toast say why, and the next change saves) and leaving Settings right after a
// change (the change is saved on the way out).
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

const READY = '#settingsForm[data-ready="true"]';
const line = (state: string) => `[data-testid="settings-save-state"][data-state="${state}"]`;

async function signIn(page: Page, url: string, username: string, password: string) {
  await page.goto(url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.getByTestId("login-username-input").fill(username);
  await page.getByTestId("login-password-input").fill(password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#loginDialog[open]").waitFor({ state: "hidden" });
  await page.locator(".project-card").first().waitFor();
}

/** Opens Settings on one section, once its saved values are on the page. */
async function openSection(page: Page, tab: string) {
  if (!await page.locator("#settingsDialog[open]").count()) {
    await page.getByTestId("settings-open-button").click();
    await page.locator("#settingsDialog[open]").waitFor();
  }
  await page.getByTestId(`settings-tab-${tab}`).click();
  await page.locator(READY).waitFor();
}

const waitForSaved = (page: Page) => page.locator(line("saved")).waitFor();
const nodeSettings = (page: Page) => page.evaluate(async () => (await fetch("/api/settings")).json());

async function leaveSettings(page: Page) {
  await page.getByTestId("settings-cancel-button").click();
  await page.locator("#settingsDialog[open]").waitFor({ state: "hidden" });
}

/** A stand-in ntfy server, so error reporting has a saved server to send to. */
async function ntfyFixture(t: test.TestContext): Promise<string> {
  const server: Server = createServer((request, response) => { request.resume(); request.on("end", () => response.end("{}")); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("ntfy fixture address missing");
  return `http://127.0.0.1:${address.port}`;
}

test("every section that waited for Save settings saves as it changes and keeps its values after a reload", { timeout: 300_000 }, async (t) => {
  const ntfyUrl = await ntfyFixture(t);
  const { page, environment, node } = await nativeUiFixture(t);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, node.url, environment.username, environment.password);
  const before = await nodeSettings(page);
  const home = path.join(environment.home, "autosave-home");
  const skills = path.join(environment.home, "autosave-skills");

  // Account: numbers save when the field is left, switches at once.
  await openSection(page, "account");
  assert.equal(await page.getByTestId("settings-save-button").count(), 0, "there is no shared Save button");
  assert.equal(await page.getByTestId("settings-save-state").innerText(), "Changes save as you make them");
  await page.getByTestId("settings-conversation-history-days").fill("45");
  assert.equal(await page.locator(line("pending")).count(), 1, "a typed number waits for the field to be left");
  await page.getByTestId("settings-conversation-history-days").press("Tab");
  await waitForSaved(page);
  await page.getByTestId("settings-auto-compact-threshold").fill("85");
  await page.getByTestId("settings-auto-compact-threshold").press("Tab");
  await waitForSaved(page);
  await page.getByTestId("settings-digest-attachments").setChecked(!before.digestAttachments);
  await waitForSaved(page);
  await page.getByTestId("settings-show-projects-on-other-nodes").setChecked(before.showProjectsOnOtherNodes === false);
  await waitForSaved(page);
  assert.equal(await page.locator("#settingsDialog").evaluate((dialog: HTMLDialogElement) => dialog.open), true, "saving never closes Settings");

  // Labels: typed text saves after a pause.
  await openSection(page, "labels");
  await page.getByTestId("settings-conversation-labels").fill("Research\nBug\nAutosaved label");
  await waitForSaved(page);

  // Conversations.
  await openSection(page, "conversations");
  await page.getByTestId("settings-new-conversation-worktree").setChecked(!before.newConversationWorktree);
  await waitForSaved(page);

  // Commands: the prompts, a switch, and one saved command.
  await openSection(page, "commands");
  await page.getByTestId("settings-start-conversation-prompt").fill("Autosaved start prompt.");
  await waitForSaved(page);
  await page.getByTestId("settings-end-conversation-enabled").check();
  await waitForSaved(page);
  await page.getByTestId("add-saved-command").click();
  await page.getByTestId("saved-command-name").fill("Autosaved command");
  await page.getByTestId("saved-command-prompt").fill("Autosaved command prompt.");
  await waitForSaved(page);

  // Workspaces: a path saves when the field is left.
  await openSection(page, "workspaces");
  await page.getByTestId("settings-project-home-input").fill(home);
  await page.getByTestId("settings-project-home-input").press("Tab");
  await waitForSaved(page);

  // Git.
  await openSection(page, "git");
  await page.getByTestId("settings-git-pull-file-limit").fill("640");
  await page.getByTestId("settings-git-pull-file-limit").press("Tab");
  await waitForSaved(page);

  // Harnesses: a model chosen in the searchable dropdown.
  await openSection(page, "engines");
  await page.getByTestId("harness-tab-claude").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="settings-claude-model-options-status"]')?.textContent === "");
  const model = page.getByTestId("settings-claude-default-model");
  const currentModel = await model.getAttribute("data-value");
  await model.click();
  const options = page.getByTestId("settings-claude-default-model-option");
  await options.first().waitFor();
  const otherModel = (await options.evaluateAll((items) => items.map((item) => item.getAttribute("data-value")))).find((value) => value && value !== currentModel)!;
  assert.ok(otherModel, "Claude offers a second model");
  await options.and(page.locator(`[data-value="${otherModel}"]`)).click();
  await waitForSaved(page);

  // Node: two switches, and terminal access through its own request.
  await openSection(page, "node");
  await page.getByTestId("settings-remote-terminal-twins").setChecked(!before.remoteTerminal.twins);
  await waitForSaved(page);
  await page.getByTestId("settings-runner-other-nodes").setChecked(!before.runnerAccess.otherNodes);
  await waitForSaved(page);
  // The dev seed turns terminal access on for its admin; the page fills the policy in just after it loads.
  await page.waitForFunction(() => (document.querySelector('[data-testid="terminal-policy-mode"]') as HTMLSelectElement).value === "admin");
  await page.getByTestId("terminal-policy-idle").fill("45");
  await page.getByTestId("terminal-policy-idle").press("Tab");
  await waitForSaved(page);

  // Resources › Load paths.
  await openSection(page, "resources");
  await page.getByTestId("resources-tab-paths").click();
  await page.getByTestId("settings-resource-skills-paths").fill(skills);
  await page.getByTestId("settings-resource-skills-paths").press("Tab");
  await waitForSaved(page);

  // System AI, through its own request.
  await openSection(page, "system-ai");
  await page.getByTestId("system-ai-decision-model").waitFor();
  await page.getByTestId("settings-sync-check-enabled").setChecked(!before.syncCheck.enabled);
  await waitForSaved(page);

  // Activity overview.
  await openSection(page, "story");
  await page.waitForFunction(() => (document.getElementById("storyInstructions") as HTMLTextAreaElement).value !== "");
  const moods = await page.getByTestId("story-moods").isChecked();
  await page.getByTestId("story-moods").setChecked(!moods);
  await waitForSaved(page);

  // Shortcuts: a captured chord.
  await openSection(page, "shortcuts");
  const recents = page.getByTestId("keymap-recents-input");
  const recentsBefore = await recents.inputValue();
  await recents.click();
  await page.keyboard.press("Control+KeyJ");
  await waitForSaved(page);
  const recentsAfter = await recents.inputValue();
  assert.notEqual(recentsAfter, recentsBefore);

  // Notifications › Send errors to ntfy: on, with a topic.
  await openSection(page, "notifications");
  await page.getByTestId("error-reporting-settings").waitFor();
  await page.getByTestId("ntfy-service-name-input").fill("Autosave ntfy");
  await page.getByTestId("ntfy-service-url-input").fill(ntfyUrl);
  await page.getByTestId("ntfy-service-add-button").click();
  await page.getByTestId("ntfy-service-list").getByText("Autosave ntfy").waitFor();
  await page.getByTestId("error-reporting-enabled").check();
  await page.getByTestId("error-reporting-client-topic").fill("autosave-errors");
  await waitForSaved(page);

  const saved = await nodeSettings(page);
  assert.equal(saved.conversationHistoryDays, 45);
  assert.equal(saved.autoCompactThreshold, 85);
  assert.equal(saved.digestAttachments, !before.digestAttachments);
  assert.equal(saved.showProjectsOnOtherNodes, before.showProjectsOnOtherNodes === false);
  // The node keeps its built-in labels beside the ones typed here.
  assert.ok(saved.conversationLabels.includes("Autosaved label"), JSON.stringify(saved.conversationLabels));
  assert.equal(saved.newConversationWorktree, !before.newConversationWorktree);
  assert.equal(saved.conversationCommands.start.prompt, "Autosaved start prompt.");
  assert.equal(saved.conversationCommands.end.enabled, true);
  assert.deepEqual(saved.conversationCommands.presets.map(({ name, prompt }: { name: string; prompt: string }) => [name, prompt]), [["Autosaved command", "Autosaved command prompt."]]);
  assert.equal(saved.projects.homePath, home);
  assert.equal(saved.gitPullFileLimit, 640);
  assert.equal(saved.conversationDefaults.claude.modelId, otherModel);
  assert.equal(saved.remoteTerminal.twins, !before.remoteTerminal.twins);
  assert.equal(saved.runnerAccess.otherNodes, !before.runnerAccess.otherNodes);
  assert.deepEqual(saved.resources.skills, [skills]);
  assert.equal(saved.syncCheck.enabled, !before.syncCheck.enabled);
  assert.equal((await page.evaluate(async () => (await fetch("/api/terminal-policy")).json())).idleMinutes, 45);

  await leaveSettings(page);
  await page.reload();
  await page.locator(".project-card").first().waitFor();
  await openSection(page, "account");
  assert.equal(await page.getByTestId("settings-conversation-history-days").inputValue(), "45");
  assert.equal(await page.getByTestId("settings-auto-compact-enabled").isChecked(), true);
  assert.equal(await page.getByTestId("settings-auto-compact-threshold").inputValue(), "85");
  assert.equal(await page.getByTestId("settings-digest-attachments").isChecked(), !before.digestAttachments);
  assert.equal(await page.getByTestId("settings-show-projects-on-other-nodes").isChecked(), before.showProjectsOnOtherNodes === false);
  await openSection(page, "labels");
  assert.ok((await page.getByTestId("settings-conversation-labels").inputValue()).split("\n").includes("Autosaved label"));
  await openSection(page, "conversations");
  assert.equal(await page.getByTestId("settings-new-conversation-worktree").isChecked(), !before.newConversationWorktree);
  await openSection(page, "commands");
  assert.equal(await page.getByTestId("settings-start-conversation-prompt").inputValue(), "Autosaved start prompt.");
  assert.equal(await page.getByTestId("settings-end-conversation-enabled").isChecked(), true);
  assert.equal(await page.getByTestId("saved-command-name").inputValue(), "Autosaved command");
  assert.equal(await page.getByTestId("saved-command-prompt").inputValue(), "Autosaved command prompt.");
  await openSection(page, "workspaces");
  assert.equal(await page.getByTestId("settings-project-home-input").inputValue(), home);
  await openSection(page, "git");
  assert.equal(await page.getByTestId("settings-git-pull-file-limit").inputValue(), "640");
  await openSection(page, "engines");
  await page.getByTestId("harness-tab-claude").click();
  assert.equal(await page.getByTestId("settings-claude-default-model").getAttribute("data-value"), otherModel);
  await openSection(page, "node");
  assert.equal(await page.getByTestId("settings-remote-terminal-twins").isChecked(), !before.remoteTerminal.twins);
  assert.equal(await page.getByTestId("settings-runner-other-nodes").isChecked(), !before.runnerAccess.otherNodes);
  await page.waitForFunction(() => (document.querySelector('[data-testid="terminal-policy-idle"]') as HTMLInputElement).value === "45");
  await openSection(page, "resources");
  await page.getByTestId("resources-tab-paths").click();
  assert.equal(await page.getByTestId("settings-resource-skills-paths").inputValue(), skills);
  await openSection(page, "system-ai");
  await page.getByTestId("system-ai-decision-model").waitFor();
  assert.equal(await page.getByTestId("settings-sync-check-enabled").isChecked(), !before.syncCheck.enabled);
  await openSection(page, "story");
  await page.waitForFunction((expected) => document.getElementById("storyInstructions") instanceof HTMLTextAreaElement
    && (document.getElementById("storyInstructions") as HTMLTextAreaElement).value !== ""
    && (document.getElementById("storyMoods") as HTMLInputElement).checked === expected, !moods);
  await openSection(page, "shortcuts");
  assert.equal(await page.getByTestId("keymap-recents-input").inputValue(), recentsAfter);
  await openSection(page, "notifications");
  await page.getByTestId("error-reporting-options").waitFor();
  assert.equal(await page.getByTestId("error-reporting-enabled").isChecked(), true);
  assert.equal(await page.getByTestId("error-reporting-client-topic").inputValue(), "autosave-errors");
  assert.deepEqual(errors, []);
});

test("a failure from the node shows on the save line and in a toast, and the next change saves", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);
  const before = await nodeSettings(page);
  await openSection(page, "account");
  await page.route("**/api/settings", (route) => route.request().method() === "PUT"
    ? route.fulfill({ status: 503, json: { error: "Settings store unavailable" } })
    : route.continue());
  await page.getByTestId("settings-digest-attachments").setChecked(!before.digestAttachments);
  await page.locator(line("failed")).waitFor();
  const saveLine = page.getByTestId("settings-save-state");
  assert.match(await saveLine.innerText(), /^Not saved: .*Settings store unavailable/);
  assert.equal(await page.getByTestId("settings-save-retry").isVisible(), true, "a failed save offers Try again");
  await page.locator(".toast", { hasText: /Settings not saved: .*Settings store unavailable/ }).waitFor();
  assert.equal(await page.getByTestId("settings-digest-attachments").isChecked(), !before.digestAttachments, "the change stays on the page");
  assert.equal((await nodeSettings(page)).digestAttachments, before.digestAttachments, "nothing was saved");

  await page.unroute("**/api/settings");
  // The next change saves both: every save sends the whole section.
  await page.getByTestId("settings-show-projects-on-other-nodes").setChecked(before.showProjectsOnOtherNodes === false);
  await waitForSaved(page);
  assert.equal(await page.getByTestId("settings-save-retry").count(), 0);
  const saved = await nodeSettings(page);
  assert.equal(saved.digestAttachments, !before.digestAttachments);
  assert.equal(saved.showProjectsOnOtherNodes, before.showProjectsOnOtherNodes === false);
});

test("leaving Settings right after a change still saves it", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);
  const until = async (check: (settings: Record<string, any>) => boolean, label: string) => {
    for (const deadline = Date.now() + 10_000; Date.now() < deadline; await page.waitForTimeout(100)) if (check(await nodeSettings(page))) return;
    assert.fail(`${label} was not saved after leaving Settings`);
  };

  // Typed text that has not waited out its pause yet.
  await openSection(page, "labels");
  await page.getByTestId("settings-conversation-labels").fill("Research\nLeft in a hurry");
  await page.getByTestId("settings-cancel-button").click();
  await page.locator("#settingsDialog[open]").waitFor({ state: "hidden" });
  await until((settings) => settings.conversationLabels.includes("Left in a hurry"), "the typed label");

  // A number still in its field, which otherwise saves only when left.
  await openSection(page, "git");
  await page.getByTestId("settings-git-pull-file-limit").fill("512");
  await page.getByTestId("settings-cancel-button").click();
  await page.locator("#settingsDialog[open]").waitFor({ state: "hidden" });
  await until((settings) => settings.gitPullFileLimit === 512, "the number still in its field");

  // Escape leaves Settings too, and saves on the way out.
  await openSection(page, "account");
  await page.getByTestId("settings-conversation-history-days").fill("21");
  await page.keyboard.press("Escape");
  await page.locator("#settingsDialog[open]").waitFor({ state: "hidden" });
  await until((settings) => settings.conversationHistoryDays === 21, "the number left with Escape");

  await openSection(page, "labels");
  assert.ok((await page.getByTestId("settings-conversation-labels").inputValue()).split("\n").includes("Left in a hurry"));
  await leaveSettings(page);
});
