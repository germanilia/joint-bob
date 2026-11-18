// Pin, star, folders and delete for the Inbox, as a mail inbox has them (inbox-folders.js has the folder tree).
//   Pin   : the account's conversation pin (the same one the project list uses); a pinned conversation stays on top.
//   Star  : kept with the account (state.controlCenter.stars). A pinned or starred conversation is "kept": no automatic
//           cleanup deletes it (the retention sweep reads both).
//   Folder: one path per conversation (state.controlCenter.folders), "A/B" being a subfolder of "A".
//   Delete: at once from the list, with an Undo; the conversation is really deleted when the Undo runs out. A kept one asks twice.
// Stars and folders are keyed `engine:sessionId`, as a pin is.

import { api, savePin } from "./api.js";
import { toast } from "./shell.js";
import { state } from "./state.js";

const MAX_STARS = 500;
const UNDO_MS = 8_000;

export const markKey = (card) => `${card.harnessId}:${card.sessionId}`;
const cardKey = (card) => `${card.projectId}:${card.conversationId}`;

export const isPinned = (card) => state.pinnedConversations.some((pin) => pin.projectId === card.projectId && pin.engine === card.harnessId && pin.sessionId === card.sessionId);
export const isStarred = (card) => state.controlCenter.stars.includes(markKey(card));
/** An assistant team's conversation is in the team's own folder (the card says which team), unless the person moved it. */
export const teamFolderName = (team) => `${team.name} team`;
export const folderOf = (card) => state.controlCenter.folders[markKey(card)] ?? (card.team ? teamFolderName(card.team) : null);
/** The person's folders, and a folder for each team that has conversations among `cards`. */
export const folderNames = (cards = []) => [...new Set([...Object.values(state.controlCenter.folders), ...cards.flatMap((card) => (card.team ? [teamFolderName(card.team)] : []))])].sort((a, b) => a.localeCompare(b));
/** Pinned or starred: nothing automatic may delete it. */
export const isKept = (card) => isPinned(card) || isStarred(card);

export function togglePin(card) {
  return savePin({ kind: "conversation", projectId: card.projectId, engine: card.harnessId, sessionId: card.sessionId }, !isPinned(card));
}

export function toggleStar(card, save) {
  const key = markKey(card);
  if (isStarred(card)) state.controlCenter.stars = state.controlCenter.stars.filter((other) => other !== key);
  else if (state.controlCenter.stars.length >= MAX_STARS) { toast.error(`You can star up to ${MAX_STARS} conversations`); return; }
  else state.controlCenter.stars = [...state.controlCenter.stars, key];
  save();
}

/** A name puts the conversation in that folder; null takes it out. */
export function setFolder(card, name, save) {
  const folders = { ...state.controlCenter.folders };
  if (name) folders[markKey(card)] = name.trim().slice(0, 40);
  else delete folders[markKey(card)];
  state.controlCenter.folders = folders;
  save();
}

/* ---------- a small menu next to a button, with a box for a new name ---------- */

let openMenu = null;
export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}

/** items: {label, checked?, run} or {input: placeholder, run(name)}. It sits on the body, so no scroll box clips it. */
export function popMenu(anchor, items) {
  closeMenu();
  const menu = document.createElement("div");
  menu.className = "control-pop";
  menu.dataset.testid = "control-pop";
  for (const item of items) {
    if (item.input) {
      const box = document.createElement("input");
      box.placeholder = item.input;
      box.maxLength = 40;
      box.dataset.testid = "control-pop-input";
      box.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && box.value.trim()) { closeMenu(); item.run(box.value.trim()); }
        if (event.key === "Escape") closeMenu();
      });
      menu.append(box);
      continue;
    }
    const choice = document.createElement("button");
    choice.type = "button";
    choice.classList.toggle("on", Boolean(item.checked));
    choice.dataset.testid = "control-pop-choice";
    const label = document.createElement("span");
    label.textContent = item.label;
    if (item.depth) choice.style.paddingLeft = `${12 + item.depth * 16}px`;
    choice.append(label, item.checked ? "✓" : "");
    choice.addEventListener("click", () => { closeMenu(); item.run(); });
    menu.append(choice);
  }
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`;
  menu.style.top = `${rect.bottom + height + 12 > innerHeight ? Math.max(8, rect.top - height - 6) : rect.bottom + 6}px`;
  openMenu = menu;
  menu.querySelector("input")?.focus();
  const outside = (event) => {
    if (menu.contains(event.target)) return;
    closeMenu();
    document.removeEventListener("pointerdown", outside, true);
  };
  setTimeout(() => document.addEventListener("pointerdown", outside, true));
  menu.addEventListener("keydown", (event) => { if (event.key === "Escape") closeMenu(); });
}

/* ---------- delete, at once, with an Undo ---------- */

const pending = new Map();
let armed = null;

/** A conversation whose delete is waiting out its Undo is not shown. */
export const isDeleting = (card) => pending.has(cardKey(card));

async function reallyDelete(card, refresh) {
  try {
    await api(`/api/projects/${encodeURIComponent(card.projectId)}/sessions?${new URLSearchParams({ sessionId: card.sessionId, engine: card.harnessId })}`, { method: "DELETE" });
  } catch (error) {
    toast.error(`Could not delete “${card.title}”: ${error.message}`);
  } finally {
    pending.delete(cardKey(card));
    await refresh();
  }
}

/** Hides the conversations and deletes them when the Undo runs out; one notice and one Undo cover all of them. */
function scheduleDelete(cards, { redraw, refresh }) {
  const timers = cards.map((card) => {
    const timer = setTimeout(() => void reallyDelete(card, refresh), UNDO_MS);
    pending.set(cardKey(card), timer);
    return [card, timer];
  });
  redraw();
  const notice = toast(cards.length === 1 ? `Deleted “${cards[0].title}”` : `Deleted ${cards.length} conversations`, UNDO_MS);
  const undo = document.createElement("button");
  undo.type = "button";
  undo.className = "toast-undo";
  undo.textContent = "Undo";
  undo.dataset.testid = "control-list-undo";
  undo.addEventListener("click", () => {
    for (const [card, timer] of timers) { clearTimeout(timer); pending.delete(cardKey(card)); }
    notice.remove();
    redraw();
  });
  notice.insertBefore(undo, notice.querySelector(".toast-close"));
}

/** Deletes now. Pinned or starred, it asks first: a second press within five seconds goes through. */
export function deleteConversation(card, actions) {
  const key = cardKey(card);
  if (isKept(card) && armed !== key) {
    armed = key;
    setTimeout(() => { if (armed === key) armed = null; }, 5_000);
    toast(`“${card.title}” is ${isPinned(card) ? "pinned" : "starred"}. Press delete again to remove it anyway.`, 5_000);
    return;
  }
  armed = null;
  scheduleDelete([card], actions);
}

/** Deletes several at once with one Undo. Pinned and starred ones are left alone: only a single, twice-asked delete removes those. Returns how many were deleted. */
export function deleteConversations(cards, actions) {
  const kept = cards.filter(isKept);
  const doomed = cards.filter((card) => !isKept(card));
  if (kept.length) toast(`${kept.length} pinned or starred conversation${kept.length === 1 ? " was" : "s were"} kept. Delete those one at a time.`, 5_000);
  if (doomed.length) scheduleDelete(doomed, actions);
  return doomed.length;
}
