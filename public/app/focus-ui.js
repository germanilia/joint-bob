import { openDashboardMode } from "./dashboards.js";
import { elements } from "./elements.js";
import { menuIcon } from "./icons.js";
import { openRecentSessions } from "./recents.js";
import { setMobileView } from "./layout.js";
import { state } from "./state.js";
import { refreshRowMenuAnchor } from "./row-menu.js";
import { toast } from "./shell.js";
import { initializeMobileProjectControls, syncMobileProjectControls, mobileFocusViewport } from "./focus-project-controls.js";
import { installCreationGestures } from "./focus-creation-gestures.js";
import { createSearchableSelect } from "./searchable-select.js";
import { sendSocket } from "./chat-controls.js";
import { openConversationSecretPicker } from "./focus-secrets.js";
import { initializePhoneUi } from "./phone-ui.js";

const fab = document.querySelector("#focusControlsButton");
const menu = document.querySelector("#focusControls");
const chatHost = document.querySelector("#focusChatControls");
const context = document.querySelector("#focusContextActions");
const nodeList = document.querySelector("#focusNodeList");
const toolsList = document.querySelector("#focusToolsList");
const toolbarHome = document.createComment("Chat toolbar location");
let enabled = false;
let position = null;

// Toolbar actions the details sheet already offers on its own (the four panels, the two switches, Mark done and the
// places); "This conversation" lists every other one.
const TOOLS_SHOWN_ELSEWHERE = new Set([
  "autoRespondPill", "chatRecentSessionsButton", "chatRunningConversationsButton", "activityToggleButton", "autoRespondButton", "chatDoneButton",
  "chatFilesButton", "chatGitButton", "backgroundTasksButton", "notifyButton",
]);

// The control center is offered from every view, as a tile beside Costs and Settings. It has no markup of its own: it is the same target icon the toolbar uses.
const controlCenterTile = Object.assign(document.createElement("button"), { type: "button", id: "focusControl", textContent: "Bob" });
controlCenterTile.dataset.testid = "focus-control-center";
controlCenterTile.title = "Bob's chat and every agent that is running";
const controlCenterIcon = elements.openControlCenterButton.querySelector("svg").cloneNode(true);
controlCenterIcon.setAttribute("class", "focus-action-icon");
controlCenterTile.prepend(controlCenterIcon);
document.querySelector("#focusMore").append(controlCenterTile);

// Each action button lives in exactly one container, chosen by the view. Captured before any move.
const actionButtons = Object.fromEntries([
  "focusMarkDone", "focusAddSecret", "focusAutoRespond", "focusNotify", "focusActivity", "focusFiles", "focusGit", "focusTasks", "focusTools",
  "focusNewConversation", "focusNewNote", "focusRecents", "focusRunning", "focusReviews", "focusProjects", "focusConversations", "focusControl",
  "focusCosts", "focusSettings",
].map(id => [id, document.getElementById(id)]));
// Buttons that work in every view sit in the same place and order everywhere ("More"); a conversation adds its details
// above them. Tools is no longer a submenu: the conversation's tools are listed in the sheet (renderTools).
const PLACES = ["focusNewConversation", "focusNewNote", "focusConversations", "focusRecents", "focusRunning", "focusReviews", "focusProjects", "focusControl", "focusCosts", "focusSettings"];
const chatPlacement = {
  "#focusPanels": ["focusActivity", "focusFiles", "focusGit", "focusTasks"],
  "#focusSwitches": ["focusAutoRespond", "focusNotify"],
  "#focusDock": ["focusMarkDone"],
  "#focusMore": PLACES,
};
const viewPlacement = { "#focusPanels": [], "#focusSwitches": [], "#focusDock": [], "#focusMore": PLACES };

const harnessPicker = createSearchableSelect({ id: "focusHarness", testid: "focus-harness", label: "Harness", prompt: "Choose a harness", placeholder: "Search harnesses", emptyText: "No harnesses found" });
const modelPicker = createSearchableSelect({ id: "focusModel", testid: "focus-model", label: "Model", prompt: "Choose a model", placeholder: "Search models", emptyText: "No models found" });
const nodePicker = createSearchableSelect({ id: "focusNode", testid: "focus-node", optionTestid: "focus-node-option", label: "Runs on", prompt: "Choose a node", placeholder: "Search nodes", emptyText: "No nodes found" });
nodeList.append(nodePicker.root);
nodePicker.onChange(value => chooseSelectValue(elements.chatNodeSelect, value));
const effortPicker = createSearchableSelect({ id: "focusEffort", testid: "focus-effort", label: "Effort", prompt: "Choose an effort level", placeholder: "Search effort levels", emptyText: "No effort levels found" });
document.querySelector("#focusHarnessSelect").append(harnessPicker.root);
document.querySelector("#focusModelSelect").append(modelPicker.root);
document.querySelector("#focusEffortSelect").append(effortPicker.root);
harnessPicker.onChange(value => chooseSelectValue(elements.chatHarnessSelect, value));
effortPicker.onChange(value => chooseSelectValue(elements.reasoningLevelSelect, value));
function chooseModel(key) {
  const sent = key === BOB_AUTO.value
    ? sendSocket({ type: "setModel", modelId: "bob-auto" })
    : sendSocket({ type: "setModel", ...modelIdentity(key) });
  if (!sent) toast.error("Not connected");
}
modelPicker.onChange(chooseModel);

// The conversation's chips under its title: the same three choices as the sheet, one tap from the messages.
const chips = {
  harness: createSearchableSelect({ id: "phoneChipHarness", testid: "phone-chip-harness", label: "Agent", prompt: "Agent", placeholder: "Search agents", emptyText: "No agents found" }),
  model: createSearchableSelect({ id: "phoneChipModel", testid: "phone-chip-model", label: "Model", prompt: "Model", placeholder: "Search models", emptyText: "No models found" }),
  effort: createSearchableSelect({ id: "phoneChipEffort", testid: "phone-chip-effort", label: "Effort", prompt: "Effort", placeholder: "Search effort levels", emptyText: "No effort levels found" }),
  node: createSearchableSelect({ id: "phoneChipNode", testid: "phone-chip-node", label: "Runs on", prompt: "Machine", placeholder: "Search machines", emptyText: "No machines found" }),
};
document.querySelector("#phoneChips").append(chips.harness.root, chips.model.root, chips.effort.root, chips.node.root);
chips.harness.onChange(value => chooseSelectValue(elements.chatHarnessSelect, value));
chips.model.onChange(chooseModel);
chips.effort.onChange(value => chooseSelectValue(elements.reasoningLevelSelect, value));
chips.node.onChange(value => chooseSelectValue(elements.chatNodeSelect, value));

function currentView() {
  return ["projects", "sessions", "chat", "control"].find(view => document.body.classList.contains(`view-${view}`)) || "projects";
}
/** The sheet rises from the bottom (phone.css); nothing is positioned by hand. */
function placeMenu() {}
const viewPanel = { projects: "#projectsPanel", sessions: "#chatsPanel", chat: "#chatPanel", control: "#controlCenterPanel" };
/** Home (the projects view with the Inbox column) has its own top line; every other view has a top bar. */
const phoneHomeTop = document.querySelector("#phoneHomeTop");
function onHome() {
  return currentView() === "projects" && document.body.classList.contains("ws-column-inbox");
}
/** The ⋯ handle lives at the end of the current view's top bar, so it never covers messages or rows. */
function placeFab() {
  // Bob's page is his chat on a phone: its own head is the top bar.
  const bar = onHome() ? phoneHomeTop : currentView() === "control" ? document.querySelector("#controlChat > .control-chat-head")
    : document.querySelector(`${viewPanel[currentView()]} > :is(.panel-bar, .chat-topbar)`);
  fab.classList.add("in-bar");
  bar.append(fab);
}
const scrim = document.querySelector("#focusScrim");
function showMenu(show = menu.hidden) {
  if (!enabled) return;
  menu.hidden = !show;
  scrim.hidden = !show;
  fab.setAttribute("aria-expanded", String(show));
  if (show) { fab.hidden = false; syncQuickActionLabels(); syncMenuLayout(); menu.querySelector(".focus-context-scroll").scrollTop = 0; }
  else if (menu.contains(document.activeElement)) fab.focus();
}
const byId = id => document.getElementById(id);
/** In a conversation the sheet is its details; elsewhere the screen's own actions over the places. */
function syncMenuLayout() {
  delete menu.dataset.section;
  const inChat = currentView() === "chat";
  menu.dataset.kind = inChat ? "details" : "more";
  byId("focusBack").hidden = true;
  for (const id of ["focusPanels", "focusChatQuickActions", "focusSwitches", "focusDock", "focusToolsHeading"]) byId(id).hidden = !inChat;
  toolsList.hidden = !inChat;
  if (inChat) renderTools();
  byId("focusMore").hidden = false;
  byId("focusMoreHeading").textContent = inChat ? "More" : "Everywhere";
  const title = byId("focusContextTitle");
  const meta = byId("focusContextMeta");
  if (inChat) {
    title.textContent = elements.sessionTitle?.textContent?.trim() || "This conversation";
    const cost = byId("chatCostMeta");
    const context = byId("contextUsageText");
    meta.textContent = [byId("chatProjectName")?.textContent?.trim(), context?.textContent?.trim() && `${context.textContent.trim()} context`, cost && !cost.hidden && cost.textContent.trim()]
      .filter(Boolean).join(" · ");
  } else {
    title.textContent = { projects: onHome() ? "Inbox" : "Projects", sessions: "This project", chat: "This conversation", control: "Bob" }[currentView()];
    meta.textContent = "";
  }
  meta.hidden = !meta.textContent;
  syncPanels();
}
/** Git and Tasks show their counts as the desktop details do. */
function syncPanels() {
  const gitCount = byId("detailsGitCount");
  const tasksBadge = byId("backgroundTasksBadge");
  // The panel buttons are detached outside a conversation, so they are reached through actionButtons.
  const git = actionButtons.focusGit.querySelector(".focus-panel-count");
  git.hidden = !gitCount || gitCount.hidden || !gitCount.textContent.trim();
  git.textContent = git.hidden ? "" : gitCount.textContent.trim();
  const tasks = actionButtons.focusTasks.querySelector(".focus-panel-count");
  tasks.hidden = !tasksBadge || tasksBadge.hidden || !tasksBadge.textContent.trim();
  tasks.textContent = tasks.hidden ? "" : tasksBadge.textContent.trim();
}

/** One row per toolbar tool, built from the toolbar each time the sheet opens, after Add secret. */
function renderTools() {
  const targets = [...elements.chatToolbar.querySelectorAll(".chat-toolbar-actions button")]
    .filter(target => !target.hidden && !TOOLS_SHOWN_ELSEWHERE.has(target.id));
  toolsList.replaceChildren(actionButtons.focusAddSecret, ...targets.map(target => {
    const label = target.querySelector(".chat-action-label, .background-tasks-label");
    const icon = target.querySelector("svg").cloneNode(true);
    icon.setAttribute("class", "focus-action-icon");
    const button = proxyButton(label ? label.textContent : target.getAttribute("aria-label"), target, icon);
    button.dataset.testid = `focus-tool-${target.dataset.testid}`;
    if (target.hasAttribute("aria-pressed")) button.setAttribute("aria-pressed", target.getAttribute("aria-pressed"));
    const badge = target.querySelector(".background-tasks-badge:not([hidden])");
    if (badge) button.append(Object.assign(document.createElement("span"), { className: "focus-pending-badge", textContent: badge.textContent }));
    return button;
  }));
}

/** Moves each action button into the container for the current view. */
function placeActions() {
  const placement = currentView() === "chat" ? chatPlacement : viewPlacement;
  for (const [selector, ids] of Object.entries(placement)) {
    document.querySelector(selector).replaceChildren(...ids.map(id => actionButtons[id]));
  }
}
/** A menu button that closes the menu and clicks the real control, re-anchoring any row menu it opens to the handle. */
function proxyButton(label, target, icon) {
  const button = document.createElement("button");
  button.type = "button";
  button.append(icon, document.createTextNode(label));
  button.disabled = target.disabled;
  button.addEventListener("click", () => {
    showMenu(false);
    target.click();
    if (elements.rowMenu.matches(":popover-open")) {
      state.rowMenuAnchor = fab;
      state.rowMenuAnchorSelector = null;
      refreshRowMenuAnchor();
    }
  });
  return button;
}
function proxyAction(label, target, icon) {
  const button = proxyButton(label, target, menuIcon(icon));
  button.dataset.testid = `focus-action-${target.id}`;
  context.append(button);
}
/** Dashboard mode for the open project. */
function dashboardAction(target) {
  const button = document.createElement("button");
  button.type = "button";
  button.append(menuIcon("dashboard"), document.createTextNode("Dashboard"));
  button.dataset.testid = "focus-dashboard";
  button.addEventListener("click", () => {
    showMenu(false);
    openDashboardMode(target()).catch((error) => toast.error(error.message));
  });
  context.append(button);
}

function syncView() {
  if (!enabled) return;
  const view = currentView();
  showMenu(false);
  placeFab();
  placeActions();
  controlCenterTile.hidden = view === "control";
  document.querySelector("#focusConversations").disabled = !state.activeProjectId;
  syncMenuLayout();
  context.replaceChildren();
  if (view === "projects") proxyAction("New project", elements.newProjectButton, "folder");
  if (view === "sessions") {
    const rowMenu = document.querySelector(`[data-project-id="${CSS.escape(state.activeProjectId || "")}"] [data-testid="project-menu-button"]`);
    if (rowMenu) proxyAction("Project actions", rowMenu, "sliders");
    if (state.activeProjectId) dashboardAction(() => ({ kind: "project", id: state.activeProjectId, projectId: state.activeProjectId }));
  }
  if (state.activeProjectId && view === "projects") proxyAction("Project notes", document.querySelector("#projectNotesButton"), "file");
  if (view === "control") {
    // Bob's head keeps only his name and state on a phone; what it held is here, one row each.
    proxyAction(elements.controlChatMonitor.textContent === "Paused" ? "Restore Bob (paused)" : "Pause Bob (monitoring)", elements.controlChatMonitor, "sliders");
    proxyAction("Bob's settings", elements.controlChatSettingsButton, "sliders");
    const extra = (label, testid, target, icon) => {
      if (!target) return;
      const button = proxyButton(label, target, menuIcon(icon));
      button.dataset.testid = testid;
      context.append(button);
    };
    extra("Dashboards", "focus-action-dashboards", document.querySelector('[data-testid="control-phone-chip-dashboards"]'), "dashboard");
    extra("Shared team", "focus-action-team", document.querySelector('[data-testid="team-phone-open"]'), "folder");
  }
  syncQuickActionLabels();
}

export function syncQuickActionLabels() {
  if (!enabled) return;
  harnessPicker.setOptions(selectOptions(elements.chatHarnessSelect));
  harnessPicker.setValue(elements.chatHarnessSelect.value);
  harnessPicker.disabled = elements.chatHarnessSelect.disabled;
  modelPicker.setOptions(modelOptions());
  modelPicker.setValue(state.routing?.active && state.routing.mode === "auto" ? BOB_AUTO.value : state.activeModelKey);
  modelPicker.disabled = elements.modelButton.disabled;
  effortPicker.setOptions(selectOptions(elements.reasoningLevelSelect));
  effortPicker.setValue(elements.reasoningLevelSelect.value);
  effortPicker.disabled = elements.reasoningLevelSelect.disabled;
  nodePicker.setOptions(Array.from(elements.chatNodeSelect.options, option => ({ value: option.value, label: option.textContent, disabled: option.disabled })));
  nodePicker.setValue(elements.chatNodeSelect.value);
  nodePicker.disabled = elements.chatNodeSelect.disabled;
  // Chat-only buttons are detached outside a chat, so they are reached through actionButtons, not the document.
  actionButtons.focusMarkDone.querySelector("#focusMarkDoneLabel").textContent = elements.chatDoneButton.querySelector(".chat-action-label").textContent;
  actionButtons.focusMarkDone.disabled = elements.chatDoneButton.disabled;
  syncSwitches();
  for (const [picker, source] of [[chips.harness, harnessPicker], [chips.model, modelPicker], [chips.node, nodePicker]]) {
    picker.setOptions(source === modelPicker ? modelOptions() : source === harnessPicker ? selectOptions(elements.chatHarnessSelect)
      : Array.from(elements.chatNodeSelect.options, option => ({ value: option.value, label: option.textContent, disabled: option.disabled })));
    picker.setValue(source.value);
    picker.disabled = source.disabled;
  }
  // The effort chip shows only when the model has levels, like the toolbar's Reasoning; Bob auto locks it.
  chips.effort.setOptions(selectOptions(elements.reasoningLevelSelect));
  chips.effort.setValue(elements.reasoningLevelSelect.value);
  chips.effort.disabled = elements.reasoningLevelSelect.disabled;
  chips.effort.root.hidden = elements.chatModeControl.hidden;
}
/** The two "when it stops" switches show their toolbar buttons' state. */
function syncSwitches() {
  actionButtons.focusAutoRespond.setAttribute("aria-checked", String(elements.autoRespondButton.classList.contains("active")));
  actionButtons.focusAutoRespond.disabled = elements.autoRespondButton.disabled;
  actionButtons.focusNotify.setAttribute("aria-checked", String(elements.notifyButton.getAttribute("aria-pressed") === "true"));
  actionButtons.focusNotify.disabled = elements.notifyButton.disabled;
}
// The switches follow their toolbar buttons however those change (the toolbar is hidden on the phone).
new MutationObserver(syncSwitches).observe(elements.autoRespondButton, { attributes: true, attributeFilter: ["class", "disabled"] });
new MutationObserver(syncSwitches).observe(elements.notifyButton, { attributes: true, attributeFilter: ["aria-pressed", "disabled"] });

/** Sets a toolbar select and fires its change, so the toolbar's own handler does the work. */
function chooseSelectValue(select, value) {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}
function selectOptions(select) {
  return Array.from(select.options).filter(option => !option.disabled).map(option => ({ value: option.value, label: option.textContent }));
}
const BOB_AUTO = { value: "bob-auto", label: "Bob auto", detail: "The classifier picks the model and reasoning" };
/** Bob auto is offered whenever routing is on, as in the model dialog; its classifier stays in that dialog. */
function modelOptions() {
  const models = state.models
    .filter(model => model.harnessId === state.engine)
    .map(model => ({ value: `${model.provider}/${model.id}`, label: model.label, detail: model.providerLabel }));
  return state.routing?.active ? [BOB_AUTO, ...models] : models;
}
function modelIdentity(key) {
  const model = state.models.find(candidate => `${candidate.provider}/${candidate.id}` === key);
  return { provider: model.provider, modelId: model.id };
}
/** Layout only: never reload a session or change the user's panel-collapse preferences.
 *  Mobile screens always use the focus interface; desktops keep the classic layout. */
export function applyFocusUi() {
  enabled = mobileFocusViewport.matches;
  document.body.classList.toggle("focus-ui", enabled);
  syncMobileProjectControls();
  fab.hidden = !enabled;
  menu.hidden = true;
  for (const [name, panel] of [["projects", elements.projectsPanel], ["chats", elements.chatsPanel]]) {
    panel.classList.toggle("collapsed", !enabled && document.body.classList.contains(`${name}-collapsed`));
  }
  if (enabled) {
    if (!toolbarHome.isConnected) elements.chatToolbar.before(toolbarHome);
    chatHost.append(elements.chatToolbar);
    syncView();
    resize();
  } else {
    if (toolbarHome.isConnected) toolbarHome.replaceWith(elements.chatToolbar);
    elements.chatMoreMenu.removeAttribute("open");
    fab.classList.remove("in-bar");
    menu.before(fab);
  }
}

function move(x, y) {
  if (fab.classList.contains("in-bar")) return placeMenu();
  const height = visualViewport?.height || innerHeight;
  position = { x: Math.max(12, Math.min(x, innerWidth - fab.offsetWidth - 12)), y: Math.max(12, Math.min(y, height - fab.offsetHeight - 12)) };
  Object.assign(fab.style, { left: `${position.x}px`, top: `${position.y}px`, right: "auto", bottom: "auto" });
  placeMenu();
}
function resize() {
  if (!enabled) return;
  document.documentElement.style.setProperty("--focus-height", `${visualViewport?.height || innerHeight}px`);
  if (position && !fab.hidden) move(position.x, position.y);
  placeMenu();
}
function toggleFab() {
  const hide = !fab.hidden;
  showMenu(false);
  fab.hidden = hide;
  if (!hide) resize();
}
export function initializeFocusUi({ openSettings, startConversation, createNote, inspectReviews, inspectRunning }) {
  const settings = () => { showMenu(false); openSettings().catch(error => toast.error(error.message)); };
  const start = () => { showMenu(false); startConversation().catch(error => toast.error(error.message)); };
  document.querySelector("#focusSettings").onclick = settings;
  document.querySelector("#focusNewConversation").onclick = start;
  document.querySelector("#conversationSearchCreateButton").onclick = start;
  decorateControls();
  actionButtons.focusMarkDone.onclick = () => { showMenu(false); elements.chatDoneButton.click(); };
  actionButtons.focusAddSecret.onclick = () => { showMenu(false); openConversationSecretPicker().catch(error => toast.error(error.message)); };
  actionButtons.focusAutoRespond.onclick = () => { showMenu(false); elements.autoRespondButton.click(); };
  actionButtons.focusActivity.onclick = () => { showMenu(false); elements.activityToggleButton.click(); };
  // Files, Git and Tasks open today's full screens, as the desktop details' summaries do.
  for (const [id, target] of [["focusFiles", "chatFilesButton"], ["focusGit", "chatGitButton"], ["focusTasks", "backgroundTasksButton"], ["focusNotify", "notifyButton"]]) {
    actionButtons[id].onclick = () => { showMenu(false); document.getElementById(target).click(); };
  }
  // Tools is listed in the sheet now; its old button scrolls there for anyone who still reaches it.
  actionButtons.focusTools.onclick = (event) => { event.stopPropagation(); syncMenuLayout(); toolsList.scrollIntoView({ block: "start" }); };
  document.querySelector("#focusBack").onclick = backToControls;
  scrim.addEventListener("click", () => showMenu(false));
  for (const [id, action] of [["focusNewNote", createNote], ["focusRecents", openRecentSessions], ["focusReviews", inspectReviews], ["focusRunning", inspectRunning]]) {
    document.getElementById(id).onclick = () => { showMenu(false); Promise.resolve().then(action).catch(error => toast.error(error.message)); };
  }
  document.querySelector("#focusProjects").onclick = () => {
    window.dispatchEvent(new CustomEvent("workspace-place", { detail: { place: "projects" } }));
    setMobileView("projects");
  };
  controlCenterTile.onclick = () => { showMenu(false); setMobileView("control"); };
  document.querySelector("#focusConversations").onclick = () => setMobileView("sessions");
  document.querySelector("#focusClose").onclick = () => showMenu(false);
  chatHost.addEventListener("click", event => { if (!mobileFocusViewport.matches && event.target.closest("button:not(:disabled)")) showMenu(false); });
  window.addEventListener("app-view-changed", syncView);
  // Inbox and Projects share the projects view on the phone; the handle and the sheet follow the tab.
  window.addEventListener("workspace-column-changed", syncView);
  initializePhoneUi({ openSettings });
  mobileFocusViewport.addEventListener("change", applyFocusUi);
  window.addEventListener("resize", resize);
  visualViewport?.addEventListener("resize", resize);
  installFabDrag();
  initializeMobileProjectControls();
  installCreationGestures(start, () => document.querySelector("#focusNewNote").click());
  installTapGestures();
  installFocusKeys();
}

function backToControls() {
  syncMenuLayout();
  actionButtons.focusTools.focus();
}
function decorateControls() {
  // Only add icons to buttons that don't already have icons in the HTML.
  // Toolbar buttons (.chat-action) already have .chat-toolbar-icon; skip them.
  for (const [id, icon] of Object.entries({
    focusBack: "back", focusClose: "close",
    focusNewConversation: "chat", focusNewNote: "pencil", focusRecents: "clock", focusReviews: "archive", focusRunning: "play",
    focusProjects: "folder", focusConversations: "chat", focusSettings: "sliders", focusAddSecret: "key",
  })) {
    const svg = menuIcon(icon);
    svg.classList.add("focus-action-icon");
    document.getElementById(id).prepend(svg);
  }
}

function installFabDrag() {
  let drag = null, dragged = false;
  fab.addEventListener("pointerdown", event => {
    if (!event.isPrimary || event.button !== 0 || fab.classList.contains("in-bar")) return;
    const rect = fab.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    dragged = false;
    fab.setPointerCapture(event.pointerId);
  });
  fab.addEventListener("pointermove", event => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (Math.hypot(dx, dy) > 7) dragged = true;
    if (dragged) move(drag.left + dx, drag.top + dy);
  });
  fab.addEventListener("pointerup", () => { drag = null; });
  fab.addEventListener("pointercancel", () => { drag = null; dragged = true; });
  fab.onclick = () => {
    if (dragged) { dragged = false; return; }
    showMenu();
  };
  fab.addEventListener("keydown", event => {
    const delta = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[event.key];
    if (!delta) return;
    event.preventDefault();
    const rect = fab.getBoundingClientRect();
    move(rect.left + delta[0], rect.top + delta[1]);
  });
}

// Delay gesture controls only; editors need native activation to open mobile keyboards.
function installTapGestures() {
  let tap = null, sequence = null, timer = null, lastTouch = -Infinity;
  const controls = "button,input,textarea,select,a,summary,label,[contenteditable],[role=button],[data-tap]";
  const nativeControls = "input,textarea,select,label,[contenteditable],#sendButton,#browserPanel,.browser-viewer,.xterm";
  const clear = () => { clearTimeout(timer); tap = sequence = null; };
  const finish = () => {
    const completed = sequence;
    clear();
    if (!enabled || !completed) return;
    if (completed.count >= 4 && mobileFocusViewport.matches) document.querySelector("#focusRunning").click();
    else if (completed.count >= 3) { showMenu(false); openRecentSessions(); }
    else if (completed.count === 2 && !completed.target.closest(controls)) toggleFab();
    else activateTap(completed.target, controls, completed);
  };
  document.addEventListener("pointerdown", event => {
    if (!enabled || event.pointerType === "mouse") return;
    if (!event.isPrimary || event.target.closest(nativeControls)) { clear(); return; }
    const now = performance.now();
    if (sequence && (now - sequence.time > 350 || Math.hypot(event.clientX - sequence.x, event.clientY - sequence.y) > 32)) finish();
    clearTimeout(timer);
    tap = { id: event.pointerId, x: event.clientX, y: event.clientY, time: now, target: event.target };
    if (event.target.closest(controls)) event.preventDefault();
  }, true);
  document.addEventListener("pointerup", event => {
    if (!enabled || event.pointerType === "mouse" || !tap || tap.id !== event.pointerId) return;
    lastTouch = performance.now();
    if (Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 12 || lastTouch - tap.time > 350) { clear(); return; }
    sequence = { count: (sequence?.count || 0) + 1, target: tap.target, x: tap.x, y: tap.y, time: lastTouch };
    tap = null;
    timer = setTimeout(finish, 350);
  }, true);
  document.addEventListener("pointercancel", clear, true);
  document.addEventListener("click", event => {
    if (!enabled || !event.isTrusted || event.detail === 0 || event.target.closest(nativeControls)) return;
    if (event.pointerType ? event.pointerType === "mouse" : performance.now() - lastTouch > 700) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  document.addEventListener("dblclick", event => {
    if (enabled && !event.target.closest(nativeControls) && performance.now() - lastTouch < 700) event.preventDefault();
  }, true);
}
/** What makes a control the same one after its list was drawn again: its kind, its names and how its words begin. */
const tapIdentity = (control) => [control.tagName, control.id, control.dataset.testid ?? "", control.classList[0] ?? "", control.getAttribute("aria-label") ?? control.textContent.trim().slice(0, 24)].join("\n");

function activateTap(target, controls, at) {
  if (!target.isConnected) {
    // A tap waits 350 ms to see whether a second one follows. A list drawn again in that time (after a tab switch, a
    // refresh) took the tapped row with it and the tap was lost. It goes to the same control drawn again at that
    // place, and to nothing else: a list that moved must not send it to another row.
    const was = target.closest(controls);
    const now = at ? document.elementFromPoint(at.x, at.y)?.closest(controls) : null;
    if (!was || !now || tapIdentity(was) !== tapIdentity(now)) return;
    target = now;
  }
  const control = target.closest(controls);
  if (!control) { if (!menu.contains(target)) showMenu(false); return; }
  const input = control instanceof HTMLLabelElement ? control.control : control;
  if (!input || input.disabled) return;
  input.focus({ preventScroll: true });
  if (input instanceof HTMLSelectElement && typeof input.showPicker === "function") input.showPicker();
  else input.click();
}

/** Whether the Escape now being handled found a choice list open (the list closes itself before the event bubbles here). */
let choiceListOpen = false;
function installFocusKeys() {
  document.addEventListener("keydown", event => {
    choiceListOpen = event.key === "Escape" && Boolean(document.querySelector(".searchable-select-popover:not([hidden])"));
  }, true);
  document.addEventListener("pointerdown", event => {
    if (mobileFocusViewport.matches && event.target.closest("dialog")) return;
    if (enabled && event.pointerType === "mouse" && !menu.contains(event.target) && !fab.contains(event.target)) showMenu(false);
  });
  document.addEventListener("keydown", event => {
    if (!enabled || document.querySelector("dialog[open]")) return;
    if ((event.ctrlKey || event.metaKey) && event.key === ".") { event.preventDefault(); showMenu(); if (!menu.hidden) menu.querySelector("button")?.focus(); }
    if (event.key === "Escape") {
      // Escape closes only an open choice list first; the sheet waits for the next one.
      if (event.defaultPrevented || choiceListOpen) return;
      if (!menu.hidden && menu.dataset.section) backToControls();
      else showMenu(false);
    }
  });
}
