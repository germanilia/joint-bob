// Live agents as a list, like a mail inbox (version B of the 14 Nov mocks): a narrow list on the left, the chosen conversation
// in a wide panel on the right (control-list-preview.js). Nothing here takes control of a conversation.
//   The list  : one scrolling list, two lines per conversation, grouped by project or by date. System messages come first
//               (control-system.js), then pinned conversations, then the rest. It never pages.
//   Scopes    : Inbox (what runs or waits), Past (marked done), All, Starred, and a folder. Past conversations are read from the
//               server when a scope or a search needs them.
//   Search    : one box over titles, projects, agents, folders and what the conversations say (inbox-search.js).
//   Marks     : pin, star, folder and delete, on a row's hover buttons and in the panel's head (control-marks.js).
// The list is drawn into elements that stay in the page, so a redraw keeps the scroll, the search box and the half-typed message.
// Styles: the end of public/bob-page.css. The card board (control-center.js) draws the same cards the other way.

import { api } from "./api.js";
import { briefStatus, projectActionList } from "./control-cards.js";
import { drawPreview } from "./control-list-preview.js";
import { deleteConversation, folderMenu, folderNames, folderOf, isDeleting, isKept, isPinned, isStarred, popMenu, togglePin, toggleStar } from "./control-marks.js";
import { loadSystem, systemList } from "./control-system.js";
import { searchFields, segments, snippet } from "./inbox-search.js";
import { toast } from "./shell.js";
import { state } from "./state.js";

const STATES = { "needs-you": "Needs you", running: "Running", review: "To review", snoozed: "Snoozed", done: "Done" };
const ORDER = Object.keys(STATES);
const INBOX = ["needs-you", "running", "review", "snoozed"];
const SCOPES = [["inbox", "Inbox", (card) => card.column !== "done"], ["past", "Past", (card) => card.column === "done"], ["all", "All", () => true], ["starred", "★", isStarred]];
const LIST_GROUP_KEY = "jointBobListGroup";
const LIST_WIDTH_KEY = "jointBobListWidth";
const MIN_WIDTH = 280;
const MAX_WIDTH = 640;
const PAST_FRESH_MS = 60_000;
const SYSTEM_EVERY_MS = 60_000;

const SVG_NS = "http://www.w3.org/2000/svg";
const ICON_PATHS = {
  pin: ["M7 3h6l-1 5 3 3H5l3-3z", "M10 11v6"],
  star: ["M10 2.5l2.3 4.8 5.2.7-3.8 3.6.9 5.2L10 14.3l-4.6 2.5.9-5.2L2.5 8l5.2-.7z"],
  folder: ["M2.5 6a1 1 0 011-1h4l2 2h7a1 1 0 011 1v7a1 1 0 01-1 1h-13a1 1 0 01-1-1z"],
  delete: ["M3.5 6h13", "M8 6V4h4v2", "M5.5 6l.8 11h7.4l.8-11"],
  search: ["M14 8.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z", "m13 13 4 4"],
  warn: ["M10 3l8 14H2z", "M10 8.5v3.5", "M10 14.6v.01"],
};

const cardKey = (card) => `${card.projectId}:${card.conversationId}`;
const entryKey = (entry) => (entry.system ? `system:${entry.id}` : cardKey(entry));

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(className, testid, text, run) {
  const node = element("button", className, text);
  node.type = "button";
  node.dataset.testid = testid;
  node.addEventListener("click", run);
  return node;
}
/** A small drawn icon, made as SVG nodes. */
function svgIcon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICON_PATHS[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
function icon(name) {
  const node = element("span", `control-list-ic ${name}`);
  node.append(svgIcon(name));
  return node;
}
/** Text with its matched words in <mark>. */
function appendParts(node, parts) {
  for (const part of parts) node.append(part.match ? Object.assign(document.createElement("mark"), { textContent: part.text }) : part.text);
}

let ui = null;
let last = null;
let selectedKey = null;
let past = [];
let pastReadAt = 0;
let pastLoading = false;
const view = { tab: "summary", query: "", scope: "inbox", rememberScope: null, group: localStorage.getItem(LIST_GROUP_KEY) === "date" ? "date" : "project" };

/* ---------- what there is: board cards, past conversations, system messages ---------- */

/** A conversation marked done looks like a board card, in the column "done". */
function pastCard(item, helpers) {
  return {
    ...item, column: "done", updatedAt: item.doneAt, pendingReviews: [], autoRespondStop: null, controlledBy: null, reviewCheck: null, snooze: null,
    activity: null, turnRunning: false, backgroundRunning: false, startedBy: "you", executionNodeId: null, projectColor: helpers.projectColor(item.projectId),
  };
}

function everything(cards, helpers) {
  const onBoard = new Set(cards.map(cardKey));
  const board = cards.map((card) => ({ ...card, projectColor: helpers.projectColor(card.projectId) }));
  // The project filter of the board limits the past ones too.
  const chosen = state.controlCenter.filter;
  const done = past.filter((item) => !onBoard.has(cardKey(item)) && (!chosen.length || chosen.includes(item.projectId))).map((item) => pastCard(item, helpers));
  return [...board, ...done].filter((card) => !isDeleting(card));
}

/** What the row says: what the person must decide, or what the agent is doing now. */
function statusText(card) {
  const [review] = card.pendingReviews ?? [];
  if (review) return [review.title, review.subject].filter(Boolean).join(" · ");
  if (card.autoRespondStop) return `Auto respond stopped: ${card.autoRespondStop.reason || card.autoRespondStop.kind}`;
  if (card.column === "needs-you" && card.reviewCheck?.reason) return card.reviewCheck.reason;
  if (card.column === "done") return briefStatus(card.summary) ?? "Done.";
  return card.activity ?? briefStatus(card.summary) ?? (card.column === "running" ? "Working…" : "Finished. Open it to review.");
}

const scopeFilter = (scope) => (scope.startsWith("folder:") ? (card) => folderOf(card) === scope.slice(7) : SCOPES.find(([id]) => id === scope)[2]);

function searchCard(card, query) {
  return searchFields([["title", 3, card.title], ["project", 2, card.projectName], ["agent", 1.5, `${card.agentLabel ?? ""} ${card.agentModel ?? ""}`],
    ["folder", 1.5, folderOf(card) ?? ""], ["status", 1, statusText(card)], ["body", 0.6, card.summary ?? ""]], query);
}
const searchMessage = (message, query) => searchFields([["title", 3, message.title], ["short", 1, message.short], ["where", 1, `${message.where} system`], ["steps", 0.5, message.steps.join(" ")]], query);

/** The scope and the search applied; the order is best match first when searching, else by date or by project. */
function visible(all) {
  const query = view.query.trim();
  const found = all.filter(scopeFilter(view.scope)).map((card) => ({ card, match: query ? searchCard(card, query) : null })).filter((item) => !query || item.match);
  const newest = (a, b) => (b.card.updatedAt ?? "").localeCompare(a.card.updatedAt ?? "");
  if (query) return found.sort((a, b) => b.match.score - a.match.score || newest(a, b));
  if (view.group === "date") return found.sort(newest);
  return found.sort((a, b) => a.card.projectName.localeCompare(b.card.projectName) || ORDER.indexOf(a.card.column) - ORDER.indexOf(b.card.column) || newest(a, b));
}

/* ---------- time ---------- */

/** The time today, else the day. */
function when(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : date.toLocaleDateString([], { day: "numeric", month: "short" });
}
function dayLabel(iso) {
  if (!iso) return "Earlier";
  const date = new Date(iso);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(date).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "This week";
  return date.toLocaleDateString([], { month: "long", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

/* ---------- the frame, kept in the page ---------- */

function buildFrame(container, helpers) {
  const root = element("div", "control-list");
  root.dataset.testid = "control-list";
  root.style.setProperty("--list-w", `${Number(localStorage.getItem(LIST_WIDTH_KEY)) || 360}px`);
  const search = element("label", "control-list-search");
  search.append(icon("search"));
  const input = element("input");
  input.placeholder = "Search every conversation…";
  input.spellcheck = false;
  input.dataset.testid = "control-list-search";
  const clear = button("control-list-clear", "control-list-clear", "×", () => { input.value = ""; typed(); input.focus(); });
  clear.title = "Clear (Esc)";
  clear.hidden = true;
  search.append(input, clear);
  const chips = element("div", "control-list-chips");
  chips.dataset.testid = "control-list-chips";
  const head = element("div", "control-list-head");
  head.append(search, chips);
  const rows = element("div", "control-list-rows");
  rows.dataset.testid = "control-list-rows";
  const left = element("div", "control-list-left");
  left.append(head, rows);
  const preview = element("aside", "control-list-preview");
  preview.dataset.testid = "control-list-preview";
  const grip = element("div", "control-list-grip");
  grip.title = "Drag to change the width of the list";
  grip.dataset.testid = "control-list-grip";
  root.append(left, grip, preview);

  const typed = () => {
    view.query = input.value;
    // Typing searches everything, even from the inbox; clearing the search goes back to where it was.
    if (view.query.trim() && view.scope === "inbox") { view.rememberScope = "inbox"; view.scope = "all"; }
    if (!view.query.trim() && view.rememberScope) { view.scope = view.rememberScope; view.rememberScope = null; }
    redraw();
  };
  input.addEventListener("input", typed);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { input.value = ""; typed(); input.blur(); event.stopPropagation(); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); move(event.key === "ArrowDown" ? 1 : -1, false); }
  });
  root.addEventListener("keydown", (event) => {
    if (/^(INPUT|TEXTAREA)$/.test(event.target.tagName) || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); move(event.key === "ArrowDown" ? 1 : -1, true); return; }
    if (event.key === "/") { event.preventDefault(); input.focus(); return; }
    const entry = selectedEntry();
    if (!entry || entry.system) return;
    if (event.key === "p") { event.preventDefault(); void markPin(entry); }
    else if (event.key === "s") { event.preventDefault(); markStar(entry); }
    else if (event.key === "Delete" || event.key === "#") { event.preventDefault(); markDelete(entry); }
  });
  grip.addEventListener("pointerdown", (event) => {
    grip.setPointerCapture(event.pointerId);
    grip.classList.add("drag");
    const move = (moved) => {
      const rect = root.getBoundingClientRect();
      // The stage may be zoomed: the pointer is in screen pixels, the width in the page's.
      const width = (moved.clientX - rect.left) * (root.offsetWidth / rect.width);
      root.style.setProperty("--list-w", `${Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)))}px`);
    };
    const done = () => {
      grip.classList.remove("drag");
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", done);
      localStorage.setItem(LIST_WIDTH_KEY, String(parseInt(root.style.getPropertyValue("--list-w"), 10)));
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", done);
  });
  container.replaceChildren(root);
  setInterval(() => { if (root.isConnected) refreshSystem(true); }, SYSTEM_EVERY_MS);
  return { root, input, clear, chips, rows, preview, helpers };
}

const redraw = () => last && renderList(...last);

/* ---------- the toolbar's "Open ↗": the chosen conversation, beside + New conversation ---------- */

let openButton = null;
/** One persistent button; the board's toolbar places it (control-center.js) and it follows the selection. */
export function listOpenButton(helpers) {
  if (!openButton) {
    openButton = button("control-list-open-button", "control-list-open", "Open ↗", () => {
      const entry = selectedEntry();
      if (entry && !entry.system) helpers.openConversation(entry).catch((error) => toast.error(error.message));
    });
  }
  return openButton;
}
function syncOpenButton() {
  if (!openButton) return;
  const entry = selectedEntry();
  openButton.hidden = !entry || entry.system;
  openButton.title = entry && !entry.system ? `Open “${entry.title}”` : "";
}

/* ---------- selection ---------- */

let entries = [];
const selectedEntry = () => entries.find((entry) => entryKey(entry) === selectedKey);

/** Arrow keys: the next or the previous row of the list as it is drawn. */
function move(step, focus) {
  const keys = [...ui.rows.querySelectorAll(".control-list-row")].map((row) => row.dataset.key);
  const next = keys[keys.indexOf(selectedKey) + step];
  if (!next) return;
  selectedKey = next;
  redraw();
  if (focus) ui.rows.querySelector(`.control-list-row[data-key="${CSS.escape(next)}"]`)?.focus();
}

function select(key) {
  selectedKey = key;
  redraw();
}

/* ---------- pin, star, folder, delete ---------- */

function markPin(card) {
  const result = togglePin(card);
  redraw();
  return result.catch((error) => toast.error(error.message));
}
function markStar(card) {
  toggleStar(card, last[2].saveControlCenter);
  redraw();
}
function markDelete(card) {
  deleteConversation(card, { redraw, refresh: last[2].refresh });
}

function tools(card) {
  const group = element("span", "control-list-tools");
  const items = [
    ["pin", isPinned(card), isPinned(card) ? "Unpin" : "Pin to the top", () => markPin(card)],
    ["star", isStarred(card), isStarred(card) ? "Remove the star" : "Star: no automatic cleanup deletes it", () => markStar(card)],
    ["folder", Boolean(folderOf(card)), folderOf(card) ? `In “${folderOf(card)}”: move or remove` : "Move to a folder", (anchor) => folderMenu(anchor, card, last[2].saveControlCenter, redraw)],
    ["delete", false, isKept(card) ? "Delete now (it is kept: asks twice)" : "Delete now (undo for a few seconds)", () => markDelete(card)],
  ];
  for (const [id, on, title, run] of items) {
    const tool = element("button", `control-list-tool ${id}${on ? " on" : ""}`);
    tool.type = "button";
    tool.append(svgIcon(id));
    tool.title = title;
    tool.dataset.testid = `control-list-${id}`;
    tool.setAttribute("aria-label", title);
    tool.addEventListener("click", (event) => { event.stopPropagation(); void run(tool); });
    group.append(tool);
  }
  return group;
}

/* ---------- reading what is not on the board ---------- */

function refreshPast() {
  // Read once when the list first opens (the Past count needs it), then again when a scope or a search wants it.
  const wanted = pastReadAt === 0 || view.scope !== "inbox" || view.query.trim();
  if (!wanted || pastLoading || Date.now() - pastReadAt < PAST_FRESH_MS) return;
  pastLoading = true;
  api("/api/control-center/past")
    .then(({ conversations }) => { past = conversations; })
    .catch((error) => console.warn("Could not read the past conversations", error))
    .finally(() => { pastLoading = false; pastReadAt = Date.now(); redraw(); });
}

function refreshSystem(force = false) {
  loadSystem({ force }).then((changed) => { if (changed) redraw(); }).catch((error) => console.warn("Could not read the system messages", error));
}

/* ---------- drawing ---------- */

/** Draws the list into the board's element; the board's own cards are not drawn. */
export function renderList(container, cards, helpers) {
  last = [container, cards, helpers];
  if (!ui || !container.contains(ui.root)) ui = buildFrame(container, helpers);
  refreshPast();
  refreshSystem();
  const all = everything(cards, helpers);
  const query = view.query.trim();
  const messages = systemList().filter((message) => !query || searchMessage(message, query));
  entries = [...messages.map((message) => ({ ...message, system: true })), ...all];
  // The first conversation opened is the first that needs the person, else the first of the board; with nothing on the board, the first system message, else the first past one.
  if (!selectedEntry()) selectedKey = entries.length ? entryKey(entries.find((entry) => entry.column === "needs-you") ?? entries.find((entry) => !entry.system && entry.column !== "done") ?? entries[0]) : null;
  const items = visible(all);
  drawChips(all);
  drawRows(items, messages, helpers, all);
  syncOpenButton();
  const chosen = selectedEntry();
  if (!chosen) {
    ui.preview.dataset.kind = "empty";
    ui.preview.replaceChildren(element("p", "control-list-note", "Choose a conversation to read it here."));
    return;
  }
  drawPreview(ui.preview, chosen, { helpers, tab: view.tab, setTab: (tab) => { view.tab = tab; redraw(); }, tools, checkAgain: () => loadSystem({ force: true }).then(redraw) });
}

function drawChips(all) {
  const query = view.query.trim();
  const count = (inScope) => all.filter(inScope).filter((card) => !query || searchCard(card, query)).length;
  ui.chips.replaceChildren();
  for (const [id, label, inScope] of SCOPES) {
    const chip = element("button", `control-list-chip ${id}`);
    chip.type = "button";
    chip.dataset.testid = `control-list-scope-${id}`;
    chip.setAttribute("aria-pressed", String(view.scope === id));
    if (id === "starred") { chip.append(svgIcon("star")); chip.title = "Starred"; } else chip.append(label);
    chip.append(element("em", "", String(count(inScope))));
    chip.addEventListener("click", () => { view.scope = id; view.rememberScope = null; redraw(); });
    ui.chips.append(chip);
  }
  const inFolder = view.scope.startsWith("folder:");
  const folder = element("button", "control-list-chip folder");
  folder.type = "button";
  folder.dataset.testid = "control-list-scope-folder";
  folder.setAttribute("aria-pressed", String(inFolder));
  folder.title = "Folders";
  folder.append(svgIcon("folder"));
  if (inFolder) folder.append(` ${view.scope.slice(7)}`, element("em", "", String(count(scopeFilter(view.scope)))));
  folder.append(" ▾");
  folder.addEventListener("click", () => openFolders(folder, all));
  ui.chips.append(folder, element("span", "control-spacer"));
  if (!query) {
    const group = element("span", "control-list-group");
    for (const [id, label] of [["project", "Project"], ["date", "Date"]]) {
      const choice = button("", `control-list-group-${id}`, label, () => { view.group = id; localStorage.setItem(LIST_GROUP_KEY, id); redraw(); });
      choice.setAttribute("aria-pressed", String(view.group === id));
      group.append(choice);
    }
    ui.chips.append(group);
  }
}

/** The folders: each with how many conversations it holds, and a box for a new name (made when a conversation is put in it). */
function openFolders(anchor, all) {
  const choose = (scope) => { view.scope = scope; view.rememberScope = null; redraw(); };
  const names = folderNames();
  popMenu(anchor, [
    ...names.map((name) => ({ label: `${name}  ·  ${all.filter((card) => folderOf(card) === name).length}`, checked: view.scope === `folder:${name}`, run: () => choose(`folder:${name}`) })),
    ...(names.length ? [] : [{ label: "No folders yet: use a conversation's folder button", run: () => undefined }]),
    ...(view.scope.startsWith("folder:") ? [{ label: "Back to the inbox", run: () => choose("inbox") }] : []),
  ]);
}

function drawRows(items, messages, helpers, all) {
  const focused = ui.rows.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  const scroll = ui.rows.scrollTop;
  const query = view.query.trim();
  ui.rows.replaceChildren();
  if (messages.length) ui.rows.append(systemHead(messages), ...messages.map((message) => systemRow(message)));
  if (query) ui.rows.append(foundLine(items.length, query));
  else if (view.scope === "inbox") ui.rows.append(summary(all, helpers));
  const pinned = query ? [] : items.filter((item) => isPinned(item.card));
  const rest = query ? items : items.filter((item) => !isPinned(item.card));
  if (!items.length) ui.rows.append(emptyNote(all, query));
  if (pinned.length) ui.rows.append(pinnedHead(pinned.length), ...pinned.map((item) => row(item, helpers)));
  let section = null;
  for (const item of rest) {
    const key = query ? null : view.group === "date" ? dayLabel(item.card.updatedAt) : item.card.projectId;
    if (key !== section) {
      section = key;
      if (key && view.group === "date") ui.rows.append(dayHead(key, rest.filter((other) => dayLabel(other.card.updatedAt) === key).length));
      else if (key) ui.rows.append(projectHead(rest.filter((other) => other.card.projectId === key).map((other) => other.card)));
    }
    ui.rows.append(row(item, helpers));
  }
  ui.rows.scrollTop = scroll;
  ui.clear.hidden = !ui.input.value;
  if (focused) ui.rows.querySelector(`.control-list-row[data-key="${CSS.escape(focused)}"]`)?.focus();
}

function summary(all, helpers) {
  const node = element("div", "control-list-summary");
  node.dataset.testid = "control-list-summary";
  for (const column of INBOX) {
    const count = all.filter((card) => card.column === column).length;
    if (!count) continue;
    const item = element("span", `control-list-count ${column}`);
    item.dataset.testid = `control-list-count-${column}`;
    item.append(element("b", "", String(count)), ` ${STATES[column]}`);
    node.append(item);
  }
  const done = element("span", "control-list-count star", `★ ${helpers.finished()} finished while watching`);
  done.dataset.testid = "control-score-finished";
  done.title = "Conversations that finished while you watched";
  node.append(done);
  return node;
}

function foundLine(count, query) {
  const node = element("div", "control-list-found");
  node.dataset.testid = "control-list-found";
  node.append(element("b", "", String(count)), ` result${count === 1 ? "" : "s"} for “${query}” · best match first`);
  return node;
}

function emptyNote(all, query) {
  const node = element("div", "control-list-empty");
  node.dataset.testid = "control-list-empty";
  const inFolder = view.scope.startsWith("folder:");
  const text = query ? "Nothing found. Try fewer words, or check the spelling: typos still match, but not wrong words."
    : inFolder ? "Nothing is in this folder yet. Put a conversation in it with the folder button."
      : view.scope === "past" ? "No conversation has been marked done yet."
        : view.scope === "starred" ? "Star a conversation to keep it here, safe from automatic deletion."
          : "No conversations are running and nothing is waiting for review. Past holds the finished ones.";
  node.append(element("b", "", query ? "Nothing found." : "Nothing here."), element("p", "", text));
  return node;
}

/* ---------- the rows ---------- */

function systemHead(messages) {
  const head = element("div", "control-list-section-head system");
  head.dataset.testid = "control-sys-head";
  head.append(element("b", "", "System"), element("span", "control-project-count", String(messages.length)), element("span", "control-spacer"), element("small", "", "fix these first"));
  return head;
}

function systemRow(message) {
  const node = element("div", `control-list-row system ${message.severity}${entryKey({ ...message, system: true }) === selectedKey ? " selected" : ""}`);
  node.tabIndex = 0;
  node.setAttribute("role", "button");
  node.dataset.testid = "control-sys-row";
  node.dataset.key = `system:${message.id}`;
  node.dataset.id = message.id;
  const title = element("span", "control-list-title", message.title);
  title.title = message.title;
  const status = element("span", "control-list-status");
  status.append(element("span", "control-list-flag system", message.severity === "error" ? "Not working" : "Check"), message.short);
  status.title = message.short;
  const badge = element("span", "control-sys-icon");
  badge.append(svgIcon("warn"));
  node.append(element("i", "control-list-dot"), badge, title, element("span", "control-list-time", ""), status);
  node.addEventListener("click", () => select(node.dataset.key));
  node.addEventListener("keydown", (event) => { if (event.key === "Enter") select(node.dataset.key); });
  return node;
}

function pinnedHead(count) {
  const head = element("div", "control-list-section-head pinned");
  head.dataset.testid = "control-list-pinned-head";
  head.append(icon("pin"), element("b", "", "Pinned"), element("span", "control-project-count", String(count)), element("span", "control-spacer"));
  const note = element("small", "control-list-keep-note", "never auto-deleted");
  note.title = "Pinned and starred conversations are never deleted by any automatic cleanup";
  head.append(note);
  return head;
}

function dayHead(label, count) {
  const head = element("div", "control-list-section-head day");
  head.dataset.testid = "control-list-day";
  head.append(element("b", "", label), element("span", "control-project-count", String(count)));
  return head;
}

function projectHead(group) {
  const [first] = group;
  const head = element("div", "control-list-section-head project");
  head.dataset.testid = "control-list-project";
  head.dataset.project = first.projectId;
  head.dataset.color = first.projectColor;
  head.append(element("b", "", first.projectName), element("span", "control-project-count", String(group.length)), element("span", "control-spacer"));
  const project = { projectId: first.projectId, projectName: first.projectName };
  for (const action of projectActionList(project)) {
    const node = button("control-card-action", `control-project-action-${action.id}`, action.label, () => Promise.resolve(action.run(project)).catch((error) => toast.error(error.message)));
    node.title = action.title;
    head.append(node);
  }
  return head;
}

function row({ card, match }, helpers) {
  const node = element("div", `control-list-row${cardKey(card) === selectedKey ? " selected" : ""}`);
  node.tabIndex = 0;
  node.setAttribute("role", "button");
  node.dataset.testid = "control-list-row";
  node.dataset.key = cardKey(card);
  node.dataset.column = card.column;
  node.dataset.color = card.projectColor;
  const title = element("span", "control-list-title");
  appendParts(title, segments(card.title, match?.hits.title));
  title.title = card.title;
  const time = element("span", "control-list-time");
  if (isPinned(card)) time.append(Object.assign(icon("pin"), { title: "Pinned" }));
  if (isStarred(card)) time.append(Object.assign(icon("star"), { title: "Starred" }));
  time.append(when(card.updatedAt));
  const text = statusText(card);
  const status = element("span", "control-list-status");
  if (card.column === "needs-you") status.append(element("span", "control-list-flag needs-you", "Needs you"));
  if (card.column === "done") status.append(element("span", "control-list-flag done", "Done"));
  const folder = folderOf(card);
  if (folder && !view.scope.startsWith("folder:")) { const place = element("span", "control-list-folder"); place.append(svgIcon("folder"), folder); status.append(place); }
  const line = element("span", "control-list-snippet");
  if (match?.hits.body && !match.hits.status) {
    const found = snippet(card.summary, match.hits.body);
    if (found.cut) line.append("…");
    appendParts(line, found.parts);
  } else appendParts(line, segments(text, match?.hits.status));
  status.append(line);
  status.title = text;
  node.append(element("i", "control-list-dot"), helpers.avatarOf(card), title, time, status, tools(card));
  node.addEventListener("click", () => select(cardKey(card)));
  node.addEventListener("keydown", (event) => { if (event.key === "Enter" && event.target === node) select(cardKey(card)); });
  node.addEventListener("dblclick", () => helpers.openConversation(card).catch((error) => toast.error(error.message)));
  return node;
}
