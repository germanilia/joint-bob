// Pin, star, folders and delete for the Inbox, as a mail inbox has them (inbox-folders.js has the folder tree).
//   Pin   : the account's conversation pin (the same one the project list uses); a pinned conversation stays on top.
//   Star  : kept with the account (state.controlCenter.stars). A pinned or starred conversation is "kept": no automatic
//           cleanup deletes it (the retention sweep reads both).
//   Folder: one path per conversation (state.controlCenter.folders), "A/B" being a subfolder of "A".
//   Delete: gone from the list at once and finished on the server behind it, without opening the conversation.
// Stars and folders are keyed `engine:sessionId`, as a pin is.

import { api, savePin } from "./api.js";
import { toast } from "./shell.js";
import { state } from "./state.js";

const MAX_STARS = 500;

export const markKey = (card) => `${card.harnessId}:${card.sessionId}`;
const cardKey = (card) => `${card.projectId}:${card.conversationId}`;

/** A pin names the conversation as the project list does: its first segment's engine and its conversation id, so both lists agree. */
const pinOf = (card) => ({ projectId: card.projectId, engine: card.pinEngine ?? card.harnessId, sessionId: card.conversationId ?? card.sessionId });
const samePin = (pin, other) => pin.projectId === other.projectId && pin.engine === other.engine && pin.sessionId === other.sessionId;
export const isPinned = (card) => state.pinnedConversations.some((pin) => samePin(pin, pinOf(card)) || samePin(pin, { projectId: card.projectId, engine: card.harnessId, sessionId: card.sessionId }));
export const isStarred = (card) => state.controlCenter.stars.includes(markKey(card));
/** An assistant team's conversation is in the team's own folder (the card says which team), unless the person moved it. */
export const teamFolderName = (team) => `${team.name} team`;
export const folderOf = (card) => state.controlCenter.folders[markKey(card)] ?? (card.team ? teamFolderName(card.team) : null);
/** The person's folders, and a folder for each team that has conversations among `cards`. */
export const folderNames = (cards = []) => [...new Set([...Object.values(state.controlCenter.folders), ...cards.flatMap((card) => (card.team ? [teamFolderName(card.team)] : []))])].sort((a, b) => a.localeCompare(b));
/** Pinned or starred: nothing automatic may delete it. */
export const isKept = (card) => isPinned(card) || isStarred(card);

export function togglePin(card) {
  const pinned = !isPinned(card);
  const identity = pinOf(card);
  const older = { projectId: card.projectId, engine: card.harnessId, sessionId: card.sessionId };
  // Unpinning also clears the pin an older Inbox saved under the newest segment's name.
  const targets = pinned || samePin(identity, older) ? [identity] : [identity, older];
  return Promise.all(targets.map((target) => savePin({ kind: "conversation", ...target }, pinned)));
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

/* ---------- delete: gone from the list at once, finished on the server behind it ---------- */

const hidden = new Set();

/** A conversation being deleted, or one the project does not list, is not shown, whatever a list read before still says. */
export const isHidden = (card) => hidden.has(cardKey(card));

/** The person found it is not listed: it leaves the Inbox for as long as the page stays open. */
export function hideUnlisted(card) {
  hidden.add(cardKey(card));
  window.dispatchEvent(new CustomEvent("conversations-removed"));
}

/**
 * Takes the conversations out of the list at once (`redraw` draws it without them) and deletes them on the server behind it, without
 * opening them or changing the view. `refresh` reads the list again afterwards: a conversation the server refused comes back with
 * that read, and its reason is told.
 */
export async function deleteConversations(cards, { redraw, refresh }) {
  for (const card of cards) hidden.add(cardKey(card));
  redraw();
  const results = await Promise.allSettled(cards.map((card) => api(`/api/projects/${encodeURIComponent(card.projectId)}/sessions?${new URLSearchParams({ sessionId: card.sessionId, engine: card.harnessId })}`, { method: "DELETE" })));
  // Already gone (a cleanup or another machine deleted it first) is what was asked for: nothing to tell.
  const failed = results.filter((result) => result.status === "rejected" && result.reason.status !== 404);
  if (failed.length) toast.error(cards.length === 1 ? `Could not delete “${cards[0].title}”: ${failed[0].reason.message}` : `Could not delete ${failed.length} of ${cards.length}: ${failed[0].reason.message}`);
  for (const card of cards) hidden.delete(cardKey(card));
  await refresh();
}
