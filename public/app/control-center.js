import { api, savePreferencesInBackground } from "./api.js";
import { elements } from "./elements.js";
import { projectListing, selectProject } from "./project-selection.js";
import { openListedSession, settleOpenedSession } from "./reviews.js";
import { setStatus, toast } from "./shell.js";
import { showConversationOpening } from "./socket.js";
import { showChatEmptyState } from "./chat-transcript.js";
import { noteOpenTiming, startOpenTiming } from "./open-timing.js";
import { state } from "./state.js";
import { registerControlView } from "./control-views.js";
import { chooseConversationFeedback } from "./conversation-feedback.js";
import { registerCardAction } from "./control-cards.js";
import { openQuickNote } from "./quick-notes.js";
import { PROJECT_COLORS } from "./session-rows.js";

let board = { cards: [], projects: [] };
let refreshing = null;
let refreshAgain = false;

let saveTimer = null;

// Colors and the filter belong to the account, so they follow the person to every browser.
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => savePreferencesInBackground({ controlCenter: state.controlCenter }), 400);
}


/**
 * The palette a project without a color of its own is given a color from; slate is left for what belongs to no project.
 * Read when used: the color list's module imports back into this one, so it is not ready while this one loads.
 */
const palette = () => PROJECT_COLORS.filter((color) => color !== "slate");

/** A steady start in the palette from a project's id (FNV-1a, so like ids get unlike colors). */
function paletteStart(projectId) {
  let hash = 0x811c9dc5;
  for (const character of projectId) hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193);
  return (hash >>> 0) % palette().length;
}

/**
 * Each project's color, worked out once per set of projects: the one chosen in its settings, as its project list shows it;
 * the others, in id order, take the first color from their steady start that no other project has, so no two share one
 * until the palette runs out.
 */
let colorsOf = { key: "", colors: new Map() };
function projectColors() {
  const key = JSON.stringify(board.projects.map((project) => [project.id, project.color ?? null]));
  if (key === colorsOf.key) return colorsOf.colors;
  const colors = new Map(board.projects.filter((project) => project.color).map((project) => [project.id, project.color]));
  const taken = new Set(colors.values());
  for (const project of [...board.projects].filter((candidate) => !candidate.color).sort((left, right) => left.id.localeCompare(right.id))) {
    const choices = palette();
    const start = paletteStart(project.id);
    const free = choices.map((_, step) => choices[(start + step) % choices.length]).find((color) => !taken.has(color));
    const color = free ?? choices[start];
    colors.set(project.id, color);
    taken.add(color);
  }
  colorsOf = { key, colors };
  return colors;
}

/** A project's color, on the board and in Bob's chat. One the board does not list yet keeps its steady start. */
export function projectColor(projectId) {
  return projectColors().get(projectId) ?? palette()[paletteStart(projectId)];
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function visibleCards() {
  const filter = new Set(state.controlCenter.filter);
  return board.cards.filter((card) => !filter.size || filter.has(card.projectId));
}

const isFolded = (id) => state.controlCenter.collapsed.includes(id);
/** Folds a section into its button, or opens it again; remembered with the account. Bob's page folds the chat and the column. */
export function toggleFolded(id) {
  state.controlCenter.collapsed = isFolded(id) ? state.controlCenter.collapsed.filter((other) => other !== id) : [...state.controlCenter.collapsed, id];
  save();
}

/**
 * Who moves a conversation forward when the person is not in it: the system answering for the agent (auto respond), or Bob
 * watching it because he started it. Null for the person's own conversations.
 */
function driverOf(card) {
  if (card.controlledBy === "you") return { id: "you-in", label: "✋ You're in it", title: "You took control; Bob and auto respond stay out" };
  if (card.autoRespondActive) return { id: "system", label: "⚙ System drives", title: "Auto respond answers this agent for you, and Bob is told when it stops" };
  if (card.reviewCheck?.pushPending && card.column === "running") return { id: "system", label: "⚙ System drives", title: "It stopped before it was done, so Bob told it to go on" };
  if (card.startedBy === "bob") return { id: "watched", label: "👁 Bob watches", title: "Bob started this and tells you when it needs you" };
  return null;
}

function render() {
  // Bob's head, the "Ask Bob" count and the column follow the board's data; the board itself is no longer drawn.
  window.dispatchEvent(new CustomEvent("control-center-rendered", { detail: { projects: board.projects, cards: board.cards, focus: [...state.controlCenter.filter] } }));
  const cards = visibleCards();
  const waiting = cards.filter((card) => card.column === "needs-you").length;
  const driven = cards.filter((card) => driverOf(card)?.id === "system").length;
  const watched = cards.filter((card) => driverOf(card)?.id === "watched").length;
  elements.controlCenterCount.textContent = [
    `${cards.filter((card) => card.column === "running").length} running`, waiting ? `${waiting} need you` : "",
    driven ? `${driven} driven by the system` : "", watched ? `${watched} watched by Bob` : "",
  ].filter(Boolean).join(" · ");
  liveView.setBadge(waiting);
}

function drawBoard(next) {
  board = next;
  // Only a newly read board may update Home; a visual redraw can still hold an older snapshot.
  window.dispatchEvent(new CustomEvent("control-center-board-refreshed", { detail: { cards: board.cards } }));
  render();
}

export function refreshControlCenter() {
  if (refreshing) { refreshAgain = true; return refreshing; }
  refreshing = (async () => {
    do {
      refreshAgain = false;
      await drawBoard(await api("/api/control-center/board"));
    } while (refreshAgain);
  })().finally(() => { refreshing = null; });
  return refreshing;
}

/**
 * Opens a conversation by its project and conversation id (or its path), the way a card does. From the control center it
 * opens over the board, with the person in control (control-lease.js). Closing it goes back to the board.
 */
export async function openConversation(card) {
  startOpenTiming("card");
  const overBoard = isControlCenterOpen();
  state.keepControlView = overBoard;
  let listing = null;
  let fromCard = false;
  let joined = false;
  let opening;
  try {
    // The project's list is fetched beside the opening, not before it: it takes seconds on a busy machine, and the page
    // showed what it showed before the click until it came. The card knows enough to open the conversation itself.
    if (state.activeProjectId !== card.projectId) listing = selectProject(card.projectId);
    // The project is chosen and its list is still on its way (the page just loaded, or a card of it was clicked a moment
    // ago): the list in the page is empty until it answers, which is not the conversation being gone.
    else { listing = projectListing(card.projectId); joined = Boolean(listing); }
    if (overBoard) {
      document.body.classList.add("control-popup");
      window.dispatchEvent(new CustomEvent("control-popup-opened", { detail: card }));
    }
    showConversationOpening(card.title);
    let session = listedSession(card);
    if (!session && listing) {
      session = cardSession(card);
      fromCard = Boolean(session);
      noteOpenTiming({ list: fromCard ? "card" : "fetched" });
      if (!session) { await listing; listing = null; session = listedSession(card); }
    }
    if (!session) {
      closeConversationPopup();
      showChatEmptyState("Not listed", "That conversation is no longer listed.");
      setStatus("Not listed");
      toast("That conversation is no longer listed");
      await refreshControlCenter();
      return;
    }
    // Over the board it opens behind the view (r-Esc2Out), the takeover from an offline machine included.
    opening = openListedSession(session, { keepView: overBoard, timed: true });
  } finally {
    state.keepControlView = false;
  }
  // The list still on its way: a failure is told as before, and an open made from the card gets what the list knows.
  if (listing) {
    void listing.then(() => {
      if (!fromCard) return;
      const listed = listedSession(card);
      if (listed) settleOpenedSession(listed);
      // A card that outlived its conversation: the socket says why it cannot open, and the board drops the card.
      else void refreshControlCenter().catch((error) => console.warn("Could not refresh the board", error));
      // A list this open only joined tells its failure where it was asked for.
    }).catch((error) => { if (!joined) toast.error(error.message); });
  }
  await opening;
}

/** The project's listed row for a card, once the project's list (kept from an earlier visit, or fresh) holds it. */
function listedSession(card) {
  return state.sessions.find((candidate) => (candidate.conversationId ?? candidate.id) === card.conversationId)
    ?? (card.path ? state.sessions.find((candidate) => candidate.path === card.path) : undefined);
}

/** What a board card already says about its conversation, enough to open it. A card without a path waits for the list. */
function cardSession(card) {
  if (!card.path || !card.sessionId) return null;
  return {
    id: card.sessionId, conversationId: card.conversationId, path: card.path, title: card.title, harnessId: card.harnessId,
    executionNodeId: card.executionNodeId ?? null, updatedAt: card.updatedAt ?? null, running: Boolean(card.turnRunning || card.backgroundRunning),
  };
}

export function closeConversationPopup() {
  if (!document.body.classList.contains("control-popup")) return;
  document.body.classList.remove("control-popup");
  window.dispatchEvent(new CustomEvent("control-popup-closed"));
}

const openCard = openConversation;

/** Focuses the board on one project, or on all of them with null. Bob's chat calls it when its project filter changes. */
export function focusProject(projectId) {
  state.controlCenter.filter = projectId ? [projectId] : [];
  save();
  render();
}

/**
 * Closes a conversation as its project's list does, with the same question about what to learn; a working one is stopped
 * first. Home's cards (home.js) call it too. Resolves true once it is closed, false when the question was dismissed.
 */
export async function markDone(card) {
  const feedback = await chooseConversationFeedback(card);
  if (!feedback) return false;
  await api("/api/control-center/cards/done", {
    method: "POST", body: JSON.stringify({ projectId: card.projectId, conversationId: card.conversationId, feedback }),
  });
  await refreshControlCenter();
  return true;
}

/** Push it on from a card: the conversation is told to go on, with what the person wrote (it can be empty). */
export async function pushOn(card, note = "") {
  await api("/api/control-center/cards/push", {
    method: "POST", body: JSON.stringify({ projectId: card.projectId, conversationId: card.conversationId, ...(note ? { note } : {}) }),
  });
  await refreshControlCenter();
}

/** Allow once or Block for the Guardian step a card waits on. */
export async function decideReview(card, review, decision) {
  await api("/api/control-center/guardian/decide", { method: "POST", body: JSON.stringify({ projectId: card.projectId, conversationId: card.conversationId, reviewId: review.id, decision }) });
  await refreshControlCenter();
}

// Reviewing a finished conversation is reading it: opening it marks it reviewed, and it leaves the review lane.
registerCardAction({
  id: "review", label: "Review", style: "primary", order: 1, title: "Open it to read what it did; it waits for review until you mark it done",
  visible: (card) => card.column === "review", run: (card) => openConversation(card),
});
/** A new conversation from the board: the quick note form, started at once, in the project the board is focused on. */
export function newConversation(content = "") {
  const focused = state.controlCenter.filter.length === 1 ? state.controlCenter.filter[0] : null;
  return openQuickNote(null, { chooseProject: true, startNow: true, projectId: focused, content });
}
// The card shows up as soon as the conversation has started, not at the next refresh.
window.addEventListener("conversation-started", () => { if (document.body.classList.contains("view-control")) void refreshControlCenter().catch(() => undefined); });

export function isControlCenterOpen() {
  return document.body.classList.contains("view-control");
}

/** Called by the chat to save the chat's side and width with the rest of the board's settings. */
export function saveControlCenter() { save(); }

export function activateControlCenter() {
  window.dispatchEvent(new CustomEvent("control-center-activated"));
  return refreshControlCenter();
}

// Bob's own view: his chat alone fills the page (bob-page.js). The Inbox in the left column lists the conversations.
const liveView = registerControlView({ id: "live", title: "Bob", order: 0, element: elements.controlViewLive });

elements.controlCenterRefresh.addEventListener("click", () => refreshControlCenter().catch((error) => toast.error(error.message)));
// What waits for the person shows on the toolbar icon, so they know without opening the control center.
const badge = element("span", "control-icon-badge");
badge.hidden = true;
badge.dataset.testid = "control-center-waiting-badge";
elements.openControlCenterButton.append(badge);
let waitingChecked = Promise.resolve();
function refreshWaiting() {
  waitingChecked = waitingChecked.then(() => api("/api/control-center/summary")).then(({ waiting }) => {
    badge.textContent = waiting > 99 ? "99+" : String(waiting);
    badge.hidden = waiting === 0;
    elements.openControlCenterButton.setAttribute("aria-label", waiting ? `Open the control center, ${waiting} waiting for you` : "Open the control center");
  }).catch((error) => console.warn("Could not read what waits for you", error));
}
// The running list and the server already announce every change; the board and the badge follow the same signals.
function onChanged() {
  if (isControlCenterOpen()) refreshControlCenter().catch((error) => console.warn("Could not refresh the control center", error));
  refreshWaiting();
}
window.addEventListener("running-refreshed", onChanged);
// What a running turn is doing changes all the time, so while the board is in view and something runs it is read again.
const LIVE_REFRESH_MS = 10_000;
setInterval(() => {
  if (!isControlCenterOpen() || document.hidden || !board.cards.some((card) => card.column === "running")) return;
  refreshControlCenter().catch((error) => console.warn("Could not refresh the control center", error));
}, LIVE_REFRESH_MS);
window.addEventListener("control-center-changed", onChanged);
// Leaving the control center closes the conversation over it.
window.addEventListener("app-view-changed", () => { if (!isControlCenterOpen()) closeConversationPopup(); });
// Esc closes the conversation over the board before it can leave the control center, from its message box too (the draft
// stays); an open command list closes first.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented || !document.body.classList.contains("control-popup")) return;
  if (document.querySelector("dialog[open]")) return;
  if (event.target === elements.messageInput ? !elements.commandAutocomplete.hidden : event.target.closest?.("input, textarea, select")) return;
  event.preventDefault();
  closeConversationPopup();
}, true);
