// The desktop workspace (wider than 700 px; the phone has its own layout, see focus-ui.js and phone-ui.js, and shows
// the same three groups on its Home: the projects view with the Inbox column).
//
// The left column is the navigation: brand and New, the workspace search, the places (Bob, Inbox,
// Projects, Board, Automations, Costs), then either the conversations that need you, run or wait for
// review in every project (Inbox), or the projects with the chosen project's conversations in a column beside them (Projects);
// Settings and the person at the bottom. Each group shows the rows that fit and "Show all" opens the
// group as one long list in the middle that scrolls (long-scroll.js). The column itself never scrolls.
//
// The conversation header keeps today's controls and ids; on the desktop a few of them move into
// the header's action slot and chip row (and back when the phone layout takes over), so every
// listener, shortcut and test id stays with its element. Docs: docs/superpowers/specs/2026-11-10-ui-redo-paper-design.md.

import { api } from "./api.js";
import { chordLabel, normalizeKeymap } from "../keymap.js";
import { openAppearance, themeLabel } from "./appearance.js";
import { currentControlView, showControlView } from "./control-views.js";
import { cardActionList, projectActionList } from "./control-cards.js";
import { isControlCenterOpen, openConversation, saveControlCenter } from "./control-center.js";
import { deleteConversations, folderOf, isHidden, isPinned, isStarred, togglePin, toggleStar } from "./control-marks.js";
import { endDrag, openMoveMenu, startDrag } from "./inbox-folders.js";
import { byUrgency, drawByFolder, drawByProject, kidCount, kidDepth, kidsFolded, modeSignature, nestRows, toggleKids } from "./inbox-modes.js";
import { openProjectMenu } from "./project-list.js";
import { openWorktreeDialog } from "./worktrees.js";
import { openContextReferencesDialog } from "./context-references.js";
import { showQuickNotes } from "./quick-notes.js";
import { openSessionAction, SESSION_ACTIONS } from "./session-list.js";
import { startConversationInProject } from "./new-session.js";
import { selectProject } from "./project-selection.js";
import { movesJobPanel } from "./control-moves.js";
import { chooseSnooze, snoozedWords, wakeCard } from "./control-snooze.js";
import { refreshSystemStrip, systemStrip } from "./inbox-system.js";
import { openInboxReply } from "./inbox-reply.js";
import { openRowMenu } from "./row-menu.js";
import { elements } from "./elements.js";
import { currentMobileView, setMobileView } from "./layout.js";
import { startGlobalConversation } from "./new-session.js";
import { createAutomationToggle, shownCard, createInboxToolbar, createProjectFilter, filterInbox, inChosenProjects, inboxFilterKey, inboxMode, inboxSignature, isSelected, isSelecting, onInboxView, setInboxMode, sourceName, toggleSelected } from "./inbox-filters.js";
import { drawChunked } from "./long-scroll.js";
import { openQuickNote } from "./quick-notes.js";
import { openSpotlight } from "./spotlight.js";
import { confirmAction, toast } from "./shell.js";
import { state } from "./state.js";

const desktop = matchMedia("(min-width: 701px)");
const COLUMN_KEY = "joint-bob-workspace-column";
const COLLAPSED_GROUPS_KEY = "joint-bob-inbox-collapsed-groups";
const collapsedGroups = new Set();
try {
  const saved = JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY) ?? "[]");
  if (Array.isArray(saved)) saved.forEach((id) => collapsedGroups.add(id));
} catch { /* storage is unavailable or the saved choice is invalid */ }
const body = document.body;
const byId = (id) => document.getElementById(id);

/* ---------- moving controls between their phone home and the desktop header ---------- */

/** Each moved element leaves a marker where it lives on the phone, so it can go back exactly there. */
const homes = new Map();
function place(element, target, before = null) {
  if (!element || !target) return;
  if (!homes.has(element)) {
    const marker = document.createComment(`${element.id} lives here on the phone`);
    element.before(marker);
    homes.set(element, marker);
  }
  if (element.parentElement === target && (!before || element.nextSibling === before)) return;
  target.insertBefore(element, before);
}
function restoreAll() {
  for (const [element, marker] of homes) if (marker.isConnected) marker.replaceWith(element);
  homes.clear();
}

const PLACEMENTS = [
  // The header's first line: Stop, Mark done, the details toggle and the ⋯ menu.
  ["abortButton", "chatHeadActions"],
  ["chatDoneButton", "chatHeadActions"],
  ["activityToggleButton", "chatHeadActions"],
  ["chatMoreMenu", "chatHeadActions"],
  // Quiet meta at the end of the chip row.
  ["contextUsage", "chatMeta"],
  ["turnTimer", "chatMeta"],
  // The details column opens today's full screens from its summaries.
  ["chatFilesButton", "detailsFilesActions"],
  ["chatGitButton", "detailsGitActions"],
  ["backgroundTasksButton", "detailsTasksActions"],
  // Story and Activity overview live in More; btw stays in the tab strip.
  ["activityStoryButton", "detailsMoreStory"],
  ["activityOverviewButton", "detailsMoreOverview"],
];

function applyPlacements() {
  if (!desktop.matches) { restoreAll(); return; }
  for (const [id, targetId] of PLACEMENTS) {
    const target = byId(targetId);
    place(byId(id), target, targetId === "chatMeta" ? byId("chatCostMeta") : null);
  }
  placeChipRow();
}

/**
 * The chip row (agent, model, effort, machine and the quiet meta) joins the header, between the title and its actions:
 * on the title's line on a wide panel, on a line of its own under it on a narrower one (styles in workspace.css). It is
 * not one of the PLACEMENTS: on the phone focus-ui.js moves it and puts it back by its own marker, so this only ever
 * moves it on the desktop. focus-ui.js may put it back at its marker after this ran (the two listen to different
 * media queries), so applyLayout places it again a frame later.
 */
function placeChipRow() {
  byId("chatTopbar").insertBefore(byId("chatToolbar"), byId("chatHeadActions"));
}

/* ---------- large text: the details are put away when the conversation would get too narrow ---------- */

/** Below this many of the conversation's own (zoomed) pixels beside the details, the details are put away. */
const READABLE_MIDDLE = 420;
const chatPanel = byId("chatPanel");
let lastPreferredWidth = 0;
function syncDetailsFloat() {
  const zoom = parseFloat(getComputedStyle(chatPanel).zoom) || 1;
  const activityZoom = parseFloat(getComputedStyle(elements.activityPanel).zoom) || 1;
  const preferred = parseFloat(getComputedStyle(elements.activityPanel).getPropertyValue("--activity-preferred-width")) || 360;
  // A person dragging the details wider changes this width; they keep the details in sight, so those float.
  const dragged = lastPreferredWidth !== 0 && preferred !== lastPreferredWidth;
  lastPreferredWidth = preferred;
  // The docked column's width on screen (styles cap it at 36% of the window).
  const details = Math.min(innerWidth * 0.36, preferred * zoom * activityZoom);
  const middle = (chatPanel.getBoundingClientRect().width - details) / zoom;
  const float = desktop.matches && innerWidth > 1023 && chatPanel.getBoundingClientRect().width > 0 && middle < READABLE_MIDDLE;
  const floated = body.classList.contains("ws-details-float");
  body.classList.toggle("ws-details-float", float);
  // When they stop fitting they are put away, not laid over the conversation. Their button in the header brings
  // them back, floating, until they fit again.
  if (!float) body.classList.remove("ws-details-tucked");
  // Larger text puts them away too, in Inbox as well: laid over the thread they would cover half the conversation.
  else if (!floated && !dragged) body.classList.add("ws-details-tucked");
}
elements.activityToggleButton.addEventListener("click", (event) => {
  if (!body.classList.contains("ws-details-tucked")) return;
  body.classList.remove("ws-details-tucked");
  // The panel is open already (only put away): the press shows it and must not close it.
  if (!elements.activityPanel.hidden) { event.stopImmediatePropagation(); event.preventDefault(); }
}, true);
document.addEventListener("activity-show-steps", () => body.classList.remove("ws-details-tucked"));
new ResizeObserver(() => syncDetailsFloat()).observe(chatPanel);
new MutationObserver(() => { syncDetailsFloat(); syncRail(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });

/* ---------- the column's mode: Inbox or Projects ---------- */

/**
 * Projects shows two columns: the projects under the places, and beside them the chosen project's conversations
 * (styles: "Projects: two columns"). Until a project is chosen there is only the first.
 */
let column = readColumn();

function readColumn() {
  try { return localStorage.getItem(COLUMN_KEY) === "projects" ? "projects" : "inbox"; } catch { return "inbox"; }
}
function setColumn(next) {
  column = next;
  try { localStorage.setItem(COLUMN_KEY, next); } catch { /* private mode: the choice lasts the page */ }
  syncColumn();
  // The phone shows the same choice as its Inbox and Projects tabs (phone-ui.js, focus-ui.js).
  window.dispatchEvent(new CustomEvent("workspace-column-changed", { detail: { column: next } }));
}

/** The phone's Home is the projects view with the Inbox column: there the groups fill the screen under the greeting. */
function phoneHomeShown() {
  return !desktop.matches && body.classList.contains("focus-ui") && currentMobileView() === "projects" && column === "inbox";
}
function groupsShown() {
  return column === "inbox" && (desktop.matches || phoneHomeShown());
}

function syncColumn() {
  body.classList.toggle("ws-column-inbox", column === "inbox");
  body.classList.toggle("ws-column-projects", column === "projects");
  body.classList.toggle("ws-picker", column === "projects" && !state.activeProjectId);
  syncRail();
  requestAnimationFrame(() => syncDetailsFloat());
  syncPlaces();
  if (column === "inbox") renderGroups();
}

function syncPlaces() {
  const view = currentMobileView();
  const control = view === "control";
  // On Bob's page "Bob" is lit for his own chat; his other pages light their place in his sub-menu instead.
  const shown = currentControlView();
  const active = body.classList.contains("costs-page") ? "costs" : control ? (shown === "automations" ? "automations" : shown === "live" ? "bob" : "") : column;
  for (const placeButton of document.querySelectorAll(":is(.ws-places, .ws-side) [data-place]")) {
    const on = placeButton.dataset.place === active;
    placeButton.classList.toggle("on", on);
    if (placeButton.hasAttribute("aria-pressed")) placeButton.setAttribute("aria-pressed", String(on));
  }
  const project = state.projects?.find((item) => item.id === state.activeProjectId);
  byId("workspaceProjectNote").textContent = column === "projects" ? "" : project?.name ?? "";
}

byId("workspaceInboxButton").addEventListener("click", () => {
  closeGroupPage();
  setColumn("inbox");
  // From Bob's pages the Inbox is the way back: the person leaves the control center by choosing it.
  if (currentMobileView() === "control") elements.controlCenterCloseButton.click();
});
byId("workspaceProjectsButton").addEventListener("click", () => {
  closeGroupPage();
  setColumn("projects");
  if (body.classList.contains("ws-picker")) elements.projectSearchInput.focus({ preventScroll: true });
});

/* ---------- the Projects place: a column of projects, a column of the chosen project's conversations ---------- */

// Each column folds on its own chevron ([ and ]): the first to the rail of icons, the conversations to a strip. A
// window too narrow for both columns and a readable conversation folds the first column by itself (the details
// column gives way before that: see syncDetailsFloat); its expand button opens it over that for as long as the
// window stays narrow.
/** The conversation's own width, without the details, under which the first column folds. */
const READABLE_WITH_LISTS = 480;
let railOpened = false;
function syncRail() {
  const two = desktop.matches && column === "projects" && Boolean(state.activeProjectId);
  // The two columns' widths, as the styles set them (--ws-side-width, --ws-list-width).
  // Larger text widens them (styles: --ws-col-side, --ws-col-list), up to a quarter of the window.
  const zoomOf = (name) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 1;
  const wide = (width, zoom) => innerWidth < 1024 ? width : Math.max(width, Math.min(width * zoom, innerWidth * 0.25));
  const side = innerWidth < 1024 ? 232 : wide(Math.min(288, Math.max(244, innerWidth * 0.19)), zoomOf("--ui-zoom-projects"));
  const list = body.classList.contains("chats-collapsed") ? 44 : wide(Math.min(336, Math.max(288, innerWidth * 0.2)), zoomOf("--ui-zoom-conversations"));
  const narrow = two && innerWidth - side - list - 3 * 14 < READABLE_WITH_LISTS;
  if (!narrow) railOpened = false;
  const auto = narrow && !railOpened && !body.classList.contains("projects-collapsed");
  body.classList.toggle("ws-auto-rail", auto);
  elements.projectsPanel.classList.toggle("collapsed", auto || body.classList.contains("projects-collapsed"));
}
addEventListener("resize", () => requestAnimationFrame(syncRail));
byId("expandProjectsButton").addEventListener("click", () => {
  if (body.classList.contains("ws-auto-rail")) railOpened = true;
  queueMicrotask(syncRail);
});
byId("collapseProjectsButton").addEventListener("click", () => { railOpened = false; queueMicrotask(syncRail); });
window.addEventListener("project-selected", syncColumn);

// The projects' own filter (clusters) folds behind a button beside the search box, as a project's filters do; the
// button shows only when there is something to filter by, and counts what is chosen.
const PROJECT_FILTERS_OPEN_KEY = "joint-bob-project-filters-open";
const projectFiltersToggle = byId("projectFiltersToggle");
const projectFilterRow = byId("projectFilterRow");
function syncProjectFilters() {
  projectFiltersToggle.hidden = projectFilterRow.hidden || !projectFilterRow.childElementCount;
  const on = projectFilterRow.querySelectorAll(".multi-select:not([hidden]) > .multi-select-trigger:not(.empty)").length;
  const count = byId("projectFiltersCount");
  count.hidden = on === 0;
  count.textContent = on ? String(on) : "";
  projectFiltersToggle.classList.toggle("on", on > 0);
  const label = on ? `Filter projects (${on} on)` : "Filter projects";
  if (projectFiltersToggle.title !== label) {
    projectFiltersToggle.title = label;
    projectFiltersToggle.setAttribute("aria-label", label);
  }
}
function setProjectFiltersOpen(open) {
  elements.projectsPanel.classList.toggle("filters-open", open);
  projectFiltersToggle.setAttribute("aria-expanded", String(open));
}
projectFiltersToggle.addEventListener("click", () => {
  const open = !elements.projectsPanel.classList.contains("filters-open");
  setProjectFiltersOpen(open);
  try { localStorage.setItem(PROJECT_FILTERS_OPEN_KEY, open ? "1" : "0"); } catch { /* private mode: the choice lasts the page */ }
});
try { setProjectFiltersOpen(localStorage.getItem(PROJECT_FILTERS_OPEN_KEY) === "1"); } catch { setProjectFiltersOpen(false); }
new MutationObserver(syncProjectFilters).observe(projectFilterRow, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "hidden"] });
syncProjectFilters();

byId("workspaceAutomationsButton").addEventListener("click", () => {
  setMobileView("control");
  showControlView("automations");
  syncPlaces();
});
window.addEventListener("app-view-changed", () => {
  // A project opened or closed (the list follows), or a different middle (the places follow).
  syncColumn();
  // Opening anything in the middle closes a group's full list.
  closeGroupPage();
});
window.addEventListener("control-view-changed", syncPlaces);
// Costs opened or closed as a page (usage-dashboard.js).
window.addEventListener("workspace-places-changed", syncPlaces);
// The workspace search names places too ("Inbox", "Projects window", a project).
window.addEventListener("workspace-place", (event) => {
  const name = event.detail?.place;
  if (name === "inbox") setColumn("inbox");
  else if (name === "projects") setColumn("projects");
  else if (name === "project") setColumn("projects");
  else if (name === "automations") byId("workspaceAutomationsButton").click();
});

/* ---------- New and More ---------- */

/** A popover menu opens under its button, inside the window. */
function anchorMenu(menu, button) {
  menu.addEventListener("toggle", (event) => {
    button.setAttribute("aria-expanded", String(event.newState === "open"));
    if (event.newState !== "open") return;
    const anchor = button.getBoundingClientRect();
    // The menu lives in a column that the text size zooms: its own lengths are multiplied by that zoom, the window's
    // coordinates are not. Unscaled, a menu far from the corner opened beside its button or outside the window.
    const zoom = menu.currentCSSZoom || 1;
    const box = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left, innerWidth - box.width - 8));
    const below = anchor.bottom + 6;
    const top = below + box.height > innerHeight - 8 ? Math.max(8, anchor.top - box.height - 6) : below;
    Object.assign(menu.style, { left: `${left / zoom}px`, top: `${top / zoom}px` });
    menu.querySelector("button:not(:disabled), a")?.focus({ preventScroll: true });
  });
  // A chosen item closes the menu; what it opens takes over. Focus moves to the menu's button first, so a dialog the
  // item opens gives focus back there when it closes (the item itself is hidden by then).
  menu.addEventListener("click", (event) => {
    if (!event.target.closest("button, a") || !menu.matches(":popover-open")) return;
    button.focus({ preventScroll: true });
    menu.hidePopover();
  }, true);
  menu.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...menu.querySelectorAll("button:not(:disabled):not([hidden]), a:not([hidden])")].filter((item) => item.getClientRects().length);
    const index = items.indexOf(document.activeElement);
    items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  });
}
anchorMenu(byId("workspaceNewMenu"), byId("workspaceNewButton"));
anchorMenu(byId("workspaceMoreMenu"), byId("workspaceMoreButton"));

const run = (action) => () => Promise.resolve().then(action).catch((error) => toast.error(error.message));
byId("workspaceNewConversation").addEventListener("click", run(startGlobalConversation));
byId("workspaceNewNote").addEventListener("click", run(() => openQuickNote(null, { chooseProject: true })));
byId("workspaceNewProject").addEventListener("click", () => elements.newProjectButton.click());
byId("workspaceIssuesButton").addEventListener("click", () => document.querySelector("#allProjectIssuesButton").click());

/** The project's own New buttons (one per agent) are offered in the New menu too, as they stand in its list. */
function renderNewHarnesses() {
  const host = byId("workspaceNewHarnesses");
  const project = state.projects?.find((item) => item.id === state.activeProjectId);
  const sources = [...elements.newSessionHarnesses.querySelectorAll("[data-new-session-harness]")];
  host.replaceChildren(...sources.map((source) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "ws-menu-item";
    item.setAttribute("role", "menuitem");
    item.dataset.testid = `workspace-new-${source.dataset.harnessId}`;
    item.disabled = source.disabled;
    item.title = source.title;
    const icon = source.querySelector("svg, img")?.cloneNode(true);
    const label = document.createElement("span");
    const name = (source.getAttribute("aria-label") || "").replace(/^New /, "").replace(/ conversation$/, "");
    label.textContent = name;
    const where = document.createElement("small");
    where.textContent = project ? `in ${project.name}` : "Choose a project first";
    label.append(where);
    if (icon) item.append(icon);
    item.append(label);
    item.addEventListener("click", () => source.click());
    return item;
  }));
  host.hidden = !sources.length;
}
byId("workspaceNewMenu").addEventListener("toggle", (event) => { if (event.newState === "open") renderNewHarnesses(); });

/* ---------- search ---------- */

const search = byId("workspaceSearchInput");
function syncSearchKey() {
  const chord = normalizeKeymap(state.keymap).commands.spotlight;
  byId("workspaceSearchKey").textContent = chord ? chordLabel(chord) : "";
}
// The column's box is the way into the workspace search: it opens with what was typed and finds as you go.
search.addEventListener("input", () => {
  const typed = search.value;
  search.value = "";
  openSpotlight(typed);
});
search.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  openSpotlight("");
});
search.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== "ArrowDown") return;
  event.preventDefault();
  openSpotlight(search.value);
});
window.addEventListener("shortcut-targets-changed", syncSearchKey);
// The folded rail has no box to type in: its search icon opens the same search.
byId("workspaceSearchRailButton").addEventListener("click", () => openSpotlight(""));

/* ---------- the groups: Needs you, Running, To review ---------- */

export const GROUPS = [
  { id: "needs-you", title: "Needs you", dot: "need", empty: "Nothing waits for you." },
  { id: "running", title: "Running", dot: "run", empty: "Nothing is running." },
  { id: "review", title: "To review", dot: "rev", empty: "Nothing to review." },
  // Every other conversation of every project, so the Inbox leaves nothing out (the server lists them with the board).
  { id: "scheduled", title: "Scheduled", dot: "sch", empty: "No scheduled runs." },
  { id: "earlier", title: "Earlier", dot: "old", empty: "No earlier conversations." },
  { id: "done", title: "Done", dot: "done", empty: "Nothing is marked done." },
];
/** The groups that hold what is not on the board: a conversation filed in a folder leaves them (it is in its folder), but never the board's groups. */
const OFF_BOARD = ["scheduled", "earlier", "done"];
/** Put aside from Needs you (control-snooze.js): not a group of the column, which counts them on Needs you's label; the "Show all"
 * page lists them on a tab of their own while there are any. */
const SNOOZED = { id: "snoozed", title: "Snoozed", dot: "old", empty: "Nothing is snoozed." };
const MARK_GROUPS = [
  { id: "pinned", title: "Pinned", empty: "No pinned conversations.", mark: isPinned },
  { id: "starred", title: "Starred", empty: "No starred conversations.", mark: isStarred },
];
let cards = [];
let loaded = false;
/** The conversations that are not on the board, read at most once a minute (they change slowly and there can be thousands). */
let earlierRead = [];
let earlierRows = [];
let earlierReadAt = 0;
const EARLIER_EVERY_MS = 60_000;

const cardKey = (card) => `${card.projectId}:${card.conversationId}`;

/** A refresh of the board can be newer than the last read of the rest: what is on the board is not listed twice. */
function syncEarlier() {
  const onBoard = new Set(cards.map(cardKey));
  earlierRows = earlierRead.filter((row) => !onBoard.has(cardKey(row)) && !isHidden(row)).map((row) => ({ ...row, column: row.scheduled ? "scheduled" : row.done ? "done" : "earlier" }));
}

/** Marks span all folders and statuses; team and filing rules still apply to the status groups. */
function cardsIn(groupId) {
  const marked = MARK_GROUPS.find((group) => group.id === groupId);
  if (marked) return allCards().filter(marked.mark);
  const listed = OFF_BOARD.includes(groupId) ? earlierRows.filter((card) => card.column === groupId && !folderOf(card)) : cards.filter((card) => card.column === groupId);
  return listed.filter((card) => !card.team);
}
const TEAM_PAGE = "team:";
/** The team folders: one per team that has conversations, with everything of it, newest first. */
function teamFolders() {
  const folders = new Map();
  for (const card of [...cards, ...earlierRows]) {
    if (!card.team) continue;
    const folder = folders.get(card.team.id) ?? { id: card.team.id, name: card.team.name, host: card.team.host, cards: [] };
    folder.cards.push(card);
    folders.set(card.team.id, folder);
  }
  for (const folder of folders.values()) folder.cards.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  return [...folders.values()].sort((a, b) => a.name.localeCompare(b.name));
}
/** The group a team conversation would be in: its dot in the folder says where it stands. */
const groupOfCard = (card) => (card.column === "snoozed" ? SNOOZED : GROUPS.find((group) => group.id === (card.column ?? "earlier")) ?? GROUPS[GROUPS.length - 1]);

const allCards = () => [...cards, ...earlierRows];
const pinnedCards = () => allCards().filter(isPinned).sort(byUrgency);
const unpinned = (card) => !isPinned(card);
const visiblePins = () => phoneHomeShown() ? filterInbox("pinned", pinnedCards()) : inChosenProjects(pinnedCards());

function isActiveCard(card) {
  const projectId = state.activeConversationProjectId || state.activeProjectId;
  if (!state.activeSessionId && !state.activeSessionPath) return false;
  return card.projectId === projectId && (card.conversationId === state.activeSessionId || card.sessionId === state.activeSessionId
    || (state.activeSessionPath && card.path === state.activeSessionPath));
}

function timeLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date)
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

/** What the row says under its title: the project, then what it is doing or what it did. */
function cardLine(card) {
  const what = card.activity || (card.summary ? card.summary.replace(/[#*_`>]/g, "").split("\n").map((line) => line.trim()).find(Boolean) : "")
    || [card.agentLabel, card.agentModel].filter(Boolean).join(" · ");
  // Another person's machine runs it: the row says whose, since nothing here can act on it.
  if (card.column === "snoozed" && card.snooze) return [card.projectName, snoozedWords(card.snooze)].join(" · ");
  return [card.projectName, card.othersMachine ? `on ${sourceName(card)}` : "", what].filter(Boolean).join(" · ");
}

/** What a row says about the conversation besides its title: its worktree, auto respond, a read-only copy, a new one and its folder. */
function rowTags(card, nested) {
  const wrap = document.createElement("span");
  wrap.className = "ws-tags";
  const tag = (text, title, testid, color) => {
    const node = document.createElement("i");
    node.className = "ws-tag";
    node.textContent = text;
    node.title = title;
    node.dataset.testid = testid;
    if (color) node.style.setProperty("--tag", color);
    wrap.append(node);
  };
  if (nested && kidCount(card)) {
    const kids = document.createElement("i");
    kids.className = "ws-tag ws-kids";
    kids.setAttribute("role", "button");
    kids.textContent = `${kidsFolded(card) ? "▸" : "▾"} ${kidCount(card)}`;
    kids.title = `${kidCount(card)} sub-agent conversation${kidCount(card) === 1 ? "" : "s"}: ${kidsFolded(card) ? "show" : "fold"} them`;
    kids.dataset.testid = "inbox-row-kids";
    kids.addEventListener("click", (event) => { event.stopPropagation(); toggleKids(card); refreshFolders(); });
    wrap.append(kids);
  }
  if (card.worktree) tag(card.worktree.name, `Worktree ${card.worktree.name}`, "inbox-row-tag-worktree", card.worktree.color);
  if (card.autoRespondActive) tag("Auto", "Auto respond is on", "inbox-row-tag-auto");
  if (card.readOnly) tag("Read-only", "A copy you can read but not write in", "inbox-row-tag-readonly");
  if (card.fresh) tag("New", "Nothing is written in it yet", "inbox-row-tag-new");
  const folder = inboxMode() === "folder" ? null : folderOf(card);
  if (folder && !card.team) tag(folder.split("/").pop(), `In the folder ${folder}`, "inbox-row-tag-folder");
  return wrap;
}

/** `selectable`: the row is part of a checklist while Select is on (inbox-filters.js): pressing it chooses it instead of opening it. */
function cardRow(card, group, testid, selectable = false, nested = true) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "ws-row";
  row.dataset.testid = testid;
  row.dataset.key = `${card.projectId}:${card.conversationId}`;
  row.classList.toggle("sel", isActiveCard(card));
  if (nested && kidDepth(card)) { row.classList.add("ws-kid"); row.style.setProperty("--kid", String(kidDepth(card))); }
  row.title = `${card.title} · ${card.projectName}`;
  const dot = document.createElement("i");
  dot.className = `ws-dot ${group.dot}`;
  dot.setAttribute("aria-hidden", "true");
  const copy = document.createElement("span");
  copy.className = "ws-row-copy";
  const top = document.createElement("span");
  top.className = "ws-row-top";
  const title = document.createElement("b");
  title.textContent = `${isPinned(card) ? "📌 " : ""}${isStarred(card) ? "★ " : ""}${card.title || "Conversation"}`;
  const time = document.createElement("time");
  time.textContent = timeLabel(card.updatedAt);
  if (card.updatedAt) time.dateTime = card.updatedAt;
  top.append(title, rowTags(card, nested), time);
  const line = document.createElement("span");
  line.className = "ws-row-line";
  line.textContent = cardLine(card);
  copy.append(top, line);
  row.append(dot, copy);
  // The row's own menu is one press away as well as on the right button (a menu as a mailbox's rows have).
  if (!card.othersMachine && !(selectable && isSelecting())) {
    const more = document.createElement("span");
    more.className = "ws-row-more";
    more.setAttribute("role", "button");
    more.setAttribute("aria-label", `${card.title || "Conversation"}: menu`);
    more.title = "Conversation menu";
    more.dataset.testid = "inbox-row-menu";
    more.textContent = "⋯";
    more.addEventListener("click", (event) => { event.stopPropagation(); openCardMenu(card, more); });
    row.append(more);
    row.draggable = true;
    row.addEventListener("dragstart", (event) => { startDrag(card); event.dataTransfer.setData("text/plain", row.dataset.key); });
    row.addEventListener("dragend", endDrag);
  }
  if (selectable && isSelecting()) {
    const box = document.createElement("i");
    box.className = "ws-check";
    box.setAttribute("aria-hidden", "true");
    row.prepend(box);
    row.setAttribute("aria-pressed", String(isSelected(card)));
    row.classList.toggle("picked", isSelected(card));
    row.addEventListener("click", () => {
      toggleSelected(card);
      row.setAttribute("aria-pressed", String(isSelected(card)));
      row.classList.toggle("picked", isSelected(card));
    });
    return row;
  }
  row.addEventListener("click", () => {
    closeGroupPage();
    openConversation(card).catch((error) => toast.error(error.message));
  });
  row.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    // Linux and macOS send this on the press: the menu opens once the button is let go, or that release would close it at once.
    if (event.buttons) row.addEventListener("pointerup", () => openCardMenu(card, row), { once: true });
    else openCardMenu(card, row);
  });
  return row;
}

/** A row's own menu (right click, or the context-menu key): put it aside or bring it back, star it, pin it, or open one of its tools. */
function openCardMenu(card, anchor) {
  const items = [];
  if (card.column === "needs-you") items.push({ label: "Snooze…", icon: "clock", testid: "inbox-row-snooze", title: "Put it aside for now: it leaves Needs you until the time you choose or something new happens", onSelect: () => chooseSnooze(card, anchor) });
  if (card.column === "snoozed") items.push({ label: "Wake", icon: "clock", testid: "inbox-row-wake", title: "Bring it back to Needs you now", onSelect: () => wakeCard(card).catch((error) => toast.error(error.message)) });
  if (!card.othersMachine) {
    items.push({ label: "Move to folder…", icon: "folder", testid: "inbox-row-folder", title: "File it in a folder or a subfolder, as in a mailbox", onSelect: () => openMoveMenu(anchor, [card], allCards(), refreshFolders) });
    items.push({ label: isStarred(card) ? "Unstar" : "Star", icon: "star", testid: "inbox-row-star", title: "A starred conversation is never removed by any automatic cleanup", onSelect: () => { toggleStar(card, saveControlCenter); renderGroups(); if (!page.hidden) renderGroupPage(); } });
    items.push({ label: isPinned(card) ? "Unpin" : "Pin", icon: "pin", testid: "inbox-row-pin", title: "A pinned conversation is never removed by any automatic cleanup", onSelect: () => togglePin(card).catch((error) => toast.error(error.message)) });
  }
  // Let Bob control (control-lease.js), then the conversation's own tools (control-moves.js): each opens it first.
  if (!card.othersMachine) {
    for (const action of cardActionList(card).filter((candidate) => ROW_TOOLS.includes(candidate.id))) {
      items.push({ label: action.label, icon: action.icon, testid: `inbox-row-${action.id}`, title: action.title, onSelect: () => Promise.resolve(action.run(card, anchor)).catch((error) => toast.error(error.message)) });
    }
  }
  // What the project's own conversation list offers (done, rename, fork, move to another project, notifications…): each opens the conversation first.
  if (!card.othersMachine && !card.readOnly) {
    for (const action of SESSION_ACTIONS) {
      if (action.when && !action.when(card)) continue;
      items.push({ label: action.label(card), icon: action.icon, testid: `inbox-row-${action.id}`, title: action.title, danger: action.danger, onSelect: () => (action.id === "delete" ? deleteFromRow(card) : openSessionAction(card, action.id, openConversation).then(refreshAfterChange)).catch((error) => toast.error(error.message)) });
    }
  }
  // Its project's dashboard, or asking Bob for one (control-dashboards.js); asking happens in Bob's chat, so his page opens first.
  for (const action of projectActionList({ projectId: card.projectId, projectName: card.projectName })) {
    items.push({ label: action.id === "dashboard" ? "Project dashboard" : "Ask Bob for a dashboard", icon: "dashboard", testid: `inbox-row-project-${action.id}`, title: action.title, onSelect: () => {
      if (action.id !== "dashboard") {
        closeGroupPage();
        if (!isControlCenterOpen()) byId("openControlCenterButton").click();
      }
      Promise.resolve(action.run({ projectId: card.projectId, projectName: card.projectName })).catch((error) => toast.error(error.message));
    } });
  }
  if (items.length) openRowMenu(anchor, items);
}
const ROW_TOOLS = ["system-control", "terminal", "git", "files", "story", "overview"];

const groupsHost = byId("workspaceGroups");
/** A folder changed (a conversation moved, a folder made, renamed or deleted): every list that shows folders is drawn again. */
function refreshFolders() {
  groupsHost.dataset.signature = "";
  renderGroups();
  if (!page.hidden) renderGroupPage();
}

// How the column groups its list: by state, by project, or by folder.
const columnTools = document.createElement("div");
columnTools.className = "ws-column-tools";
function makeModeBar(testid) {
  const bar = document.createElement("div");
  bar.className = "ws-mode";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Group the list");
  bar.dataset.testid = testid;
  for (const [id, label] of [["state", "State"], ["project", "Project"], ["folder", "Folder"]]) {
    const choice = document.createElement("button");
    choice.type = "button";
    choice.textContent = label;
    choice.dataset.mode = id;
    choice.dataset.testid = `${testid}-${id}`;
    choice.addEventListener("click", () => { setInboxMode(id); closeGroupPage(); });
    bar.append(choice);
  }
  return bar;
}
const modeBar = makeModeBar("workspace-mode");
// The phone's Home has its own, in the toolbar above its list.
const phoneModeBar = makeModeBar("phone-mode");
function syncModeBar() {
  for (const bar of [modeBar, phoneModeBar]) for (const choice of bar.children) choice.setAttribute("aria-pressed", String(choice.dataset.mode === inboxMode()));
}
syncModeBar();

/** Opens the project in the Projects place (its conversations, notes and worktrees are there) and runs `then` once it is the open one. */
async function inProject(project, then) {
  closeGroupPage();
  setColumn("projects");
  await selectProject(project.id);
  then?.();
}

/** A project's menu from the Inbox: its notes and worktree tools first, then the project's own entries. */
function openInboxProjectMenu(anchor, project) {
  const fail = (error) => toast.error(error.message);
  openProjectMenu(anchor, project, [
    { label: "Open the project's page", icon: "folder", testid: "project-open-page", title: "Its conversations, notes and worktrees in the Projects place", onSelect: () => inProject(project).catch(fail) },
    { label: "Notes", icon: "pencil", testid: "project-open-notes", title: "The project's notes and their run queue", onSelect: () => inProject(project, showQuickNotes).catch(fail) },
    { label: "New worktree…", icon: "folder", testid: "project-new-worktree", title: "A synced copy of the project's code for isolated work", onSelect: () => inProject(project, () => openWorktreeDialog(null)).catch(fail) },
    { label: "Manage worktrees", icon: "folder", testid: "project-manage-worktrees", title: "Merge, rename or delete the project's worktrees", onSelect: () => inProject(project, () => setTimeout(() => { const section = document.querySelector('[data-testid="other-worktrees"]'); if (section) { section.open = true; section.scrollIntoView({ block: "nearest" }); } }, 600)).catch(fail) },
    { label: "Review together…", icon: "copy", testid: "project-review-together", title: "Start a conversation with references to several worktrees or conversations", onSelect: () => inProject(project, openContextReferencesDialog).catch(fail) },
  ]);
}
// The system messages and a batch of conversations being moved sit under the places, above the groups.
/** After Mark read or Delete the board and the Earlier list are read again at once. */
function refreshAfterChange() {
  earlierReadAt = 0;
  return readBoard();
}
/** The board drawn again without the conversations being deleted (control-marks.js). */
const redrawBoard = () => acceptCards(cards);
/** Deleting from a row's menu: asked once, then the row goes at once and the server finishes behind it; the conversation is not opened. */
async function deleteFromRow(card) {
  const confirmed = await confirmAction({
    eyebrow: "Delete conversation",
    title: `Delete conversation “${card.title}”?`,
    message: "The transcript is deleted from this node.",
    confirmLabel: "Delete conversation",
    destructive: true,
  });
  if (confirmed) await deleteConversations([card], { redraw: redrawBoard, refresh: refreshAfterChange });
}
// The phone's Home filters and selects above its groups (the desktop's column keeps every row; its Show all page has its own bar).
const phoneToolbar = createInboxToolbar({
  id: "inboxHome", allCards, afterChange: refreshAfterChange, redraw: redrawBoard, folded: true,
  visibleCards: () => [...visiblePins(), ...GROUPS.filter((group) => group.id !== "needs-you").flatMap((group) => filterInbox(group.id, cardsIn(group.id).filter(unpinned)))],
});
phoneToolbar.root.classList.add("phone-only");
phoneToolbar.root.prepend(phoneModeBar);
groupsHost.before(phoneToolbar.root);
// On the phone the column is not shown: the system messages and a running move sit on Home, above its filters.
const phoneWidth = matchMedia("(max-width: 700px)");
// The desktop column lists every project unless some are chosen here (the board's project chips, as one box).
const columnFilter = createProjectFilter({ id: "inboxColumn", allCards });
function placeColumnNotes() {
  if (phoneWidth.matches) { phoneToolbar.root.before(systemStrip, movesJobPanel); return; }
  const side = byId("workspaceSide");
  // The grouping choice and the project filter share one row, so the column keeps its height for the list.
  columnTools.append(modeBar, columnFilter.root, createAutomationToggle("inboxColumn-automations"));
  side.append(systemStrip, movesJobPanel, columnTools);
  // Bob is the first conversation of the list (bob-page.js puts him here): he stays right above it.
  const bob = side.querySelector(":scope > .ws-place-bob");
  if (bob) side.append(bob);
}
phoneWidth.addEventListener("change", placeColumnNotes);
placeColumnNotes();

/** The phone's Home before the board has answered: the shape of what is coming (a card, then rows), not four empty headings. */
function loadingGroups() {
  const host = document.createElement("div");
  host.className = "ws-loading";
  host.dataset.testid = "workspace-loading";
  host.setAttribute("role", "status");
  host.setAttribute("aria-label", "Loading your conversations");
  host.append(Object.assign(document.createElement("i"), { className: "ws-loading-label" }), Object.assign(document.createElement("i"), { className: "ws-loading-card" }),
    Object.assign(document.createElement("i"), { className: "ws-loading-label" }));
  for (let index = 0; index < 4; index += 1) host.append(Object.assign(document.createElement("i"), { className: "ws-loading-row" }));
  return host;
}
// A group's label and its "nothing here" line; the phone sets taller ones (phone.css: --ws-lab-height, --ws-empty-height).
const LABEL_HEIGHT = 43;
/** The column shows up to this many conversations of each group and scrolls; Show all has the rest. */
const COLUMN_ROWS = 10;
const EMPTY_HEIGHT = 26;
/** The deck's bar is this tall. */
const DECK_BAR = 48;
function cssHeight(name, fallback) {
  return parseFloat(getComputedStyle(groupsHost).getPropertyValue(name)) || fallback;
}

/** The phone's Home draws what needs you as a swipeable deck of cards; home.js gives it (`needDeck`, from all the cards). */
let needCard = null;
export function useNeedCards(render) {
  needCard = render;
  renderGroups();
}

function sectionHeading(id, title, count, collapsed, phone) {
  const label = document.createElement("div");
  label.className = "ws-lab ws-state-heading";
  const name = document.createElement("span");
  name.textContent = title;
  if (phone) label.append(name, count);
  else {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "ws-section-toggle";
    toggle.dataset.testid = `workspace-group-toggle-${id}`;
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.append(name, count);
    toggle.addEventListener("click", () => {
      const hadFocus = document.activeElement === toggle;
      if (collapsed) collapsedGroups.delete(id);
      else collapsedGroups.add(id);
      try { localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...collapsedGroups])); } catch { /* the choice lasts the page */ }
      renderGroups();
      if (hadFocus) groupsHost.querySelector(`[data-testid="${toggle.dataset.testid}"]`)?.focus({ preventScroll: true });
    });
    label.append(toggle);
  }
  return label;
}

function prependPinned(pins, chunked) {
  if (!pins.length) return;
  const section = document.createElement("section");
  section.className = "ws-group";
  section.dataset.group = "pinned";
  section.dataset.testid = "workspace-group-pinned";
  const phone = phoneHomeShown();
  const collapsed = !phone && collapsedGroups.has("pinned");
  const count = Object.assign(document.createElement("i"), { textContent: String(pins.length) });
  const label = sectionHeading("pinned", "Pinned", count, collapsed, phone);
  if (!phone) label.append(showAllButton("pinned", "Pinned", pins.length));
  section.append(label);
  groupsHost.prepend(section);
  if (!collapsed) for (const card of pins) chunked.push({ make: () => cardRow(card, groupOfCard(card), "workspace-group-row", phone, false), into: section });
}

function showAllButton(id, title, count) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ws-show-all";
  button.dataset.testid = `workspace-show-all-${id}`;
  button.textContent = "Show all";
  button.setAttribute("aria-label", `Show all ${count}: ${title}`);
  button.addEventListener("click", () => openGroupPage(id));
  return button;
}

const rowSignature = (card) => [cardKey(card), card.column, card.title, card.updatedAt, card.activity, card.controlledBy, card.summary,
  card.reviewCheck?.reason, card.pendingReviews?.length, card.autoRespondStop?.reason, isActiveCard(card), isStarred(card), folderOf(card),
  card.worktree?.name, card.autoRespondActive, kidCount(card), card.snooze?.until];

/** The Inbox previews each state group below the pinned conversations. */
function renderGroups(refit = true) {
  if (!groupsShown()) return;
  syncModeBar();
  if (inboxMode() !== "state") { renderModeList(); return; }
  // Words being written for Push it on on a card are not drawn away; the card draws the groups again when it closes.
  if (groupsHost.querySelector(".ws-wait.pushing")) return;
  // The phone's Home applies the project and Show filters (inbox-filters.js); the desktop column lists everything.
  phoneToolbar.update();
  phoneToolbar.root.hidden = !loaded;
  if (!loaded && phoneHomeShown()) {
    if (groupsHost.dataset.signature !== "loading") { groupsHost.dataset.signature = "loading"; groupsHost.replaceChildren(loadingGroups()); }
    return;
  }
  columnFilter.update();
  const phone = phoneHomeShown();
  const pins = visiblePins();
  const groupCards = GROUPS.map((group) => cardsIn(group.id));
  const visibleGroups = GROUPS.map((group, index) => {
    const list = groupCards[index].filter(unpinned);
    return phone ? filterInbox(group.id, list) : inChosenProjects(list);
  });
  const listIn = (index) => nestRows(visibleGroups[index]);
  const counts = visibleGroups.map((list) => list.length);
  const sample = groupsHost.querySelector(".ws-row");
  const rowHeight = sample ? sample.getBoundingClientRect().height + 2 : 52;
  // The phone's Home shows what needs you as cards with their actions (home.js), as the desktop's Home does.
  const cardsHere = Boolean(needCard) && phoneHomeShown();
  const cardSample = groupsHost.querySelector(".ws-wait");
  const cardHeight = cardSample ? cardSample.getBoundingClientRect().height + 8 : 160;
  const heightOf = (index) => (cardsHere && GROUPS[index].id === "needs-you" ? cardHeight : rowHeight);
  const room = groupsHost.clientHeight;
  const folderCount = teamFolders().length;
  let budget = room - GROUPS.length * cssHeight("--ws-lab-height", LABEL_HEIGHT) - counts.filter((count) => !count).length * cssHeight("--ws-empty-height", EMPTY_HEIGHT)
    - (folderCount ? cssHeight("--ws-lab-height", LABEL_HEIGHT) + folderCount * rowHeight : 0);
  const shown = GROUPS.map(() => 0);
  if (phoneHomeShown()) {
    // The phone's Home scrolls: Needs you is one deck of every card and the other groups list every conversation, one
    // long scroll drawn in chunks (long-scroll.js), with no Show all.
    GROUPS.forEach((group, index) => { shown[index] = counts[index]; });
    budget = 0;
  } else if (cardsHere && counts[GROUPS.findIndex((group) => group.id === "needs-you")]) {
    const index = GROUPS.findIndex((group) => group.id === "needs-you");
    shown[index] = counts[index];
    budget -= cardHeight + DECK_BAR;
  }
  let dealt = true;
  while (dealt) {
    dealt = false;
    for (const [index] of GROUPS.entries()) {
      if (shown[index] >= counts[index] || budget < heightOf(index)) continue;
      shown[index] += 1;
      budget -= heightOf(index);
      dealt = true;
    }
  }
  // The column is one scroll with the first ten of every group, whatever the window's height.
  if (!phone) GROUPS.forEach((group, index) => { shown[index] = collapsedGroups.has(group.id) ? 0 : Math.min(counts[index], COLUMN_ROWS); });
  // Nothing that is drawn changed (a refresh found the same board): the rows, and a deck being swiped, stay as they are.
  const fullCounts = GROUPS.map((group, index) => (phone ? filterInbox(group.id, groupCards[index]) : inChosenProjects(groupCards[index])).length);
  const signature = JSON.stringify([loaded, phone, cardsHere, groupsHost.clientWidth, counts, fullCounts, cardsIn(SNOOZED.id).length, inboxSignature(), phone ? [] : [...collapsedGroups], pins.map(rowSignature), GROUPS.map((_, index) => listIn(index).slice(0, shown[index]).map(rowSignature)), teamFolders().map((folder) => [folder.id, folder.cards.length, folder.cards.map((card) => card.column).join()])]);
  if (groupsHost.childElementCount && groupsHost.dataset.signature === signature) { syncInboxNote(); return; }
  groupsHost.dataset.signature = signature;
  const scroll = groupsHost.scrollTop;
  const chunked = [];
  groupsHost.replaceChildren(...GROUPS.map((group, index) => {
    const section = document.createElement("section");
    section.className = "ws-group";
    section.dataset.group = group.id;
    section.dataset.testid = `workspace-group-${group.id}`;
    const count = document.createElement("i");
    count.dataset.testid = `workspace-group-count-${group.id}`;
    const total = groupCards[index].filter(unpinned).length;
    count.textContent = !loaded ? "…" : total === counts[index] ? String(counts[index]) : `${counts[index]} of ${total}`;
    const collapsed = !phone && collapsedGroups.has(group.id);
    const label = sectionHeading(group.id, group.title, count, collapsed, phone);
    const snoozed = group.id === "needs-you" ? cardsIn(SNOOZED.id).length : 0;
    if (snoozed) {
      const link = document.createElement("button");
      link.type = "button";
      link.className = "ws-show-all ws-snoozed-link";
      link.dataset.testid = "workspace-snoozed-link";
      link.textContent = `${snoozed} snoozed`;
      link.title = "Conversations put aside from Needs you; each comes back when its time comes or something new happens";
      link.addEventListener("click", () => openGroupPage(SNOOZED.id));
      label.append(link);
    }
    // The full status list still includes pins for review and bulk actions.
    const fullCount = fullCounts[index];
    if (!phone && fullCount) label.append(showAllButton(group.id, group.title, fullCount));
    section.append(label);
    if (collapsed) return section;
    if (loaded && !counts[index]) {
      const empty = document.createElement("p");
      empty.className = "ws-empty";
      empty.textContent = fullCount ? "All matching conversations are pinned." : total ? "Nothing matches the filters." : group.empty;
      section.append(empty);
    }
    if (cardsHere && group.id === "needs-you") {
      if (counts[index]) section.append(needCard(listIn(index)));
    } else if (phone) for (const card of listIn(index)) chunked.push({ make: () => cardRow(card, group, "workspace-group-row", true), into: section });
    else for (const card of listIn(index).slice(0, shown[index])) section.append(cardRow(card, group, "workspace-group-row"));
    return section;
  }));
  const folders = teamFolders();
  if (folders.length) {
    const section = document.createElement("section");
    section.className = "ws-group ws-folders";
    section.dataset.testid = "workspace-team-folders";
    const label = document.createElement("div");
    label.className = "ws-lab";
    label.append(Object.assign(document.createElement("span"), { textContent: "Team folders" }));
    section.append(label);
    for (const folder of folders) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "ws-row ws-folder";
      row.dataset.testid = "workspace-team-folder";
      row.dataset.team = folder.id;
      const needs = folder.cards.filter((card) => card.column === "needs-you").length;
      const dot = document.createElement("i");
      dot.className = `ws-dot ${needs ? "need" : folder.cards.some((card) => card.column === "running") ? "run" : "old"}`;
      dot.setAttribute("aria-hidden", "true");
      const copy = document.createElement("span");
      copy.className = "ws-row-copy";
      const top = document.createElement("span");
      top.className = "ws-row-top";
      top.append(Object.assign(document.createElement("b"), { textContent: `${folder.name} team` }), Object.assign(document.createElement("time"), { textContent: String(folder.cards.length) }));
      const line = document.createElement("span");
      line.className = "ws-row-line";
      line.textContent = [folder.host && `on ${folder.host}`, needs && `${needs} need${needs === 1 ? "s" : ""} you`].filter(Boolean).join(" · ");
      copy.append(top, line);
      row.append(dot, copy);
      row.title = `${folder.name} team: ${folder.cards.length} conversation${folder.cards.length === 1 ? "" : "s"}`;
      row.addEventListener("click", () => openGroupPage(`${TEAM_PAGE}${folder.id}`));
      section.append(row);
    }
    groupsHost.append(section);
  }
  const pinnedRows = [];
  prependPinned(pins, pinnedRows);
  drawChunked(groupsHost, [...pinnedRows, ...chunked], { key: phoneHomeShown() ? "phone-home" : "inbox-state" });
  groupsHost.scrollTop = scroll;
  // The first render measures a row; a different height deals again once.
  const measured = groupsHost.querySelector(".ws-row");
  const measuredCard = groupsHost.querySelector(".ws-wait");
  // A first render (or one after the phone and the desktop swapped) measured another row height: deal again once.
  if (refit && ((measured && Math.abs(measured.getBoundingClientRect().height + 2 - rowHeight) > 1)
    || (measuredCard && Math.abs(measuredCard.getBoundingClientRect().height + 8 - cardHeight) > 1))) renderGroups(false);
  syncInboxNote();
}

/** The column by project or by folder: every conversation of the chosen projects, a filed one out of Scheduled, Earlier and Done as in the state groups. */
function renderModeList() {
  columnFilter.update();
  if (!loaded) return;
  // By folder every conversation is listed, in its folder; by project a filed one is out of Scheduled, Earlier and Done as in the state groups.
  const visible = inChosenProjects(allCards()).filter((card) => inboxMode() === "folder" || !OFF_BOARD.includes(card.column) || card.team || !folderOf(card));
  const pins = visiblePins();
  const signature = JSON.stringify([inboxMode(), inboxSignature(), modeSignature(), pins.map(rowSignature), visible.map(rowSignature)]);
  if (groupsHost.childElementCount && groupsHost.dataset.signature === signature) { syncInboxNote(); return; }
  groupsHost.dataset.signature = signature;
  const scroll = groupsHost.scrollTop;
  const common = { makeRow: cardRow, groupOf: groupOfCard, openPage: openGroupPage, afterChange: refreshFolders };
  if (inboxMode() === "project") drawByProject(groupsHost, { ...common, cards: visible, newIn: (project) => startConversationInProject(project.id).catch((error) => toast.error(error.message)), openMenu: openInboxProjectMenu });
  else drawByFolder(groupsHost, { ...common, cards: visible });
  const pinnedRows = [];
  prependPinned(pins, pinnedRows);
  drawChunked(groupsHost, pinnedRows, { key: `inbox-${inboxMode()}` });
  groupsHost.scrollTop = scroll;
  syncInboxNote();
}

function syncInboxNote() {
  const needs = cardsIn("needs-you").length;
  const note = byId("workspaceInboxNote");
  note.textContent = needs ? `${needs} need${needs === 1 ? "s" : ""} you` : "";
  note.classList.toggle("needs", needs > 0);
}

new ResizeObserver(() => requestAnimationFrame(() => renderGroups())).observe(groupsHost);

/* ---------- reading the board ---------- */

let refreshing = null;
let again = false;
let refreshTimer = null;

async function readBoard() {
  // Signed out (or not yet signed in): the read would only 401.
  if (!state.authenticated) return;
  if (refreshing) { again = true; return refreshing; }
  refreshing = (async () => {
    do {
      again = false;
      const wantEarlier = Date.now() - earlierReadAt > EARLIER_EVERY_MS;
      let board = await api(`/api/control-center/board?look=1${wantEarlier ? "&earlier=1" : ""}`);
      // Read the new home of a pin before removing its old row from the board.
      if (!board.earlier) {
        const nextKeys = new Set((board.cards || []).map(cardKey));
        if (cards.some((card) => isPinned(card) && !nextKeys.has(cardKey(card)))) board = await api("/api/control-center/board?look=1&earlier=1");
      }
      if (board.earlier) { earlierRead = board.earlier; earlierReadAt = Date.now(); }
      acceptCards(board.cards || [], Boolean(board.earlier));
    } while (again);
    void refreshSystemStrip();
  })().catch((error) => console.warn("Could not read the workspace groups", error)).finally(() => { refreshing = null; });
  return refreshing;
}

function acceptCards(next, updatedEarlier) {
  const nextKeys = new Set(next.map(cardKey));
  // A conversation left the board (finished, marked done): it now belongs to Earlier, which is read again at once.
  const left = cards.some((card) => !nextKeys.has(cardKey(card)));
  cards = next.filter((card) => !isHidden(card));
  loaded = true;
  syncEarlier();
  if (left && !updatedEarlier && started) { earlierReadAt = 0; scheduleGroupsRefresh(0); }
  // The phone's greeting and its Inbox tab count them (phone-ui.js).
  window.dispatchEvent(new CustomEvent("workspace-groups-counted", { detail: Object.fromEntries(GROUPS.map((group) => [group.id, cardsIn(group.id).length])) }));
  announceCards();
  renderGroups();
  if (!page.hidden) renderGroupPage();
}

/** Bursts of change notices cost one read. */
export function scheduleGroupsRefresh(delay = 800) {
  if (!started) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { void readBoard(); }, delay);
}

for (const name of ["running-refreshed", "control-center-changed", "conversation-started", "pending-reviews-refreshed"]) {
  window.addEventListener(name, () => scheduleGroupsRefresh());
}
// The control center read its board: something changed. Its board leaves out other people's machines, which the Inbox lists,
// so the Inbox reads its own instead of taking those cards.
window.addEventListener("control-center-board-refreshed", () => scheduleGroupsRefresh());
// Conversations were removed by a cleanup, another machine or a delete: Earlier is cached for a minute, so it is read again now.
window.addEventListener("conversations-removed", () => { earlierReadAt = 0; scheduleGroupsRefresh(); });
window.addEventListener("conversation-pins-changed", () => {
  renderGroups();
  if (!page.hidden) renderGroupPage();
});
// "activeConversationChanged" is announced on every redraw of the chat controls (about once a second while an agent
// works). The groups mark the open conversation, so they are drawn again only when another conversation is open;
// drawing them on every announcement rebuilt every row of the column each second.
let markedConversation = "";
document.addEventListener("activeConversationChanged", () => {
  const key = `${state.activeConversationProjectId || state.activeProjectId || ""}|${state.activeSessionId || ""}|${state.activeSessionPath || ""}`;
  if (key === markedConversation) return;
  markedConversation = key;
  renderGroups();
  if (!page.hidden) renderGroupPage();
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleGroupsRefresh(200); });
// What a running turn is doing changes all the time; while something runs and the page is seen, its line is read again.
setInterval(() => {
  if (document.hidden || !(desktop.matches || phoneHomeShown()) || !cards.some((card) => card.column === "running")) return;
  void readBoard();
}, 20_000);

/* ---------- Show all: one group as a long list in the middle ---------- */

const page = byId("workspaceGroupPage");
const pageList = byId("workspaceGroupList");
let pageGroup = "needs-you";
let pageQuery = "";
/** Show all includes every Earlier conversation, regardless of the phone's range choice. */
function filteredOnPage(groupId) {
  const terms = pageQuery.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return filterInbox(groupId, cardsIn(groupId), true).filter((card) => {
    const text = [card.title, card.projectName, card.summary, card.activity, card.agentLabel, card.agentModel].filter(Boolean).join(" ").toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}
const pageToolbar = createInboxToolbar({ id: "inboxPage", allCards, visibleCards: () => filteredOnPage(pageGroup), afterChange: refreshAfterChange, redraw: redrawBoard });
const pageSearch = document.createElement("input");
pageSearch.type = "search";
pageSearch.className = "inbox-search";
pageSearch.dataset.testid = "inboxPage-search";
pageSearch.placeholder = "Search conversations";
pageSearch.setAttribute("aria-label", "Search conversations");
pageSearch.addEventListener("input", () => {
  pageQuery = pageSearch.value.trim();
  renderGroupPage();
});
pageToolbar.root.prepend(pageSearch);
pageList.before(pageToolbar.root);
/** Home (home.js) draws the cards in the middle: the same ones the column lists, without the automations when they are hidden. */
function announceCards() {
  window.dispatchEvent(new CustomEvent("workspace-cards", { detail: { cards: cards.filter(shownCard) } }));
}
onInboxView(() => {
  announceCards();
  renderGroups();
  if (!page.hidden) renderGroupPage();
});

/** A project, folder or Not filed as one list in the middle, most urgent first. */
function listingPage(id) {
  const [kind, ...rest] = id.split(":");
  const name = rest.join(":");
  if (kind === "project") return { title: allCards().find((card) => card.projectId === name)?.projectName ?? "Project", cards: allCards().filter((card) => card.projectId === name) };
  if (kind === "folder") return { title: name.split("/").pop(), crumb: name, cards: allCards().filter((card) => (folderOf(card) ?? "") === name || (folderOf(card) ?? "").startsWith(`${name}/`)) };
  if (id === "view:unfiled") return { title: "Not filed", cards: allCards().filter((card) => !folderOf(card)) };
  return null;
}
function renderListingPage(id, { title, crumb, cards: listed }) {
  byId("workspaceGroupTitle").textContent = title;
  page.querySelector(".ws-page-crumb").textContent = crumb ?? "Every project";
  byId("workspaceGroupTabs").replaceChildren();
  const scroll = pageList.scrollTop;
  pageList.replaceChildren();
  const entries = nestRows(inChosenProjects(listed).sort(byUrgency)).map((card) => () => {
    const row = cardRow(card, groupOfCard(card), "workspace-listing-page-row");
    row.classList.add("wide");
    return withPageActions(card, row);
  });
  if (!entries.length) entries.push(() => Object.assign(document.createElement("p"), { className: "ws-empty", textContent: loaded ? "Nothing here yet." : "Loading…" }));
  drawChunked(pageList, entries, { key: `listing-${id}|${inboxFilterKey()}` });
  pageList.scrollTop = scroll;
}

function renderTeamPage(teamId) {
  const folder = teamFolders().find((item) => item.id === teamId);
  byId("workspaceGroupTitle").textContent = folder ? `${folder.name} team` : "Team";
  byId("workspaceGroupTabs").replaceChildren();
  const scroll = pageList.scrollTop;
  pageList.replaceChildren();
  const entries = (folder?.cards ?? []).map((card) => () => {
    const row = cardRow(card, groupOfCard(card), "workspace-team-page-row");
    row.classList.add("wide");
    return row;
  });
  if (!entries.length) entries.push(() => Object.assign(document.createElement("p"), { className: "ws-empty", textContent: loaded ? "This team has no conversations yet." : "Loading…" }));
  drawChunked(pageList, entries, { key: `team-page-${teamId}` });
  pageList.scrollTop = scroll;
}

export function openGroupPage(groupId) {
  pageGroup = groupId;
  page.hidden = false;
  body.classList.add("ws-page-open");
  renderGroupPage();
  byId("workspaceGroupClose").focus({ preventScroll: true });
}

export function closeGroupPage() {
  if (page.hidden) return;
  page.querySelector(".ws-page-crumb").textContent = "Every project";
  page.hidden = true;
  body.classList.remove("ws-page-open");
}

/** Every card of the group is one continuous list that scrolls (long-scroll.js); a refresh draws it again where it was, another group starts at the top. */
function renderGroupPage() {
  if (pageGroup.startsWith(TEAM_PAGE)) { renderTeamPage(pageGroup.slice(TEAM_PAGE.length)); return; }
  const listing = listingPage(pageGroup);
  if (listing) { renderListingPage(pageGroup, listing); return; }
  // Snoozed is a tab of its own while there are any, or while it is the one open.
  const tabs = [...MARK_GROUPS, ...GROUPS];
  if (cardsIn(SNOOZED.id).length || pageGroup === SNOOZED.id) tabs.push(SNOOZED);
  const group = tabs.find((item) => item.id === pageGroup) ?? GROUPS[0];
  byId("workspaceGroupTitle").textContent = group.title;
  page.querySelector(".ws-page-crumb").textContent = "Every project";
  byId("workspaceGroupTabs").replaceChildren(...tabs.map((item) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(item.id === group.id));
    tab.dataset.testid = `workspace-group-tab-${item.id}`;
    tab.append(item.title, Object.assign(document.createElement("b"), { textContent: String(filteredOnPage(item.id).length) }));
    tab.addEventListener("click", () => { pageGroup = item.id; renderGroupPage(); });
    return tab;
  }));
  const filtered = filteredOnPage(group.id);
  const items = group.mark ? filtered.sort(byUrgency) : nestRows(filtered);
  pageToolbar.update();
  const scroll = pageList.scrollTop;
  pageList.replaceChildren();
  const entries = items.map((card) => () => {
    const row = cardRow(card, groupOfCard(card), "workspace-group-page-row", true, !group.mark);
    row.classList.add("wide");
    return withPageActions(card, row);
  });
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "ws-empty";
    empty.textContent = !loaded ? "Loading…" : cardsIn(group.id).length ? "Nothing matches the filters." : group.empty;
    entries.push(empty);
  }
  drawChunked(pageList, entries, { key: `${group.id}|${inboxFilterKey()}|${pageQuery}` });
  // Emptying a scroll box sends it to its top; a refresh of the same group puts it back (a new group's key resets it after this).
  pageList.scrollTop = scroll;
}

function withPageActions(card, row) {
  if (isSelecting()) return row;
  const snooze = card.column === "needs-you";
  const wake = card.column === "snoozed";
  const canReply = !card.readOnly && !card.othersMachine && !card.pendingReviews?.length;
  if (!canReply && !snooze && !wake) return row;
  const item = document.createElement("div");
  item.className = "ws-page-item";
  item.append(row);
  if (canReply) {
    const reply = document.createElement("button");
    reply.type = "button";
    reply.className = "ghost compact ws-page-action ws-page-reply";
    reply.textContent = "Reply";
    reply.title = "Quick reply";
    reply.setAttribute("aria-label", `Quick reply to ${card.title || "conversation"}`);
    reply.addEventListener("click", () => openInboxReply(card, {
      open: () => row.click(),
      onSent: () => scheduleGroupsRefresh(0),
    }));
    item.append(reply);
  }
  if (snooze || wake) {
    const action = document.createElement("button");
    action.type = "button";
    action.className = "ghost compact ws-page-action";
    action.dataset.testid = snooze ? "workspace-page-snooze" : "workspace-page-wake";
    action.textContent = snooze ? "Snooze" : "Wake";
    action.title = snooze ? "Put it aside for now: it leaves Needs you until the time you choose or something new happens" : "Bring it back to Needs you now";
    action.addEventListener("click", () => {
      if (snooze) chooseSnooze(card, action);
      else wakeCard(card).catch((error) => toast.error(error.message));
    });
    item.append(action);
  }
  return item;
}

byId("workspaceGroupClose").addEventListener("click", closeGroupPage);
// Whatever asks for Bob's chat (a dashboard's "Ask Bob", Spotlight's "Ask Bob") shows it: a group's full list gives way.
window.addEventListener("bob-chat-wanted", closeGroupPage);
page.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); closeGroupPage(); }
});

/* ---------- the person ---------- */

let machineName = "";
function syncPerson() {
  const name = state.username || "You";
  byId("workspacePersonName").textContent = name;
  byId("workspaceAvatar").textContent = name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join("") || "·";
  byId("workspacePersonDetail").textContent = [machineName || "This machine", `${themeLabel()} theme`].join(" · ");
}
byId("workspacePersonButton").addEventListener("click", () => openAppearance());
new MutationObserver(syncPerson).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-palette"] });
// System can be chosen without the colours changing, so a theme choice anywhere updates the line too.
document.addEventListener("click", (event) => {
  if (event.target.closest?.(".theme-tile, [data-testid^='appearance-theme-'], #appearanceResetButton")) queueMicrotask(syncPerson);
});

async function loadMachine() {
  try {
    const { node } = await api("/api/cluster/node");
    machineName = node?.name ?? "";
  } catch { /* the line keeps "This machine" */ }
  syncPerson();
}

/* ---------- a project's list: its filters fold behind one button ---------- */

// The state chips, the label and cluster lists, Show done, Show scheduled and Mark all reviewed took half of the
// column, leaving room for one or two conversations. On the desktop they sit behind the Filters button beside the
// search box (styles: #conversationListPane.filters-open); the button counts the filters that are on, so a narrowed
// list never looks like the whole list. The choice is kept. The phone keeps its own filter sheet.
const FILTERS_OPEN_KEY = "joint-bob-conversation-filters-open";
const filtersPane = byId("conversationListPane");
const filtersToggle = byId("conversationFiltersToggle");
const filtersCount = byId("conversationFiltersCount");

function filtersOn() {
  return filtersPane.querySelectorAll("#chatFilters button.active:not([data-filter='all']), #conversationFilterRow .multi-select:not([hidden]) > .multi-select-trigger:not(.empty), .done-filter input:checked").length;
}
let filtersShown = -1;
function syncFilters() {
  const on = filtersOn();
  if (on === filtersShown) return;
  filtersShown = on;
  filtersCount.hidden = on === 0;
  filtersCount.textContent = on ? String(on) : "";
  filtersToggle.classList.toggle("on", on > 0);
  const label = on ? `Filters (${on} on)` : "Filters";
  filtersToggle.title = label;
  filtersToggle.setAttribute("aria-label", label);
}
function setFiltersOpen(open) {
  filtersPane.classList.toggle("filters-open", open);
  filtersToggle.setAttribute("aria-expanded", String(open));
}
filtersToggle.addEventListener("click", () => {
  const open = !filtersPane.classList.contains("filters-open");
  setFiltersOpen(open);
  try { localStorage.setItem(FILTERS_OPEN_KEY, open ? "1" : "0"); } catch { /* private mode: the choice lasts the page */ }
});
try { setFiltersOpen(localStorage.getItem(FILTERS_OPEN_KEY) === "1"); } catch { setFiltersOpen(false); }
for (const home of [byId("chatFilters"), byId("conversationFilterRow")]) {
  new MutationObserver(syncFilters).observe(home, { subtree: true, attributes: true, attributeFilter: ["class", "hidden"] });
}
// Show done and Show scheduled are also set as the list is drawn (they are kept per project).
new MutationObserver(syncFilters).observe(byId("sessionList"), { childList: true });
filtersPane.addEventListener("change", syncFilters);
window.addEventListener("project-selected", () => requestAnimationFrame(syncFilters));
syncFilters();

/* ---------- start ---------- */

/** Signed in: the running list's first answer says the session is good, so the board and the machine are read after it. */
let started = false;

function applyLayout() {
  applyPlacements();
  body.classList.toggle("ws-desktop", desktop.matches);
  if (!desktop.matches) closeGroupPage();
  else requestAnimationFrame(() => { if (desktop.matches) placeChipRow(); });
  syncColumn();
  if (started && !loaded) scheduleGroupsRefresh(0);
}
desktop.addEventListener("change", applyLayout);
applyLayout();
syncSearchKey();
syncPerson();

window.addEventListener("running-refreshed", () => {
  if (started) return;
  started = true;
  syncPerson();
  void loadMachine();
  syncColumn();
  scheduleGroupsRefresh(0);
});
