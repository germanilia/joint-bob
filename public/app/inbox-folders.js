// The Inbox's folders, as a mailbox has them: a folder is a path, and "Clients/Contigos" is a subfolder of "Clients".
// A conversation is in one folder or none (state.controlCenter.folders, keyed `engine:sessionId`); the folders the person made
// are also kept as a list (state.controlCenter.folderList) so a folder can be empty. A team's conversations are in the team's
// folder without being moved there (control-marks.js `folderOf`).

import { saveControlCenter } from "./control-center.js";
import { folderOf, markKey, popMenu, setFolder, teamFolderName } from "./control-marks.js";
import { confirmAction } from "./shell.js";
import { state } from "./state.js";

export const leafOf = (path) => path.split("/").pop();
export const parentOf = (path) => path.split("/").slice(0, -1).join("/");
export const depthOf = (path) => path.split("/").length - 1;
const within = (path, folder) => path === folder || path.startsWith(`${folder}/`);

/** Every folder, with the parents of each (a conversation in "A/B" makes "A" exist), sorted so a parent comes before its children. */
export function folderPaths(cards = []) {
  const found = new Set();
  const add = (path) => {
    const parts = path.split("/");
    for (let length = 1; length <= parts.length; length += 1) found.add(parts.slice(0, length).join("/"));
  };
  for (const path of state.controlCenter.folderList) add(path);
  for (const path of Object.values(state.controlCenter.folders)) add(path);
  for (const card of cards) if (card.team) add(teamFolderName(card.team));
  return [...found].sort((a, b) => a.localeCompare(b));
}
export const childFolders = (paths, parent) => paths.filter((path) => parentOf(path) === parent);
/** The conversation is in this folder, or with `deep` in one of its subfolders. */
export function isInFolder(card, path, deep = false) {
  const folder = folderOf(card);
  return Boolean(folder) && (deep ? within(folder, path) : folder === path);
}
/** A team's folder belongs to the team, not to the person: it cannot be renamed or deleted. */
export const isTeamFolder = (path, cards) => cards.some((card) => card.team && teamFolderName(card.team) === path.split("/")[0]);

const cleanName = (name) => name.trim().replace(/\//g, "-").slice(0, 100);

export function createFolder(parent, name) {
  const clean = cleanName(name);
  if (!clean) return null;
  const path = parent ? `${parent}/${clean}` : clean;
  if (!state.controlCenter.folderList.includes(path)) state.controlCenter.folderList = [...state.controlCenter.folderList, path];
  saveControlCenter();
  return path;
}

export function renameFolder(path, name) {
  const clean = cleanName(name);
  if (!clean) return;
  const to = [parentOf(path), clean].filter(Boolean).join("/");
  const remap = (value) => (within(value, path) ? to + value.slice(path.length) : value);
  state.controlCenter.folderList = [...new Set(state.controlCenter.folderList.map(remap))];
  state.controlCenter.folders = Object.fromEntries(Object.entries(state.controlCenter.folders).map(([key, value]) => [key, remap(value)]));
  saveControlCenter();
}

/** The folder and its subfolders go; the conversations in them stay, back in the Inbox. */
export function deleteFolder(path) {
  state.controlCenter.folderList = state.controlCenter.folderList.filter((value) => !within(value, path));
  state.controlCenter.folders = Object.fromEntries(Object.entries(state.controlCenter.folders).filter(([, value]) => !within(value, path)));
  saveControlCenter();
}

/** Puts each conversation in the folder (null: back in the Inbox). */
export function moveToFolder(cards, path) {
  for (const card of cards) setFolder(card, path || null, () => {});
  saveControlCenter();
}

/** Where to put these conversations: the folder tree, "No folder", and a new folder. */
export function openMoveMenu(anchor, cards, allCards, afterChange) {
  const here = cards.length === 1 ? folderOf(cards[0]) : null;
  const put = (path) => () => { moveToFolder(cards, path); afterChange(); };
  popMenu(anchor, [
    ...folderPaths(allCards).map((path) => ({ label: leafOf(path), depth: depthOf(path), checked: path === here, run: put(path === here ? null : path) })),
    { label: "No folder", checked: cards.length === 1 && !here, run: put(null) },
    { input: "New folder…", run: (name) => { const path = createFolder("", name); if (path) put(path)(); } },
  ]);
}

/** A folder's own menu: a subfolder, a new name, or deleting it (nothing in it is deleted). */
export function openFolderMenu(anchor, path, afterChange) {
  popMenu(anchor, [
    { input: "New subfolder…", run: (name) => { createFolder(path, name); afterChange(); } },
    { input: "Rename to…", run: (name) => { renameFolder(path, name); afterChange(); } },
    { label: "Delete folder", run: async () => {
      const confirmed = await confirmAction({ eyebrow: "Delete folder", title: `Delete the folder “${leafOf(path)}”?`, message: "Its conversations are not deleted: they go back to the Inbox.", confirmLabel: "Delete folder", destructive: true });
      if (!confirmed) return;
      deleteFolder(path);
      afterChange();
    } },
  ]);
}

export { markKey };

/* ---------- dragging a conversation onto a folder ---------- */

let dragged = null;
export const startDrag = (card) => { dragged = card; };
export const endDrag = () => { dragged = null; };
export const draggedCard = () => dragged;
