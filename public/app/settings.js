import { api, savePreferencesInBackground } from "./api.js";
import { loadProviderProfiles } from "./provider-profiles.js";
import { antigravityLoginControls } from "./antigravity-login.js";
import { loadHarnesses } from "./chat-controls.js";
import { brandIcon, menuIcon } from "./icons.js";
import { applyAdminVisibility, isNodeAdmin, loadNodeBlocks, loadTerminalPolicy, loadUsers, saveChangedTerminalPolicy } from "./node-admin.js";
import { loadMyNodes } from "./roaming.js";
import { loadBrowserStatus } from "./browser.js";
import { loadBrowserProfileDirectory } from "./browser-profiles-settings.js";
import { fillShortcutSettings } from "./shortcut-settings.js";
import { loadSkills } from "./composer-dialogs.js";
import { authKnown, showSignedOut } from "./auth.js";
import { loadClusterPanel } from "./cluster-panel.js";
import { loadRelayServing } from "./relay-serving.js";
import { loadWebhooks } from "./webhooks.js";
import { loadAutomationTags } from "./automation-tags.js";
import { loadUpdatesPanel } from "./updates.js";
import { elements } from "./elements.js";
import { loadNtfyServicesPanel } from "./ntfy.js";
import { loadErrorReportingSettings } from "./error-reporting-settings.js";
import { loadStorySettings } from "./story-settings.js";
import { loadMfaSettings } from "./mfa.js";
import { loadRoutingConfigs, saveDirtyRoutingConfig } from "./routing-configs.js";
import { showResourcesPanel } from "./resources.js";
import { loadSecretAccounts, revealSecretAccount, secretAccounts } from "./secrets.js";
import { confirmAction, syncNotifyButton, toast } from "./shell.js";
import { state } from "./state.js";
import { renderSessions } from "./session-list.js";
import { createSearchableSelect } from "./searchable-select.js";
import { refreshSessionsQuietly } from "./socket.js";
import { loadWorkspaces } from "./workspaces.js";
import { loadGitReviewerSettings } from "./git-reviewer-options.js";
import { loadSummaryModelSettings } from "./summary-model-settings.js";
import { labelIconsValue, loadLabelIcons } from "./label-icons.js";
import { createSettingsSearch } from "./settings-search.js";
// settings-page (P4): Settings → File sync.
import { loadFileSyncSettings } from "./file-sync-settings.js";
import { loadGuardianSettings } from "./guardian-settings.js";
import { loadQualityAnalytics } from "./quality-analytics.js";
import { loadSystemAiSettings, saveSystemAiSettings } from "./system-ai-settings.js";
import { loadConversationChatSettings } from "./conversation-chat.js";
import { buildSectionHeads, drawSectionIcons, installSettingsPage, openGroup, showSection } from "./settings-page.js";
import { autosaveFields, deferSave, invalidSetting, settingsAutosave, stillTyping } from "./settings-autosave.js";

const settingsGroups = [...document.querySelectorAll("#settingsForm .settings-group")];
const settingsSaveState = document.querySelector("#settingsSaveState");
buildSectionHeads(elements.settingsTabs);
drawSectionIcons(elements.settingsTabs);
installSettingsPage(elements.settingsForm);
for (const group of settingsGroups) {
  group.querySelector(".settings-group-label").addEventListener("click", () => openGroup(group, settingsGroups));
}
// Every change saves on its own; this line in the open section says how that went.
const autosave = settingsAutosave();
autosave.onError = (error) => toast.error(`Settings not saved: ${error.message}`);

/** Compares two "major.minor.patch" strings; anything else never counts as newer. */
function isNewerVersion(candidate, baseline) {
  const left = String(candidate).split(".").map(Number);
  const right = String(baseline).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

/** Renders released versions newest first into a container, one section each. */
function renderChangelogEntries(container, entries) {
  container.replaceChildren();
  for (const entry of entries) {
    const section = document.createElement("section");
    section.className = "changelog-entry";
    const heading = document.createElement("h3");
    heading.textContent = entry.version;
    if (entry.date) {
      const date = document.createElement("span");
      date.className = "changelog-date";
      date.textContent = entry.date;
      heading.append(date);
    }
    const changes = document.createElement("ul");
    for (const change of entry.changes) {
      const item = document.createElement("li");
      item.textContent = change;
      changes.append(item);
    }
    section.append(heading, changes);
    container.append(section);
  }
}

async function loadChangelogPanel() {
  const { version, entries } = await api("/api/changelog");
  elements.settingsChangelogVersion.textContent = version;
  renderChangelogEntries(elements.settingsChangelogList, entries);
}

// The dialog is the only sign that a deployment landed, so it opens once per
// upgrade: never on a first visit, and never on a plain refresh.
export async function showWhatsNew(lastSeenVersion) {
  const { version, entries } = await api("/api/changelog");
  if (!lastSeenVersion) {
    savePreferencesInBackground({ lastSeenVersion: version });
    return;
  }
  if (!isNewerVersion(version, lastSeenVersion)) return;
  savePreferencesInBackground({ lastSeenVersion: version });
  const shipped = entries.filter((entry) => isNewerVersion(entry.version, lastSeenVersion));
  if (!shipped.length) return;
  elements.whatsNewVersion.textContent = version;
  renderChangelogEntries(elements.whatsNewList, shipped);
  elements.whatsNewDialog.showModal();
}

function renderClientLogs() {
  const entries = window.jointBobClientLogs?.entries() || [];
  elements.settingsClientLogs.textContent = entries.join("\n") || "No client logs captured.";
  elements.settingsClientLogsCopyButton.disabled = entries.length === 0;
  elements.settingsClientLogsClearButton.disabled = entries.length === 0;
  elements.settingsClientLogs.scrollTo(0, elements.settingsClientLogs.scrollHeight);
}

// These panels guard their own loading and do not depend on Save settings.
const ownLoading = (panel) => ["settingsPanel-cluster", "settingsPanel-relay", "settingsPanel-webhooks", "settingsPanel-browser", "settingsPanel-node", "settingsPanel-users", "settingsPanel-file-sync", "settingsPanel-automation-tags", "settingsPanel-story", "settingsPanel-guardian", "settingsPanel-quality", "settingsPanel-system-ai"].includes(panel.id);

/** Shows one settings panel and hides the rest, keeping the tablist's roving tabindex correct. */
function selectSettingsTab(requested) {
  // A tab hidden from this account (Relay for a replicated user, admin tabs for a member) falls back to Account.
  const name = elements.settingsTabs.some((tab) => tab.dataset.settingsTab === requested && !tab.hidden && (isNodeAdmin() || !tab.hasAttribute("data-admin-only"))) ? requested : "account";
  // Leaving Classifiers commits the routing configuration being edited.
  if (elements.settingsForm.dataset.tab === "classifiers" && name !== "classifiers" && autosave.waiting("routing")) autosave.schedule("routing", 0);
  elements.settingsForm.dataset.tab = name;
  // Saving checks its own fields; the form never validates as a whole.
  elements.settingsForm.noValidate = true;
  for (const tab of elements.settingsTabs) {
    const selected = tab.dataset.settingsTab === name;
    tab.setAttribute("aria-selected", selected ? "true" : "false");
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const panel of elements.settingsPanels) panel.hidden = panel.id !== `settingsPanel-${name}`;
  // Phones show either the section list or one section; desktop CSS ignores this.
  elements.settingsForm.dataset.mobileView = "panel";
  showSection(elements.settingsTabs.find((tab) => tab.dataset.settingsTab === name), { groups: settingsGroups, title: elements.settingsCurrentTitle, crumb: document.querySelector("#settingsCurrentCrumb"), saveState: settingsSaveState, restartMessage: elements.settingsRestartMessage });
  autosave.quiet();
  document.querySelector(`#settingsPanel-${name}`).scrollTop = 0;
  if (name === "cluster" || name === "browser") void loadBrowserStatus();
  if (name === "browser") void loadBrowserProfileDirectory();
  if (name === "relay") void loadRelayServing();
  if (name === "webhooks") void loadWebhooks();
  if (name === "automation-tags") void loadAutomationTags();
  if (name === "notifications") { void loadNtfyServicesPanel(); void loadErrorReportingSettings(); }
  if (name === "classifiers") void loadRoutingConfigs().catch((error) => { elements.routingConfigStatus.textContent = error.message; });
  if (name === "guardian" || name === "classifiers") void loadGuardianSettings().catch((error) => toast.error(error.message));
  if (name === "quality") void loadQualityAnalytics();
  if (name === "system-ai") {
    void loadSystemAiSettings({ controls: (descriptor, settings, prefix, options) => createConversationControls(descriptor, settings, prefix, { ...options, preserveUnavailableThinking: true }), render: (settings, descriptors) => {
      systemHarnessDescriptors = descriptors;
      renderBackgroundAgentSettings(settings); renderSyncCheckSettings(settings); renderDashboardAgentSettings(settings);
    }, value: () => ({ backgroundAgent: backgroundAgentValue(), syncCheck: syncCheckValue(), dashboards: dashboardAgentValue() }) });
    void loadSummaryModelSettings().catch(error => toast.error(error.message));
  }
  if (name === "logs") renderClientLogs();
  if (name === "resources") showResourcesPanel();
  if (name === "file-sync") void loadFileSyncSettings(); // settings-page (P4)
  if (name === "connections") void loadProviderProfiles().catch((error) => toast.error(error.message));
  if (name === "story") void loadStorySettings().catch((error) => toast.error(error.message));
  if (name === "git") void loadGitReviewerSettings().catch((error) => toast.error(error.message));
  if (name === "conversations") void loadConversationChatSettings().catch((error) => toast.error(error.message));
  if (name === "users") void loadUsers().catch((error) => toast.error(error.message));
  if (name === "account") void loadMyNodes().catch((error) => toast.error(error.message));
  if (name === "node") {
    void loadNodeBlocks().catch((error) => toast.error(error.message));
    void loadTerminalPolicy().catch((error) => toast.error(error.message));
  }
}

/** Hides the tabs a replicated user cannot use. Their only feature is `conversations`, so settings tabs go. */
export function syncSettingsAccess() {
  const allowed = !state.isRemoteLogin;
  for (const node of document.querySelectorAll("[data-requires-settings]")) {
    node.hidden = !allowed;
  }
  if (!allowed && ["relay", "webhooks"].includes(elements.settingsForm.dataset.tab)) selectSettingsTab("account");
}

let runtimeDefaults;
let harnessDescriptors = [];
let selectedHarnessId = null;
let kiroEnabledInput;
function kiroEnabledValue() { return !kiroEnabledInput || kiroEnabledInput.checked; }
const clearedHarnessesOnSave = new Set();
const globalResourceFields = { skills: elements.settingsResourceSkillsPaths, prompts: elements.settingsResourcePromptsPaths, rules: elements.settingsResourceRulesPaths, plugins: elements.settingsResourcePluginsPaths };
const runtimeFields = {};
const runtimeLabels = {};
const defaultsOutputs = {};
const conversationFields = {};

function runtimeFieldsValue() { return Object.fromEntries(Object.entries(runtimeFields).map(([id, fields]) => [id, Object.fromEntries(Object.entries(fields).map(([field, input]) => [field, input.value.trim()]))])); }
function blankHarnessPayload() { return { executable: "", configPath: "", sessionPath: "" }; }
function controlPrefix(id) { return id[0].toUpperCase() + id.slice(1); }
function labeledControl(text, control) { const label = document.createElement("label"); label.append(text, control); return label; }
// Paths save when the field is left (settings-autosave.js): a half-typed path must never apply.
function makeInput(id, testid) { const input = document.createElement("input"); input.id = id; input.dataset.testid = testid; input.autocomplete = "off"; input.dataset.saveWhenLeft = ""; return input; }

const UNAVAILABLE = " (not available on this node)";

/** Keeps a saved choice listed even when the harness no longer offers it, so saving leaves it unchanged. */
function withSaved(options, value) {
  return !value || options.some((option) => option.value === value) ? options : [{ value, label: `${value}${UNAVAILABLE}` }, ...options];
}

function createConversationControls(descriptor, settings, prefix, options = {}) {
  const defaults = options.current ?? settings.conversationDefaults[descriptor.id];
  const idPrefix = options.idPrefix ?? `settings${prefix}Default`;
  const testPrefix = options.testPrefix ?? `settings-${descriptor.id}-default`;
  const labelPrefix = options.label ?? "New conversation";
  const fixedProvider = descriptor.configuration.fixedProvider;
  const provider = fixedProvider ? null : createSearchableSelect({ id: `${idPrefix}Provider`, testid: `${testPrefix}-provider`, prompt: "Choose a provider", placeholder: "Search providers", emptyText: "No providers found" });
  const model = createSearchableSelect({ id: `${idPrefix}Model`, testid: `${testPrefix}-model`, prompt: "Choose a model", placeholder: "Search models", emptyText: "No models found" });
  provider?.setValue(defaults.provider); model.setValue(defaults.modelId);
  const thinking = document.createElement("select");
  thinking.id = `${idPrefix}Thinking`; thinking.dataset.testid = `${testPrefix}-thinking`;
  const status = document.createElement("output"); status.className = "engine-readiness model-options-status"; status.dataset.testid = options.testPrefix ? `${options.testPrefix}-model-options-status` : `settings-${descriptor.id}-model-options-status`;

  let catalog = { providers: [], models: [] };
  const selectedProvider = () => provider ? provider.value : fixedProvider;
  function fillThinking(levels, current) {
    const choices = levels.map(level => ({ value: level, label: level }));
    thinking.replaceChildren(...(options.preserveUnavailableThinking ? withSaved(choices, current) : choices).map(({ value, label }) => new Option(label, value)));
    thinking.value = current && (options.preserveUnavailableThinking || levels.includes(current)) ? current : levels.includes("default") ? "default" : levels[0];
  }
  function refreshModels() {
    const models = catalog.models.filter((candidate) => candidate.provider === selectedProvider());
    model.setOptions(withSaved(models.map(({ id, label }) => ({ value: id, label: label || id, detail: id })), model.value));
    const chosen = models.find(({ id }) => id === model.value);
    fillThinking(chosen?.thinkingLevels?.length ? chosen.thinkingLevels : descriptor.configuration.thinkingLevels, thinking.value);
  }
  provider?.onChange(() => {
    // A model belongs to one provider, so switching provider asks for a new model.
    if (!catalog.models.some((candidate) => candidate.provider === provider.value && candidate.id === model.value)) model.setValue("");
    refreshModels();
  });
  model.onChange(refreshModels);
  fillThinking(descriptor.configuration.thinkingLevels, defaults.thinkingLevel);
  provider?.setOptions(withSaved([], defaults.provider));
  model.setOptions(withSaved([], defaults.modelId));

  status.textContent = "Loading available models…";
  const refresh = () => api(`/api/harnesses/${encodeURIComponent(descriptor.id)}/model-options`).then((body) => {
    catalog = body;
    provider?.setOptions(withSaved(body.providers.map(({ id, label }) => ({ value: id, label: label || id, detail: id })), provider.value));
    refreshModels();
    status.textContent = body.models.length ? "" : `${descriptor.label} has no models available on this node.`;
  }).catch((error) => { status.textContent = `Could not load ${descriptor.label} models: ${error.message}`; });

  const controls = [provider && labeledControl(`${labelPrefix} provider`, provider.root), labeledControl(`${labelPrefix} model`, model.root), status, labeledControl(`${labelPrefix} thinking`, thinking)].filter(Boolean);
  const loaded = refresh();
  return { fields: { provider, model, thinking }, controls, loaded, refresh };
}

function createRuntimeControls(descriptor, settings, defaults, prefix) {
  const fields = {};
  const fieldset = document.createElement("fieldset"); fieldset.className = "phase-settings";
  const legend = document.createElement("legend"); legend.textContent = `${descriptor.label} path overrides`; fieldset.append(legend);
  const definitions = [["executable", "Executable"], ["configPath", "Node-local config and auth path"], ["sessionPath", "Synchronized transcript/session root"]];
  for (const [field, label] of definitions) {
    const suffix = field === "configPath" ? "ConfigPath" : field === "sessionPath" ? "SessionPath" : "Executable";
    const testSuffix = field === "configPath" ? "config" : field === "sessionPath" ? "session" : "executable";
    fields[field] = makeInput(`settings${prefix}${suffix}`, `settings-${descriptor.id}-${testSuffix}-input`);
    fields[field].value = settings.runtimeOverrides[descriptor.id][field];
    fields[field].addEventListener("input", () => clearedHarnessesOnSave.delete(descriptor.id));
    fieldset.append(labeledControl(label, fields[field]));
  }
  const button = document.createElement("button"); button.className = "ghost"; button.type = "button";
  button.id = `settingsUse${prefix}DefaultsButton`; button.dataset.testid = `settings-use-${descriptor.id}-defaults-button`; button.textContent = `Use node defaults for ${descriptor.label}`;
  button.addEventListener("click", () => useHarnessDefaults(descriptor.id)); fieldset.append(button);
  return { fields, fieldset };
}

function createHarnessPanel(descriptor, settings, defaults) {
  const prefix = controlPrefix(descriptor.id);
  const panel = document.createElement("div"); panel.id = `harnessPanel-${descriptor.id}`; panel.dataset.harnessPanel = descriptor.id;
  panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", `harnessTab-${descriptor.id}`);
  // Everyone picks their own models for new conversations; only the admin sees the node's paths.
  if (!defaults) {
    const conversation = createConversationControls(descriptor, settings, prefix);
    conversationFields[descriptor.id] = conversation.fields;
    panel.append(...conversation.controls); return panel;
  }
  const output = document.createElement("output"); output.className = "engine-defaults"; output.id = `settings${prefix}Defaults`; output.dataset.testid = `settings-${descriptor.id}-defaults`;
  output.textContent = `Node defaults — executable: ${defaults[descriptor.id].executable}; config: ${defaults[descriptor.id].configPath}; sessions: ${defaults[descriptor.id].sessionPath}.`;
  const conversation = createConversationControls(descriptor, settings, prefix);
  const runtime = createRuntimeControls(descriptor, settings, defaults, prefix);
  conversationFields[descriptor.id] = conversation.fields; runtimeFields[descriptor.id] = runtime.fields; defaultsOutputs[descriptor.id] = output;
  runtimeLabels[descriptor.id] = { executable: `${descriptor.label} executable`, configPath: `${descriptor.label} config path`, sessionPath: `${descriptor.label} session path` };
  if (descriptor.id === "kiro") {
    kiroEnabledInput = document.createElement("input");
    kiroEnabledInput.type = "checkbox";
    kiroEnabledInput.dataset.testid = "settings-kiro-enabled";
    kiroEnabledInput.checked = settings.kiroEnabled !== false;
    const label = document.createElement("label");
    label.className = "checkbox-row";
    label.append(kiroEnabledInput, "Enable Kiro on this machine");
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Uses Joint Bob's managed Kiro CLI v3. When disabled, no Kiro runs, background checks or updates start. Saved conversations remain readable.";
    const syncEnabled = () => { runtime.fieldset.disabled = !kiroEnabledInput.checked; };
    kiroEnabledInput.addEventListener("change", syncEnabled);
    syncEnabled();
    panel.append(label, hint);
  }
  if (descriptor.id === "antigravity") panel.append(antigravityLoginControls(descriptor.ready, async () => {
    await Promise.all([conversation.refresh(), loadHarnesses()]);
  }));
  panel.append(output, ...conversation.controls, runtime.fieldset); return panel;
}

function selectHarnessTab(name) {
  selectedHarnessId = name;
  const tabs = [...document.querySelectorAll("#harnessTabs [data-harness-tab]")];
  for (const tab of tabs) { const selected = tab.dataset.harnessTab === name; tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1; }
  for (const panel of document.querySelectorAll("[data-harness-panel]")) panel.hidden = panel.dataset.harnessPanel !== name;
}

function bindHarnessTab(tab) {
  tab.addEventListener("click", () => selectHarnessTab(tab.dataset.harnessTab));
  tab.addEventListener("keydown", (event) => {
    const step = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 0;
    if (!step) return; event.preventDefault();
    const tabs = [...document.querySelectorAll("#harnessTabs [data-harness-tab]")];
    const next = tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length]; selectHarnessTab(next.dataset.harnessTab); next.focus();
  });
}

function renderHarnessSettings(descriptors, settings, defaults) {
  kiroEnabledInput = undefined;
  const previous = selectedHarnessId;
  for (const map of [runtimeFields, runtimeLabels, defaultsOutputs, conversationFields]) for (const key of Object.keys(map)) delete map[key];
  const tabs = document.querySelector("#harnessTabs"); const panels = document.querySelector("#harnessPanels"); tabs.replaceChildren(); panels.replaceChildren();
  for (const descriptor of descriptors) {
    const tab = document.createElement("button"); tab.className = "settings-subtab"; tab.type = "button"; tab.id = `harnessTab-${descriptor.id}`;
    tab.dataset.harnessTab = descriptor.id; tab.dataset.testid = `harness-tab-${descriptor.id}`; tab.setAttribute("role", "tab"); tab.setAttribute("aria-controls", `harnessPanel-${descriptor.id}`); tab.append(brandIcon(descriptor.id, `harness-tab-icon ${descriptor.id}`), descriptor.label);
    bindHarnessTab(tab); tabs.append(tab); panels.append(createHarnessPanel(descriptor, settings, defaults));
  }
  selectHarnessTab(descriptors.some(({ id }) => id === previous) ? previous : descriptors.find(({ runtimeConfigured }) => runtimeConfigured)?.id || descriptors[0].id);
}

function conversationDefaultsValue() {
  return Object.fromEntries(harnessDescriptors.map((descriptor) => {
    const fields = conversationFields[descriptor.id];
    return [descriptor.id, { provider: fields.provider ? fields.provider.value : descriptor.configuration.fixedProvider, modelId: fields.model.value, thinkingLevel: fields.thinking.value }];
  }));
}
let systemHarnessDescriptors = [];
let syncCheckFields = null;

/** The sync check picks its own harness and model; switching harness starts from that harness's conversation default. */
function renderSyncCheckModel(settings, harnessId, current) {
  const descriptor = systemHarnessDescriptors.find(({ id }) => id === harnessId);
  if (!descriptor) { elements.settingsSyncCheckModel.replaceChildren(); syncCheckFields = null; return; }
  const controls = createConversationControls(descriptor, settings, "", { current: current ?? settings.conversationDefaults[descriptor.id], idPrefix: "settingsSyncCheckChoice", testPrefix: "settings-sync-check", label: "Sync check", preserveUnavailableThinking: true });
  syncCheckFields = { descriptor, ...controls.fields };
  elements.settingsSyncCheckModel.replaceChildren(...controls.controls);
}

function renderSyncCheckSettings(settings) {
  const sync = settings.syncCheck;
  const runnable = systemHarnessDescriptors.filter(({ runtimeConfigured }) => runtimeConfigured);
  const choices = runnable.some(({ id }) => id === sync.harnessId) ? runnable : [...runnable, systemHarnessDescriptors.find(({ id }) => id === sync.harnessId)].filter(Boolean);
  elements.settingsSyncCheckEnabled.checked = sync.enabled;
  elements.settingsSyncCheckHarness.replaceChildren(...choices.map(({ id, label }) => new Option(label, id)));
  elements.settingsSyncCheckHarness.value = sync.harnessId;
  elements.settingsSyncCheckHarness.onchange = () => renderSyncCheckModel(settings, elements.settingsSyncCheckHarness.value);
  renderSyncCheckModel(settings, sync.harnessId, sync);
  elements.settingsSyncCheckStatus.textContent = "";
  api("/api/settings/sync-check").then((status) => { elements.settingsSyncCheckStatus.textContent = syncCheckSummary(status); }).catch(() => {});
}

function syncCheckSummary(status) {
  if (!status.lastCheckAt) return "Not checked yet on this node.";
  const parts = [`Last checked ${new Date(status.lastCheckAt).toLocaleString()}.`, `${status.resolvedTotal} conflict${status.resolvedTotal === 1 ? "" : "s"} fixed since the node started.`];
  if (status.unresolved.length) parts.push(`Needs a look: ${status.unresolved.map((item) => `${item.path} (${item.reason})`).join("; ")}.`);
  if (status.folderIssues.length) parts.push(`Folder issues: ${status.folderIssues.map((item) => item.message).join("; ")}.`);
  if (status.lastError) parts.push(`Last error: ${status.lastError}.`);
  return parts.join(" ");
}

function syncCheckValue() {
  if (!syncCheckFields) return undefined;
  const { descriptor, provider, model, thinking } = syncCheckFields;
  return { enabled: elements.settingsSyncCheckEnabled.checked, harnessId: descriptor.id, provider: provider ? provider.value : descriptor.configuration.fixedProvider, modelId: model.value, thinkingLevel: thinking.value };
}

let backgroundAgentFields = null;

/** Automatic shows no model: it runs the chosen agent's own default model and effort. */
function renderBackgroundAgentModel(settings, harnessId, current) {
  const descriptor = systemHarnessDescriptors.find(({ id }) => id === harnessId);
  if (!descriptor) { elements.settingsBackgroundAgentModel.replaceChildren(); backgroundAgentFields = null; return; }
  const stored = current?.harnessId === harnessId && current.modelId ? current : settings.conversationDefaults[descriptor.id];
  const controls = createConversationControls(descriptor, settings, "", { current: stored, idPrefix: "settingsBackgroundAgentChoice", testPrefix: "settings-background-agent", label: "Background agent", preserveUnavailableThinking: true });
  backgroundAgentFields = { descriptor, ...controls.fields };
  elements.settingsBackgroundAgentModel.replaceChildren(...controls.controls);
}

function backgroundAgentSummary(status) {
  const label = harnessDescriptors.find(({ id }) => id === status.agent.harnessId)?.label ?? status.agent.harnessId;
  const model = [status.agent.modelId, status.agent.thinkingLevel].filter(Boolean).join(", ");
  const how = status.agent.source === "automatic" ? "Automatic is using" : "Using";
  const ready = status.ready.map((id) => harnessDescriptors.find((descriptor) => descriptor.id === id)?.label ?? id);
  return `${how} ${label}${model ? ` (${model})` : ""}. Signed in here: ${ready.length ? ready.join(", ") : "none found"}.`;
}

function renderBackgroundAgentSettings(settings) {
  const choice = settings.backgroundAgent ?? { harnessId: "" };
  const runnable = systemHarnessDescriptors.filter(({ runtimeConfigured }) => runtimeConfigured);
  const choices = !choice.harnessId || runnable.some(({ id }) => id === choice.harnessId) ? runnable : [...runnable, systemHarnessDescriptors.find(({ id }) => id === choice.harnessId)].filter(Boolean);
  elements.settingsBackgroundAgentHarness.replaceChildren(new Option("Automatic", ""), ...choices.map(({ id, label }) => new Option(label, id)));
  elements.settingsBackgroundAgentHarness.value = choice.harnessId;
  elements.settingsBackgroundAgentHarness.onchange = () => renderBackgroundAgentModel(settings, elements.settingsBackgroundAgentHarness.value, choice);
  renderBackgroundAgentModel(settings, choice.harnessId, choice);
  elements.settingsBackgroundAgentStatus.textContent = "";
  api("/api/settings/background-agent").then((status) => { elements.settingsBackgroundAgentStatus.textContent = backgroundAgentSummary(status); }).catch(() => {});
}

function backgroundAgentValue() {
  if (!backgroundAgentFields) return { harnessId: "", provider: "", modelId: "", thinkingLevel: "" };
  const { descriptor, provider, model, thinking } = backgroundAgentFields;
  return { harnessId: descriptor.id, provider: provider ? provider.value : descriptor.configuration.fixedProvider, modelId: model.value, thinkingLevel: thinking.value };
}

let dashboardAgentFields = null;

/** Like the sync check, the dashboard agent picks its own harness and model on this node. */
function renderDashboardAgentModel(settings, harnessId, current) {
  const descriptor = systemHarnessDescriptors.find(({ id }) => id === harnessId);
  if (!descriptor) { elements.settingsDashboardsModel.replaceChildren(); dashboardAgentFields = null; return; }
  const controls = createConversationControls(descriptor, settings, "", { current: current ?? settings.conversationDefaults[descriptor.id], idPrefix: "settingsDashboardsChoice", testPrefix: "settings-dashboards", label: "Dashboard agent", preserveUnavailableThinking: true });
  dashboardAgentFields = { descriptor, ...controls.fields };
  elements.settingsDashboardsModel.replaceChildren(...controls.controls);
}

function renderDashboardAgentSettings(settings) {
  const agent = settings.dashboards;
  const runnable = systemHarnessDescriptors.filter(({ runtimeConfigured }) => runtimeConfigured);
  const choices = runnable.some(({ id }) => id === agent.harnessId) ? runnable : [...runnable, systemHarnessDescriptors.find(({ id }) => id === agent.harnessId)].filter(Boolean);
  elements.settingsDashboardsHarness.replaceChildren(...choices.map(({ id, label }) => new Option(label, id)));
  elements.settingsDashboardsHarness.value = agent.harnessId;
  elements.settingsDashboardsHarness.onchange = () => renderDashboardAgentModel(settings, elements.settingsDashboardsHarness.value);
  renderDashboardAgentModel(settings, agent.harnessId, agent);
}

function dashboardAgentValue() {
  if (!dashboardAgentFields) return undefined;
  const { descriptor, provider, model, thinking } = dashboardAgentFields;
  return { harnessId: descriptor.id, provider: provider ? provider.value : descriptor.configuration.fixedProvider, modelId: model.value, thinkingLevel: thinking.value };
}

/** One row per checked path, marked passed or failed so a problem stands out from the rest. */
function renderRuntimeReadiness(readiness) {
  elements.settingsRuntimeStatus.replaceChildren(...Object.entries(readiness).flatMap(([id, fields]) => Object.entries(fields).map(([field, result]) => {
    const row = document.createElement("p"); row.className = `engine-check-row ${result.ok ? "ok" : "failed"}`;
    row.append(menuIcon(result.ok ? "check" : "close"), `${runtimeLabels[id][field]}: ${result.message}`);
    return row;
  })));
}
async function checkRuntimePaths() { const readiness = await api("/api/settings/runtime-check", { method: "POST", body: JSON.stringify(runtimeFieldsValue()) }); renderRuntimeReadiness(readiness); return readiness; }
function useHarnessDefaults(id) { clearedHarnessesOnSave.add(id); for (const input of Object.values(runtimeFields[id])) input.value = ""; autosave.schedule("main", 0); }
function invalidRuntimeOverrides(readiness, values) { return Object.entries(readiness).filter(([id]) => id !== "kiro" || kiroEnabledValue()).flatMap(([id, fields]) => Object.entries(fields).filter(([field, result]) => !result.ok && values[id][field] !== runtimeDefaults[id][field]).map(([field]) => runtimeLabels[id][field])); }
export const projectResourceFields = { skills: elements.projectResourceSkillsPaths, prompts: elements.projectResourcePromptsPaths, rules: elements.projectResourceRulesPaths, plugins: elements.projectResourcePluginsPaths };
export function fillResourceFields(fields, resources) { for (const [type, field] of Object.entries(fields)) field.value = (resources[type] || []).join("\n"); }
export function resourceFieldsValue(fields) { return Object.fromEntries(Object.entries(fields).map(([type, field]) => [type, field.value.split("\n").map((line) => line.trim()).filter(Boolean)])); }

let settingsLoading = false;
let settingsReady = false;
/** The retention choices last saved, so a change that deletes more asks first. */
let savedRetention = { days: 0, scope: {} };

/**
 * The fields the node's settings request carries (PUT /api/settings, or /api/settings/personal
 * for a member). Changing one saves them all, as the Save settings button did.
 */
const MAIN_FIELDS = [
  "#settingsShowProjectsOnOtherNodes", "#settingsConversationHistoryDays", "#settingsConversationRetentionDays", "[data-retention-scope]", "#settingsBackup input", "#settingsBackup select",
  "#settingsAutoCompactEnabled", "#settingsAutoCompactThreshold", "#settingsDigestAttachments",
  "#settingsShellTimeoutEnabled", "#settingsShellTimeoutSeconds", "#settingsSubprocessMaxLifetimeMinutes",
  "#settingsConversationCpuLimitEnabled", "#settingsConversationCpuLimitCores", "#settingsConversationMemoryLimitEnabled", "#settingsConversationMemoryLimitGb",
  "#settingsConversationLabels", "#settingsLabelIcons input",
  "#settingsNewConversationWorktree",
  "#settingsStartConversationEnabled", "#settingsStartConversationPrompt", "#settingsEndConversationEnabled", "#settingsEndConversationPrompt",
  "#savedCommandsList > .saved-command-row input", "#savedCommandsList > .saved-command-row textarea",
  "#settingsProjectHome", "#settingsGitPullFileLimit", "#settingsGitPullTimeoutSeconds",
  "#harnessPanels input[data-save-when-left]", "#harnessPanels [data-testid='settings-kiro-enabled']",
  "#harnessPanels .searchable-select-trigger[data-testid*='-default-']", "#harnessPanels select[data-testid*='-default-']",
  "#settingsRemoteTerminalTwins", "#settingsRemoteTerminalOtherNodes", "#settingsRunnerOtherNodes",
  "#settingsResourceSkillsPaths", "#settingsResourcePromptsPaths", "#settingsResourceRulesPaths", "#settingsResourcePluginsPaths",
].join(", ");
/** Saved when the field is left, not while typing: a half-typed number or path must never apply. */
const SAVE_WHEN_LEFT = "input[type='number'], #settingsProjectHome, #harnessPanels [data-testid$='-input'], .resource-paths-input, #settingsBackup input";

/** Without a tab, phones open on the section list; desktop shows Account beside the list. */
export async function openSettings(tab) {
  // Who is signed in decides which sections and fields exist (the admin's paths, Updates, Users): a request made
  // while the app is still starting waits for the node's answer, and nobody signed out opens Settings.
  await authKnown;
  if (!state.authenticated) return;
  applyAdminVisibility();
  // Reopening a closed dialog must not wait for its previous request to finish.
  if (!elements.settingsDialog.open) elements.settingsDialog.showModal();
  selectSettingsTab(tab ?? "account");
  if (!tab) elements.settingsForm.dataset.mobileView = "menu";
  if (settingsLoading) return;
  settingsLoading = true;
  settingsReady = false;
  // Nothing saves until the saved values are on the page: an unfinished read must never overwrite them.
  elements.settingsForm.dataset.ready = "false";
  autosave.setBase("loading");
  elements.settingsForm.setAttribute("aria-busy", "true");
  elements.settingsRestartMessage.hidden = true;
  elements.settingsRestartMessage.textContent = "";
  // Navigation stays usable. Cluster actions have their own loading guard and
  // do not depend on local harness/model discovery.
  for (const panel of elements.settingsPanels) panel.inert = !ownLoading(panel);
  for (const load of [loadSecretAccounts, loadChangelogPanel, loadMfaSettings, loadClusterPanel, ...(isNodeAdmin() ? [loadUpdatesPanel] : []), loadWorkspaces]) {
    void load().catch((error) => toast.error(error.message));
  }
  try {
    await loadSettings();
    settingsReady = true;
  } finally {
    settingsLoading = false;
    elements.settingsForm.removeAttribute("aria-busy");
    for (const panel of elements.settingsPanels) panel.inert = !settingsReady && !ownLoading(panel);
    elements.settingsForm.dataset.ready = String(settingsReady);
    autosave.setBase(settingsReady ? "ready" : "unavailable");
  }
}

/** Leaves Settings for the workspace. A change still waiting is saved on the way out. */
export function closeSettings() {
  // A field that saves when it is left (numbers, paths) must be left before the page goes.
  if (elements.settingsDialog.contains(document.activeElement)) document.activeElement.blur();
  if (elements.settingsDialog.open) elements.settingsDialog.close();
}

async function loadSettings() {
  const admin = isNodeAdmin();
  const [settings, defaults, harnessBody] = await Promise.all([api("/api/settings"), admin ? api("/api/settings/runtime-defaults") : null, api("/api/harnesses")]);
  runtimeDefaults = defaults;
  harnessDescriptors = harnessBody.harnesses.filter(({ configuration }) => configuration);
  clearedHarnessesOnSave.clear();
  elements.settingsUsername.textContent = state.username;
  document.querySelector("#settingsEmailField").hidden = state.isRemoteLogin;
  document.querySelector("#settingsEmail").value = state.email;
  document.querySelector("#settingsEmail").disabled = state.isRemoteLogin;
  document.querySelector("#settingsEmailStatus").textContent = "";
  for (const input of [elements.settingsCurrentPassword, elements.settingsNewPassword, elements.settingsNewPasswordRepeat]) input.value = "";
  renderHarnessSettings(harnessDescriptors, settings, defaults);
  void fillShortcutSettings();
  elements.settingsRestartMessage.hidden = true;
  elements.settingsRestartMessage.textContent = "";
  document.querySelector("#settingsConversationLabels").value = settings.conversationLabels.join("\n");
  loadLabelIcons(settings.conversationLabelIcons);
  document.querySelector("#settingsConversationHistoryDays").value = settings.conversationHistoryDays;
  elements.settingsAutoCompactEnabled.checked = settings.autoCompactThreshold !== null;
  elements.settingsAutoCompactThreshold.value = settings.autoCompactThreshold ?? 70;
  elements.settingsAutoCompactThreshold.disabled = !elements.settingsAutoCompactEnabled.checked;
  elements.settingsDigestAttachments.checked = settings.digestAttachments;
  document.querySelector("#settingsShowProjectsOnOtherNodes").checked = settings.showProjectsOnOtherNodes !== false;
  elements.settingsNewConversationWorktree.checked = settings.newConversationWorktree;
  elements.settingsStartConversationEnabled.checked = settings.conversationCommands.start.enabled;
  elements.settingsStartConversationPrompt.value = settings.conversationCommands.start.prompt;
  elements.settingsEndConversationEnabled.checked = settings.conversationCommands.end.enabled;
  elements.settingsEndConversationPrompt.value = settings.conversationCommands.end.prompt;
  renderSavedCommands(settings.conversationCommands.presets || []);
  elements.completionSoundSelect.value = state.completionSound;
  syncNotifyButton();
  if (!admin) return;
  elements.settingsRemoteTerminalTwins.checked = settings.remoteTerminal.twins;
  elements.settingsRemoteTerminalOtherNodes.checked = settings.remoteTerminal.otherNodes;
  elements.settingsRunnerOtherNodes.checked = settings.runnerAccess.otherNodes;
  elements.settingsGitPullFileLimit.value = settings.gitPullFileLimit ?? 1000;
  elements.settingsGitPullTimeoutSeconds.value = settings.gitPullTimeoutSeconds ?? 360;
  elements.settingsProjectHome.value = settings.projects.homePath;
  document.querySelector("#settingsConversationRetentionDays").value = settings.conversationRetentionDays;
  fillRetentionScope(settings.conversationRetentionScope);
  savedRetention = { days: settings.conversationRetentionDays, scope: retentionScopeValue() };
  fillBackup(settings.conversationBackup);
  // Not part of the settings, and not a reason to keep them from opening.
  void loadBackupStatus();
  elements.settingsShellTimeoutEnabled.checked = settings.shellCommandTimeoutSeconds !== null;
  elements.settingsShellTimeoutSeconds.value = settings.shellCommandTimeoutSeconds ?? 600;
  elements.settingsSubprocessMaxLifetimeMinutes.value = settings.subprocessMaxLifetimeMinutes ?? 360;
  elements.settingsShellTimeoutSeconds.disabled = !elements.settingsShellTimeoutEnabled.checked;
  // A node that predates the limits sends neither field.
  elements.settingsConversationCpuLimitEnabled.checked = settings.conversationCpuLimitCores != null;
  elements.settingsConversationCpuLimitCores.value = settings.conversationCpuLimitCores ?? 2;
  elements.settingsConversationCpuLimitCores.disabled = !elements.settingsConversationCpuLimitEnabled.checked;
  elements.settingsConversationMemoryLimitEnabled.checked = settings.conversationMemoryLimitGb != null;
  elements.settingsConversationMemoryLimitGb.value = settings.conversationMemoryLimitGb ?? 8;
  elements.settingsConversationMemoryLimitGb.disabled = !elements.settingsConversationMemoryLimitEnabled.checked;
  elements.settingsRemoteTerminalTwins.checked = settings.remoteTerminal.twins;
  elements.settingsRemoteTerminalOtherNodes.checked = settings.remoteTerminal.otherNodes;
  elements.settingsRuntimeStatus.textContent = "";
  elements.settingsSkillsStatus.textContent = "";
  fillResourceFields(globalResourceFields, settings.resources);
}

const savedCommandsList = document.querySelector("#savedCommandsList");
let savedCommandSnapshot = "";

function renderSavedCommands(commands) {
  savedCommandsList.replaceChildren();
  for (const command of commands) addSavedCommandRow(command);
  savedCommandSnapshot = JSON.stringify(savedCommandsValue());
  void import("./command-sharing.js").then(({ mountReceivedCommands }) => mountReceivedCommands(savedCommandsList));
}

function addSavedCommandRow(command = { name: "", prompt: "" }) {
  const row = document.createElement("div");
  row.className = "saved-command-row";
  row.dataset.commandId = command.id || crypto.randomUUID();
  const name = document.createElement("input");
  name.placeholder = "Name";
  name.dataset.testid = "saved-command-name";
  name.setAttribute("aria-label", "Command name");
  name.maxLength = 80;
  name.required = true;
  name.value = command.name;
  const prompt = document.createElement("textarea");
  prompt.placeholder = "Prompt to paste into chat";
  prompt.dataset.testid = "saved-command-prompt";
  prompt.setAttribute("aria-label", "Command prompt");
  prompt.maxLength = 10000;
  prompt.required = true;
  prompt.rows = 2;
  prompt.value = command.prompt;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "ghost compact";
  remove.textContent = "Remove";
  remove.dataset.testid = "saved-command-remove";
  remove.setAttribute("aria-label", "Remove saved command");
  remove.addEventListener("click", () => { row.remove(); autosave.schedule("main", 0); });
  const share = document.createElement("button");
  share.type = "button"; share.className = "ghost compact";
  share.textContent = "Share"; share.dataset.testid = "saved-command-share";
  share.title = state.isRemoteLogin ? "Change command sharing on the owning node." : "Offer this command to other machines. Its latest changes are saved first.";
  share.disabled = state.isRemoteLogin;
  share.addEventListener("click", async () => {
    try {
      // Sharing reads the saved command, so a change still waiting is saved first.
      const errors = await autosave.flush();
      const saved = JSON.parse(savedCommandSnapshot || "[]");
      if (errors.length || !saved.some((item) => item.id === row.dataset.commandId)) {
        toast(errors.length ? `Fix the command first: ${errors[0]}` : "Give the command a name and a prompt before sharing it.");
        return;
      }
      const { openCommandSharing } = await import("./command-sharing.js");
      await openCommandSharing(row.dataset.commandId);
    } catch (error) { toast.error(error.message); }
  });
  row.append(name, prompt, remove, share);
  savedCommandsList.append(row);
  if (!command.name) name.focus();
}

document.querySelector("#addSavedCommand").addEventListener("click", () => addSavedCommandRow());

function savedCommandsValue() {
  // A row added but not yet typed into is a draft, not a command.
  const rows = [...savedCommandsList.querySelectorAll(":scope > .saved-command-row")].filter((row) => [...row.querySelectorAll("input, textarea")].some((field) => field.value.trim()));
  if (rows.length > 50) throw invalidSetting("Save at most 50 commands");
  return rows.map((row) => {
    const [name, prompt] = row.querySelectorAll("input, textarea");
    if (!name.value.trim() || !prompt.value.trim()) throw invalidSetting("Saved commands need a name and prompt");
    return { id: row.dataset.commandId, name: name.value.trim(), prompt: prompt.value.trim() };
  });
}

function personalSettingsValue() {
  return {
    conversationDefaults: conversationDefaultsValue(),
    conversationLabels: document.querySelector("#settingsConversationLabels").value.split("\n").map((label) => label.trim()).filter(Boolean),
    conversationHistoryDays: Number(document.querySelector("#settingsConversationHistoryDays").value),
    autoCompactThreshold: elements.settingsAutoCompactEnabled.checked ? Number(elements.settingsAutoCompactThreshold.value) : null,
    digestAttachments: elements.settingsDigestAttachments.checked,
    showProjectsOnOtherNodes: document.querySelector("#settingsShowProjectsOnOtherNodes").checked,
    conversationCommands: {
      start: { enabled: elements.settingsStartConversationEnabled.checked, prompt: elements.settingsStartConversationPrompt.value.trim() },
      end: { enabled: elements.settingsEndConversationEnabled.checked, prompt: elements.settingsEndConversationPrompt.value.trim() },
      presets: savedCommandsValue(),
    },
  };
}

/** A member saves only their own settings; nothing they send can change the node's. */
async function savePersonalSettings() {
  const value = personalSettingsValue();
  const saved = await api("/api/settings/personal", { method: "PUT", body: JSON.stringify(value) });
  savedCommandSnapshot = JSON.stringify(value.conversationCommands.presets);
  state.conversationLabels = saved.conversationLabels;
  if (state.activeProjectId) void refreshSessionsQuietly();
  else renderSessions();
}

/** The fields this save sends, checked the way the browser would before a form submit. */
function checkMainFields() {
  for (const field of elements.settingsForm.querySelectorAll(MAIN_FIELDS)) {
    // Saved commands are checked by savedCommandsValue, which leaves a row not yet typed into out.
    if (field.disabled || !field.willValidate || field.closest("#savedCommandsList") || field.checkValidity()) continue;
    const label = field.closest("label")?.firstChild?.textContent?.trim() || field.getAttribute("aria-label") || field.id;
    throw invalidSetting(`${label}: ${field.validationMessage}`);
  }
}

/** Saves every setting the page holds for the node: what the Save settings button used to send. */
async function saveSettings() {
  if (!settingsReady || settingsLoading) throw invalidSetting("Settings are still loading");
  checkMainFields();
  for (const descriptor of harnessDescriptors) {
    if (descriptor.id === "kiro" && !kiroEnabledValue()) continue;
    const { provider, model } = conversationFields[descriptor.id];
    if (provider && !provider.value) throw invalidSetting(`Choose a ${descriptor.label} provider for new conversations`);
    if (!model.value) throw invalidSetting(`Choose a ${descriptor.label} model for new conversations`);
  }
  if (!isNodeAdmin()) { await savePersonalSettings(); return; }
  const runtime = runtimeFieldsValue();
  for (const harness of clearedHarnessesOnSave) runtime[harness] = blankHarnessPayload();
  const invalid = invalidRuntimeOverrides(await checkRuntimePaths(), runtime);
  // The page is read after that round trip: a number started meanwhile waits until it is left.
  if (stillTyping("main")) throw deferSave();
  if (invalid.length) throw invalidSetting(`Fix unavailable custom paths: ${invalid.join(", ")}`);
  const presets = savedCommandsValue();
  const retention = retentionToSave();
  showBackupSaveError(null);
  const backup = backupKnown ? backupToSave() : null;
  const saved = await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify({
      runtimes: runtime,
      kiroEnabled: kiroEnabledValue(),
      conversationDefaults: conversationDefaultsValue(),
      projects: { homePath: elements.settingsProjectHome.value.trim() },
      resources: resourceFieldsValue(globalResourceFields),
      conversationLabels: document.querySelector("#settingsConversationLabels").value.split("\n").map((label) => label.trim()).filter(Boolean),
      conversationLabelIcons: labelIconsValue(),
      conversationHistoryDays: Number(document.querySelector("#settingsConversationHistoryDays").value),
      conversationRetentionDays: retention.days,
      conversationRetentionScope: retention.scope,
      ...(backup ? { conversationBackup: backup } : {}),
      autoCompactThreshold: elements.settingsAutoCompactEnabled.checked ? Number(elements.settingsAutoCompactThreshold.value) : null,
      shellCommandTimeoutSeconds: elements.settingsShellTimeoutEnabled.checked ? Number(elements.settingsShellTimeoutSeconds.value) : null,
      subprocessMaxLifetimeMinutes: Number(elements.settingsSubprocessMaxLifetimeMinutes.value),
      conversationCpuLimitCores: elements.settingsConversationCpuLimitEnabled.checked ? Number(elements.settingsConversationCpuLimitCores.value) : null,
      conversationMemoryLimitGb: elements.settingsConversationMemoryLimitEnabled.checked ? Number(elements.settingsConversationMemoryLimitGb.value) : null,
      digestAttachments: elements.settingsDigestAttachments.checked,
      showProjectsOnOtherNodes: document.querySelector("#settingsShowProjectsOnOtherNodes").checked,
      newConversationWorktree: elements.settingsNewConversationWorktree.checked,
      gitPullFileLimit: Number(elements.settingsGitPullFileLimit.value),
      gitPullTimeoutSeconds: Number(elements.settingsGitPullTimeoutSeconds.value),
      remoteTerminal: { twins: elements.settingsRemoteTerminalTwins.checked, otherNodes: elements.settingsRemoteTerminalOtherNodes.checked },
      runnerAccess: { otherNodes: elements.settingsRunnerOtherNodes.checked },
      conversationCommands: { ...personalSettingsValue().conversationCommands, presets },
    }),
  }).catch((error) => { showBackupSaveError(error); throw error; });
  savedCommandSnapshot = JSON.stringify(presets);
  savedRetention = { days: saved.conversationRetentionDays ?? retention.days, scope: { ...(saved.conversationRetentionScope ?? retention.scope) } };
  // The form takes what the node saved: the secret key leaves its field. A field changed while
  // the request ran stays as typed, and is saved next. The status follows the new setting.
  if (backup && JSON.stringify(conversationBackupValue()) === JSON.stringify(backup)) fillBackupFields(saved.conversationBackup);
  void loadBackupStatus();
  await saveChangedTerminalPolicy();
  state.conversationLabels = saved.conversationLabels;
  state.conversationLabelIcons = saved.conversationLabelIcons;
  // Refreshes can keep queuing during live activity; they are not part of saving.
  if (state.activeProjectId) void refreshSessionsQuietly();
  else renderSessions();
  const restartRequired = harnessDescriptors.filter(({ id }) => saved.restartRequired?.[id]).map(({ label }) => `${label} configuration`);
  // A restart notice stays until Settings is opened again, so it is not lost to the next save.
  if (restartRequired.length) {
    elements.settingsRestartMessage.hidden = false;
    elements.settingsRestartMessage.textContent = `Restart required for ${restartRequired.join(" and ")} changes.`;
  }
}

elements.settingsButton.addEventListener("click", () => openSettings().catch((error) => toast.error(error.message)));
async function runSkillOperation(operation) {
  const buttons = [elements.settingsSyncSkillsButton, elements.settingsReloadSkillsButton];
  for (const item of buttons) item.disabled = true;
  try { await operation(); await loadSkills(true); }
  catch (error) { elements.settingsSkillsStatus.textContent = error.message; toast.error(error.message); }
  finally { for (const item of buttons) item.disabled = false; }
}

async function syncLocalSkills() {
  const paths = resourceFieldsValue(globalResourceFields).skills;
  if (!await confirmAction({
    title: "Sync local skills?",
    message: "Import these trusted skill directories, including scripts, as local managed skills? Matching local managed copies are replaced with backups. Choose clusters separately in Skills.",
    confirmLabel: "Sync skills",
    destructive: true,
  })) return;
  const result = await api("/api/settings/skills/sync", { method: "POST", body: JSON.stringify({ paths }) });
  const backup = result.backupPath ? ` Backups: ${result.backupPath}.` : "";
  elements.settingsSkillsStatus.textContent = `Imported ${result.published.length}; unchanged ${result.unchanged.length}.${backup} Manage cluster sharing in the Skills tab.`;
}

async function reloadSkills() {
  const result = await api("/api/settings/skills/reload", { method: "POST", body: JSON.stringify({}) });
  const failures = result.failed.map((failure) => `${failure.sessionId}: ${failure.error}`).join("; ");
  elements.settingsSkillsStatus.textContent = `Reloaded ${result.reloaded}; skipped ${result.skipped}; failed ${result.failed.length}.${failures ? ` ${failures}.` : ""} Busy sessions skipped; retry when idle. Claude loads changes on its next run.`;
}

/* What the retention sweep may delete beyond the list: six boxes saved as one setting, and a
   button that asks the node what the ticked boxes would delete. The button changes nothing. */
const retentionBoxes = () => [...document.querySelectorAll("[data-retention-scope]")];

/** The three boxes that widen the first one do nothing without it. */
function syncRetentionScope() {
  const full = document.querySelector("#settingsRetentionFull").checked;
  for (const box of document.querySelectorAll("[data-retention-needs-full]")) box.disabled = !full;
}

/** A node that predates the setting sends none: every box is unticked. */
function fillRetentionScope(scope) {
  for (const box of retentionBoxes()) box.checked = scope?.[box.dataset.retentionScope] === true;
  syncRetentionScope();
  const preview = document.querySelector("#settingsRetentionPreview");
  preview.hidden = true;
  preview.replaceChildren();
}

function retentionScopeValue() {
  return Object.fromEntries(retentionBoxes().map((box) => [box.dataset.retentionScope, box.checked]));
}

function retentionSize(bytes) {
  const megabytes = (Number(bytes) || 0) / 1e6;
  if (megabytes >= 1000) return `${(megabytes / 1000).toFixed(megabytes >= 10_000 ? 0 : 1)} GB`;
  return `${megabytes >= 10 || megabytes === 0 ? megabytes.toFixed(0) : megabytes.toFixed(1)} MB`;
}

function retentionTable(testId, caption, headings, rows) {
  const table = document.createElement("table");
  table.dataset.testid = testId;
  table.createCaption().textContent = caption;
  const head = table.createTHead().insertRow();
  for (const heading of headings) { const cell = document.createElement("th"); cell.scope = "col"; cell.textContent = heading; head.append(cell); }
  const body = table.createTBody();
  for (const { kind, cells } of rows) {
    const row = body.insertRow();
    if (kind) row.dataset.kind = kind;
    for (const text of cells) row.insertCell().textContent = String(text);
  }
  return table;
}

/** The line over the dry run's tables: what is kept of a conversation before it goes. `saved` is the node's saved backup setting. */
function retentionBackupLine(saved) {
  const line = document.createElement("p");
  line.className = "settings-hint";
  line.dataset.testid = "settings-retention-preview-backup";
  const days = saved.keepDays;
  const kept = days > 0 ? `Each backup is deleted after ${days.toLocaleString()} ${days === 1 ? "day" : "days"}.` : "The backups are kept for good.";
  line.textContent = saved.destination === "off"
    ? "No backup is made: what is deleted is gone."
    : `Expired conversations and left-behind files are backed up to ${saved.where} first. ${kept} Empty conversations and background runs are not backed up.`;
  // The boxes are read from the page, the backup setting from the node: say so when the two differ.
  if (backupChanged()) line.textContent += " This is the saved backup setting. Your changes below are not saved yet.";
  return line;
}

function retentionPreviewTables(preview) {
  const count = (total) => [total.conversations.toLocaleString(), total.files.toLocaleString(), retentionSize(total.bytes)];
  const { totals } = preview;
  // A node that predates backups says nothing about them.
  const tables = [...(preview.backup ? [retentionBackupLine(preview.backup)] : []), retentionTable("settings-retention-preview-totals", "With the boxes ticked above, on this machine", ["", "Conversations", "Files", "Size"], [
    { kind: "expired", cells: [`Expired: no activity for ${preview.retentionDays} days`, ...count(totals.expired)] },
    { kind: "empty", cells: ["Empty: never got a message", ...count(totals.empty)] },
    { kind: "background", cells: ["Background runs", ...count(totals.background)] },
    { kind: "leftover", cells: ["Left-behind files", ...count(totals.leftover)] },
    { kind: "held", cells: ["Held back, not deleted", ...count(totals.held)] },
  ])];
  const projects = preview.projects.slice(0, 5);
  if (projects.length) {
    tables.push(retentionTable("settings-retention-preview-projects", "Largest projects", ["Project", "Conversations", "Size"], projects.map((project) => (
      { cells: [project.name, (project.expired.conversations + project.empty.conversations).toLocaleString(), retentionSize(project.expired.bytes + project.empty.bytes)] }))));
  }
  const kept = Object.entries(preview.kept);
  if (kept.length) {
    tables.push(retentionTable("settings-retention-preview-kept", "Old enough, and kept", ["Why", "Conversations"], kept.map(([reason, conversations]) => (
      { cells: [reason.charAt(0).toUpperCase() + reason.slice(1), conversations.toLocaleString()] }))));
  }
  if (totals.expired.conversations + totals.empty.conversations > preview.passLimit) {
    const note = document.createElement("p");
    note.className = "settings-hint";
    note.textContent = `One hourly check deletes at most ${preview.passLimit.toLocaleString()} conversations. The rest go in the checks that follow.`;
    tables.push(note);
  }
  return tables;
}

async function showRetentionPreview() {
  const button = document.querySelector("#settingsRetentionPreviewButton");
  const target = document.querySelector("#settingsRetentionPreview");
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Checking…";
  try {
    // The ticked boxes, not the saved ones: the point is to look before saving.
    const query = new URLSearchParams(Object.entries(retentionScopeValue()).map(([box, ticked]) => [box, ticked ? "1" : "0"]));
    target.replaceChildren(...retentionPreviewTables(await api(`/api/settings/retention-preview?${query}`)));
  } catch (error) {
    const message = document.createElement("p");
    message.setAttribute("role", "alert");
    message.dataset.testid = "settings-retention-preview-error";
    message.textContent = `Could not work out what would be deleted: ${error.message}`;
    target.replaceChildren(message);
  } finally {
    target.hidden = false;
    button.disabled = false;
    button.textContent = label;
  }
}

/* Backup before deleting: where the hourly check writes a conversation before it deletes it, and
   for how many days the backup is kept. Saved with the other settings, each field when it is left;
   a bucket is saved once nothing it needs is missing. The check button tries the place that is
   typed, saved or not, and the status says what this machine keeps now. */
const backupForm = {
  group: document.getElementById("settingsBackup"),
  destination: document.getElementById("settingsBackupDestination"),
  keepDays: document.getElementById("settingsBackupKeepDays"),
  folder: document.getElementById("settingsBackupFolder"),
  folderHint: document.getElementById("settingsBackupFolderHint"),
  credentials: document.getElementById("settingsBackupS3Credentials"),
  secret: document.getElementById("settingsBackupS3SecretAccessKey"),
  secretSaved: document.getElementById("settingsBackupS3SecretSaved"),
  more: document.getElementById("settingsBackupS3More"),
  checkButton: document.getElementById("settingsBackupCheckButton"),
  checkResult: document.getElementById("settingsBackupCheckResult"),
  saveError: document.getElementById("settingsBackupSaveError"),
  status: document.getElementById("settingsBackupStatus"),
  // A bucket's text fields, each under the name it has in the setting.
  s3: {
    bucket: document.getElementById("settingsBackupS3Bucket"),
    region: document.getElementById("settingsBackupS3Region"),
    prefix: document.getElementById("settingsBackupS3Prefix"),
    endpoint: document.getElementById("settingsBackupS3Endpoint"),
    accessKeyId: document.getElementById("settingsBackupS3AccessKeyId"),
    profile: document.getElementById("settingsBackupS3Profile"),
  },
};
/** False on a node that predates backups: the group stays hidden and a save leaves the setting out. */
let backupKnown = false;
/** What the form held when it was last filled from the node, to tell a choice that is not saved yet. */
let backupSnapshot = "";
let backupCheckRun = 0;
let backupStatusRun = 0;

/** A line with a tick, or a cross and the page's error colour. Its text is the node's, so it is set as text. */
function backupNote(kind, text, testId) {
  const note = document.createElement("p");
  note.className = `retention-backup-note ${kind}`;
  if (kind === "failed") note.setAttribute("role", "alert");
  if (testId) note.dataset.testid = testId;
  const words = document.createElement("span");
  words.textContent = text;
  note.append(menuIcon(kind === "failed" ? "close" : "check"), words);
  return note;
}

/** Shows the rows of the chosen place ("on": of any place) and of the chosen way to sign in, and no others. */
function syncBackupFields() {
  const destination = backupForm.destination.value;
  for (const row of backupForm.group.querySelectorAll("[data-backup-kind]")) {
    const { backupKind: kind, backupCredentials: credentials } = row.dataset;
    row.hidden = (kind === "on" ? destination === "off" : kind !== destination) || (credentials !== undefined && credentials !== backupForm.credentials.value);
  }
  // A number field that is not on screen must not hold up a save: the browser cannot point at it.
  backupForm.keepDays.disabled = destination === "off";
}

/** `saved` is the node's `conversationBackup`, when Settings open. What a check or a refused save said goes. */
function fillBackup(saved) {
  backupKnown = Boolean(saved);
  backupForm.group.hidden = !backupKnown;
  // A group that is not shown must not hold up a save with a number nobody can see.
  if (!backupKnown) { backupForm.keepDays.disabled = true; return; }
  fillBackupFields(saved);
  // An address that is saved must not hide behind a closed line.
  backupForm.more.open = Boolean(saved.s3.endpoint);
  backupCheckRun += 1;
  backupForm.checkResult.replaceChildren();
  backupForm.saveError.replaceChildren();
}

/** The fields as the node has them, also after a save. The secret key never comes back, so its field ends empty. */
function fillBackupFields(saved) {
  backupForm.destination.value = saved.destination;
  backupForm.keepDays.value = saved.keepDays;
  backupForm.folder.value = saved.folder;
  backupForm.folder.placeholder = saved.defaultFolder;
  const defaultFolder = document.createElement("code");
  defaultFolder.textContent = saved.defaultFolder;
  backupForm.folderHint.replaceChildren("Leave this empty to use ", defaultFolder, ". Use a folder outside your projects.");
  for (const [name, input] of Object.entries(backupForm.s3)) input.value = saved.s3[name];
  backupForm.credentials.value = saved.s3.credentials;
  backupForm.secret.value = "";
  backupForm.secret.placeholder = saved.hasSecretAccessKey ? "A key is saved. Type a new one to replace it." : "";
  // A narrow field cuts its placeholder short, so the line under the field says it too.
  backupForm.secretSaved.hidden = !saved.hasSecretAccessKey;
  syncBackupFields();
  backupSnapshot = JSON.stringify(conversationBackupValue());
}

/** The setting as the form has it, in the shape a save takes: the fields of the chosen place and no others. */
function conversationBackupValue() {
  const destination = backupForm.destination.value;
  // With backups off the days are not on screen, so the saved number stays.
  if (destination === "off") return { destination };
  const value = { destination, keepDays: Number(backupForm.keepDays.value) };
  if (destination === "folder") return { ...value, folder: backupForm.folder.value.trim() };
  const typed = (name) => backupForm.s3[name].value.trim();
  const credentials = backupForm.credentials.value;
  const secretAccessKey = backupForm.secret.value.trim();
  return {
    ...value,
    s3: {
      bucket: typed("bucket"), region: typed("region"), prefix: typed("prefix"), endpoint: typed("endpoint"), credentials,
      // The secret key goes only when one was typed: leaving it out keeps the saved one.
      ...(credentials === "keys" ? { accessKeyId: typed("accessKeyId"), ...(secretAccessKey ? { secretAccessKey } : {}) } : { profile: typed("profile") }),
    },
  };
}

/** What a bucket still needs before the node would take it, in the node's words; "" when nothing. */
function backupMissing({ destination, s3 }) {
  if (destination !== "s3") return "";
  if (!s3.bucket) return "Backups to S3 need a bucket";
  if (!s3.region) return "Backups to S3 need the bucket's region";
  if (s3.credentials === "keys" && (!s3.accessKeyId || (!s3.secretAccessKey && backupForm.secretSaved.hidden))) return "Backups to S3 need an access key ID and its secret key, or a profile";
  return "";
}

/**
 * The backup setting a save sends. Choosing a bucket shows its empty fields, so a bucket that still
 * misses a part is not sent: the save waits until the fields are filled, and says so next to them
 * (the save line is at the top of the page).
 */
function backupToSave() {
  const value = conversationBackupValue();
  const missing = backupMissing(value);
  if (!missing) return value;
  const note = document.createElement("p");
  note.className = "settings-hint";
  note.dataset.testid = "settings-backup-unfinished";
  note.textContent = `Not saved yet. ${missing}.`;
  backupForm.saveError.replaceChildren(note);
  throw invalidSetting(missing);
}

/** Whether the form holds a backup choice that the node has not saved. */
function backupChanged() {
  return backupKnown && JSON.stringify(conversationBackupValue()) !== backupSnapshot;
}

function backupKeptText({ kept, nextRemovalAt }) {
  if (!kept.backups) return "No backups yet.";
  const one = kept.backups === 1;
  const count = `${kept.backups.toLocaleString()} ${one ? "backup" : "backups"}`;
  // One conversation's backup is often far below a megabyte.
  const size = kept.bytes > 0 && kept.bytes < 1e6 ? `${Math.max(1, Math.round(kept.bytes / 1e3))} KB` : retentionSize(kept.bytes);
  if (!nextRemovalAt) return `${count} kept for good (${size}).`;
  const due = new Date(nextRemovalAt);
  const when = due.getTime() <= Date.now() ? "at the next hourly check" : `on ${due.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}`;
  return `${count} kept (${size}). ${one ? "It" : "The oldest"} is removed ${when}.`;
}

function backupStatusNotes(status) {
  const kept = document.createElement("p");
  kept.className = "settings-hint";
  kept.dataset.testid = "settings-backup-kept";
  kept.textContent = backupKeptText(status);
  if (!status.problem) return [kept];
  const at = new Date(status.problem.at);
  const when = Number.isFinite(at.getTime()) ? ` on ${at.toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" })}` : "";
  return [kept, backupNote("failed", `Problem${when}: ${status.problem.message}`, "settings-backup-problem")];
}

/** What this machine keeps now and the last problem. Asked when settings open, after a save, and after a check that went well. */
async function loadBackupStatus() {
  if (!backupKnown) return;
  const run = ++backupStatusRun;
  let notes;
  try { notes = backupStatusNotes(await api("/api/settings/conversation-backups")); }
  catch (error) { notes = [backupNote("failed", error.message, "settings-backup-status-error")]; }
  // An answer that a later request overtook is out of date.
  if (run === backupStatusRun) backupForm.status.replaceChildren(...notes);
}

async function checkBackupDestination() {
  // The days go with the request, so let the browser point at a number the node would refuse.
  if (!backupForm.keepDays.reportValidity()) return;
  const run = ++backupCheckRun;
  const label = backupForm.checkButton.textContent;
  backupForm.checkButton.disabled = true;
  backupForm.checkButton.textContent = "Checking…";
  backupForm.checkResult.replaceChildren();
  let note;
  try {
    // What is typed, whether or not it is saved yet.
    const answer = await api("/api/settings/conversation-backups/check", { method: "POST", body: JSON.stringify(conversationBackupValue()) });
    note = answer.ok ? backupNote("ok", `Joint Bob can write backups to ${answer.where}.`) : backupNote("failed", answer.message);
    // On the node a check of the saved place that goes well ends a problem about making backups, so the status is read again.
    if (answer.ok) void loadBackupStatus();
  } catch (error) {
    note = backupNote("failed", error.message);
  } finally {
    backupForm.checkButton.disabled = false;
    backupForm.checkButton.textContent = label;
  }
  // An answer about values that changed while it was on its way would mislead.
  if (run === backupCheckRun) backupForm.checkResult.replaceChildren(note);
}

/** A save the node refused because of the backup setting: its reason goes over the fields, in the node's words. */
function showBackupSaveError(error) {
  // The node names the setting it refused, so a refusal about another one stays out of this group.
  const refused = error?.details?.setting === "conversationBackup";
  backupForm.saveError.replaceChildren(...(refused ? [backupNote("failed", error.cause?.message || error.message)] : []));
}

backupForm.destination.addEventListener("change", syncBackupFields);
backupForm.credentials.addEventListener("change", syncBackupFields);
backupForm.checkButton.addEventListener("click", () => { void checkBackupDestination(); });
// What a check or a refused save said was about the values as they were.
backupForm.group.addEventListener("input", () => { backupCheckRun += 1; backupForm.checkResult.replaceChildren(); backupForm.saveError.replaceChildren(); });
document.querySelector("#settingsRetentionFull").addEventListener("change", syncRetentionScope);
document.querySelector("#settingsRetentionPreviewButton").addEventListener("click", () => { void showRetentionPreview(); });
elements.settingsSyncSkillsButton.addEventListener("click", () => runSkillOperation(syncLocalSkills));
elements.settingsReloadSkillsButton.addEventListener("click", () => runSkillOperation(reloadSkills));
elements.settingsCheckRuntimePathsButton.addEventListener("click", () => checkRuntimePaths().catch((error) => toast.error(error.message)));
elements.settingsAutoCompactEnabled.addEventListener("change", () => { elements.settingsAutoCompactThreshold.disabled = !elements.settingsAutoCompactEnabled.checked; });
elements.settingsShellTimeoutEnabled.addEventListener("change", () => { elements.settingsShellTimeoutSeconds.disabled = !elements.settingsShellTimeoutEnabled.checked; });
elements.settingsConversationCpuLimitEnabled.addEventListener("change", () => { elements.settingsConversationCpuLimitCores.disabled = !elements.settingsConversationCpuLimitEnabled.checked; });
elements.settingsConversationMemoryLimitEnabled.addEventListener("change", () => { elements.settingsConversationMemoryLimitGb.disabled = !elements.settingsConversationMemoryLimitEnabled.checked; });
for (const tab of elements.settingsTabs) {
  tab.addEventListener("click", () => selectSettingsTab(tab.dataset.settingsTab));
  tab.addEventListener("keydown", (event) => {
    // The tablist is a vertical sidebar on wide screens and a horizontal strip on narrow
    // ones, so both axes walk it.
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const visible = elements.settingsTabs.filter((item) => !item.hidden && (isNodeAdmin() || !item.hasAttribute("data-admin-only")));
    const index = visible.indexOf(tab);
    const next = visible[(index + step + visible.length) % visible.length];
    selectSettingsTab(next.dataset.settingsTab);
    next.focus();
  });
}
elements.settingsBackButton.addEventListener("click", () => { elements.settingsForm.dataset.mobileView = "menu"; });
// Search sections and saved account metadata. Never index secret values.
const settingsSearch = createSettingsSearch({
  input: elements.settingsSearchInput,
  results: elements.settingsSearchResults,
  tabs: elements.settingsTabs,
  panels: elements.settingsPanels,
  isAvailable: (tab) => !tab.hidden && (isNodeAdmin() || !tab.hasAttribute("data-admin-only")),
  getExtraEntries: () => {
    const tab = elements.settingsTabs.find((item) => item.dataset.settingsTab === "secrets");
    if (!tab || tab.hidden) return [];
    return secretAccounts.map((account) => ({
      tab,
      title: account.label,
      section: "Secret accounts",
      key: "Secrets › Secret accounts",
      search: `${account.label} ${account.provider} ${account.websiteOrigin ?? ""} ${account.variables.map((variable) => variable.name).join(" ")}`,
      accountId: account.id,
    }));
  },
  onPick(tab, element, entry) {
    selectSettingsTab(tab.dataset.settingsTab);
    const target = entry.accountId ? revealSecretAccount(entry.accountId) : element;
    if (!target || target === tab) return;
    // A section's own tab (Relay › Serving) opens that tab.
    if (target.matches("[role='tab']")) target.click();
    // A setting behind a closed disclosure has no place on the page to scroll to until it opens.
    const closed = target.closest("details:not([open])");
    if (closed) closed.open = true;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.remove("settings-hit");
    void target.offsetWidth;
    target.classList.add("settings-hit");
  },
});
elements.settingsDialog.addEventListener("keydown", (event) => {
  // ⌘F inside Settings jumps to the search box instead of the browser's find bar.
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") { event.preventDefault(); settingsSearch.focus(); }
});
elements.cancelSettingsButton.addEventListener("click", closeSettings);
elements.settingsClientLogsCopyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(window.jointBobClientLogs?.entries().join("\n") || "");
    toast("Client logs copied");
  } catch (error) { toast.error(error.message || "Could not copy client logs"); }
});
elements.settingsClientLogsClearButton.addEventListener("click", () => window.jointBobClientLogs?.clear());
window.addEventListener("joint-bob-client-logs-changed", () => {
  if (elements.settingsForm.dataset.tab === "logs") renderClientLogs();
});
elements.settingsLogoutButton.addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
    showSignedOut();
  } catch (error) {
    toast.error(error.message);
  }
});
document.querySelector("#settingsChangeEmailButton").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const input = document.querySelector("#settingsEmail");
  const status = document.querySelector("#settingsEmailStatus");
  if (!input.reportValidity()) return;
  button.disabled = true;
  status.textContent = "";
  try {
    const result = await api("/api/auth/email", { method: "PUT", body: JSON.stringify({ email: input.value.trim() }) });
    state.email = result.email;
    input.value = result.email;
    status.textContent = `Email changed to ${result.email}`;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
elements.settingsChangePasswordButton.addEventListener("click", async () => {
  const newPassword = elements.settingsNewPassword.value;
  if (newPassword !== elements.settingsNewPasswordRepeat.value) {
    toast.error("New passwords do not match");
    return;
  }
  try {
    await api("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword: elements.settingsCurrentPassword.value, newPassword }),
    });
    for (const input of [elements.settingsCurrentPassword, elements.settingsNewPassword, elements.settingsNewPasswordRepeat]) input.value = "";
    toast("Password changed");
  } catch (error) {
    toast.error(error.message);
  }
});
/* ---- Saving as you go ----
   The node's settings save through the request the Save settings button used to send; System AI
   through its own. Text saves after a pause in typing, numbers and paths when the field is left,
   everything else at once. */
autosave.channel("main", saveSettings);
autosave.channel("system-ai", saveSystemAiSettings);
// Terminal access has its own request (node-admin.js); it used to ride on Save settings too.
autosave.channel("terminal", saveChangedTerminalPolicy);
autosaveFields(document.querySelector('[data-testid="settings-terminal-policy"]'), "terminal");
// A routing configuration has its own Save button and is redrawn after every save, so an edit
// waits until you leave the configuration's section or Settings, as Save settings used to commit it.
autosave.channel("routing", saveDirtyRoutingConfig);
for (const type of ["input", "change", "choice-change"]) {
  document.querySelector("#routingConfigEditor").addEventListener(type, (event) => { if (!event.target.closest?.(".searchable-select-popover")) autosave.mark("routing"); });
}
document.addEventListener("routing-config-saved", () => autosave.settle("routing"));
const summaryFieldset = document.querySelector("#settingsSummaryWriter")?.closest("fieldset");
for (const field of elements.settingsForm.querySelectorAll(SAVE_WHEN_LEFT)) field.dataset.saveWhenLeft = "";
autosaveFields(elements.settingsForm, "main", { accept: (target) => settingsReady && target.matches(MAIN_FIELDS), askFirst: confirmDeletingMore });
// The activity summary, moved into System AI, saves on its own (summary-model-settings.js).
autosaveFields(document.querySelector("#settingsPanel-system-ai"), "system-ai", { accept: (target) => !summaryFieldset?.contains(target) && target.matches("input, select, textarea, .searchable-select-trigger") });
// Enter in a field, or a button without a type, submits the form: that saves now, and never closes Settings.
elements.settingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void autosave.flush();
});

const RETENTION_WORDS = {
  full: "older conversations that a project's list no longer shows",
  includeUnrecorded: "old transcripts that have no conversation record",
  includeScheduled: "old conversations started by schedules and webhooks",
  includeTickets: "old conversations of finished tickets",
  leftovers: "files left behind by conversations that were already deleted",
  backgroundRuns: "Joint Bob's own background-run transcripts after 7 days",
};

/**
 * Deleting more conversations, or sooner, is asked first; No puts the allowed choice back. Until it
 * is allowed, saving sends the choice allowed before (see retentionToSave), so no other save sends it.
 */
async function confirmDeletingMore(target) {
  const days = document.querySelector("#settingsConversationRetentionDays");
  const widens = target.matches("[data-retention-scope]") ? target.checked && !savedRetention.scope[target.dataset.retentionScope]
    : target === days ? Number(days.value) > 0 && Number(days.value) < Number(savedRetention.days) : false;
  if (!widens) return true;
  const what = target === days ? `conversations with no activity for ${Number(days.value).toLocaleString()} days` : RETENTION_WORDS[target.dataset.retentionScope];
  const confirmed = await confirmAction({
    title: "Delete more conversations?",
    message: `From the next hourly check this machine deletes ${what}, on every node. If you are not sure, choose Cancel and use Show what would be deleted first.`,
    confirmLabel: "Delete them",
    destructive: true,
  });
  if (confirmed) {
    if (target === days) savedRetention.days = Number(days.value);
    else savedRetention.scope[target.dataset.retentionScope] = true;
    return true;
  }
  if (target === days) days.value = savedRetention.days;
  else { target.checked = false; syncRetentionScope(); }
  return false;
}

/** The retention choices a save may send: fewer deletions at once, more only once allowed. */
function retentionToSave() {
  const days = Number(document.querySelector("#settingsConversationRetentionDays").value);
  const scope = retentionScopeValue();
  for (const [box, ticked] of Object.entries(scope)) if (ticked && !savedRetention.scope[box]) scope[box] = false;
  return { days: savedRetention.days && days < savedRetention.days ? savedRetention.days : days, scope };
}

// Leaving Settings saves what is still waiting; whatever cannot be saved is said in the workspace.
elements.settingsDialog.addEventListener("cancel", () => {
  if (elements.settingsDialog.contains(document.activeElement)) document.activeElement.blur();
});
elements.settingsDialog.addEventListener("close", () => {
  if (!autosave.pending) return;
  void autosave.flush().then((errors) => { for (const error of new Set(errors)) toast.error(`Settings not saved: ${error}`); });
});
