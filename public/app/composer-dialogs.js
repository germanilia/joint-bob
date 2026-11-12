import { executeComposerCommand, LOCAL_COMMANDS } from "../composer-commands.js";
import { api } from "./api.js";
import { openByTheWay } from "./by-the-way.js";
import { sendSocket } from "./chat-controls.js";
import { setInputValue } from "./composer.js";
import { markedText } from "./choice-popover.js";
import { elements } from "./elements.js";
import { rankChoices } from "./fuzzy.js";
import { attachDigitShortcuts, isRowSelectorQuery, LIST_SHORTCUT_LIMIT, shortcutIndexBadge } from "./list-shortcuts.js";
import { brandIcon } from "./icons.js";
import { normalizedQuery } from "./layout.js";
import { toast } from "./shell.js";
import { state } from "./state.js";

// Opus is pinned to the explicit Opus 5 id so the CLI's "opus" alias cannot
// drift to an older release.
export const CLAUDE_MODEL_OPTIONS = [];
export const PI_MODEL_PROVIDERS = [];

export function syncModelButton() {
  const auto = state.routing?.active && state.routing.mode === "auto";
  const active = state.models.find((model) => `${model.provider}/${model.id}` === state.activeModelKey);
  elements.modelButtonName.textContent = active?.label || state.activeModelLabel || "Model";
  elements.modelAutoLabel.hidden = !auto;
  elements.modelButton.classList.toggle("auto", auto);
  elements.modelButton.title = auto ? "Auto evaluator active: the classifier picks the model and reasoning for each prompt" : "";
  if (elements.modelDialog.open) renderModelDialog();
}

/** Rows 1-10 carry a digit shortcut, in the order this render lists them. */
let modelShortcuts = [];
let queuedModelSelection = null;
let routingClassifiersRequest = null;

export async function loadRoutingClassifiers() {
  if (state.routingClassifiers) return state.routingClassifiers;
  if (routingClassifiersRequest) return routingClassifiersRequest;
  routingClassifiersRequest = api("/api/routing-configs")
    .then((body) => { state.routingClassifiers = Array.isArray(body.classifiers) ? body.classifiers : []; })
    .catch((error) => { toast.error(error.message); state.routingClassifiers = []; })
    .then(() => state.routingClassifiers)
    .finally(() => { routingClassifiersRequest = null; });
  return routingClassifiersRequest;
}

/** Saves a new classifier choice onto this node's active routing configuration.
    Only the configuration's originating node can change a shared one. */
async function saveRoutingClassifier(classifierId) {
  try {
    const configId = state.routing?.configId;
    if (!configId) throw new Error("No routing configuration is active on this node");
    const body = await api("/api/routing-configs");
    const config = (body.configs ?? []).find((entry) => entry.id === configId);
    if (!config) throw new Error("The active routing configuration is gone");
    if (!config.mine) throw new Error("Only the node that created this configuration can change it");
    const saved = await api(`/api/routing-configs/${configId}`, { method: "PUT", body: JSON.stringify({ name: config.name, policy: { ...config.policy, classifierId } }) });
    if (!saved.config) throw new Error("Saving the classifier failed");
    state.routing = { ...state.routing, classifierId };
    toast("Classifier updated");
  } catch (error) {
    toast.error(error.message);
  } finally {
    if (elements.modelDialog.open) renderModelDialog();
  }
}

export function openQueuedModelPicker(activeKey, onSelect) {
  const model = state.models.find((candidate) => `${candidate.provider}/${candidate.id}` === activeKey);
  queuedModelSelection = { activeKey, onSelect, harness: model?.harnessId || state.engine };
  renderModelDialog();
  elements.modelDialog.showModal();
}

export function queuedReasoningLevels(provider, modelId) {
  const model = state.models.find((candidate) => candidate.provider === provider && candidate.id === modelId);
  if (!model) return null;
  const descriptor = state.harnesses.find(({ id }) => id === model.harnessId);
  return model.thinkingLevels || descriptor?.configuration.thinkingLevels || null;
}

function renderQueuedModels() {
  const selection = queuedModelSelection;
  const harnessLabel = document.createElement("label");
  harnessLabel.textContent = "Harness ";
  const harness = document.createElement("select");
  harness.dataset.testid = "queued-message-harness-select";
  for (const option of state.harnesses) harness.add(new Option(option.label, option.id));
  harness.value = selection.harness;
  harness.addEventListener("change", () => {
    selection.harness = harness.value;
    renderModelDialog();
    elements.modelDialogList.querySelector("select").focus();
  });
  harnessLabel.append(harness);
  elements.modelDialogList.append(harnessLabel);
  const available = state.models.filter((model) => model.harnessId === selection.harness);
  const models = [{ provider: "", id: "", label: "Inherit conversation settings" }, ...available];
  elements.modelDialogTitle.textContent = "Queued message harness and model";
  for (const model of models) elements.modelDialogList.append(modelOptionButton({
    key: `${model.provider}/${model.id}`, label: model.label,
    active: selection.activeKey === `${model.provider}/${model.id}`,
    onSelect: () => selection.onSelect(model.provider ? model : null),
  }));
  if (!available.length) {
    const empty = document.createElement("span");
    empty.className = "model-shortcuts-empty";
    empty.textContent = "No configured models for this harness";
    elements.modelDialogList.append(empty);
  }
}

elements.modelDialog.addEventListener("close", () => { queuedModelSelection = null; });

function modelOptionButton({ key, label, active, onSelect }) {
  const option = document.createElement("button");
  option.type = "button";
  option.className = "model-option";
  option.dataset.modelKey = key;
  option.dataset.testid = `model-option-${key.replace(/[^a-z0-9.-]+/gi, "-")}`;
  option.classList.toggle("active", active);
  if (modelShortcuts.length < LIST_SHORTCUT_LIMIT) {
    modelShortcuts.push(onSelect);
    option.append(shortcutIndexBadge("model-option-index", modelShortcuts.length));
  }
  option.append(document.createTextNode(label));
  option.addEventListener("click", () => {
    onSelect();
    elements.modelDialog.close();
  });
  return option;
}

function skillInvocation(skill) {
  return skill.invocation || `/${skill.name} `;
}

/** Rows 1-10 carry a digit shortcut; a filtered list renumbers on every keystroke. */
let skillShortcuts = [];

function chooseSkill(skill) {
  const invocation = skillInvocation(skill);
  elements.skillsDialog.close();
  elements.messageInput.value = invocation;
  elements.messageInput.focus();
  elements.messageInput.setSelectionRange(invocation.length, invocation.length);
}

function renderSkillsDialog() {
  elements.skillsDialogList.replaceChildren();
  skillShortcuts = [];
  if (state.skillsLoading) {
    const loading = document.createElement("span");
    loading.className = "model-shortcuts-empty";
    loading.textContent = "Loading skills…";
    elements.skillsDialogList.append(loading);
    return;
  }

  const typed = elements.skillsDialogSearchInput.value || "";
  const query = isRowSelectorQuery(typed) ? "" : normalizedQuery(typed);
  const matches = state.skills
    .filter((skill) => skill.harness === state.engine)
    .filter((skill) => !query || `${skill.name}\n${skill.description}`.toLowerCase().includes(query));

  if (!matches.length) {
    const empty = document.createElement("span");
    empty.className = "model-shortcuts-empty";
    empty.textContent = query ? "No matching skills." : "No skills installed for this agent.";
    elements.skillsDialogList.append(empty);
    return;
  }

  for (const skill of matches) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "skill-option";
    option.dataset.testid = "skill-option";
    if (skillShortcuts.length < LIST_SHORTCUT_LIMIT) {
      skillShortcuts.push(skill);
      option.append(shortcutIndexBadge("skill-option-index", skillShortcuts.length));
    }
    const name = document.createElement("strong");
    name.textContent = skill.name;
    if (skill.scope === "project") {
      const scope = document.createElement("em");
      scope.className = "skill-option-scope";
      scope.textContent = "project";
      name.append(" ", scope);
    }
    const description = document.createElement("span");
    description.className = "skill-option-description";
    description.textContent = skill.description;
    option.append(name, description);
    option.addEventListener("click", () => chooseSkill(skill));
    elements.skillsDialogList.append(option);
  }
}

let skillRequestGeneration = 0;
let pendingSkillScope;
const skillContext = () => ({ projectId: state.activeConversationProjectId || state.activeProjectId, conversationId: state.activeConversationId || state.activeSessionId || undefined });

export async function loadSkills(force = false) {
  const context = skillContext();
  const { projectId, conversationId } = context;
  const scope = JSON.stringify(context);
  if (!projectId) {
    skillRequestGeneration++;
    pendingSkillScope = undefined;
    state.skills = [];
    state.skillsLoading = false;
    state.skillsProjectId = null;
    state.skillsConversationId = null;
    return;
  }
  if ((!force && state.skillsProjectId === projectId && state.skillsConversationId === conversationId) || pendingSkillScope === scope) return;
  const request = ++skillRequestGeneration;
  pendingSkillScope = scope;
  state.skills = [];
  state.skillsLoading = true;
  renderSkillsDialog();
  try {
    const params = new URLSearchParams();
    if (conversationId) params.set("conversationId", conversationId);
    const body = await api(`/api/projects/${encodeURIComponent(projectId)}/skills?${params}`);
    if (request !== skillRequestGeneration || JSON.stringify(skillContext()) !== scope) return;
    state.skills = body.skills;
    state.skillsProjectId = projectId;
    state.skillsConversationId = conversationId;
  } catch (error) {
    if (request === skillRequestGeneration && JSON.stringify(skillContext()) === scope) {
      state.skills = [];
      state.skillsProjectId = null;
      state.skillsConversationId = null;
      toast.error(error.message);
    }
  } finally {
    if (request === skillRequestGeneration) {
      pendingSkillScope = undefined;
      state.skillsLoading = false;
      renderSkillsDialog();
      renderCommandAutocomplete();
    }
  }
}

async function openSkillsDialog() {
  elements.skillsDialogSearchInput.value = "";
  elements.skillsDialog.showModal();
  renderSkillsDialog();
  await loadSkills(true);
  if (elements.skillsDialog.open) elements.skillsDialogSearchInput.focus();
}

/** A digit toggles that tool row, exactly as clicking its checkbox does. */
let toolShortcuts = [];

function toolOption(tool) {
  const label = document.createElement("label");
  label.className = "tool-option";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = tool.active;
  checkbox.disabled = state.sessionBusy;
  checkbox.dataset.testid = "tools-dialog-tool-toggle";
  checkbox.addEventListener("change", () => {
    const toolNames = state.tools
      .filter((candidate) => candidate.name === tool.name ? checkbox.checked : candidate.active)
      .map((candidate) => candidate.name);
    if (!sendSocket({ type: "setTools", toolNames })) {
      checkbox.checked = !checkbox.checked;
      toast.error("Conversation is not connected yet");
      return;
    }
    state.toolsLoading = true;
    renderToolsDialog();
  });
  if (toolShortcuts.length < LIST_SHORTCUT_LIMIT) {
    toolShortcuts.push(checkbox);
    label.append(shortcutIndexBadge("tool-option-index", toolShortcuts.length));
  }
  const copy = document.createElement("span");
  const name = document.createElement("strong");
  name.textContent = tool.name;
  const description = document.createElement("span");
  description.className = "tool-option-description";
  description.textContent = tool.description;
  copy.append(name, description);
  label.append(checkbox, copy);
  return label;
}

export function renderToolsDialog() {
  elements.toolsDialogList.replaceChildren();
  toolShortcuts = [];
  if (state.toolsLoading) {
    const loading = document.createElement("span");
    loading.className = "model-shortcuts-empty";
    loading.textContent = "Loading tools…";
    elements.toolsDialogList.append(loading);
    return;
  }
  if (!state.tools.length) {
    const empty = document.createElement("span");
    empty.className = "model-shortcuts-empty";
    empty.textContent = "Tools have not been reported for this session yet.";
    elements.toolsDialogList.append(empty);
    return;
  }
  for (const tool of state.tools) elements.toolsDialogList.append(toolOption(tool));
}

function openToolsDialog() {
  state.tools = [];
  state.toolsLoading = true;
  elements.toolsDialog.showModal();
  renderToolsDialog();
  if (!sendSocket({ type: "tools" })) {
    state.toolsLoading = false;
    renderToolsDialog();
    toast.error("Conversation is not connected yet");
  }
}

function openModelDialog() {
  queuedModelSelection = null;
  renderModelDialog();
  elements.modelDialog.showModal();
}

export function composerCommandHandlers() {
  return {
    help: () => {
      setInputValue("/");
      elements.messageInput.focus();
      renderCommandAutocomplete();
    },
    skills: () => {
      setInputValue("");
      void openSkillsDialog();
    },
    model: () => {
      setInputValue("");
      openModelDialog();
    },
    tools: () => {
      setInputValue("");
      openToolsDialog();
    },
    compact: (instructions) => {
      setInputValue("");
      if (!sendSocket({ type: "compact", message: instructions })) {
        toast.error("Conversation is not connected yet");
        return;
      }
      toast("Compacting conversation…");
    },
    bobRestart: () => {
      setInputValue("");
      if (!sendSocket({ type: "restart" })) {
        toast.error("Conversation is not connected yet");
        return;
      }
      toast("Restarting harness…");
    },
    bobBtw: () => {
      setInputValue("");
      void openByTheWay();
    },
  };
}

function commandSourceKey() {
  return JSON.stringify({ ...skillContext(), harness: state.engine });
}

let commandRequestGeneration = 0;
let pendingCommandKey;
async function loadCommands() {
  const { projectId, conversationId } = skillContext();
  const harness = state.engine;
  const key = commandSourceKey();
  if (!projectId || pendingCommandKey === key || state.commandsKey === key) return;
  const request = ++commandRequestGeneration;
  pendingCommandKey = key;
  state.commandsLoading = true;
  try {
    const params = new URLSearchParams({ harness });
    if (conversationId) params.set("conversationId", conversationId);
    const body = await api(`/api/projects/${encodeURIComponent(projectId)}/commands?${params}`);
    if (request !== commandRequestGeneration || commandSourceKey() !== key) return;
    state.commands = body.commands;
    state.commandsKey = key;
  } catch (error) {
    if (request === commandRequestGeneration && commandSourceKey() === key) {
      state.commands = [];
      state.commandsKey = key;
      toast.error(error.message);
    }
  } finally {
    if (request === commandRequestGeneration) {
      pendingCommandKey = undefined;
      state.commandsLoading = false;
      renderCommandAutocomplete();
    }
  }
}

function slashCommandQuery() {
  const { selectionStart, selectionEnd, value } = elements.messageInput;
  if (selectionStart !== selectionEnd || selectionEnd !== value.length) return null;
  const match = /^\/([^\s]*)$/.exec(value);
  return match ? match[1].toLowerCase() : null;
}


export function hideCommandAutocomplete() {
  state.commandSuggestions = [];
  state.commandAutocompleteIndex = 0;
  elements.commandAutocomplete.hidden = true;
  elements.messageInput.setAttribute("aria-expanded", "false");
  elements.messageInput.removeAttribute("aria-activedescendant");
}

export function commandAutocompleteOpen() {
  return !elements.commandAutocomplete.hidden && state.commandSuggestions.length > 0;
}

export function selectCommandSuggestion(index = state.commandAutocompleteIndex) {
  const suggestion = state.commandSuggestions[index];
  if (!suggestion) return;
  hideCommandAutocomplete();
  if (suggestion.reference) { insertFileReference(suggestion); return; }
  if (!executeComposerCommand(suggestion.invocation, composerCommandHandlers())) {
    setInputValue(suggestion.invocation);
    elements.messageInput.focus();
  }
}

// "@" followed by a path names a project file. The list walks one folder at a time with the
// file browser's own listing: what comes after the last "/" is matched loosely against that
// folder's entries, and choosing a folder steps into it.
const folderListings = new Map();

function fileReferenceQuery() {
  const { selectionStart, selectionEnd, value } = elements.messageInput;
  if (!state.activeProjectId || selectionStart !== selectionEnd) return null;
  const match = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, selectionEnd));
  if (!match) return null;
  const typed = match[1];
  const slash = typed.lastIndexOf("/");
  return { start: selectionEnd - typed.length - 1, end: selectionEnd, dir: slash < 0 ? "" : typed.slice(0, slash), leaf: typed.slice(slash + 1) };
}

function folderListingUrl(dir) {
  const url = new URL(`/api/projects/${encodeURIComponent(state.activeProjectId)}/files`, location.origin);
  url.searchParams.set("dir", dir);
  if (state.activeNodeId) url.searchParams.set("nodeId", state.activeNodeId);
  return `${url.pathname}${url.search}`;
}

/**
 * The folder's entries, or null while they first load; the list draws again when they arrive.
 * A listing older than half a minute is read again, so files the agent just wrote appear.
 */
function folderEntries(dir) {
  const key = folderListingUrl(dir);
  const listing = folderListings.get(key);
  if (listing && (listing.loading || Date.now() - listing.at < 30_000)) return listing.entries;
  const next = { entries: listing?.entries ?? null, at: Date.now(), loading: true };
  folderListings.set(key, next);
  api(key)
    .then((body) => { next.entries = body.entries; })
    .catch(() => { next.entries ??= []; })
    .finally(() => { next.loading = false; next.at = Date.now(); if (fileReferenceQuery()) renderCommandAutocomplete(); });
  return next.entries;
}

function insertFileReference(suggestion) {
  const { value } = elements.messageInput;
  const token = `@${suggestion.path}${suggestion.directory ? "/" : " "}`;
  const caret = suggestion.start + token.length;
  setInputValue(`${value.slice(0, suggestion.start)}${token}${value.slice(suggestion.end)}`);
  elements.messageInput.setSelectionRange(caret, caret);
  elements.messageInput.focus();
  if (suggestion.directory) renderCommandAutocomplete();
}

function commandRows(query) {
  if (state.activeProjectId && state.commandsKey !== commandSourceKey()) void loadCommands();
  const commands = state.commandsKey === commandSourceKey()
    ? state.commands
    : LOCAL_COMMANDS.map((command) => ({ ...command, harness: state.engine }));
  // Names match loosely ("cmp" finds compact); descriptions must contain what was typed.
  return rankChoices(query, commands
    .filter((command) => command.harness === state.engine)
    .map((command) => ({ ...command, label: command.name, detail: command.description })))
    .slice(0, 10)
    .map(({ choice, hits }) => ({
      suggestion: choice,
      // A command typed as its own name shows which letters matched; any other form is shown as it is typed.
      name: choice.invocation.trim() === `/${choice.name}` ? ["/", markedText(choice.name, hits)] : [choice.invocation.trim()],
      description: choice.description,
    }));
}

function fileRows(reference) {
  const entries = folderEntries(reference.dir);
  if (!entries) return [];
  // Hidden files appear once a "." is typed.
  const visible = entries.filter((entry) => reference.leaf.startsWith(".") || !entry.name.startsWith("."));
  return rankChoices(reference.leaf, visible.map((entry) => ({ ...entry, label: entry.name, value: entry.name })))
    .slice(0, 10)
    .map(({ choice, hits }) => ({
      suggestion: { reference: true, path: choice.path, directory: choice.type === "directory", start: reference.start, end: reference.end },
      name: [markedText(choice.name, hits), choice.type === "directory" ? "/" : ""],
      description: choice.type === "directory" ? "Folder" : "File",
    }));
}

export function renderCommandAutocomplete() {
  if (elements.messageInput.disabled) { hideCommandAutocomplete(); return; }
  const query = slashCommandQuery();
  const reference = query === null ? fileReferenceQuery() : null;
  const rows = query !== null ? commandRows(query) : reference ? fileRows(reference) : [];
  state.commandSuggestions = rows.map((row) => row.suggestion);
  if (!rows.length) {
    hideCommandAutocomplete();
    return;
  }

  state.commandAutocompleteIndex = Math.min(state.commandAutocompleteIndex, state.commandSuggestions.length - 1);
  elements.commandAutocomplete.replaceChildren();
  rows.forEach((row, index) => {
    const option = document.createElement("button");
    option.type = "button";
    option.id = `command-autocomplete-option-${index}`;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(index === state.commandAutocompleteIndex));
    option.dataset.testid = row.suggestion.reference ? "chat-file-autocomplete-option" : "chat-command-autocomplete-option";
    const name = document.createElement("span");
    name.className = "command-autocomplete-name";
    name.append(...row.name);
    const description = document.createElement("span");
    description.className = "command-autocomplete-description";
    description.textContent = row.description;
    option.append(name, description);
    option.addEventListener("pointerdown", (event) => event.preventDefault());
    option.addEventListener("click", () => selectCommandSuggestion(index));
    elements.commandAutocomplete.append(option);
  });
  elements.commandAutocomplete.hidden = false;
  elements.messageInput.setAttribute("aria-expanded", "true");
  elements.messageInput.setAttribute("aria-activedescendant", `command-autocomplete-option-${state.commandAutocompleteIndex}`);
  elements.commandAutocomplete.children[state.commandAutocompleteIndex]?.scrollIntoView({ block: "nearest" });
}

export function renderReasoningOptions() {
  const hasLevels = state.availableThinkingLevels.length > 0;
  const auto = state.routing?.active && state.routing.mode === "auto";
  elements.chatModeLabel.textContent = "Reasoning";
  elements.reasoningLevelSelect.replaceChildren();
  for (const level of state.availableThinkingLevels) {
    const option = document.createElement("option");
    option.value = level;
    option.textContent = level;
    elements.reasoningLevelSelect.append(option);
  }
  elements.reasoningLevelSelect.value = state.thinkingLevel;
  elements.chatModeControl.hidden = !hasLevels;
  // Bob auto owns the reasoning level; the picker stays visible but locked.
  elements.reasoningLevelSelect.disabled = auto;
  elements.chatModeLabel.textContent = auto ? "Reasoning (Bob auto)" : "Reasoning";
}

export function changeReasoningLevel(event) {
  const level = event.currentTarget.value;
  if (!sendSocket({ type: "setThinking", level })) toast.error("Not connected");
}

function appendModel(model) {
  elements.modelDialogList.append(modelOptionButton({
    key: `${model.provider}/${model.id}`, label: model.label,
    active: state.activeModelKey === `${model.provider}/${model.id}`,
    onSelect: () => { if (!sendSocket({ type: "setModel", provider: model.provider, modelId: model.id })) toast.error("Not connected"); },
  }));
}

function renderModelDialog() {
  const descriptor = state.harnesses.find(({ id }) => id === state.engine);
  const models = state.models.filter((model) => model.harnessId === state.engine);
  elements.modelDialogTitle.textContent = `${descriptor.label} model`;
  elements.modelDialogList.replaceChildren(); modelShortcuts = [];
  if (queuedModelSelection) { renderQueuedModels(); return; }
  if (state.routing?.active) {
    const autoActive = state.routing.mode === "auto";
    const autoRow = modelOptionButton({
      key: "bob-auto", label: "Bob auto", active: autoActive,
      onSelect: () => { if (!sendSocket({ type: "setModel", modelId: "bob-auto" })) toast.error("Not connected"); },
    });
    autoRow.dataset.testid = "model-option-bob-auto";
    autoRow.title = "The difficulty classifier picks the model and reasoning for each prompt";
    elements.modelDialogList.append(autoRow);
    // Under Bob auto, the scoring model itself is selectable here too. Changing the
    // choice edits this node's active configuration, so it is owner-gated.
    const classifierRow = document.createElement("label");
    classifierRow.className = "model-option routing-classifier-option";
    classifierRow.dataset.testid = "routing-classifier-option";
    const classifierLabel = document.createElement("span");
    classifierLabel.textContent = "Classifier";
    const classifierSelect = document.createElement("select");
    classifierSelect.dataset.testid = "routing-classifier-dialog-select";
    const classifiers = state.routingClassifiers ?? [{ id: state.routing.classifierId, label: state.routing.classifierId }];
    for (const classifier of classifiers) classifierSelect.add(new Option(classifier.label || classifier.id, classifier.id));
    classifierSelect.value = state.routing.classifierId || classifiers[0]?.id || "";
    const editable = state.routing.editable !== false;
    classifierSelect.disabled = !editable;
    classifierSelect.title = editable ? "Changes this node's active routing configuration" : "Only the node that created this configuration can change the classifier";
    classifierSelect.addEventListener("change", () => { void saveRoutingClassifier(classifierSelect.value); });
    classifierSelect.addEventListener("click", (event) => event.stopPropagation());
    classifierRow.append(classifierLabel, classifierSelect);
    elements.modelDialogList.append(classifierRow);
    if (state.routingClassifiers === null) void loadRoutingClassifiers().then(() => { if (elements.modelDialog.open) renderModelDialog(); });
  }
  if (!models.length) {
    const empty = document.createElement("span"); empty.className = "model-shortcuts-empty"; empty.textContent = "No configured models"; elements.modelDialogList.append(empty); return;
  }
  const providers = [...new Set(models.map(({ provider }) => provider))];
  for (const provider of providers) {
    const providerModels = models.filter((candidate) => candidate.provider === provider);
    const presentation = providerModels[0];
    if (providers.length > 1 || presentation.providerLabel || presentation.providerIcon) {
      const heading = document.createElement("div");
      heading.className = "model-dialog-group";
      if (presentation.providerIcon) heading.append(brandIcon(presentation.providerIcon, "model-group-icon"));
      heading.append(document.createTextNode(presentation.providerLabel || provider));
      elements.modelDialogList.append(heading);
    }
    for (const model of providerModels) appendModel(model);
  }
}
elements.skillsDialogSearchInput.addEventListener("input", () => renderSkillsDialog());
elements.closeSkillsDialogButton.addEventListener("click", () => elements.skillsDialog.close());
elements.closeToolsDialogButton.addEventListener("click", () => elements.toolsDialog.close());
elements.modelButton.addEventListener("click", openModelDialog);
attachDigitShortcuts(elements.skillsDialog, () => skillShortcuts, (skill) => chooseSkill(skill));
attachDigitShortcuts(elements.toolsDialog, () => toolShortcuts, (checkbox) => checkbox.click());
attachDigitShortcuts(elements.modelDialog, () => modelShortcuts, (onSelect) => {
  onSelect();
  elements.modelDialog.close();
});
