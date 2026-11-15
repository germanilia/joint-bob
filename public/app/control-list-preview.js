// The panel on the right of the control center's list (version B of the 14 Nov mocks): the chosen conversation's head (what it
// is, Review · Done · ⋯ with pin / star / folder / delete), then three tabs, one at a time with the whole height:
//   Summary : what waits for you (Guardian's held step, a stopped auto respond, a check that found it waits), then its summary.
//   Chat    : what you asked, its last message, and a box that writes to it (pinned at the bottom).
//   Steps   : its last tool and shell calls.
// A system message has a panel of its own (control-system.js). Nothing here takes control of a conversation.
//
// On Bob's page the Chat tab is the conversation's real chat (the one Take control opens): the chat panel is placed over the
// tab's body, so every message, the queued ones with Force start / Earlier / Later / Edit / Delete, and pasting images work as
// they do in the conversation itself. Narrower screens keep the plain thread and box below.
//
// The panel is drawn into an element that stays in the page, so a redraw keeps the half-typed message and the scroll.
// Data: the board card, plus `GET /api/control-center/cards/detail` and `POST /api/control-center/cards/reply`.

import { api } from "./api.js";
import { renderMarkdown } from "../markdown.js";
import { cardActionList } from "./control-cards.js";
import { closeConversationPopup, openConversation } from "./control-center.js";
import { folderOf, isKept } from "./control-marks.js";
import { menuIcon } from "./icons.js";
import { systemPanel } from "./control-system.js";
import { formatDate, toast } from "./shell.js";

const cardKey = (card) => `${card.projectId}:${card.conversationId}`;
const STATES = { "needs-you": "Needs you", running: "Running", review: "To review", snoozed: "Snoozed", reviewed: "Reviewed", done: "Done" };
const TABS = [["summary", "Summary"], ["chat", "Chat"], ["steps", "Steps"]];
// Card actions (control-moves.js) shown as a row of buttons under the title, not in the "More ▾" menu.
const CONVERSATION_TOOLS = ["terminal", "git", "files", "story"];

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

const drafts = new Map();
const details = new Map();
let drawn = { key: null, stamp: "", tab: "" };
let detailToken = 0;

/**
 * Draws the panel for `card` (or for a system message) into `preview`. `context`: helpers (the board's), tab, setTab, markItems
 * (the pin / star / folder / delete items of its ⋯ menu), checkAgain (reads the system messages again).
 */
export function drawPreview(preview, card, context) {
  if (card.system) {
    hideChat();
    drawn = { key: `system:${card.id}`, stamp: "", tab: "" };
    preview.dataset.kind = "system";
    preview.replaceChildren(...systemPanel(card, { checkAgain: context.checkAgain }));
    return;
  }
  const { helpers, tab } = context;
  const key = cardKey(card);
  const inline = tab === "chat" && document.body.classList.contains("bob-desk");
  if (!inline) hideChat();
  const stamp = JSON.stringify([card.column, card.updatedAt, card.summary, card.activity, (card.pendingReviews ?? []).map((review) => review.id), card.reviewCheck, card.autoRespondStop, card.controlledBy, card.snooze, isKept(card), folderOf(card)]);
  if (key === drawn.key && stamp === drawn.stamp && tab === drawn.tab) return;
  const same = key === drawn.key && tab === drawn.tab;
  const typing = same && preview.contains(document.activeElement) && document.activeElement.tagName === "TEXTAREA";
  const body = preview.querySelector(".control-list-body");
  const scroll = same && body ? body.scrollTop : 0;
  drawn = { key, stamp, tab };
  preview.dataset.kind = "conversation";
  const content = element("div", "control-list-body");
  content.dataset.testid = `control-list-tab-${tab}`;
  const pieces = [...head(card, context, inline), tabBar(card, context), content];
  if (tab === "chat" && !inline) pieces.push(composer(card, helpers));
  preview.replaceChildren(...pieces);
  if (inline) headButtons(card, helpers);
  if (inline) showChat(card, content);
  else fillBody(content, card, context);
  content.scrollTop = scroll;
  if (typing) preview.querySelector("textarea").focus();
  loadDetail(card, () => { if (drawn.key === key && drawn.tab === tab && content.isConnected) { if (!inline) fillBody(content, card, context); tabBar(card, context, preview.querySelector(".control-list-tabs")); } });
}

const inlineChat = { key: null, observer: null };

/** Opens the conversation behind the Chat tab and keeps its panel on the tab's body. Watching: nobody takes control of it. */
function showChat(card, anchor) {
  const key = cardKey(card);
  document.body.classList.add("control-inline");
  inlineChat.observer?.disconnect();
  inlineChat.observer = new ResizeObserver(() => placeChat(anchor));
  inlineChat.observer.observe(anchor);
  placeChat(anchor);
  if (inlineChat.key === key && document.body.classList.contains("control-popup")) return;
  inlineChat.key = key;
  openConversation({ ...card, inline: true }).catch((error) => toast.error(error.message));
}

/** Follows the anchor; once it is hidden (another tab of Bob's page) or gone, the chat goes with it. */
function placeChat(anchor) {
  if (!anchor.isConnected || anchor.offsetParent === null) {
    drawn = { key: null, stamp: "", tab: "" };
    hideChat();
    return;
  }
  const box = anchor.getBoundingClientRect();
  for (const [name, value] of [["x", box.left], ["y", box.top], ["w", box.width], ["h", box.height]]) document.body.style.setProperty(`--bob-pop-${name}`, `${Math.round(value)}px`);
}

/** The card's buttons that are not tools (Take control, Snooze, ...) join the chat's head row, before its Mark done. */
function headButtons(card, helpers) {
  removeHeadButtons();
  const skip = cardActionList(card).filter((action) => action.more || CONVERSATION_TOOLS.includes(action.id)).map((action) => action.id);
  const row = helpers.actionRow(card, skip);
  if (!row) return;
  row.classList.add("control-head-buttons");
  row.dataset.testid = "control-head-buttons";
  document.querySelector("#chatHeadActions").prepend(row);
}
const removeHeadButtons = () => document.querySelector("#chatHeadActions .control-head-buttons")?.remove();

export function hideChat() {
  removeHeadButtons();
  if (!inlineChat.key) return;
  inlineChat.observer?.disconnect();
  inlineChat.key = null;
  document.body.classList.remove("control-inline");
  closeConversationPopup();
}

function head(card, context, inline) {
  const { helpers } = context;
  const top = element("div", "control-list-pv-top");
  top.append(helpers.avatarOf(card), projectTag(card));
  top.append(statePill(card, helpers));
  if (isKept(card)) {
    const kept = element("span", "control-list-kept", "Kept");
    kept.title = "Pinned or starred: no automatic cleanup deletes it";
    kept.dataset.testid = "control-list-kept";
    top.append(kept);
  }
  top.append(element("span", "control-spacer"));
  const meta = [card.agentLabel, card.agentModel, helpers.driverOf(card)?.label, card.updatedAt ? `${card.column === "done" ? "Done " : ""}${formatDate(card.updatedAt)}` : null].filter(Boolean).join(" · ");
  const line = element("div", "control-list-pv-line");
  line.append(element("p", "control-list-meta", meta));
  // One group at the end of the line: Review, Done and ⋯ (pin, star, folder, delete and the card's other actions).
  const marks = context.markItems(card);
  // On the Chat tab the chat's own head already has Mark done, so Take control, Snooze and the other buttons live there (headButtons)
  // and the panel keeps only ⋯.
  if (inline) line.append(helpers.moreMenu(card, [], marks));
  else if (card.column !== "done") line.append(helpers.actionRow(card, CONVERSATION_TOOLS, { after: helpers.doneButton(card), extras: marks }));
  else line.append(helpers.moreMenu(card, [], marks));
  // The conversation's tools (Terminal, Git, Folders, Story) follow its actions on the same line, so the buttons are one group.
  line.append(toolsRow(card));
  return [top, element("h2", "control-list-heading", card.title), line];
}

/** Terminal, Git, Folders and Story: each opens the conversation first, then the tool, as the card's actions do. */
function toolsRow(card) {
  const row = element("div", "control-list-pv-tools");
  row.dataset.testid = "control-list-tools";
  for (const action of cardActionList(card).filter((candidate) => CONVERSATION_TOOLS.includes(candidate.id))) {
    const tool = button("control-list-pv-tool", `control-list-tool-${action.id}`, "", (event) => {
      Promise.resolve(action.run(card, event.currentTarget)).catch((error) => toast.error(error.message));
    });
    tool.title = action.title;
    tool.append(menuIcon(action.icon), action.label);
    row.append(tool);
  }
  return row;
}

function projectTag(card) {
  const tag = element("span", "control-list-ptag", card.projectName);
  tag.dataset.color = card.projectColor;
  return tag;
}

function statePill(card, helpers) {
  if (card.column === "running") return helpers.runningBadge(card);
  const pill = element("span", `control-badge ${card.column}`, STATES[card.column]);
  pill.dataset.testid = "control-list-state";
  return pill;
}

/** Summary | Chat | Steps; Steps says how many it has once the conversation has been read. */
function tabBar(card, context, into) {
  const bar = into ?? element("div", "control-list-tabs");
  bar.setAttribute("role", "tablist");
  bar.replaceChildren(...TABS.map(([id, label]) => {
    const tab = button("control-list-tab", `control-list-tab-button-${id}`, label, () => context.setTab(id));
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(context.tab === id));
    const count = id === "steps" ? details.get(cardKey(card))?.steps?.length : 0;
    if (count) tab.append(element("em", "", String(count)));
    return tab;
  }));
  return bar;
}

function fillBody(content, card, context) {
  const detail = details.get(cardKey(card));
  if (context.tab === "summary") content.replaceChildren(...needBlock(card, context.helpers), summarySection(card));
  else if (context.tab === "chat") content.replaceChildren(thread(detail));
  else content.replaceChildren(steps(detail));
}

/** What the person must decide, with its buttons: Allow once and Block for a held step. Part of the summary. */
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
    for (const [decision, label, className] of [["allow", "Allow once", "control-action warn"], ...(review.alwaysKey ? [["allow-always", "Allow always", "control-action warn"]] : []), ["block", "Block", "control-action"]]) {
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
  const node = element("section", "control-list-section");
  node.dataset.testid = "control-list-summary-text";
  const text = element("div", "control-list-markdown markdown");
  if (card.summary) renderMarkdown(text, card.summary);
  else text.textContent = "No summary yet.";
  node.append(element("h4", "", "Summary"), text);
  return node;
}

function thread(detail) {
  const node = element("div", "control-list-thread");
  node.dataset.testid = "control-list-thread";
  if (!detail) { node.append(element("p", "control-list-note", "Reading the conversation…")); return node; }
  if (detail.request) {
    const bubble = element("div", "control-list-msg you");
    bubble.append(element("b", "", "You asked"), element("p", "", detail.request));
    node.append(bubble);
  }
  if (detail.answer) {
    const bubble = element("div", "control-list-msg agent");
    const body = element("div", "control-list-markdown markdown");
    renderMarkdown(body, detail.answer);
    bubble.append(element("b", "", "Its last message"), body);
    if (detail.answerCut) bubble.append(element("small", "", "Long message: the start is cut."));
    node.append(bubble);
  }
  if (detail.failed) node.append(element("p", "control-list-note", "The conversation could not be read here. Open it to see more."));
  else if (detail.unavailable) node.append(element("p", "control-list-note", "The conversation is on another machine, so its messages cannot be shown here. Open it to read it."));
  else if (!node.children.length) node.append(element("p", "control-list-note", "Nothing written yet."));
  return node;
}

function steps(detail) {
  const node = element("section", "control-list-section");
  node.dataset.testid = "control-list-steps";
  node.append(element("h4", "", "Tool and shell calls"));
  if (!detail) { node.append(element("p", "control-list-note", "Reading the conversation…")); return node; }
  if (!detail.steps?.length) { node.append(element("p", "control-list-note", detail.failed ? "The conversation could not be read here." : detail.unavailable ? "The conversation is on another machine, so its steps cannot be shown here." : "No steps yet.")); return node; }
  const list = element("ul", "control-list-steplist");
  for (const step of detail.steps) {
    const item = element("li", step.failed ? "failed" : "", step.name);
    if (step.target) item.append(" ", element("code", "", step.target));
    list.append(item);
  }
  node.append(list);
  return node;
}

/** The box that writes to the conversation, pinned under the chat. */
function composer(card, helpers) {
  const key = cardKey(card);
  const foot = element("div", "control-list-foot");
  const form = element("form", "control-list-composer");
  form.dataset.testid = "control-list-composer";
  const text = element("textarea");
  text.rows = 2;
  text.value = drafts.get(key) ?? "";
  text.placeholder = card.controlledBy === "you" ? "You are in this conversation" : card.column === "done" ? `Message ${card.agentLabel || "the agent"} to bring it back…` : `Message ${card.agentLabel || "the agent"}…`;
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
  foot.append(form, element("p", "control-list-hint", "Enter sends · Shift+Enter for a new line"));
  return foot;
}

/** The last reading shows at once and the new one replaces it, so a redraw does not blank the chat. */
function loadDetail(card, draw) {
  const key = cardKey(card);
  const token = ++detailToken;
  api(`/api/control-center/cards/detail?${new URLSearchParams({ projectId: card.projectId, conversationId: card.conversationId })}`)
    .then((detail) => {
      details.set(key, detail);
      if (token === detailToken) draw();
    })
    .catch(() => {
      if (token !== detailToken || details.has(key)) return;
      details.set(key, { request: null, answer: null, steps: [], failed: true });
      draw();
    });
}
