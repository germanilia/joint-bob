import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { waitInPage } from "./wait-in-page.js";

async function signIn(page: Page, url: string, username: string, password: string) {
  await page.goto(url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.getByTestId("login-username-input").fill(username);
  await page.getByTestId("login-password-input").fill(password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#loginDialog[open]").waitFor({ state: "hidden" });
  await waitInPage(page, async () => (await import('/app/state.js')).state.preferencesLoaded);
  await page.locator(".project-card").first().waitFor({ state: "visible" });
  await page.getByTestId("settings-open-button").waitFor({ state: "attached" });
}

async function openHarnessSettings(page: Page) {
  await page.getByTestId("settings-open-button").click();
  await page.locator("#settingsDialog[open]").waitFor();
  await page.getByTestId("settings-tab-engines").click();
  await page.locator('#settingsForm[data-ready="true"]').waitFor();
}

/** Every change saves on its own; this waits for the save line to say it did. */
async function waitForSaved(page: Page) {
  await page.locator('[data-testid="settings-save-state"][data-state="saved"]').waitFor();
}

/** Leaves Settings with Back to Joint Bob, as a person does once their changes are saved. */
async function leaveSettings(page: Page) {
  await page.getByTestId("settings-cancel-button").click();
  await page.locator("#settingsDialog[open]").waitFor({ state: "hidden" });
}

async function waitForHarnesses(page: Page) {
  await waitInPage(page, async () => (await import("/app/state.js")).state.harnesses.some((harness) => harness.id === "kiro"));
}

test("slow harness metadata does not hide projects", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  let releaseHarnesses!: () => void;
  const harnessGate = new Promise<void>((resolve) => { releaseHarnesses = resolve; });
  // The route says when the request reaches the gate. A waitForRequest made here would start its 20 s before the page loads and
  // the person signs in, which a cold first run can take longer than, though no single step does.
  let harnessHeld!: () => void;
  const harnessRequest = new Promise<void>((resolve) => { harnessHeld = resolve; });
  await page.route("**/api/harnesses", async (route) => {
    harnessHeld();
    await harnessGate;
    await route.continue();
  });

  try {
    await signIn(page, node.url, environment.username, environment.password);
    // The list asks for harness metadata as soon as the projects are loaded, so once they show the request is held at the gate.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([harnessRequest, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("The page never asked for /api/harnesses")), 20_000); })])
      .finally(() => clearTimeout(timer));
    await page.getByText("Internal Assistant", { exact: true }).waitFor();
  } finally {
    releaseHarnesses();
    await waitForHarnesses(page);
  }
});

test("new conversation controls follow registered harnesses and align toolbar tasks", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.route("**/api/harnesses", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.harnesses.push({ id: "cursor", label: "Cursor", newSessionPath: "cursor:new", runtimeConfigured: true });
    await route.fulfill({ response, json: body });
  });
  await signIn(page, node.url, environment.username, environment.password);
  await waitForHarnesses(page);
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();

  const buttons = page.locator("[data-new-session-harness]");
  await buttons.first().waitFor();
  assert.deepEqual(await buttons.evaluateAll((items) => items.map((item) => item.getAttribute("aria-label"))), [
    "New Pi conversation", "New Claude conversation", "New Kiro conversation", "New Cursor conversation",
  ]);
  assert.deepEqual(await buttons.evaluateAll((items) => items.map((item) => item.querySelector("svg")?.classList.contains("new-chat-harness-icon"))), [true, true, true, true]);
  assert.equal(await buttons.evaluateAll((items) => items.every((item) => [...item.childNodes].every((node) => node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()))), true, "desktop harness controls use icons without chat labels");
  // "▾" after the icons names the same agents, then a quick note and a new project.
  await page.getByTestId("new-chat-menu-button").click();
  const icons = await buttons.evaluateAll((items) => items.map((item) => item.getAttribute("aria-label")));
  assert.deepEqual(await page.locator("#rowMenu button").allInnerTexts(), [...icons, "Quick note", "New project"]);
  await page.keyboard.press("Escape");

  await page.locator("#sessionList .session-card").first().click();
  const geometry = await page.evaluate(() => {
    const tasks = document.querySelector("#backgroundTasksButton")!.getBoundingClientRect();
    const terminal = document.querySelector("#openTerminalButton")!.getBoundingClientRect();
    return { taskTop: tasks.top, taskHeight: tasks.height, terminalTop: terminal.top, terminalHeight: terminal.height };
  });
  assert.equal(geometry.taskTop, geometry.terminalTop, "Tasks aligns with adjacent toolbar buttons");
  assert.equal(geometry.taskHeight, geometry.terminalHeight, "Tasks has the same height as adjacent toolbar buttons");
});

async function markClaudeSignedOut(page: Page) {
  await page.route("**/api/harnesses", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const claude = body.harnesses.find((harness: { id: string }) => harness.id === "claude");
    claude.ready = false;
    claude.unavailableReason = "Claude is not signed in on this node";
    await route.fulfill({ response, json: body });
  });
}

test("new conversation buttons are disabled for a harness that is not signed in", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await markClaudeSignedOut(page);
  await signIn(page, node.url, environment.username, environment.password);
  await waitForHarnesses(page);
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();

  const claude = page.getByTestId("session-create-claude-button");
  // Buttons stay disabled until the project's execution nodes load; a signed-in harness then enables.
  await page.locator('[data-testid="session-create-button"]:enabled').waitFor();
  assert.equal(await claude.isDisabled(), true, "a signed-out harness cannot start a conversation");
  assert.equal(await claude.getAttribute("title"), "Claude is not signed in on this node");

  await page.locator("#sessionList .session-card").first().click();
  const option = page.getByTestId("chat-harness-select").locator('option[value="claude"]');
  assert.equal(await option.evaluate((element: HTMLOptionElement) => element.disabled), true, "the harness switcher cannot pick a signed-out harness");
});

// 701–1023 px is the desktop workspace (the phone starts at 700 px). The one "+ New conversation" button with a harness
// dialog that narrow window had is gone; the left column's New lists the project's agents instead.
test("a narrow window's New disables a harness that is not signed in", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.setViewportSize({ width: 720, height: 844 });
  await markClaudeSignedOut(page);
  await signIn(page, node.url, environment.username, environment.password);
  await waitForHarnesses(page);
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator('[data-testid="session-create-button"]:enabled').waitFor();

  await page.getByTestId("workspace-new-button").click();
  const claude = page.getByTestId("workspace-new-claude");
  await claude.waitFor({ state: "visible" });
  assert.equal(await claude.isDisabled(), true);
  assert.equal(await page.getByTestId("workspace-new-pi").isEnabled(), true);
  assert.equal(await claude.getAttribute("title"), "Claude is not signed in on this node");
});

test("a narrow window's New starts a conversation with the agent chosen there", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.setViewportSize({ width: 720, height: 844 });
  await signIn(page, node.url, environment.username, environment.password);
  await waitForHarnesses(page);
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator('[data-testid="session-create-button"]:enabled').waitFor();

  await page.getByTestId("workspace-new-button").click();
  const agents = page.getByTestId("workspace-new-harnesses").locator(".ws-menu-item > span");
  await agents.first().waitFor({ state: "visible" });
  const names = await agents.evaluateAll((spans) => spans.map((span) => span.firstChild?.textContent ?? ""));
  assert.deepEqual(names.filter((name) => ["Pi", "Claude", "Kiro"].includes(name)), ["Pi", "Claude", "Kiro"], `the project's agents, in order: ${names.join(", ")}`);
  // Each agent is a logo beside its name, on one compact row.
  const rows = await page.getByTestId("workspace-new-harnesses").locator(".ws-menu-item").evaluateAll((items) => items.map((item) => {
    const icon = item.querySelector("svg, img")!.getBoundingClientRect();
    const label = item.querySelector("span")!.getBoundingClientRect();
    return { sameRow: label.top < icon.bottom && icon.top < label.bottom, height: item.getBoundingClientRect().height };
  }));
  for (const row of rows) {
    assert.equal(row.sameRow, true, "the agent logo and its name share one row");
    assert.ok(row.height < 56, `an agent row stays compact, got ${row.height}px`);
  }
  await page.getByTestId("workspace-new-kiro").click();
  await page.getByTestId("new-session-name-dialog").waitFor({ state: "visible" });
  assert.equal(await page.evaluate(async () => (await import("/app/state.js")).state.newSessionDraft.sessionPath), "kiro:new");
});

test("a narrow window keeps agent, model, effort and machine on one row and Tasks in the details", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.setViewportSize({ width: 720, height: 844 });
  await signIn(page, node.url, environment.username, environment.password);
  await waitForHarnesses(page);
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card").first().click();
  await page.locator("#chatToolbar").waitFor({ state: "visible" });

  // No named helpers inside evaluate: the test compiler wraps them in a function the page does not have.
  const layout = await page.evaluate(() => {
    const [harness, model, reasoning, node] = ["#chatHarnessSelect", "#modelButton", "#reasoningLevelSelect", "#chatNodeSelect"].map((selector) => {
      const box = document.querySelector(selector)!.getBoundingClientRect();
      return Math.round(box.top + box.height / 2);
    });
    return {
      harness, model, node,
      // Harnesses without a reasoning control hide the whole label.
      reasoning: (document.querySelector("#chatModeControl") as HTMLElement).hidden ? null : reasoning,
      tasksInDetails: !!document.querySelector("#detailsTasks #backgroundTasksButton"),
    };
  });
  assert.equal(layout.harness, layout.model, "agent and model share a row");
  if (layout.reasoning !== null) assert.equal(layout.reasoning, layout.model, "effort sits on the model's row");
  assert.equal(layout.node, layout.model, "the machine sits on the model's row");
  assert.equal(layout.tasksInDetails, true, "Tasks moved into the details column");
});

test("model picker renders provider presentation metadata", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);
  await waitForHarnesses(page);

  const iconMarkup = await page.evaluate(async () => {
    const { brandIcon } = await import("/app/icons.js");
    return {
      openai: brandIcon("openai", "model-group-icon").outerHTML,
      custom: brandIcon("custom", "model-group-icon").outerHTML,
    };
  });
  await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    const harness = state.harnesses[0] ?? { id: "fixture-harness", label: "Fixture" };
    if (!state.harnesses.length) state.harnesses = [harness];
    const harnessId = harness.id;
    state.engine = harnessId;
    state.models = [
      { harnessId, provider: "openai-codex", id: "gpt", label: "GPT model", providerLabel: "GPT", providerIcon: "openai" },
      { harnessId, provider: "fixture-provider", id: "fixture", label: "Fixture model", providerLabel: "Independent", providerIcon: "custom" },
    ];
    const modelButton = document.querySelector("#modelButton")!;
    modelButton.removeAttribute("disabled");
    modelButton.click();
  });
  await page.locator("#modelDialog[open]").waitFor({ state: "visible" });

  const headings = page.locator("#modelDialogList .model-dialog-group");
  assert.deepEqual(await headings.allTextContents(), ["GPT", "Independent"]);
  assert.deepEqual(await headings.locator("svg").evaluateAll((icons) => icons.map((icon) => icon.outerHTML)), [iconMarkup.openai, iconMarkup.custom]);
  await page.getByTestId("model-option-fixture-provider-fixture").click();
  await page.locator("#modelDialog[open]").waitFor({ state: "hidden" });

  await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    state.models = [{ harnessId: state.engine, provider: "openai-codex", id: "gpt", label: "GPT model", providerLabel: "GPT", providerIcon: "openai" }];
    const modelButton = document.querySelector("#modelButton")!;
    modelButton.removeAttribute("disabled");
    modelButton.click();
  });
  await page.locator("#modelDialog[open]").waitFor({ state: "visible" });
  assert.equal(await page.locator("#modelDialogList .model-dialog-group").innerText(), "GPT");
});

test("node settings configure or disable automatic context compaction", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);
  await page.getByTestId("settings-open-button").click();
  await page.locator("#settingsDialog[open]").waitFor();

  await page.locator('#settingsForm[data-ready="true"]').waitFor();
  const enabled = page.getByTestId("settings-auto-compact-enabled");
  const threshold = page.getByTestId("settings-auto-compact-threshold");
  assert.equal(await enabled.isChecked(), true);
  assert.equal(await threshold.inputValue(), "70");
  await threshold.fill("82");
  await threshold.press("Tab");
  await waitForSaved(page);
  await leaveSettings(page);
  assert.equal(await page.evaluate(async () => (await (await fetch("/api/settings")).json()).autoCompactThreshold), 82);

  await page.getByTestId("settings-open-button").click();
  await page.locator("#settingsDialog[open]").waitFor();
  await page.locator('#settingsForm[data-ready="true"]').waitFor();
  await enabled.uncheck();
  assert.equal(await threshold.isDisabled(), true);
  await waitForSaved(page);
  await leaveSettings(page);
  assert.equal(await page.evaluate(async () => (await (await fetch("/api/settings")).json()).autoCompactThreshold), null);
});

test("node settings leave shell commands unlimited by default and can cap their run time", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);
  await page.getByTestId("settings-open-button").click();
  await page.locator("#settingsDialog[open]").waitFor();

  await page.locator('#settingsForm[data-ready="true"]').waitFor();
  const enabled = page.getByTestId("settings-shell-timeout-enabled");
  const seconds = page.getByTestId("settings-shell-timeout-seconds");
  assert.equal(await enabled.isChecked(), false);
  assert.equal(await seconds.isDisabled(), true);
  await enabled.check();
  assert.equal(await seconds.isDisabled(), false);
  await seconds.fill("900");
  await seconds.press("Tab");
  await waitForSaved(page);
  await leaveSettings(page);
  assert.equal(await page.evaluate(async () => (await (await fetch("/api/settings")).json()).shellCommandTimeoutSeconds), 900);

  await page.getByTestId("settings-open-button").click();
  await page.locator("#settingsDialog[open]").waitFor();
  await page.locator('#settingsForm[data-ready="true"]').waitFor();
  assert.equal(await enabled.isChecked(), true);
  assert.equal(await seconds.inputValue(), "900");
  await enabled.uncheck();
  assert.equal(await seconds.isDisabled(), true);
  await waitForSaved(page);
  await leaveSettings(page);
  assert.equal(await page.evaluate(async () => (await (await fetch("/api/settings")).json()).shellCommandTimeoutSeconds), null);
});

test("harness settings and model picker follow runtime metadata", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.route("**/api/harnesses/kiro/model-options", (route) => route.fulfill({ json: {
    providers: [{ id: "kiro", label: "Kiro" }],
    models: [{ provider: "kiro", id: "default", label: "Kiro default", thinkingLevels: ["default", "high"] }, { provider: "kiro", id: "fixture-model", label: "Fixture model", thinkingLevels: ["default", "high"] }],
  } }));
  await signIn(page, node.url, environment.username, environment.password);
  await openHarnessSettings(page);

  for (const id of ["pi", "claude", "kiro"]) await page.getByTestId(`harness-tab-${id}`).waitFor();
  await page.getByTestId("harness-tab-kiro").click();
  await page.getByTestId("settings-kiro-default-model").click();
  await page.getByTestId("settings-kiro-default-model-search").fill("fixture");
  await page.locator('[data-testid="settings-kiro-default-model-option"][data-value="fixture-model"]').click();
  await page.getByTestId("settings-kiro-default-thinking").selectOption("high");
  await waitForSaved(page);
  await leaveSettings(page);

  const defaults = await page.evaluate(async () => (await (await fetch("/api/settings")).json()).conversationDefaults);
  assert.deepEqual(defaults.kiro, { provider: "kiro", modelId: "fixture-model", thinkingLevel: "high" });

  await page.route("**/api/models", (route) => route.fulfill({ json: { models: [
    { provider: "kiro", id: "fixture-model", label: "Kiro default", thinkingLevels: ["default", "high"], harnessId: "kiro" },
    { provider: "claude", id: "sonnet", label: "Claude Sonnet", thinkingLevels: ["high"], harnessId: "claude" },
    { provider: "openai-codex", id: "gpt", label: "Pi GPT", thinkingLevels: ["high"], harnessId: "pi" },
  ] } }));
  await page.reload();
  await page.getByTestId("settings-open-button").waitFor();
  await waitForHarnesses(page);
  await openHarnessSettings(page);
  await page.getByTestId("harness-tab-kiro").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="settings-kiro-model-options-status"]')?.textContent === "");
  assert.equal(await page.getByTestId("settings-kiro-default-model").getAttribute("data-value"), "fixture-model");
  assert.equal(await page.getByTestId("settings-kiro-default-model").textContent(), "Fixture model");
  assert.equal(await page.getByTestId("settings-kiro-default-thinking").inputValue(), "high");
  for (const id of ["pi", "claude"]) {
    await page.getByTestId(`harness-tab-${id}`).click();
    await page.getByTestId(`settings-${id}-default-model`).waitFor();
  }

  await page.evaluate(async () => {
    document.querySelector("#settingsDialog")?.close();
    const { state } = await import("/app/state.js");
    state.models = (await (await fetch("/api/models")).json()).models;
    state.engine = "kiro";
    (await import("/app/composer-dialogs.js")).openQueuedModelPicker("/", () => {});
  });
  await page.locator("#modelDialog[open]").waitFor();
  await page.locator('[data-testid="model-option-kiro-fixture-model"]').waitFor();
  assert.match(await page.locator("#modelDialogList").innerText(), /Kiro default/);
  assert.equal(await page.getByText("Claude Sonnet", { exact: true }).count(), 0);
  assert.equal(await page.getByText("Pi GPT", { exact: true }).count(), 0);
  await page.locator("#modelDialog").evaluate((dialog: HTMLDialogElement) => dialog.close());

  await page.locator("#projectList .project-card").filter({ has: page.getByText("Internal Assistant", { exact: true }) }).click();
  await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    await (await import("/app/cron.js")).openScheduledTasks(state.activeProjectId);
  });
  await page.getByTestId("cron-new").click();
  assert.deepEqual(await page.getByTestId("cron-engine").locator("option").allTextContents(), ["Pi", "Claude", "Kiro"]);
  await page.locator("#cronDialog").evaluate((dialog: HTMLDialogElement) => dialog.close());

  await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    state.activeSessionId = crypto.randomUUID();
    (await import("/app/socket.js")).openSession("kiro:new", "New Kiro conversation");
  });
  await page.getByText("Ready for your first message", { exact: true }).waitFor();
  assert.match(await page.getByTestId("chat-message-input").getAttribute("placeholder") || "", /Kiro|work/);
  assert.match(await page.locator("#messages").innerText(), /Kiro will run/);
  assert.doesNotMatch(await page.locator("#messages").innerText(), /Pi will run/);
});

test("harness settings choose provider and model from searchable dropdowns of what the harness offers", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.route("**/api/harnesses/pi/model-options", (route) => route.fulfill({ json: {
    providers: [{ id: "anthropic", label: "anthropic" }, { id: "openai-codex", label: "openai-codex" }],
    models: [
      { provider: "anthropic", id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", thinkingLevels: ["off", "low", "high"] },
      { provider: "openai-codex", id: "gpt-6-sol", label: "GPT 6 Sol", thinkingLevels: ["off", "medium", "xhigh"] },
      { provider: "openai-codex", id: "gpt-5.6-luna", label: "GPT 5.6 Luna", thinkingLevels: ["off", "low"] },
    ],
  } }));
  await signIn(page, node.url, environment.username, environment.password);
  await openHarnessSettings(page);
  await page.getByTestId("harness-tab-pi").click();
  const provider = page.getByTestId("settings-pi-default-provider");
  const model = page.getByTestId("settings-pi-default-model");
  const providerSearch = page.getByTestId("settings-pi-default-provider-search");
  const modelSearch = page.getByTestId("settings-pi-default-model-search");
  assert.equal(await provider.evaluate((element) => element.tagName), "BUTTON", "the closed picker is a dropdown, not a text box");
  assert.match(await provider.evaluate((element) => getComputedStyle(element).backgroundImage), /svg/, "the closed picker shows a dropdown chevron");
  const providerOptions = page.getByTestId("settings-pi-default-provider-option");
  const modelOptions = page.getByTestId("settings-pi-default-model-option");

  await provider.click();
  assert.equal(await providerSearch.evaluate((element) => element === document.activeElement), true, "opening the dropdown focuses its search box");
  await providerSearch.fill("anthro");
  assert.deepEqual(await providerOptions.allTextContents(), ["anthropic"], "typing filters providers");
  await providerSearch.press("Enter");
  await model.click();
  assert.deepEqual(await modelOptions.locator(":scope").evaluateAll((items) => items.map((item) => item.getAttribute("data-value"))), ["claude-sonnet-4-5"], "models follow the chosen provider");
  await modelOptions.first().click();
  assert.deepEqual(await page.locator("#settingsPiDefaultThinking option").allTextContents(), ["off", "low", "high"], "thinking follows the chosen model");

  await provider.click();
  await providerOptions.filter({ hasText: "openai-codex" }).click();
  assert.equal(await model.getAttribute("data-value"), "", "switching provider asks for a model of that provider");
  assert.equal(await model.textContent(), "Choose a model");
  // The provider saves at once; a missing model is refused on the save line, with nothing sent.
  await page.getByTestId("settings-save-state").getByText("Not saved: Choose a Pi model for new conversations", { exact: true }).waitFor();
  await model.click();
  await modelSearch.fill("sol");
  assert.equal(await modelOptions.count(), 1, "typing filters models by label or ID");
  await modelSearch.press("Enter");
  assert.equal(await model.textContent(), "GPT 6 Sol");
  assert.deepEqual(await page.locator("#settingsPiDefaultThinking option").allTextContents(), ["off", "medium", "xhigh"]);

  await model.click();
  await modelSearch.fill("not a listed model");
  assert.equal(await modelOptions.count(), 0);
  await modelSearch.press("Escape");
  assert.equal(await page.locator("#settingsDialog").evaluate((dialog: HTMLDialogElement) => dialog.open), true, "Escape closes only the list");
  assert.equal(await modelSearch.isVisible(), false);
  assert.equal(await model.textContent(), "GPT 6 Sol", "an unlisted entry cannot be chosen");

  await page.locator("#settingsPiDefaultThinking").selectOption("xhigh");
  await waitForSaved(page);
  await leaveSettings(page);
  const defaults = await page.evaluate(async () => (await (await fetch("/api/settings")).json()).conversationDefaults);
  assert.deepEqual(defaults.pi, { provider: "openai-codex", modelId: "gpt-6-sol", thinkingLevel: "xhigh" });
});

test("on a phone the harness pickers open as a list of options", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);
  await page.setViewportSize({ width: 720, height: 844 });
  // The phone layout keeps Settings behind the menu; open it the way that menu does.
  await page.evaluate(async () => (await import("/app/settings.js")).openSettings("engines"));
  await page.locator("#settingsDialog[open]").waitFor();
  await page.getByTestId("harness-tab-claude").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="settings-claude-model-options-status"]')?.textContent === "");
  const model = page.getByTestId("settings-claude-default-model");
  await model.click();
  const options = page.getByTestId("settings-claude-default-model-option");
  await options.first().waitFor({ state: "visible" });
  assert.ok(await options.count() > 1, "the Claude models are listed");
  await options.and(page.locator('[data-value="haiku"]')).click();
  assert.equal(await model.getAttribute("data-value"), "haiku");
  assert.equal(await model.textContent(), "Haiku");
  assert.equal(await page.getByTestId("settings-claude-default-model-search").isVisible(), false, "choosing closes the list");
});

test("listing-only harness metadata does not offer execution or break settings", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.route("**/api/harnesses", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.harnesses.push({ id: "archive", label: "Archive", newSessionPath: "archive:new", runtimeConfigured: false });
    await route.fulfill({ response, json: body });
  });

  await signIn(page, node.url, environment.username, environment.password);
  await waitForHarnesses(page);
  await openHarnessSettings(page);
  for (const id of ["pi", "claude", "kiro"]) await page.getByTestId(`harness-tab-${id}`).waitFor();
  assert.equal(await page.getByTestId("harness-tab-archive").count(), 0);
  await page.locator("#settingsDialog").evaluate((dialog: HTMLDialogElement) => dialog.close());

  await page.locator("#projectList .project-card").filter({ has: page.getByText("Internal Assistant", { exact: true }) }).click();
  assert.equal(await page.locator("#chatHarnessSelect option[value=archive]").count(), 0);

  await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    await (await import("/app/cron.js")).openScheduledTasks(state.activeProjectId);
  });
  await page.getByTestId("cron-new").click();
  assert.equal(await page.getByTestId("cron-engine").locator("option[value=archive]").count(), 0);
  await page.locator("#cronDialog").evaluate((dialog: HTMLDialogElement) => dialog.close());
});

test("node settings run the sync check by default and let the user pick its harness", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);
  await page.getByTestId("settings-open-button").click();
  await page.locator("#settingsDialog[open]").waitFor();

  await page.locator('#settingsForm[data-ready="true"]').waitFor();
  await page.getByTestId('settings-tab-system-ai').click();
  await page.getByTestId('system-ai-decision-model').waitFor();
  const enabled = page.getByTestId("settings-sync-check-enabled");
  const harness = page.getByTestId("settings-sync-check-harness");
  assert.equal(await enabled.isChecked(), true, "the sync check is on by default");
  assert.equal(await harness.inputValue(), "pi");
  await page.getByTestId("settings-sync-check-model").waitFor({ state: "attached" });

  await harness.selectOption("claude");
  await enabled.uncheck();
  await waitForSaved(page);
  await page.getByTestId('system-ai-status').getByText('Saved', { exact: false }).waitFor();
  const saved = await page.evaluate(async () => (await (await fetch("/api/settings")).json()) as { syncCheck: Record<string, unknown>; conversationDefaults: Record<string, Record<string, unknown>> });
  assert.equal(saved.syncCheck.enabled, false);
  assert.equal(saved.syncCheck.harnessId, "claude");
  assert.equal(saved.syncCheck.modelId, saved.conversationDefaults.claude.modelId, "a new harness starts from its conversation default model");
});

test("node settings let the user pick the dashboard agent's harness and model", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);
  await page.getByTestId("settings-open-button").click();
  await page.locator("#settingsDialog[open]").waitFor();

  await page.locator('#settingsForm[data-ready="true"]').waitFor();
  await page.getByTestId('settings-tab-system-ai').click();
  await page.getByTestId('system-ai-decision-model').waitFor();
  const harness = page.getByTestId("settings-dashboards-harness");
  assert.equal(await harness.inputValue(), "pi", "the dashboard agent starts on Pi");
  await page.getByTestId("settings-dashboards-model").waitFor({ state: "attached" });

  await harness.selectOption("claude");
  await waitForSaved(page);
  await page.getByTestId('system-ai-status').getByText('Saved', { exact: false }).waitFor();
  const saved = await page.evaluate(async () => (await (await fetch("/api/settings")).json()) as { dashboards: Record<string, unknown>; conversationDefaults: Record<string, Record<string, unknown>> });
  assert.equal(saved.dashboards.harnessId, "claude");
  assert.equal(saved.dashboards.modelId, saved.conversationDefaults.claude.modelId, "a new harness starts from its conversation default model");
});

test("node settings run background work on an automatic agent and let the user choose one", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);
  await page.getByTestId("settings-open-button").click();
  await page.locator("#settingsDialog[open]").waitFor();

  await page.locator('#settingsForm[data-ready="true"]').waitFor();
  await page.getByTestId('settings-tab-system-ai').click();
  await page.getByTestId('system-ai-decision-model').waitFor();
  const harness = page.getByTestId("settings-background-agent-harness");
  assert.equal(await harness.inputValue(), "", "background work starts on Automatic");
  assert.equal(await page.locator("#settingsBackgroundAgentModel").locator("select, input, button").count(), 0, "Automatic has no model of its own");
  await page.getByTestId("settings-background-agent-status").filter({ hasText: /Automatic is using .+\. Signed in here: / }).waitFor();

  await harness.selectOption("claude");
  await page.getByTestId("settings-background-agent-model").waitFor({ state: "attached" });
  await waitForSaved(page);
  await page.getByTestId('system-ai-status').getByText('Saved', { exact: false }).waitFor();
  const saved = await page.evaluate(async () => (await (await fetch("/api/settings")).json()) as { backgroundAgent: Record<string, unknown>; conversationDefaults: Record<string, Record<string, unknown>> });
  assert.equal(saved.backgroundAgent.harnessId, "claude");
  assert.equal(saved.backgroundAgent.modelId, saved.conversationDefaults.claude.modelId, "a chosen agent starts from its conversation default model");
  const status = await page.evaluate(async () => (await (await fetch("/api/settings/background-agent")).json()) as { agent: Record<string, unknown> });
  assert.deepEqual([status.agent.harnessId, status.agent.source], ["claude", "setting"]);
});
