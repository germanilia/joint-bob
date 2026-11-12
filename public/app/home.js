// Desktop Home: the middle of the Inbox place when no conversation is open, or when the brand (Home) is pressed.
// A serif greeting by time of day with "N need you · N running · N to review · $X spent today"; Needs you as cards
// (project, time, agent, title, the question) with Answer, Push it on, Done and Open; Running (live line, time) and
// Ready to review (Review) side by side. Needs you scrolls when there are many; Running and Ready to review show the rows
// that fit and "Show all" opens the group as one long list (workspace.js). The cards' actions are the control center's own: taking
// control to answer (control-lease.js), Push it on (`POST /api/control-center/cards/push`), Done with the closing
// question (control-center.js `markDone`) and opening the conversation. The phone's Home uses `waitingCard` too.
// Spec: docs/superpowers/specs/2026-11-10-ui-redo-paper-design.md; mock: mocks/ui-redo "Desktop · Home". Styles: home.css.

import { api } from "./api.js";
import { briefStatus, cardActionList } from "./control-cards.js";
import { decideReview, markDone, openConversation, pushOn } from "./control-center.js";
import { takeControl } from "./control-lease.js";
import { chooseSnooze } from "./control-snooze.js";
import { drawChunked } from "./long-scroll.js";
import { openNeedDetail } from "./needs-detail.js";
import { elements } from "./elements.js";
import { menuIcon } from "./icons.js";
import { currentMobileView, setMobileView } from "./layout.js";
import { toast } from "./shell.js";
import { state } from "./state.js";
import { openGroupPage, useNeedCards } from "./workspace.js";

const byId = (id) => document.getElementById(id);
const body = document.body;
const desktop = matchMedia("(min-width: 701px)");
const home = byId("homePage");

let cards = [];
let loaded = false;
/** Inbox pressed while a conversation is open: Home shows over it until a conversation is opened. */
let requested = false;
let shownFor = "";
let spentToday = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* ---------- what a card says ---------- */

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
function clock(value) {
  if (!value) return "";
  const date = new Date(value);
  return date.toDateString() === new Date().toDateString() ? timeFormat.format(date) : dayFormat.format(date);
}

/** How long ago it last moved, as the Running list says it: "4 min", "2 h", "3 d". */
export function sinceLabel(value, now = Date.now()) {
  if (!value) return "";
  const minutes = Math.max(0, Math.round((now - Date.parse(value)) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

/** What the conversation waits on, in its own words: the step to allow, why auto respond stopped, what Bob found. */
export function questionOf(card) {
  const [review] = card.pendingReviews ?? [];
  if (review) return [review.title, review.subject].filter(Boolean).join(": ");
  if (card.autoRespondStop) return card.autoRespondStop.reason || card.autoRespondStop.kind;
  if (card.reviewCheck?.needsYou && card.reviewCheck.reason) return card.reviewCheck.reason;
  return briefStatus(card.summary) ?? "It stopped and waits for you.";
}

function liveLine(card) {
  return card.activity || briefStatus(card.summary) || (card.column === "running" ? "Working…" : "Finished. Open it to review.");
}

/* ---------- a waiting card: Answer, Push it on, Done, Open ---------- */

/** Answering is working in it as the person: control is taken (Bob and auto respond stay out) and the message box is ready. */
async function answer(card) {
  if (card.controlledBy === null) await takeControl(card);
  else await openConversation(card);
  requested = false;
  sync();
  requestAnimationFrame(() => elements.messageInput?.focus({ preventScroll: true }));
}

/**
 * One conversation that waits for the person, as a card. `compact` is the phone's. Push it on first asks what to tell it,
 * in a box on the card (it can stay empty), as Bob's chat does.
 */
export function waitingCard(card, { compact = false } = {}) {
  const root = element("article", `ws-wait${compact ? " compact" : ""}`);
  root.dataset.testid = "home-card";
  root.dataset.key = `${card.projectId}:${card.conversationId}`;
  const top = element("div", "ws-wait-top");
  top.append(element("i", "ws-dot need"), element("span", "ws-wait-project", card.projectName));
  const when = element("time", "", [clock(card.updatedAt), card.agentLabel].filter(Boolean).join(" · "));
  if (card.updatedAt) when.dateTime = card.updatedAt;
  top.append(when);
  const title = element("b", "ws-wait-title", card.title || "Conversation");
  const question = element("p", "ws-wait-question", questionOf(card));
  question.title = question.textContent;
  const actions = element("div", "ws-wait-actions");
  const run = (button, work) => {
    button.disabled = true;
    Promise.resolve().then(work).catch((error) => toast.error(error.message)).finally(() => { if (button.isConnected) button.disabled = false; });
  };
  const button = (label, className, testid, work) => {
    const node = element("button", className);
    node.type = "button";
    node.setAttribute("aria-label", label);
    const icon = menuIcon({ Answer: "chat", "Push it on": "play", Snooze: "clock", Done: "check", Open: "transfer", "Allow once": "check", Block: "close" }[label]);
    icon.classList.add("ws-wait-action-icon");
    node.append(icon, element("span", "ws-wait-action-label", label));
    node.dataset.testid = testid;
    node.addEventListener("click", (event) => { event.stopPropagation(); run(node, work); });
    return node;
  };
  const [review] = card.pendingReviews ?? [];
  if (review) {
    // A risky step held by Guardian is answered with its own two buttons.
    actions.append(
      button("Allow once", "primary compact", "home-card-allow", () => decideReview(card, review, "allow")),
      button("Block", "compact soft", "home-card-block", () => decideReview(card, review, "block")),
    );
  } else {
    const answerButton = button("Answer", "primary compact", "home-card-answer", () => answer(card));
    answerButton.title = card.controlledBy === "someone-else" ? "Open it; someone else is in control" : "Open it with you in control, ready to answer";
    const push = button("Push it on", "compact soft", "home-card-push", () => openPushBox(root, card, push));
    push.title = "Tell it to go on, with a word of instructions if you like";
    actions.append(answerButton, push);
  }
  const snooze = button("Snooze", "compact ghost", "home-card-snooze", () => chooseSnooze(card, snooze));
  snooze.title = "Put it aside for now: it leaves Needs you until the time you choose or something new happens";
  actions.append(snooze);
  const done = button("Done", "compact ghost", "home-card-done", () => markDone(card));
  done.title = card.turnRunning ? "Stop it and close it: it leaves Home, and you can open it again from its project" : "Close it: it leaves Home, and you can open it again from its project";
  actions.append(done, element("span", "ws-home-spacer"));
  const open = button("Open", "ghost compact ws-wait-open", "home-card-open", () => { requested = false; return openConversation(card); });
  const arrow = chevron();
  arrow.classList.add("ws-wait-open-chevron");
  open.append(arrow);
  actions.append(open);
  root.append(top, title, question, actions);
  // Looking at a card changes nothing; tapping it (not its buttons) shows what exactly it needs, over Home.
  root.tabIndex = 0;
  root.title = "Tap to see what it needs";
  const showDetail = () => openNeedDetail(card, {
    ask: questionOf(card),
    open: () => { requested = false; return openConversation(card); },
    onChange: () => { shownFor = ""; window.dispatchEvent(new CustomEvent("control-center-changed")); },
  });
  root.addEventListener("click", (event) => { if (!event.target.closest("button, a, textarea, form")) showDetail(); });
  root.addEventListener("keydown", (event) => { if (event.target === root && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); showDetail(); } });
  return root;
}

/* ---------- the phone's Needs you deck ---------- */

/** The card the deck shows (kept across redraws, so a refresh does not take the reader back to the first). */
let deckKey = "";

/**
 * Every needs-you card as one swipeable row: scroll-snap, one card nearly the width with the next peeking, "2 of 4", arrow
 * buttons and arrow keys, and a mouse can drag it. Moving through it does nothing to a card (nothing is marked seen).
 */
export function needDeck(items) {
  const deck = element("div", "ws-deck");
  deck.dataset.testid = "needs-deck";
  deck.setAttribute("role", "group");
  deck.setAttribute("aria-roledescription", "carousel");
  deck.setAttribute("aria-label", "What needs you");
  const track = element("div", "ws-deck-track");
  track.dataset.testid = "needs-deck-track";
  track.tabIndex = 0;
  track.setAttribute("aria-label", "Cards that need you; use the arrow keys to move between them");
  for (const [index, card] of items.entries()) {
    const slide = element("div", "ws-deck-slide");
    slide.dataset.index = String(index);
    slide.dataset.key = `${card.projectId}:${card.conversationId}`;
    slide.setAttribute("role", "group");
    slide.setAttribute("aria-label", `${index + 1} of ${items.length}`);
    slide.append(waitingCard(card, { compact: true }));
    track.append(slide);
  }
  const bar = element("div", "ws-deck-bar");
  const previous = element("button", "ghost ws-deck-step", "‹");
  const next = element("button", "ghost ws-deck-step", "›");
  for (const [node, label, testid] of [[previous, "Previous card", "needs-deck-previous"], [next, "Next card", "needs-deck-next"]]) { node.type = "button"; node.setAttribute("aria-label", label); node.title = label; node.dataset.testid = testid; }
  const position = element("span", "ws-deck-position");
  position.dataset.testid = "needs-deck-position";
  position.setAttribute("aria-live", "polite");
  bar.append(previous, position, next);
  deck.append(track, bar);

  const slides = () => [...track.children];
  const indexNow = () => {
    const all = slides();
    if (!all.length) return 0;
    const step = all.length > 1 ? all[1].offsetLeft - all[0].offsetLeft : track.clientWidth;
    return Math.max(0, Math.min(all.length - 1, Math.round(track.scrollLeft / (step || 1))));
  };
  const show = () => {
    const at = indexNow();
    position.textContent = `${at + 1} of ${items.length}`;
    previous.disabled = at === 0;
    next.disabled = at >= items.length - 1;
    const key = slides()[at]?.dataset.key;
    if (key) deckKey = key;
  };
  const go = (to, behavior = "smooth") => {
    const target = slides()[Math.max(0, Math.min(items.length - 1, to))];
    if (target) track.scrollTo({ left: target.offsetLeft - slides()[0].offsetLeft, behavior });
  };
  let frame = 0;
  track.addEventListener("scroll", () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(show); }, { passive: true });
  previous.addEventListener("click", () => go(indexNow() - 1));
  next.addEventListener("click", () => go(indexNow() + 1));
  track.addEventListener("keydown", (event) => {
    if (event.target !== track) return;
    if (event.key === "ArrowRight") { event.preventDefault(); go(indexNow() + 1); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); go(indexNow() - 1); }
    else if (event.key === "Home") { event.preventDefault(); go(0); }
    else if (event.key === "End") { event.preventDefault(); go(items.length - 1); }
  });
  // A mouse drags the row like a finger does (touch scrolls it natively). A drag is not a tap: the click after it is dropped.
  let drag = null;
  track.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "mouse" || event.button !== 0 || event.target.closest("button, textarea, a")) return;
    drag = { x: event.clientX, left: track.scrollLeft, moved: false };
  });
  track.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const delta = event.clientX - drag.x;
    if (!drag.moved && Math.abs(delta) < 6) return;
    if (!drag.moved) { drag.moved = true; track.classList.add("dragging"); track.setPointerCapture(event.pointerId); }
    track.scrollLeft = drag.left - delta;
  });
  const release = () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    track.classList.remove("dragging");
    if (moved) {
      go(indexNow());
      track.addEventListener("click", (event) => event.stopPropagation(), { capture: true, once: true });
    }
  };
  track.addEventListener("pointerup", release);
  track.addEventListener("pointercancel", release);
  // Redrawn while the reader is on the third card: it stays on that card.
  requestAnimationFrame(() => {
    const at = Math.max(0, items.findIndex((card) => `${card.projectId}:${card.conversationId}` === deckKey));
    if (at > 0) go(at, "instant");
    show();
  });
  return deck;
}

function chevron() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "m9 18 6-6-6-6");
  svg.append(path);
  return svg;
}

/** The instructions box Push it on opens on its card: Enter pushes, Shift+Enter is a new line, Esc closes it. */
function openPushBox(root, card, pushButton) {
  if (root.querySelector(".ws-wait-push")) { root.querySelector(".ws-wait-push textarea").focus(); return; }
  const form = element("form", "ws-wait-push");
  form.dataset.testid = "home-card-push-box";
  const box = element("textarea");
  box.rows = 2;
  box.placeholder = `Anything to tell “${card.title}” as it goes on? Leave it empty to just push it on.`;
  box.setAttribute("aria-label", "Instructions for Push it on");
  const send = element("button", "primary compact", "Push it on");
  send.type = "submit";
  send.dataset.testid = "home-card-push-send";
  const cancel = element("button", "ghost compact", "Cancel");
  cancel.type = "button";
  // Closing lets Home and the phone's groups draw what changed meanwhile.
  const close = () => {
    form.remove(); root.classList.remove("pushing"); pushButton.hidden = false;
    shownFor = ""; schedule();
    window.dispatchEvent(new CustomEvent("control-center-changed"));
  };
  cancel.addEventListener("click", close);
  box.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    send.disabled = true;
    pushOn(card, box.value.trim())
      .then(() => { toast(`Told “${card.title}” to go on`); close(); })
      .catch((error) => { toast.error(error.message); send.disabled = false; });
  });
  const row = element("div", "ws-wait-actions");
  row.append(send, cancel);
  form.append(box, row);
  pushButton.hidden = true;
  root.classList.add("pushing");
  root.querySelector(".ws-wait-question").after(form);
  box.focus();
}

/* ---------- Running and Ready to review ---------- */

function listRow(card) {
  const row = element("div", `ws-home-row ${card.column === "running" ? "run" : "rev"}`);
  row.dataset.testid = "home-row";
  row.dataset.key = `${card.projectId}:${card.conversationId}`;
  const main = element("button", "ws-home-row-main");
  main.type = "button";
  main.title = `${card.title} · ${card.projectName}`;
  const copy = element("span", "ws-home-row-copy");
  copy.append(element("b", "", card.title || "Conversation"), element("small", "", [card.projectName, liveLine(card)].filter(Boolean).join(" · ")));
  main.append(element("i", `ws-dot ${card.column === "running" ? "run" : "rev"}`), copy);
  main.addEventListener("click", () => { requested = false; openConversation(card).catch((error) => toast.error(error.message)); });
  row.append(main);
  if (card.column === "running") {
    const time = element("time", "", sinceLabel(card.updatedAt));
    if (card.updatedAt) time.dateTime = card.updatedAt;
    time.title = "Since it last moved";
    row.append(time);
  } else {
    // Reviewing is the board card's own action: opening it marks it reviewed.
    const review = cardActionList(card).find((action) => action.id === "review");
    const button = element("button", "compact soft", "Review");
    button.type = "button";
    button.dataset.testid = "home-row-review";
    button.addEventListener("click", () => {
      requested = false;
      Promise.resolve(review ? review.run(card) : openConversation(card)).catch((error) => toast.error(error.message));
    });
    row.append(button);
  }
  return row;
}

/* ---------- drawing and fitting ---------- */

const inColumn = (column) => cards.filter((card) => card.column === column);

function greetingWord(hour = new Date().getHours()) {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 18) return "Good afternoon";
  return "Good evening";
}

function money(value) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: value >= 100 ? 0 : 2 }).format(value);
}

function renderHead() {
  const raw = (state.username || "").trim();
  const name = raw ? raw[0].toUpperCase() + raw.slice(1) : "";
  byId("homeGreeting").textContent = name ? `${greetingWord()}, ${name}` : greetingWord();
  const line = byId("homeCounts");
  if (!loaded) { line.textContent = ""; return; }
  const need = inColumn("needs-you").length;
  const needs = element(need ? "b" : "span", "", `${need} need${need === 1 ? "s" : ""} you`);
  const parts = [` · ${inColumn("running").length} running · ${inColumn("review").length} to review`];
  if (spentToday !== null) parts.push(` · ${money(spentToday)} spent today`);
  line.replaceChildren(needs, ...parts);
}

/** The whole items of one kind that fit in `host`: one is drawn to measure, then as many as its height allows. */
function fitCount(host, sample, gap, columns = 1) {
  host.replaceChildren(sample);
  const height = sample.getBoundingClientRect().height;
  const room = host.clientHeight;
  if (!height || !room) return columns;
  return Math.max(1, Math.floor((room + gap) / (height + gap))) * columns;
}

function renderNeed() {
  const host = byId("homeNeedCards");
  const need = inColumn("needs-you");
  byId("homeNeedCount").textContent = loaded ? String(need.length) : "…";
  home.classList.toggle("need-empty", loaded && !need.length);
  if (!need.length) {
    host.replaceChildren(element("p", "ws-empty", loaded ? "Nothing waits for you." : "Loading…"));
    return;
  }
  host.style.setProperty("--home-columns", String(host.clientWidth >= 620 ? 2 : 1));
  // Every card is there: the area scrolls, drawn in chunks (long-scroll.js); a refresh keeps the place.
  const scroll = host.scrollTop;
  host.replaceChildren();
  drawChunked(host, need.map((card) => () => waitingCard(card)), { key: "home-needs" });
  host.scrollTop = scroll;
}

function renderList(column, hostId, countId, empty) {
  const host = byId(hostId);
  const items = inColumn(column);
  byId(countId).textContent = loaded ? String(items.length) : "…";
  const all = host.closest("section").querySelector(".ws-home-all");
  if (!items.length) {
    host.replaceChildren(element("p", "ws-empty", loaded ? empty : "Loading…"));
    all.hidden = true;
    return;
  }
  const size = fitCount(host, listRow(items[0]), 0);
  host.replaceChildren(...items.slice(0, size).map(listRow));
  host.closest("section").querySelector(".ws-home-all").hidden = items.length <= size;
}

function render() {
  if (home.hidden) return;
  // Words being written for Push it on are not drawn away; closing the box draws Home again.
  if (home.querySelector(".ws-wait.pushing")) { shownFor = ""; return; }
  renderHead();
  renderNeed();
  renderList("running", "homeRunList", "homeRunCount", "Nothing is running.");
  renderList("review", "homeReviewList", "homeReviewCount", "Nothing to review.");
  home.querySelector('[data-group="needs-you"]').hidden = loaded && inColumn("needs-you").length === 0;
}

/* ---------- when Home is the middle ---------- */

const activeKey = () => `${state.activeConversationProjectId || state.activeProjectId || ""}:${state.activeSessionId || state.activeSessionPath || ""}`;
let lastActive = activeKey();

function wanted() {
  if (!desktop.matches || body.classList.contains("focus-ui") || !body.classList.contains("ws-column-inbox")) return false;
  if (body.classList.contains("ws-page-open")) return false;
  if (["board", "control"].includes(currentMobileView())) return false;
  return requested || !(state.activeSessionId || state.activeSessionPath);
}

function sync() {
  const key = activeKey();
  // Another conversation opened: it takes the middle.
  if (key !== lastActive) { lastActive = key; if (state.activeSessionId || state.activeSessionPath) requested = false; }
  const show = wanted();
  if (body.classList.contains("ws-home") !== show) body.classList.toggle("ws-home", show);
  if (home.hidden === show) home.hidden = !show;
  if (show) {
    const drawing = JSON.stringify([cards.map((card) => [card.projectId, card.conversationId, card.column, card.title, card.updatedAt, card.activity, card.controlledBy, questionOf(card)]), loaded, spentToday, home.clientWidth, home.clientHeight, state.username]);
    if (drawing !== shownFor) {
      shownFor = drawing;
      render();
    }
    // Read when signed in, then every few minutes (a day without prices stays without the spend, not read again at once).
    if (state.authenticated && (!spentReadAt || Date.now() - spentReadAt > SPENT_REFRESH_MS)) void readSpent();
  } else shownFor = "";
}

let queued = false;
function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; sync(); });
}

/* ---------- today's spend ---------- */

const SPENT_REFRESH_MS = 5 * 60_000;
let spentReadAt = 0;
let readingSpent = false;
async function readSpent() {
  if (readingSpent) return;
  readingSpent = true;
  spentReadAt = Date.now();
  try {
    const today = new Date();
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const parameters = new URLSearchParams({ sections: "summary", pageSize: "1", refresh: "false", from: day, to: day, utcOffset: String(-today.getTimezoneOffset()), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" });
    const data = await api(`/api/usage?${parameters}`, { signal: AbortSignal.timeout(20_000) });
    const cost = data?.summary?.apiCostUsd;
    spentToday = typeof cost === "number" ? cost : null;
  } catch {
    // The line goes without the spend; Costs has the details.
  } finally {
    readingSpent = false;
    schedule();
  }
}

/* ---------- wiring ---------- */

window.addEventListener("workspace-cards", (event) => { cards = event.detail.cards ?? []; loaded = true; schedule(); });
for (const name of ["app-view-changed", "workspace-column-changed", "project-selected", "running-refreshed"]) window.addEventListener(name, schedule);
document.addEventListener("activeConversationChanged", schedule);
desktop.addEventListener("change", schedule);
new MutationObserver(schedule).observe(body, { attributes: true, attributeFilter: ["class"] });
new ResizeObserver(schedule).observe(home);

// The brand (the mark and "Joint Bob") is the way Home, also over an open conversation, from the board or from Bob's
// page (only the person leaves it, and pressing Home is the person leaving). Inbox keeps bringing the open
// conversation back, as it always has (workspace.js).
byId("workspaceHomeButton").addEventListener("click", () => {
  requested = true;
  if (["board", "control"].includes(currentMobileView())) setMobileView(state.activeSessionId || state.activeSessionPath ? "chat" : "sessions");
  if (!body.classList.contains("ws-column-inbox")) byId("workspaceInboxButton").click();
  schedule();
});
byId("workspaceInboxButton").addEventListener("click", (event) => {
  // Pressed by the person (not by Home itself): Inbox is the open conversation again.
  if (event.isTrusted) requested = false;
  schedule();
});
// A row of the left column (or the group page) opens its conversation, even the one Home was shown over.
document.addEventListener("click", (event) => {
  if (event.target.closest?.(".ws-row") && requested) { requested = false; schedule(); }
}, true);

for (const all of home.querySelectorAll(".ws-home-all")) all.addEventListener("click", () => openGroupPage(all.dataset.group));
// The greeting follows the time of day, the Running times the clock.
setInterval(() => { shownFor = ""; schedule(); }, 60_000);
schedule();
// The phone's Home shows the same cards under its greeting.
useNeedCards((items) => needDeck(items));
