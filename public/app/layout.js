import { savePreferencesInBackground } from "./api.js";
import { elements } from "./elements.js";
import { projectMatchesClusters, sessionMatchesClusters } from "./cluster-filters.js";
import { activateControlCenter } from "./control-center.js";
import { formatDate, toast } from "./shell.js";
import { state } from "./state.js";

export function shortSessionTitle(session) {
  // Pi names a session it could not title "Untitled Pi session"; any harness's untitled session reads the same.
  const title = session?.title || "Conversation";
  if (!session?.path) return title;
  if (title && !title.endsWith(".jsonl") && title !== "Untitled Pi session") return title;
  return `Conversation • ${formatDate(session.updatedAt || session.createdAt)}`;
}

/** The title as the list and chat header show it. Moves, recents and references keep the stored title. */
export function sessionDisplayTitle(session) {
  return shortSessionTitle({ ...session, title: session.displayTitle ?? session.title });
}

/**
 * The chat header must agree with the conversations list. Status updates and
 * sessionInfoChanged carry the engine's own live session name (for example a
 * generated one), which must not clobber a Joint Bob rename the list still shows.
 */
export function syncChatTitleFromSessions(engineName) {
  const session = state.sessions.find((item) => item.id === state.activeSessionId)
    || state.sessions.find((item) => item.path === state.activeSessionPath);
  elements.sessionTitle.textContent = session ? sessionDisplayTitle(session) : engineName;
}

/**
 * Desktop-only: the mobile layout already shows a single panel at a time, so the
 * body class simply narrows one grid column down to the rail width.
 */
export function setPanelCollapsed(panel, collapsed) {
  const panelElement = panel === "projects" ? elements.projectsPanel : elements.chatsPanel;
  document.body.classList.toggle(`${panel}-collapsed`, collapsed);
  panelElement.classList.toggle("collapsed", collapsed && !document.body.classList.contains("focus-ui"));
  if (!state.preferencesLoaded) return;
  if (panel === "projects") savePreferencesInBackground({ projectsPanelCollapsed: collapsed });
  else savePreferencesInBackground({ chatsPanelCollapsed: collapsed });
}

export function togglePanel(panel) {
  // Above the phone width the workspace's left column folds to a rail of icons (workspace.css).
  if (matchMedia("(max-width: 700px)").matches) return;
  setPanelCollapsed(panel, !document.body.classList.contains(`${panel}-collapsed`));
}

const MOBILE_VIEWS = ["projects", "sessions", "chat", "control"];

export function currentMobileView() {
  return MOBILE_VIEWS.find((name) => document.body.classList.contains(`view-${name}`)) ?? "projects";
}

/**
 * The app-wide control center key. It opens the control center from anywhere and puts the user
 * back in the view they left, so one key moves in both directions.
 */
export function toggleControlView() {
  if (currentMobileView() === "control") {
    setMobileView(state.viewBeforeControl || (state.activeProjectId ? "sessions" : "projects"));
    return;
  }
  setMobileView("control");
}

/** The view one level up: a conversation returns to its project's list, and the list and the control center to the projects. */
export function parentView(view) {
  // A conversation opened from the phone's Home goes back there (phone-ui.js sets the mark).
  if (view === "chat" && state.chatFromHome) return "projects";
  if (view === "chat") return state.activeProjectId ? "sessions" : "projects";
  if (view === "sessions" || view === "control") return "projects";
  return null;
}
function controlExitView() {
  return state.viewBeforeControl || (state.activeProjectId ? "sessions" : "projects");
}

// Back climbs one level and never leaves the app; it does not replay the places visited. History holds a stack of
// placeholder steps for Back to use up, and each tap or key press tops it up. Chrome's Back skips steps a page added
// without a tap or key press, so steps are added only during one. A phone keeps 20 steps, wider screens one.
const BACK_STEPS = matchMedia("(max-width: 700px)").matches ? 20 : 1;
let currentStep = history.state?.backStep ?? 0;

function refillBackSteps() {
  if (!navigator.userActivation.isActive) return;
  while (currentStep < BACK_STEPS) {
    currentStep += 1;
    history.pushState({ backStep: currentStep }, "");
  }
}
for (const type of ["pointerup", "keydown"]) document.addEventListener(type, refillBackSteps, true);

/**
 * What lies over the views takes Back before the views do, newest first: a list sheet, a menu sheet, a dialog (inside
 * Settings on a phone, a section first returns to the Settings list), then the phone's ⋯ sheet. Where the browser has
 * CloseWatcher (Android Chrome), Back goes to a dialog's or a sheet's own watcher and never reaches history, so
 * nothing here runs twice; this is what Back does in the others (iOS Safari), where it used to close all of Settings,
 * or leave the conversation under an open sheet. True when something closed.
 */
function closeTopLayer() {
  const sheet = [...document.querySelectorAll(".choice-scrim")].find((scrim) => !scrim.hidden);
  if (sheet) {
    // The scrim's own press handler closes the list and returns focus to its field.
    sheet.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    return true;
  }
  const menu = [...document.querySelectorAll("[popover]")].filter((popover) => popover.matches(":popover-open")).at(-1);
  if (menu) { menu.hidePopover(); return true; }
  const dialog = [...document.querySelectorAll("dialog[open]")].filter((open) => open.matches(":modal")).at(-1);
  // Signing in cannot be backed out of.
  if (dialog && dialog !== elements.loginDialog) {
    const form = dialog.querySelector("#settingsForm");
    if (form?.dataset.mobileView === "panel" && matchMedia("(max-width: 700px)").matches) { form.dataset.mobileView = "menu"; return true; }
    // As the browser's own close request: the dialog may refuse (an editor with unsaved text asks first).
    if (dialog.dispatchEvent(new Event("cancel", { cancelable: true }))) dialog.close();
    return true;
  }
  if (dialog) return true;
  const focusSheet = document.getElementById("focusControls");
  if (focusSheet && !focusSheet.hidden && document.body.classList.contains("focus-ui")) { document.getElementById("focusScrim")?.click(); return true; }
  return false;
}

function climbOneLevel() {
  if (closeTopLayer()) return;
  const parent = parentView(currentMobileView());
  if (parent) setMobileView(parent);
}

export function setMobileView(view) {
  if (state.keepControlView && view !== "control") return;
  if (view === "control" && currentMobileView() !== "control") state.viewBeforeControl = currentMobileView();
  if (state.preferencesLoaded) savePreferencesInBackground({ mobileView: view });

  document.body.classList.remove("view-projects", "view-sessions", "view-chat", "view-control");
  document.body.classList.add(`view-${view}`);
  for (const [name, navButton] of [
    ["projects", elements.navProjectsButton],
    ["sessions", elements.navSessionsButton],
    ["chat", elements.navChatButton],
  ]) {
    navButton.classList.toggle("active", name === view);
  }
  if (view === "control") activateControlCenter().catch((error) => toast.error(error.message));
  window.dispatchEvent(new CustomEvent("app-view-changed"));
}

window.addEventListener("popstate", () => {
  const wentBack = (history.state?.backStep ?? 0) < currentStep;
  currentStep = history.state?.backStep ?? 0;
  if (wentBack) climbOneLevel();
});

// Before the first tap there are no steps, so the first Back after opening the app would close it. Chrome lets a page
// hold one close watcher without a tap, and Back reaches it before history.
if (BACK_STEPS > 1 && "CloseWatcher" in window) new CloseWatcher().addEventListener("close", climbOneLevel);

export function selectedProject() {
  return state.projects.find((project) => project.id === state.activeProjectId) || null;
}

export function normalizedQuery(value) {
  return value.trim().toLowerCase();
}

export function sessionDisplayState(session) {
  if (session.turnRunning || (!session.backgroundRunning && (session.running || session.reviewState === "running"))) return "active";
  if (session.backgroundRunning) return "background";
  if (session.reviewState === "needs_review") return "review";
  return "done";
}

export function sessionChatState(session) {
  const display = sessionDisplayState(session);
  return display === "background" ? "active" : display;
}

/** A conversation the user closed out. Unrelated to the "done" status chip, which means reviewed. */
function isDoneConversation(session) {
  return Boolean(session.doneAt);
}

/** Project lists and badges share visibility, including saved settings for unopened projects. */
export function sessionIsVisible(session, projectId = state.activeProjectId) {
  const active = projectId === state.activeProjectId;
  const visibility = active
    ? { done: state.showDoneConversations, scheduled: state.showScheduledConversations }
    : state.projectConversationVisibility[projectId] || {};
  // Other projects' snapshots already exclude schedules hidden from history on the server.
  return (visibility.done === true || !isDoneConversation(session))
    && (!session.cronTaskId || (visibility.scheduled === true
      && (!active || (state.knownCronTaskIds.has(session.cronTaskId) && !state.hiddenCronTaskIds.has(session.cronTaskId)))));
}

function matchesClassification(session) {
  const value = session.classification ? `label:${session.classification}` : "unclassified";
  return !state.classificationFilters.size || state.classificationFilters.has(value);
}

/** Status chips combine: choosing Running and Needs review shows both. None chosen is All. */
function matchesChatFilters(session) {
  if (!state.chatFilters.size) return true;
  return [...state.chatFilters].some((filter) => filter === "cron" ? Boolean(session.cronTaskId) : sessionChatState(session) === filter);
}

export function updateChatFilterCounts() {
  const sessions = state.sessions.filter((session) => matchesClassification(session) && sessionMatchesClusters(session) && sessionIsVisible(session));
  const counts = { all: sessions.length, active: 0, review: 0, done: 0, cron: sessions.filter(session => session.cronTaskId).length };
  for (const session of sessions) counts[sessionChatState(session)] += 1;
  for (const count of elements.chatFilters.querySelectorAll("[data-filter-count]")) {
    count.textContent = counts[count.dataset.filterCount];
  }
}

export function filteredSessions() {
  const query = normalizedQuery(elements.sessionSearchInput.value || "");
  return state.sessions.filter((session) => {
    if (!matchesClassification(session) || !sessionMatchesClusters(session) || !sessionIsVisible(session)) return false;
    const searchableText = `${shortSessionTitle(session)}\n${session.firstMessage || ""}\n${session.path || ""}`.toLowerCase();
    if (query && !searchableText.includes(query)) return false;
    return matchesChatFilters(session);
  });
}

export function filteredProjects() {
  const query = normalizedQuery(elements.projectSearchInput.value || "");
  return state.projects.filter((project) => projectMatchesClusters(project)
    && (!query || `${project.name}\n${project.path}`.toLowerCase().includes(query)));
}

elements.navProjectsButton.addEventListener("click", () => setMobileView("projects"));
elements.navSessionsButton.addEventListener("click", () => setMobileView("sessions"));
elements.navChatButton.addEventListener("click", () => setMobileView("chat"));
elements.backToProjectsButton.addEventListener("click", () => setMobileView("projects"));
elements.backToSessionsButton.addEventListener("click", () => setMobileView(parentView("chat")));
elements.openControlCenterButton.addEventListener("click", () => setMobileView("control"));
const EXIT_PROMPT_MS = 3000;
let exitPromptTimer = null;

function hideExitPrompt() {
  clearTimeout(exitPromptTimer);
  elements.controlExitPrompt.hidden = true;
}

function leaveControlCenter() {
  hideExitPrompt();
  setMobileView(controlExitView());
}
elements.controlCenterCloseButton.addEventListener("click", leaveControlCenter);
elements.controlExitConfirm.addEventListener("click", leaveControlCenter);
// Esc twice is the quick way out, so one stray press does not leave: the first asks, the second leaves. It leaves typing in a
// field and open dialogs alone.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || currentMobileView() !== "control" || event.defaultPrevented) return;
  if (document.querySelector("dialog[open]") || event.target.closest?.("input, textarea, select")) return;
  if (!elements.controlExitPrompt.hidden) { leaveControlCenter(); return; }
  elements.controlExitPrompt.hidden = false;
  clearTimeout(exitPromptTimer);
  exitPromptTimer = setTimeout(hideExitPrompt, EXIT_PROMPT_MS);
});
elements.collapseProjectsButton.addEventListener("click", () => setPanelCollapsed("projects", true));

elements.expandProjectsButton.addEventListener("click", () => setPanelCollapsed("projects", false));
elements.collapseChatsButton.addEventListener("click", () => setPanelCollapsed("chats", true));
elements.expandChatsButton.addEventListener("click", () => setPanelCollapsed("chats", false));
