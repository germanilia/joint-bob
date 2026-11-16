// The Inbox's filters and multi-select, for the phone's Home and the "Show all" page (workspace.js draws the rows).
//   Projects : a multi-select of the projects that have conversations; nothing chosen means every project.
//   Sources  : the machines the conversations run on (this machine, a twin, another person's machine); nothing chosen means all.
//   Status   : Needs you, Running, To review, Earlier; nothing chosen means all.
//   Show     : how many Earlier conversations: by default the latest 10 of each project; the person can widen it (25 per project,
//              the last day, week or month, everything). Needs you, Running and To review are never cut: they are live and every
//              one of them stays in sight.
//   Filter   : on the phone the four choices above fold behind one "Filter" button, which counts the ones that narrow the list,
//              so Home starts with its conversations and not with two rows of boxes.
//   Select   : turns the rows into a checklist (workspace.js `cardRow`); the bar then marks the chosen ones as read or deletes them.
//              Mark read applies to the ones To review. Delete skips pinned and starred conversations (nothing may remove them
//              by accident), running ones and other people's, and says so. Move… sends the chosen ones to another machine
//              together (control-moves.js).
// One state, any number of toolbars: a change in one is shown in the others.

import { api } from "./api.js";
import { isKept } from "./control-marks.js";
import { startMoving } from "./control-moves.js";
import { createMultiSelect } from "./multi-select.js";
import { confirmAction, toast } from "./shell.js";
import { state } from "./state.js";

const RANGE_KEY = "joint-bob-inbox-range";
const DAY = 86_400_000;
const RANGES = [
  { id: "latest-10", label: "Earlier: latest 10 per project", latest: 10 },
  { id: "latest-25", label: "Earlier: latest 25 per project", latest: 25 },
  { id: "day", label: "Earlier: last 24 hours", within: DAY },
  { id: "week", label: "Earlier: last 7 days", within: 7 * DAY },
  { id: "month", label: "Earlier: last 30 days", within: 30 * DAY },
  { id: "all", label: "Earlier: everything" },
];

const keyOf = (card) => `${card.projectId}:${card.conversationId}`;
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

function storedRange() {
  try { return RANGES.find((range) => range.id === localStorage.getItem(RANGE_KEY)) ?? RANGES[0]; } catch { return RANGES[0]; }
}

const STATUSES = [
  { value: "needs-you", label: "Needs you" },
  { value: "running", label: "Running" },
  { value: "review", label: "To review" },
  { value: "earlier", label: "Earlier" },
];

/** The machine a conversation runs on: "local" for this one, else its node id. */
const sourceOf = (card) => (card.executionNodeId && card.executionNodeId !== state.localNodeId ? card.executionNodeId : "local");
/** A machine's name, as the clusters it is a member of name it. */
export function sourceName(card) {
  const source = sourceOf(card);
  if (source === "local") return "This machine";
  return state.clusters.flatMap((cluster) => cluster.members).find((member) => member.nodeId === source)?.name || source.slice(0, 8);
}

// The chosen projects are kept in this browser: the desktop column lists only them until the person widens it again.
const PROJECTS_KEY = "joint-bob-inbox-projects";
function storedProjects() {
  try { return new Set(JSON.parse(localStorage.getItem(PROJECTS_KEY) ?? "[]")); } catch { return new Set(); }
}
function chooseProjects(values) {
  projects = values;
  try { localStorage.setItem(PROJECTS_KEY, JSON.stringify([...projects])); } catch { /* private mode: the choice lasts the page */ }
  emitView();
}
let projects = storedProjects();
let sources = new Set();
let statuses = new Set();
let range = storedRange();
let selecting = false;
const selected = new Set();
const viewListeners = new Set();
const selectionListeners = new Set();

/** Filters or select mode changed: the rows are drawn again. */
export function onInboxView(listener) { viewListeners.add(listener); }
const emitView = () => { for (const listener of viewListeners) listener(); selectionChanged(); };
const selectionChanged = () => { for (const listener of selectionListeners) listener(); };

/** What the drawn rows depend on, to tell whether they must be drawn again. */
export const inboxSignature = () => JSON.stringify([[...projects], [...sources], [...statuses], range.id, selecting, [...selected]]);
/** The same without the chosen rows: a list keeps its place while rows are chosen, and starts at the top for other filters. */
export const inboxFilterKey = () => JSON.stringify([[...projects], [...sources], [...statuses], range.id, selecting]);
export const isSelecting = () => selecting;
export const isSelected = (card) => selected.has(keyOf(card));

export function toggleSelected(card) {
  const key = keyOf(card);
  if (!selected.delete(key)) selected.add(key);
  selectionChanged();
}

/** Applies the status, project and source choices, and the Show choice to Earlier. */
export function filterInbox(groupId, cards) {
  if (statuses.size && !statuses.has(groupId)) return [];
  const inProjects = cards.filter((card) => (!projects.size || projects.has(card.projectId)) && (!sources.size || sources.has(sourceOf(card))));
  if (groupId !== "earlier") return inProjects;
  if (range.within) {
    const since = Date.now() - range.within;
    return inProjects.filter((card) => Date.parse(card.updatedAt) >= since);
  }
  if (!range.latest) return inProjects;
  const kept = new Set();
  const taken = new Map();
  for (const card of [...inProjects].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))) {
    const count = taken.get(card.projectId) ?? 0;
    if (count >= range.latest) continue;
    taken.set(card.projectId, count + 1);
    kept.add(card);
  }
  return inProjects.filter((card) => kept.has(card));
}

/* ---------- the actions on the chosen ones ---------- */

async function markRead(cards, afterChange) {
  const targets = cards.filter((card) => card.column === "review" && card.updatedAt);
  if (!targets.length) { toast("Only conversations in To review can be marked as read."); return; }
  const projectIds = [...new Set(targets.map((card) => card.projectId))];
  const results = await Promise.allSettled(projectIds.map((projectId) => api(`/api/projects/${encodeURIComponent(projectId)}/sessions/reviewed-all`, {
    method: "PUT",
    body: JSON.stringify({ sessions: targets.filter((card) => card.projectId === projectId).map((card) => ({ sessionPath: card.path, updatedAt: card.updatedAt })) }),
  })));
  const failure = results.find((result) => result.status === "rejected");
  if (failure) toast.error(failure.reason.message);
  else toast(`Marked ${plural(targets.length, "conversation")} as read${targets.length < cards.length ? `; ${cards.length - targets.length} did not need it` : ""}`);
  afterChange();
}

async function deleteChosen(cards, afterChange) {
  const targets = cards.filter((card) => !isKept(card) && card.column !== "running" && !card.othersMachine);
  const skipped = cards.length - targets.length;
  if (!targets.length) { toast("Pinned, starred, running and other people's conversations are not deleted here."); return; }
  const confirmed = await confirmAction({
    title: `Delete ${plural(targets.length, "conversation")}?`,
    message: `This cannot be undone.${skipped ? ` ${plural(skipped, "pinned, starred, running or other person's conversation")} will be left alone.` : ""}`,
    confirmLabel: "Delete", destructive: true,
  });
  if (!confirmed) return;
  const results = await Promise.allSettled(targets.map((card) => api(`/api/projects/${encodeURIComponent(card.projectId)}/sessions?${new URLSearchParams({ sessionId: card.sessionId, engine: card.harnessId })}`, { method: "DELETE" })));
  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length) toast.error(`Could not delete ${failed.length} of ${targets.length}: ${failed[0].reason.message}`);
  else toast(`Deleted ${plural(targets.length, "conversation")}`);
  afterChange();
}

/* ---------- the toolbar ---------- */

function button(className, testid, text, run) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.dataset.testid = testid;
  node.textContent = text;
  node.addEventListener("click", run);
  return node;
}

/** Keeps a project multi-select's options (the projects that have conversations) and its chosen values current. */
function projectOptions(select, allCards) {
  let drawn = "";
  return () => {
    const names = new Map(allCards().map((card) => [card.projectId, card.projectName]));
    const options = [...names].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
    // A chosen project that no longer has conversations would hide everything with nothing to untick.
    if (options.length && [...projects].some((id) => !names.has(id))) chooseProjects(new Set([...projects].filter((id) => names.has(id))));
    const drawing = JSON.stringify(options);
    if (drawing !== drawn) { drawn = drawing; select.setOptions(options); }
    select.setValues(projects);
  };
}

/** The desktop column's project filter: the same choice as the toolbars', on its own above the list. */
export function createProjectFilter({ id, allCards }) {
  const select = createMultiSelect({ id: `${id}Projects`, testid: `${id}-projects`, label: "Projects", prompt: "All projects", placeholder: "Search projects" });
  select.onChange(chooseProjects);
  select.root.classList.add("inbox-column-filter");
  const update = projectOptions(select, allCards);
  selectionListeners.add(update);
  return { root: select.root, update };
}
/** Only the chosen projects' conversations (all of them when none is chosen). */
export const inChosenProjects = (cards) => (projects.size ? cards.filter((card) => projects.has(card.projectId)) : cards);

/**
 * `allCards()` is every conversation the Inbox knows (for the project list and for finding what is chosen), `visibleCards()` the
 * ones listed now (for "All shown"), `afterChange()` reads the board again after Mark read or Delete.
 */
export function createInboxToolbar({ id, allCards, visibleCards, afterChange, folded = false }) {
  const root = document.createElement("div");
  root.className = "inbox-tools";
  root.dataset.testid = `${id}-tools`;

  const projectSelect = createMultiSelect({ id: `${id}Projects`, testid: `${id}-projects`, label: "Projects", prompt: "All projects", placeholder: "Search projects" });
  projectSelect.onChange(chooseProjects);
  const sourceSelect = createMultiSelect({ id: `${id}Sources`, testid: `${id}-sources`, label: "Sources", prompt: "All sources", placeholder: "Search machines" });
  sourceSelect.onChange((values) => { sources = values; emitView(); });
  const statusSelect = createMultiSelect({ id: `${id}Statuses`, testid: `${id}-statuses`, label: "Status", prompt: "All statuses", placeholder: "Search statuses" });
  statusSelect.setOptions(STATUSES);
  statusSelect.onChange((values) => { statuses = values; emitView(); });

  const rangeSelect = document.createElement("select");
  rangeSelect.className = "inbox-range";
  rangeSelect.dataset.testid = `${id}-range`;
  rangeSelect.setAttribute("aria-label", "Show");
  for (const option of RANGES) rangeSelect.append(new Option(option.label, option.id));
  rangeSelect.addEventListener("change", () => {
    range = RANGES.find((option) => option.id === rangeSelect.value);
    try { localStorage.setItem(RANGE_KEY, range.id); } catch { /* private mode: the choice lasts the page */ }
    emitView();
  });

  const selectButton = button("inbox-select-toggle", `${id}-select`, "Select", () => {
    selecting = !selecting;
    selected.clear();
    emitView();
  });

  const filters = document.createElement("div");
  filters.className = "inbox-tools-filters";
  filters.dataset.testid = `${id}-filters`;
  filters.append(projectSelect.root, sourceSelect.root, statusSelect.root, rangeSelect);
  // Folded (the phone's Home): one row with Filter and Select; Filter opens the choices under it.
  const filterButton = button("inbox-filter-toggle", `${id}-filter`, "Filter", () => {
    filters.hidden = !filters.hidden;
    update();
  });
  const head = document.createElement("div");
  head.className = "inbox-tools-head";
  if (folded) {
    filters.hidden = true;
    head.append(filterButton, selectButton);
  } else filters.append(selectButton);

  const count = document.createElement("span");
  count.className = "inbox-bar-count";
  count.dataset.testid = `${id}-selected-count`;
  const chosen = () => allCards().filter((card) => selected.has(keyOf(card)));
  const allShown = button("inbox-bar-button", `${id}-select-all`, "All shown", () => {
    for (const card of visibleCards()) selected.add(keyOf(card));
    emitView();
  });
  const markReadButton = button("inbox-bar-button", `${id}-mark-read`, "Mark read", () => {
    const cards = chosen();
    selected.clear();
    selecting = false;
    emitView();
    void markRead(cards, afterChange);
  });
  const deleteButton = button("inbox-bar-button danger", `${id}-delete`, "Delete", () => {
    const cards = chosen();
    void deleteChosen(cards, () => { selected.clear(); selecting = false; emitView(); afterChange(); });
  });
  const bar = document.createElement("div");
  bar.className = "inbox-tools-bar";
  bar.dataset.testid = `${id}-bar`;
  const moveButton = button("inbox-bar-button", `${id}-move`, "Move…", () => {
    const cards = chosen().filter((card) => !card.othersMachine);
    if (!cards.length) { toast("Only your own conversations can be moved to another machine."); return; }
    startMoving(cards, bar, () => { selected.clear(); selecting = false; emitView(); afterChange(); }).catch((error) => toast.error(error.message));
  });
  moveButton.title = "Move the chosen conversations to another machine together";
  bar.append(count, allShown, markReadButton, moveButton, deleteButton);
  if (folded) root.classList.add("folded");
  root.append(...(folded ? [head] : []), filters, bar);

  const drawProjects = projectOptions(projectSelect, allCards);
  let sourcesDrawn = "";
  function update() {
    drawProjects();
    const machines = new Map(allCards().map((card) => [sourceOf(card), sourceName(card)]));
    const sourceOptions = [...machines].map(([value, label]) => ({ value, label })).sort((a, b) => (a.value === "local" ? -1 : b.value === "local" ? 1 : a.label.localeCompare(b.label)));
    const sourceDrawing = JSON.stringify(sourceOptions);
    if (sourceDrawing !== sourcesDrawn) { sourcesDrawn = sourceDrawing; sourceSelect.setOptions(sourceOptions); }
    sourceSelect.setValues(sources);
    statusSelect.setValues(statuses);
    rangeSelect.value = range.id;
    const narrowing = [projects.size, sources.size, statuses.size, range !== RANGES[0]].filter(Boolean).length;
    filterButton.textContent = narrowing ? `Filter · ${narrowing}` : "Filter";
    filterButton.classList.toggle("narrowing", narrowing > 0);
    filterButton.setAttribute("aria-expanded", String(!filters.hidden));
    selectButton.textContent = selecting ? "Cancel" : "Select";
    selectButton.setAttribute("aria-pressed", String(selecting));
    bar.hidden = !selecting;
    count.textContent = `${selected.size} selected`;
    markReadButton.disabled = !selected.size;
    moveButton.disabled = !selected.size;
    deleteButton.disabled = !selected.size;
  }
  selectionListeners.add(update);
  update();
  return { root, update };
}
