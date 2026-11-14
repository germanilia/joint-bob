// Live agents as a list, grouped by project (version B2 of the 13 Nov mocks): one row per conversation, and the chosen
// conversation opens on the right with what it needs, its summary, its chat (what you asked, its last message, a box
// to write to it), its last steps and its actions. Nothing here takes control of a conversation: choosing a row only reads it.
// The card board (control-center.js) draws the same cards the other way; the board's "List | Cards" switch picks one.
// Styles: the end of public/bob-page.css.
//
// The list and the preview are drawn into elements that stay in the page, so a redraw keeps the list's scroll position,
// the person's half-typed message and the preview's own scroll. Data: the board cards, plus
// `GET /api/control-center/cards/detail` (what was asked, its last message, its last steps) and
// `POST /api/control-center/cards/reply` (a message to the conversation, as the person wrote it).

import { api } from "./api.js";
import { renderMarkdown } from "../markdown.js";
import { briefStatus, projectActionList } from "./control-cards.js";
import { formatDate, toast } from "./shell.js";

const STATES = { "needs-you": "Needs you", running: "Running", review: "To review", snoozed: "Snoozed" };
const ORDER = Object.keys(STATES);

const cardKey = (card) => `${card.projectId}:${card.conversationId}`;

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

let ui = null;
let last = null;
let selectedKey = null;
let previewKey = null;
let previewStamp = "";
let detailToken = 0;
const drafts = new Map();
const details = new Map();

/** Projects in name order; inside a project, what needs the person first, then running, then finished; the newest first. */
function ordered(cards) {
  return [...cards].sort((a, b) => a.projectName.localeCompare(b.projectName)
    || ORDER.indexOf(a.column) - ORDER.indexOf(b.column)
    || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

/** What the row says: what the person must decide, or what the agent is doing now. */
function statusText(card) {
  const [review] = card.pendingReviews ?? [];
  if (review) return [review.title, review.subject].filter(Boolean).join(" · ");
  if (card.autoRespondStop) return `Auto respond stopped: ${card.autoRespondStop.reason || card.autoRespondStop.kind}`;
  if (card.column === "needs-you" && card.reviewCheck?.reason) return card.reviewCheck.reason;
  return card.activity ?? briefStatus(card.summary) ?? (card.column === "running" ? "Working…" : "Finished. Open it to review.");
}

function statePill(card, helpers) {
  if (card.column === "running") return helpers.runningBadge(card);
  const pill = element("span", `control-badge ${card.column}`, STATES[card.column]);
  pill.dataset.testid = "control-list-state";
  return pill;
}

function projectTag(card) {
  const tag = element("span", "control-list-ptag", card.projectName);
  tag.dataset.color = card.projectColor;
  return tag;
}

/* ---------- the frame, kept in the page ---------- */

function buildFrame(container) {
  const root = element("div", "control-list");
  root.dataset.testid = "control-list";
  const summary = element("div", "control-list-summary");
  summary.dataset.testid = "control-list-summary";
  const rows = element("div", "control-list-rows");
  rows.dataset.testid = "control-list-rows";
  const preview = element("aside", "control-list-preview");
  preview.dataset.testid = "control-list-preview";
  const left = element("div", "control-list-left");
  left.append(summary, rows);
  root.append(left, preview);
  rows.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const keys = [...rows.querySelectorAll(".control-list-row")].map((row) => row.dataset.key);
    const next = keys[keys.indexOf(selectedKey) + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    select(next, true);
  });
  container.replaceChildren(root);
  return { root, summary, rows, preview };
}

function select(key, focus = false) {
  selectedKey = key;
  renderList(...last);
  if (focus) ui.rows.querySelector(`.control-list-row[data-key="${CSS.escape(key)}"]`)?.focus();
}

/** Draws the list into the board's element; the board's own cards are not drawn. */
export function renderList(container, cards, helpers) {
  last = [container, cards, helpers];
  if (!ui || !container.contains(ui.root)) ui = buildFrame(container);
  const sorted = ordered(cards.map((card) => ({ ...card, projectColor: helpers.projectColor(card.projectId) })));
  // The first row opened is the first conversation that needs the person, or else the first of the list.
  if (!sorted.some((card) => cardKey(card) === selectedKey)) selectedKey = cardKey(sorted.find((card) => card.column === "needs-you") ?? sorted[0]);
  drawSummary(sorted, helpers);
  drawRows(sorted, helpers);
  drawPreview(sorted.find((card) => cardKey(card) === selectedKey), helpers);
}

function drawSummary(cards, helpers) {
  ui.summary.replaceChildren();
  for (const column of ORDER) {
    const count = cards.filter((card) => card.column === column).length;
    if (!count) continue;
    const item = element("span", `control-list-count ${column}`);
    item.dataset.testid = `control-list-count-${column}`;
    item.append(element("b", "", String(count)), ` ${STATES[column]}`);
    ui.summary.append(item);
  }
  const done = element("span", "control-list-count star", `★ ${helpers.finished()} finished while watching`);
  done.dataset.testid = "control-score-finished";
  done.title = "Conversations that finished while you watched";
  ui.summary.append(done);
}

/* ---------- the rows ---------- */

function drawRows(cards, helpers) {
  const focused = ui.rows.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  ui.rows.replaceChildren();
  for (let index = 0; index < cards.length;) {
    const end = cards.findIndex((card, at) => at > index && card.projectId !== cards[index].projectId);
    const group = cards.slice(index, end < 0 ? cards.length : end);
    ui.rows.append(projectHead(group), ...group.map((card) => row(card, helpers)));
    index += group.length;
  }
  if (focused) ui.rows.querySelector(`.control-list-row[data-key="${CSS.escape(focused)}"]`)?.focus();
}

function projectHead(group) {
  const [first] = group;
  const head = element("div", "control-list-project");
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

function row(card, helpers) {
  const node = element("button", "control-list-row");
  node.type = "button";
  node.dataset.testid = "control-list-row";
  node.dataset.key = cardKey(card);
  node.dataset.column = card.column;
  node.dataset.color = card.projectColor;
  node.classList.toggle("selected", cardKey(card) === selectedKey);
  const status = element("span", "control-list-status", statusText(card));
  status.title = status.textContent;
  node.append(element("i", "control-list-dot"), helpers.avatarOf(card), element("span", "control-list-title", card.title), statePill(card, helpers), status, element("span", "control-list-time", card.updatedAt ? formatDate(card.updatedAt) : ""));
  node.addEventListener("click", () => select(cardKey(card)));
  node.addEventListener("dblclick", () => helpers.openConversation(card).catch((error) => toast.error(error.message)));
  return node;
}

/* ---------- the preview ---------- */

function drawPreview(card, helpers) {
  const key = cardKey(card);
  const stamp = JSON.stringify([card.column, card.updatedAt, card.summary, card.activity, (card.pendingReviews ?? []).map((review) => review.id), card.reviewCheck, card.autoRespondStop, card.controlledBy, card.snooze]);
  if (key === previewKey && stamp === previewStamp) return;
  const typing = key === previewKey && ui.preview.contains(document.activeElement) && document.activeElement.tagName === "TEXTAREA";
  const scroll = key === previewKey ? ui.preview.scrollTop : 0;
  previewKey = key;
  previewStamp = stamp;
  const thread = element("div", "control-list-thread");
  thread.dataset.testid = "control-list-thread";
  const steps = section("Last steps", "control-list-steps");
  ui.preview.replaceChildren(...previewHead(card, helpers), ...needBlock(card, helpers), summarySection(card), chatSection(card, thread, helpers), steps, footer(card, helpers));
  ui.preview.scrollTop = scroll;
  if (typing) ui.preview.querySelector("textarea").focus();
  loadDetail(card, thread, steps);
}

function section(title, testid) {
  const node = element("section", "control-list-section");
  node.dataset.testid = testid;
  node.append(element("h4", "", title));
  return node;
}

function previewHead(card, helpers) {
  const top = element("div", "control-list-pv-top");
  top.append(helpers.avatarOf(card), projectTag(card), statePill(card, helpers), element("span", "control-spacer"),
    button("control-list-open", "control-list-open", "Open conversation ↗", () => helpers.openConversation(card).catch((error) => toast.error(error.message))));
  const meta = [card.agentLabel, card.agentModel, helpers.driverOf(card)?.label, card.updatedAt ? formatDate(card.updatedAt) : null].filter(Boolean).join(" · ");
  return [top, element("h2", "control-list-heading", card.title), element("p", "control-list-meta", meta)];
}

/** What the person must decide, with its buttons: Allow once and Block for a held step. */
function needBlock(card, helpers) {
  const [review] = card.pendingReviews ?? [];
  if (!review && !card.autoRespondStop && card.column !== "needs-you") return [];
  const box = element("div", "control-list-need");
  box.dataset.testid = "control-list-need";
  if (review) {
    box.append(element("b", "", `✋ Guardian holds a step: ${review.title}`));
    if (review.subject) box.append(element("pre", "", review.subject));
    if (review.detail) box.append(element("p", "", review.detail));
    const buttons = element("div", "control-list-need-actions");
    for (const [decision, label, className] of [["allow", "Allow once", "control-action warn"], ["block", "Block", "control-action"]]) {
      buttons.append(button(className, `control-review-${decision}`, label, (event) => {
        event.currentTarget.disabled = true;
        helpers.decideReview(card, review, decision).catch((error) => { toast.error(error.message); event.target.disabled = false; });
      }));
    }
    box.append(buttons);
  } else if (card.autoRespondStop) {
    box.append(element("b", "", "✋ Auto respond stopped"), element("p", "", card.autoRespondStop.reason || card.autoRespondStop.kind));
  } else {
    box.append(element("b", "", "✋ Waits for you"));
    if (card.reviewCheck?.reason) box.append(element("p", "", card.reviewCheck.reason));
  }
  return [box];
}

function summarySection(card) {
  const node = section("Summary", "control-list-summary-text");
  const body = element("div", "control-list-markdown markdown");
  if (card.summary) renderMarkdown(body, card.summary);
  else body.textContent = "No summary yet.";
  node.append(body);
  return node;
}

/** The chat: what was asked and its last message (read from the conversation), and a box that writes to it. */
function chatSection(card, thread, helpers) {
  const node = section("Chat", "control-list-chat");
  const key = cardKey(card);
  const form = element("form", "control-list-composer");
  form.dataset.testid = "control-list-composer";
  const text = element("textarea");
  text.rows = 2;
  text.value = drafts.get(key) ?? "";
  text.placeholder = card.controlledBy === "you" ? "You are in this conversation" : `Message ${card.agentLabel || "the agent"}…`;
  text.disabled = card.controlledBy === "you";
  text.dataset.testid = "control-list-message";
  text.addEventListener("input", () => drafts.set(key, text.value));
  text.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
  });
  const send = element("button", "primary", "Send");
  send.type = "submit";
  send.disabled = text.disabled;
  send.dataset.testid = "control-list-send";
  form.append(text, send);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const message = text.value.trim();
    if (!message) return;
    send.disabled = true;
    api("/api/control-center/cards/reply", { method: "POST", body: JSON.stringify({ projectId: card.projectId, conversationId: card.conversationId, message }) })
      .then(() => { drafts.delete(key); text.value = ""; toast(`Sent to “${card.title}”`); return helpers.refresh(); })
      .catch((error) => toast.error(error.message))
      .finally(() => { send.disabled = text.disabled; });
  });
  node.append(thread, form);
  return node;
}

function footer(card, helpers) {
  const foot = element("div", "control-list-footer");
  const actions = helpers.actionRow(card);
  if (actions) foot.append(actions);
  foot.append(helpers.doneButton(card));
  return foot;
}

/* ---------- what the conversation says ---------- */

function drawThread(thread, steps, detail) {
  thread.replaceChildren();
  if (detail.request) {
    const bubble = element("div", "control-list-msg you");
    bubble.append(element("b", "", "You asked"), element("p", "", detail.request));
    thread.append(bubble);
  }
  if (detail.answer) {
    const bubble = element("div", "control-list-msg agent");
    const body = element("div", "control-list-markdown markdown");
    renderMarkdown(body, detail.answer);
    bubble.append(element("b", "", "Its last message"), body);
    if (detail.answerCut) bubble.append(element("small", "", "Long message: the start is cut."));
    thread.append(bubble);
  }
  if (detail.unavailable) thread.append(element("p", "control-list-note", "The conversation is on another machine, so its messages cannot be shown here. Open it to read it."));
  else if (!thread.children.length) thread.append(element("p", "control-list-note", "Nothing written yet."));
  steps.querySelector("ul")?.remove();
  steps.hidden = !detail.steps?.length;
  if (!steps.hidden) {
    const list = element("ul", "control-list-steplist");
    for (const step of detail.steps) {
      const item = element("li", step.failed ? "failed" : "", step.name);
      if (step.target) item.append(" ", element("code", "", step.target));
      list.append(item);
    }
    steps.append(list);
  }
}

/** The last reading shows at once and the new one replaces it, so a redraw does not blank the chat. */
function loadDetail(card, thread, steps) {
  const key = cardKey(card);
  const token = ++detailToken;
  const known = details.get(key);
  if (known) drawThread(thread, steps, known);
  else { thread.append(element("p", "control-list-note", "Reading the conversation…")); steps.hidden = true; }
  api(`/api/control-center/cards/detail?${new URLSearchParams({ projectId: card.projectId, conversationId: card.conversationId })}`)
    .then((detail) => {
      details.set(key, detail);
      if (token === detailToken && thread.isConnected) drawThread(thread, steps, detail);
    })
    .catch(() => {
      if (token === detailToken && thread.isConnected && !known) thread.replaceChildren(element("p", "control-list-note", "The conversation could not be read here. Open it to see more."));
    });
}
