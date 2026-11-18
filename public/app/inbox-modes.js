// The Inbox column grouped by project or by folder (the third grouping, by state, is workspace.js). Both draw into the column's own list
// with the same rows as by state (`makeRow`), so a row looks and acts the same wherever it is listed.
//   By project : a section per project (pinned first, then the latest), its most urgent conversations, and the project's own menu.
//   By folder  : Pinned, Starred, then the person's folders and subfolders as a tree that opens in place; drag a row onto a folder to file it.

import { folderOf, isPinned, isStarred, popMenu } from "./control-marks.js";
import { childFolders, depthOf, draggedCard, endDrag, folderPaths, isInFolder, isTeamFolder, leafOf, moveToFolder, openFolderMenu, createFolder } from "./inbox-folders.js";
import { isProjectPinned } from "./session-rows.js";
import { state } from "./state.js";

/** Most urgent first: what needs you, then what runs, then what waits for review, then the rest. */
const ORDER = ["needs-you", "snoozed", "running", "review", "scheduled", "earlier", "done"];
const rank = (card) => ORDER.indexOf(card.column ?? "earlier");
export const byUrgency = (a, b) => Number(isPinned(b)) - Number(isPinned(a)) || rank(a) - rank(b) || String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""));

/* ---------- sub-agents under their parent ---------- */

const rowKey = (card) => `${card.projectId}:${card.conversationId}`;
const folded = new Set();
const kids = new Map();
const depths = new WeakMap();
/** How many sub-agent conversations sit under this card in the list it was last drawn in. */
export const kidCount = (card) => kids.get(rowKey(card)) ?? 0;
export const kidsFolded = (card) => folded.has(rowKey(card));
export const kidDepth = (card) => depths.get(card) ?? 0;
export function toggleKids(card) { if (!folded.delete(rowKey(card))) folded.add(rowKey(card)); }
/** Puts each sub-agent's conversation right under its parent's when both are in the list; a folded parent hides them. */
export function nestRows(list) {
  const byPath = new Map(list.filter((card) => card.path).map((card) => [card.path, card]));
  const parentOf = (card) => { const parent = card.parentPath ? byPath.get(card.parentPath) : null; return parent && parent !== card ? parent : null; };
  const children = new Map();
  for (const card of list) {
    const parent = parentOf(card);
    if (parent) children.set(parent, [...children.get(parent) ?? [], card]);
  }
  const out = [];
  const seen = new Set();
  const hidden = new Set();
  const hide = (card) => { for (const child of children.get(card) ?? []) { hidden.add(child); hide(child); } };
  const add = (card, depth) => {
    if (seen.has(card)) return;
    seen.add(card);
    depths.set(card, depth);
    kids.set(rowKey(card), children.get(card)?.length ?? 0);
    out.push(card);
    if (folded.has(rowKey(card))) hide(card);
    else for (const child of children.get(card) ?? []) add(child, depth + 1);
  };
  for (const card of list) if (!parentOf(card)) add(card, 0);
  // A loop of parents has no first card: its members are listed as they come. What a folded parent hides stays hidden.
  for (const card of list) if (!hidden.has(card)) add(card, 0);
  return out;
}

const PROJECT_ROWS = 5;
const FOLDER_ROWS = 20;
const OPEN_KEY = "joint-bob-inbox-open-folders";
let openFolders = (() => { try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]")); } catch { return new Set(); } })();
function toggleOpen(path, open = !openFolders.has(path)) {
  if (open) openFolders.add(path); else openFolders.delete(path);
  try { localStorage.setItem(OPEN_KEY, JSON.stringify([...openFolders])); } catch { /* private mode: the choice lasts the page */ }
}
/** What the drawn lists depend on besides the cards. */
export const modeSignature = () => JSON.stringify([[...folded], [...openFolders], state.controlCenter.folderList, state.controlCenter.folders, state.controlCenter.stars, state.projects.map((project) => [project.id, project.name])]);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(className, label, testid, onClick, text) {
  const node = el("button", className, text);
  node.type = "button";
  node.setAttribute("aria-label", label);
  node.title = label;
  node.dataset.testid = testid;
  node.addEventListener("click", (event) => { event.stopPropagation(); onClick(node); });
  return node;
}
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** A coloured count that says how many of a project's or folder's conversations are in a state. */
function pills(cards) {
  const wrap = el("span", "ws-pills");
  for (const [column, label] of [["needs-you", "need you"], ["running", "running"], ["review", "to review"]]) {
    const count = cards.filter((card) => card.column === column).length;
    if (!count) continue;
    const pill = el("i", `ws-pill ${column}`, String(count));
    pill.title = `${count} ${label}`;
    wrap.append(pill);
  }
  return wrap;
}

/* ---------- by project ---------- */

export function drawByProject(host, { cards, makeRow, groupOf, openPage, newIn, openMenu }) {
  const byProject = new Map();
  for (const card of cards) byProject.set(card.projectId, [...byProject.get(card.projectId) ?? [], card]);
  const records = [...byProject].map(([id, list]) => ({ id, name: list[0].projectName, record: state.projects.find((project) => project.id === id), cards: list.sort(byUrgency) }));
  const latest = (project) => project.cards.reduce((newest, card) => (String(card.updatedAt ?? "") > newest ? String(card.updatedAt) : newest), "");
  records.sort((a, b) => Number(isProjectPinned(b.id)) - Number(isProjectPinned(a.id)) || latest(b).localeCompare(latest(a)));
  host.replaceChildren(...records.map((project) => {
    const section = el("section", "ws-group ws-project");
    section.dataset.testid = "workspace-project";
    section.dataset.project = project.id;
    const head = el("div", "ws-lab ws-project-head");
    const name = button("ws-project-name", `${project.name}: every conversation`, "workspace-project-name", () => openPage(`project:${project.id}`), project.name);
    head.append(name, pills(project.cards));
    if (project.record) {
      head.append(
        button("ws-project-tool", `New conversation in ${project.name}`, "workspace-project-new", () => newIn(project.record), "+"),
        button("ws-project-tool", `${project.name} menu`, "workspace-project-menu", (anchor) => openMenu(anchor, project.record), "⋯"),
      );
    }
    section.append(head);
    for (const card of nestRows(project.cards).slice(0, PROJECT_ROWS)) section.append(makeRow(card, groupOf(card), "workspace-group-row"));
    if (project.cards.length > PROJECT_ROWS) {
      const all = button("ws-show-all ws-project-all", `Show all ${project.cards.length} of ${project.name}`, "workspace-project-show-all", () => openPage(`project:${project.id}`), `Show all ${project.cards.length}`);
      section.append(all);
    }
    return section;
  }));
  if (!records.length) host.replaceChildren(el("p", "ws-empty", "No conversations."));
}

/* ---------- by folder ---------- */

function dropTarget(row, path, afterDrop) {
  row.addEventListener("dragover", (event) => { if (!draggedCard()) return; event.preventDefault(); row.classList.add("over"); });
  row.addEventListener("dragleave", () => row.classList.remove("over"));
  row.addEventListener("drop", (event) => {
    event.preventDefault();
    row.classList.remove("over");
    const card = draggedCard();
    endDrag();
    if (!card) return;
    moveToFolder([card], path);
    afterDrop();
  });
}

function folderRow(path, cards, { openPage, afterChange, team }) {
  const row = el("div", "ws-folder-row");
  row.dataset.testid = "workspace-folder";
  row.dataset.path = path;
  row.style.setProperty("--depth", String(depthOf(path)));
  const open = openFolders.has(path);
  const deep = cards.filter((card) => isInFolder(card, path, true));
  row.append(
    button("ws-folder-chevron", open ? `Close ${leafOf(path)}` : `Open ${leafOf(path)}`, "workspace-folder-toggle", () => { toggleOpen(path); afterChange(); }, open ? "▾" : "▸"),
    button("ws-folder-name", `${path}: every conversation in it`, "workspace-folder-name", () => openPage(`folder:${path}`), leafOf(path)),
    pills(deep),
    el("em", "ws-folder-count", String(deep.length)),
  );
  if (!team) row.append(button("ws-project-tool", `${leafOf(path)} folder menu`, "workspace-folder-menu", (anchor) => openFolderMenu(anchor, path, () => { toggleOpen(path, true); afterChange(); }), "⋯"));
  dropTarget(row, path, afterChange);
  return row;
}

export function drawByFolder(host, { cards, makeRow, groupOf, openPage, afterChange }) {
  const paths = folderPaths(cards);
  const nodes = [];
  const head = el("div", "ws-lab");
  head.append(el("span", "", "Folders"), button("ws-show-all", "New folder", "workspace-folder-new", (anchor) => popMenu(anchor, [{ input: "New folder…", run: (name) => { createFolder("", name); afterChange(); } }]), "New folder"));
  nodes.push(head);
  for (const [id, label, test] of [["pinned", "Pinned", isPinned], ["starred", "Starred", isStarred]]) {
    const row = el("div", "ws-folder-row ws-folder-view");
    row.dataset.testid = `workspace-folder-${id}`;
    row.append(el("span", "ws-folder-chevron"), button("ws-folder-name", `${label} conversations`, `workspace-folder-${id}-open`, () => openPage(`view:${id}`), label), el("em", "ws-folder-count", String(cards.filter(test).length)));
    nodes.push(row);
  }
  const addFolder = (path) => {
    const team = isTeamFolder(path, cards);
    nodes.push(folderRow(path, cards, { openPage, afterChange, team }));
    if (!openFolders.has(path)) return;
    for (const child of childFolders(paths, path)) addFolder(child);
    const here = nestRows(cards.filter((card) => isInFolder(card, path)).sort(byUrgency));
    for (const card of here.slice(0, FOLDER_ROWS)) {
      const wrap = el("div", "ws-folder-item");
      wrap.style.setProperty("--depth", String(depthOf(path) + 1));
      wrap.append(makeRow(card, groupOf(card), "workspace-folder-row-conversation"));
      nodes.push(wrap);
    }
    if (here.length > FOLDER_ROWS) nodes.push(button("ws-show-all ws-folder-more", `Show all ${here.length} in ${leafOf(path)}`, "workspace-folder-more", () => openPage(`folder:${path}`), `Show all ${here.length}`));
  };
  for (const root of childFolders(paths, "")) addFolder(root);
  const unfiled = el("div", "ws-folder-row ws-folder-view");
  unfiled.dataset.testid = "workspace-folder-unfiled";
  unfiled.append(el("span", "ws-folder-chevron"), button("ws-folder-name", "Conversations in no folder", "workspace-folder-unfiled-open", () => openPage("view:unfiled"), "Not filed"), el("em", "ws-folder-count", String(cards.filter((card) => !folderOf(card)).length)));
  dropTarget(unfiled, "", afterChange);
  nodes.push(unfiled);
  host.replaceChildren(...nodes);
}

