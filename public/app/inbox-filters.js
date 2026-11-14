// The Inbox's filters and multi-select, for the phone's Home and the "Show all" page (workspace.js draws the rows).
//   Projects : a multi-select of the projects that have conversations; nothing chosen means every project.
//   Show     : by default the latest 10 conversations of each project; the person can widen it (25 per project, the last day,
//              week or month, everything). Needs you is never cut by date: what waits for the person must stay in sight.
//   Select   : turns the rows into a checklist (workspace.js `cardRow`); the bar then marks the chosen ones as read or deletes them.
//              Mark read applies to the ones To review. Delete skips pinned and starred conversations (nothing may remove them
//              by accident) and running ones, and says so.
// One state, any number of toolbars: a change in one is shown in the others.

import { api } from "./api.js";
import { isKept } from "./control-marks.js";
import { createMultiSelect } from "./multi-select.js";
import { confirmAction, toast } from "./shell.js";

const RANGE_KEY = "joint-bob-inbox-range";
const DAY = 86_400_000;
const RANGES = [
  { id: "latest-10", label: "Latest 10 per project", latest: 10 },
  { id: "latest-25", label: "Latest 25 per project", latest: 25 },
  { id: "day", label: "Last 24 hours", within: DAY },
  { id: "week", label: "Last 7 days", within: 7 * DAY },
  { id: "month", label: "Last 30 days", within: 30 * DAY },
  { id: "all", label: "Everything" },
];

const keyOf = (card) => `${card.projectId}:${card.conversationId}`;
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

function storedRange() {
  try { return RANGES.find((range) => range.id === localStorage.getItem(RANGE_KEY)) ?? RANGES[0]; } catch { return RANGES[0]; }
}

let projects = new Set();
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
export const inboxSignature = () => JSON.stringify([[...projects], range.id, selecting, [...selected]]);
/** The same without the chosen rows: a list keeps its place while rows are chosen, and starts at the top for other filters. */
export const inboxFilterKey = () => JSON.stringify([[...projects], range.id, selecting]);
export const isSelecting = () => selecting;
export const isSelected = (card) => selected.has(keyOf(card));

export function toggleSelected(card) {
  const key = keyOf(card);
  if (!selected.delete(key)) selected.add(key);
  selectionChanged();
}

/** Applies the project choice, and the Show choice except to Needs you. */
export function filterInbox(groupId, cards) {
  const inProjects = projects.size ? cards.filter((card) => projects.has(card.projectId)) : cards;
  if (groupId === "needs-you") return inProjects;
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
  const targets = cards.filter((card) => !isKept(card) && card.column !== "running");
  const skipped = cards.length - targets.length;
  if (!targets.length) { toast("Pinned, starred and running conversations are not deleted here."); return; }
  const confirmed = await confirmAction({
    title: `Delete ${plural(targets.length, "conversation")}?`,
    message: `This cannot be undone.${skipped ? ` ${plural(skipped, "pinned, starred or running conversation")} will be left alone.` : ""}`,
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

/**
 * `allCards()` is every conversation the Inbox knows (for the project list and for finding what is chosen), `visibleCards()` the
 * ones listed now (for "All shown"), `afterChange()` reads the board again after Mark read or Delete.
 */
export function createInboxToolbar({ id, allCards, visibleCards, afterChange }) {
  const root = document.createElement("div");
  root.className = "inbox-tools";
  root.dataset.testid = `${id}-tools`;

  const projectSelect = createMultiSelect({ id: `${id}Projects`, testid: `${id}-projects`, label: "Projects", prompt: "All projects", placeholder: "Search projects" });
  projectSelect.onChange((values) => { projects = values; emitView(); });

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
  filters.append(projectSelect.root, rangeSelect, selectButton);

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
  bar.append(count, allShown, markReadButton, deleteButton);
  root.append(filters, bar);

  let projectsDrawn = "";
  function update() {
    const names = new Map(allCards().map((card) => [card.projectId, card.projectName]));
    const options = [...names].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
    const drawing = JSON.stringify(options);
    if (drawing !== projectsDrawn) { projectsDrawn = drawing; projectSelect.setOptions(options); }
    projectSelect.setValues(projects);
    rangeSelect.value = range.id;
    selectButton.textContent = selecting ? "Cancel" : "Select";
    selectButton.setAttribute("aria-pressed", String(selecting));
    bar.hidden = !selecting;
    count.textContent = `${selected.size} selected`;
    markReadButton.disabled = !selected.size;
    deleteButton.disabled = !selected.size;
  }
  selectionListeners.add(update);
  update();
  return { root, update };
}
