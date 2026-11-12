// The desktop workspace (wider than 700 px; the phone has its own layout, see focus-ui.js and phone-ui.js, and shows
// the same three groups on its Home: the projects view with the Inbox column).
//
// The left column is the navigation: brand and New, the workspace search, the places (Bob, Inbox,
// Projects, Board, Automations, Costs), then either the conversations that need you, run or wait for
// review in every project (Inbox), or the projects with the chosen project's conversations in a column beside them (Projects);
// Settings and the person at the bottom. Each group shows the rows that fit and "Show all" opens the
// group as a paged list in the middle. The column never scrolls.
//
// The conversation header keeps today's controls and ids; on the desktop a few of them move into
// the header's action slot and chip row (and back when the phone layout takes over), so every
// listener, shortcut and test id stays with its element. Docs: docs/superpowers/specs/2026-11-10-ui-redo-paper-design.md.

import { api } from "./api.js";
import { chordLabel, normalizeKeymap } from "../keymap.js";
import { openAppearance, themeLabel } from "./appearance.js";
import { currentControlView, showControlView } from "./control-views.js";
import { isControlCenterOpen, openConversation } from "./control-center.js";
import { elements } from "./elements.js";
import { currentMobileView, setMobileView } from "./layout.js";
import { startGlobalConversation } from "./new-session.js";
import { openQuickNote } from "./quick-notes.js";
import { openSpotlight } from "./spotlight.js";
import { toast } from "./shell.js";
import { state } from "./state.js";

const desktop = matchMedia("(min-width: 701px)");
const COLUMN_KEY = "joint-bob-workspace-column";
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
  // The panel's side chat, Story and Activity overview fold into the details column's More.
  ["activityChatTab", "detailsMoreMenu"],
  ["activityStoryButton", "detailsMoreMenu"],
  ["activityOverviewButton", "detailsMoreMenu"],
];

function applyPlacements() {
  if (!desktop.matches) { restoreAll(); return; }
  for (const [id, targetId] of PLACEMENTS) {
    const target = byId(targetId);
    place(byId(id), target, targetId === "chatMeta" ? byId("chatCostMeta") : null);
  }
}

/* ---------- large text: the details float when the conversation would get too narrow ---------- */

/** Below this many of the conversation's own (zoomed) pixels beside the details, the details float over the thread. */
const READABLE_MIDDLE = 420;
const chatPanel = byId("chatPanel");
function syncDetailsFloat(resized = false) {
  const zoom = parseFloat(getComputedStyle(chatPanel).zoom) || 1;
  const activityZoom = parseFloat(getComputedStyle(elements.activityPanel).zoom) || 1;
  const preferred = parseFloat(getComputedStyle(elements.activityPanel).getPropertyValue("--activity-preferred-width")) || 360;
  // The docked column's width on screen (styles cap it at 36% of the window).
  const details = Math.min(innerWidth * 0.36, preferred * zoom * activityZoom);
  const middle = (chatPanel.getBoundingClientRect().width - details) / zoom;
  const two = body.classList.contains("ws-column-projects") && !body.classList.contains("ws-picker");
  const float = desktop.matches && innerWidth > 1023 && chatPanel.getBoundingClientRect().width > 0 && middle < READABLE_MIDDLE;
  const floated = body.classList.contains("ws-details-float");
  body.classList.toggle("ws-details-float", float);
  // Beside the two columns of Projects the details give way first: when they stop fitting they are put away, not laid
  // over the conversation. Their button in the header brings them back, floating, until they fit again.
  if (!float) body.classList.remove("ws-details-tucked");
  // (A person dragging the details wider, or choosing larger text, keeps them in sight: they float, as before.)
  else if (!floated && two && resized !== true) body.classList.add("ws-details-tucked");
}
elements.activityToggleButton.addEventListener("click", (event) => {
  if (!body.classList.contains("ws-details-tucked")) return;
  body.classList.remove("ws-details-tucked");
  // The panel is open already (only put away): the press shows it and must not close it.
  if (!elements.activityPanel.hidden) { event.stopImmediatePropagation(); event.preventDefault(); }
}, true);
new ResizeObserver(() => syncDetailsFloat()).observe(chatPanel);
new MutationObserver(() => syncDetailsFloat(true)).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });

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
  const active = control ? (currentControlView() === "automations" ? "automations" : "bob")
    : view === "board" ? "board" : column;
  for (const placeButton of document.querySelectorAll(".ws-places [data-place]")) {
    const on = placeButton.dataset.place === active;
    placeButton.classList.toggle("on", on);
    if (placeButton.hasAttribute("aria-pressed")) placeButton.setAttribute("aria-pressed", String(on));
  }
  const project = state.projects?.find((item) => item.id === state.activeProjectId);
  byId("workspaceProjectNote").textContent = column === "projects" ? "" : project?.name ?? "";
}

/** Inbox and Projects are about the conversations: from the board they bring the conversation back to the middle. */
function leaveBoard() {
  closeGroupPage();
  if (currentMobileView() === "board") setMobileView(state.activeSessionId || state.activeSessionPath ? "chat" : "sessions");
}
byId("workspaceInboxButton").addEventListener("click", () => {
  leaveBoard();
  setColumn("inbox");
});
byId("workspaceProjectsButton").addEventListener("click", () => {
  leaveBoard();
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
  const side = innerWidth < 1024 ? 232 : Math.min(288, Math.max(244, innerWidth * 0.19));
  const list = body.classList.contains("chats-collapsed") ? 44 : Math.min(336, Math.max(288, innerWidth * 0.2));
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

byId("workspaceBoardButton").addEventListener("click", () => {
  if (!state.activeProjectId) {
    setColumn("projects");
    toast("Choose a project to see its board");
    return;
  }
  elements.openBoardButton.click();
});
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
    const width = menu.offsetWidth;
    const left = Math.max(8, Math.min(anchor.left, innerWidth - width - 8));
    const below = anchor.bottom + 6;
    const top = below + menu.offsetHeight > innerHeight - 8 ? Math.max(8, anchor.top - menu.offsetHeight - 6) : below;
    Object.assign(menu.style, { left: `${left}px`, top: `${top}px` });
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
anchorMenu(byId("detailsMoreMenu"), byId("detailsMoreButton"));

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

/* ---------- the groups: Needs you, Running, To review ---------- */

export const GROUPS = [
  { id: "needs-you", title: "Needs you", dot: "need", empty: "Nothing waits for you." },
  { id: "running", title: "Running", dot: "run", empty: "Nothing is running." },
  { id: "review", title: "To review", dot: "rev", empty: "Nothing to review." },
];
let cards = [];
let loaded = false;

function cardsIn(groupId) {
  return cards.filter((card) => card.column === groupId);
}

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
  return [card.projectName, what].filter(Boolean).join(" · ");
}

function cardRow(card, group, testid) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "ws-row";
  row.dataset.testid = testid;
  row.dataset.key = `${card.projectId}:${card.conversationId}`;
  row.classList.toggle("sel", isActiveCard(card));
  row.title = `${card.title} · ${card.projectName}`;
  const dot = document.createElement("i");
  dot.className = `ws-dot ${group.dot}`;
  dot.setAttribute("aria-hidden", "true");
  const copy = document.createElement("span");
  copy.className = "ws-row-copy";
  const top = document.createElement("span");
  top.className = "ws-row-top";
  const title = document.createElement("b");
  title.textContent = card.title || "Conversation";
  const time = document.createElement("time");
  time.textContent = timeLabel(card.updatedAt);
  if (card.updatedAt) time.dateTime = card.updatedAt;
  top.append(title, time);
  const line = document.createElement("span");
  line.className = "ws-row-line";
  line.textContent = cardLine(card);
  copy.append(top, line);
  row.append(dot, copy);
  row.addEventListener("click", () => {
    closeGroupPage();
    openConversation(card).catch((error) => toast.error(error.message));
  });
  return row;
}

const groupsHost = byId("workspaceGroups");
// A group's label and its "nothing here" line; the phone sets taller ones (phone.css: --ws-lab-height, --ws-empty-height).
const LABEL_HEIGHT = 34;
const EMPTY_HEIGHT = 26;
function cssHeight(name, fallback) {
  return parseFloat(getComputedStyle(groupsHost).getPropertyValue(name)) || fallback;
}

/** The phone's Home draws what needs you as cards; home.js gives the card (`waitingCard`). */
let needCard = null;
export function useNeedCards(render) {
  needCard = render;
  renderGroups();
}

/** Each group shows the rows that fit: rows are dealt one at a time in group order, so a long group cannot starve the others. */
function renderGroups(refit = true) {
  if (!groupsShown()) return;
  // Words being written for Push it on on a card are not drawn away; the card draws the groups again when it closes.
  if (groupsHost.querySelector(".ws-wait.pushing")) return;
  const counts = GROUPS.map((group) => cardsIn(group.id).length);
  const sample = groupsHost.querySelector(".ws-row");
  const rowHeight = sample ? sample.getBoundingClientRect().height + 2 : 52;
  // The phone's Home shows what needs you as cards with their actions (home.js), as the desktop's Home does.
  const cardsHere = Boolean(needCard) && phoneHomeShown();
  const cardSample = groupsHost.querySelector(".ws-wait");
  const cardHeight = cardSample ? cardSample.getBoundingClientRect().height + 8 : 160;
  const heightOf = (index) => (cardsHere && GROUPS[index].id === "needs-you" ? cardHeight : rowHeight);
  const room = groupsHost.clientHeight;
  let budget = room - GROUPS.length * cssHeight("--ws-lab-height", LABEL_HEIGHT) - counts.filter((count) => !count).length * cssHeight("--ws-empty-height", EMPTY_HEIGHT);
  const shown = GROUPS.map(() => 0);
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
  groupsHost.replaceChildren(...GROUPS.map((group, index) => {
    const section = document.createElement("section");
    section.className = "ws-group";
    section.dataset.group = group.id;
    section.dataset.testid = `workspace-group-${group.id}`;
    const label = document.createElement("div");
    label.className = "ws-lab";
    const name = document.createElement("span");
    name.textContent = group.title;
    const count = document.createElement("i");
    count.dataset.testid = `workspace-group-count-${group.id}`;
    count.textContent = loaded ? String(counts[index]) : "…";
    label.append(name, count);
    if (counts[index] > shown[index] || (counts[index] && room && shown[index] === 0)) {
      const all = document.createElement("button");
      all.type = "button";
      all.className = "ws-show-all";
      all.dataset.testid = `workspace-show-all-${group.id}`;
      all.textContent = "Show all";
      all.setAttribute("aria-label", `Show all ${counts[index]}: ${group.title}`);
      all.addEventListener("click", () => openGroupPage(group.id));
      label.append(all);
    }
    section.append(label);
    if (loaded && !counts[index]) {
      const empty = document.createElement("p");
      empty.className = "ws-empty";
      empty.textContent = group.empty;
      section.append(empty);
    }
    for (const card of cardsIn(group.id).slice(0, shown[index])) {
      section.append(cardsHere && group.id === "needs-you" ? needCard(card) : cardRow(card, group, "workspace-group-row"));
    }
    return section;
  }));
  // The first render measures a row; a different height deals again once.
  const measured = groupsHost.querySelector(".ws-row");
  const measuredCard = groupsHost.querySelector(".ws-wait");
  // A first render (or one after the phone and the desktop swapped) measured another row height: deal again once.
  if (refit && ((measured && Math.abs(measured.getBoundingClientRect().height + 2 - rowHeight) > 1)
    || (measuredCard && Math.abs(measuredCard.getBoundingClientRect().height + 8 - cardHeight) > 1))) renderGroups(false);
  syncInboxNote();
}

function syncInboxNote() {
  const needs = cardsIn("needs-you").length;
  const note = byId("workspaceInboxNote");
  note.textContent = needs ? `${needs} need${needs === 1 ? "s" : ""} you` : "";
  note.classList.toggle("needs", needs > 0);
}

new ResizeObserver(() => requestAnimationFrame(() => {
  renderGroups();
  if (!page.hidden) renderGroupPage();
})).observe(groupsHost);

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
      const board = await api("/api/control-center/board?look=1");
      acceptCards(board.cards || []);
    } while (again);
  })().catch((error) => console.warn("Could not read the workspace groups", error)).finally(() => { refreshing = null; });
  return refreshing;
}

function acceptCards(next) {
  cards = next;
  loaded = true;
  // The phone's greeting and its Inbox tab count them (phone-ui.js).
  window.dispatchEvent(new CustomEvent("workspace-groups-counted", { detail: Object.fromEntries(GROUPS.map((group) => [group.id, cardsIn(group.id).length])) }));
  // Home (home.js) draws the same cards in the middle.
  window.dispatchEvent(new CustomEvent("workspace-cards", { detail: { cards } }));
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
// The control center reads the same board; its answer is used as it arrives.
window.addEventListener("control-center-rendered", (event) => { if (event.detail?.cards) acceptCards(event.detail.cards); });
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

/* ---------- Show all: one group as a paged list in the middle ---------- */

const page = byId("workspaceGroupPage");
const pageList = byId("workspaceGroupList");
let pageGroup = "needs-you";
let pageIndex = 0;
let pageSize = 8;

export function openGroupPage(groupId) {
  pageGroup = groupId;
  pageIndex = 0;
  page.hidden = false;
  body.classList.add("ws-page-open");
  renderGroupPage();
  byId("workspaceGroupClose").focus({ preventScroll: true });
}

export function closeGroupPage() {
  if (page.hidden) return;
  page.hidden = true;
  body.classList.remove("ws-page-open");
}

function renderGroupPage(refit = true) {
  const group = GROUPS.find((item) => item.id === pageGroup) ?? GROUPS[0];
  byId("workspaceGroupTitle").textContent = group.title;
  byId("workspaceGroupTabs").replaceChildren(...GROUPS.map((item) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(item.id === group.id));
    tab.dataset.testid = `workspace-group-tab-${item.id}`;
    tab.append(item.title, Object.assign(document.createElement("b"), { textContent: String(cardsIn(item.id).length) }));
    tab.addEventListener("click", () => { pageGroup = item.id; pageIndex = 0; renderGroupPage(); });
    return tab;
  }));
  const items = cardsIn(group.id);
  // Rows share one height, so the page holds the whole rows that fit above the pager.
  const sample = pageList.querySelector(".ws-row");
  const rowHeight = sample ? sample.getBoundingClientRect().height + 6 : 70;
  const room = pageList.clientHeight || (page.clientHeight - 160);
  pageSize = Math.max(1, Math.floor((room + 6) / rowHeight));
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  pageIndex = Math.min(pageIndex, pages - 1);
  const slice = items.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
  pageList.replaceChildren(...slice.map((card) => {
    const row = cardRow(card, group, "workspace-group-page-row");
    row.classList.add("wide");
    return row;
  }));
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "ws-empty";
    empty.textContent = loaded ? group.empty : "Loading…";
    pageList.append(empty);
  }
  byId("workspaceGroupPager").hidden = items.length <= pageSize;
  byId("workspaceGroupPosition").textContent = items.length ? `${pageIndex * pageSize + 1}–${Math.min(items.length, (pageIndex + 1) * pageSize)} of ${items.length}` : "";
  byId("workspaceGroupPrevious").disabled = pageIndex === 0;
  byId("workspaceGroupNext").disabled = pageIndex >= pages - 1;
  // A first page drawn before a row could be measured is fitted again once.
  const measured = pageList.querySelector(".ws-row");
  if (refit && measured && Math.abs(measured.getBoundingClientRect().height + 6 - rowHeight) > 1) renderGroupPage(false);
}

byId("workspaceGroupClose").addEventListener("click", closeGroupPage);
byId("workspaceGroupPrevious").addEventListener("click", () => { pageIndex -= 1; renderGroupPage(); });
byId("workspaceGroupNext").addEventListener("click", () => { pageIndex += 1; renderGroupPage(); });
page.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); closeGroupPage(); }
});
new ResizeObserver(() => { if (!page.hidden) requestAnimationFrame(renderGroupPage); }).observe(page);

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
