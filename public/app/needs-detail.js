// What exactly a needs-you card waits for, without opening the conversation: a sheet over Home (bottom sheet on the
// phone, a centred card on the desktop) with the ask, why Bob or Guardian flagged it, how long it has waited, the agent's
// last message in full (markdown, scrollable) and its last steps, and the card's own actions. Looking at it changes
// nothing; only its buttons do. Data: the board card, plus `GET /api/control-center/cards/detail` for the transcript.
// Answer opens a reply box here (`POST /api/control-center/cards/reply`), Push it on a box for instructions.

import { api } from "./api.js";
import { decideReview, markDone, openConversation, pushOn } from "./control-center.js";
import { chooseSnooze } from "./control-snooze.js";
import { renderMarkdown } from "../markdown.js";
import { toast } from "./shell.js";

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function waited(value, now = Date.now()) {
  if (!value) return "";
  const minutes = Math.max(0, Math.round((now - Date.parse(value)) / 60_000));
  if (minutes < 1) return "Waiting for a moment";
  if (minutes < 60) return `Waiting ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `Waiting ${hours} h` : `Waiting ${Math.round(hours / 24)} d`;
}

function section(title, testid) {
  const node = element("section", "need-sheet-section");
  node.dataset.testid = testid;
  node.append(element("h3", "", title));
  return node;
}

let current = null;

/** Closes the open sheet, if any. */
export function closeNeedDetail() { current?.close(); }

/**
 * @param {object} card the board card
 * @param {{ ask: string, onChange?: () => void, open: () => Promise<void>, answer: () => Promise<void> }} options
 *   `ask` is what the card says it waits on; `open` opens the conversation (the sheet closes first); `onChange` runs after
 *   something was done to the card (Push it on, Done, a reply).
 */
export function openNeedDetail(card, { ask, open, onChange = () => {} }) {
  closeNeedDetail();
  const dialog = element("dialog", "need-sheet");
  dialog.dataset.testid = "need-sheet";
  dialog.setAttribute("aria-labelledby", "needSheetTitle");
  const grab = element("span", "need-sheet-grab");
  const head = element("header", "need-sheet-head");
  const heading = element("div", "need-sheet-heading");
  const meta = element("p", "need-sheet-meta", [card.projectName, card.agentLabel, waited(card.updatedAt)].filter(Boolean).join(" · "));
  meta.dataset.testid = "need-sheet-meta";
  const title = element("h2", "", card.title || "Conversation");
  title.id = "needSheetTitle";
  heading.append(meta, title);
  const close = element("button", "ghost need-sheet-close");
  close.type = "button"; close.setAttribute("aria-label", "Close"); close.title = "Close (Esc)"; close.dataset.testid = "need-sheet-close";
  const cross = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of [["viewBox", "0 0 24 24"], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "2"], ["stroke-linecap", "round"], ["aria-hidden", "true"]]) cross.setAttribute(name, value);
  const strokes = document.createElementNS("http://www.w3.org/2000/svg", "path");
  strokes.setAttribute("d", "M6 6l12 12M18 6 6 18");
  cross.append(strokes);
  close.append(cross);
  head.append(heading, close);

  const content = element("div", "need-sheet-body");
  // What it needs, and why it is here.
  const needs = section("What it needs", "need-sheet-ask");
  const [review] = card.pendingReviews ?? [];
  if (review) {
    needs.append(element("p", "need-sheet-ask-text", `Guardian holds a step: ${review.title}`));
    if (review.subject) { const code = element("pre", "need-sheet-code", review.subject); needs.append(code); }
    if (review.detail) needs.append(element("p", "need-sheet-note", review.detail));
  } else needs.append(element("p", "need-sheet-ask-text", ask));
  const why = [];
  if (card.reviewCheck?.needsYou) why.push(`Bob checked it${card.reviewCheck.by ? ` (${card.reviewCheck.by})` : ""} and found it waits for you${card.reviewCheck.reason && card.reviewCheck.reason !== ask ? `: ${card.reviewCheck.reason}` : "."}`);
  if (card.autoRespondStop) why.push(`Auto respond stopped: ${card.autoRespondStop.reason || card.autoRespondStop.kind}`);
  if (card.controlledBy === "someone-else") why.push("Someone else is in control of this conversation.");
  for (const line of why) needs.append(element("p", "need-sheet-note", line));
  content.append(needs);

  const request = section("You asked", "need-sheet-request"); request.hidden = true;
  const last = section("Its last message", "need-sheet-last"); last.hidden = true;
  const steps = section("Its last steps", "need-sheet-steps"); steps.hidden = true;
  const loading = element("p", "need-sheet-note", "Reading the conversation…");
  loading.dataset.testid = "need-sheet-loading";
  content.append(request, last, steps, loading);

  // Actions: the card's own, with the reply and instruction boxes opening here.
  const foot = element("footer", "need-sheet-foot");
  const box = element("form", "need-sheet-box"); box.hidden = true; box.dataset.testid = "need-sheet-box";
  const text = element("textarea"); text.rows = 3;
  const boxActions = element("div", "need-sheet-actions");
  const send = element("button", "primary", "Send"); send.type = "submit"; send.dataset.testid = "need-sheet-send";
  const cancel = element("button", "ghost", "Cancel"); cancel.type = "button";
  boxActions.append(send, cancel);
  box.append(text, boxActions);
  let mode = null;
  const showBox = (next) => {
    mode = next;
    box.hidden = false;
    text.value = "";
    text.placeholder = next === "reply" ? "Your answer, sent to the conversation as you wrote it" : `Anything to tell “${card.title}” as it goes on? Leave it empty to just push it on.`;
    text.setAttribute("aria-label", next === "reply" ? "Your answer" : "Instructions for Push it on");
    send.textContent = next === "reply" ? "Send answer" : "Push it on";
    actions.hidden = true;
    text.focus();
  };
  const hideBox = () => { box.hidden = true; mode = null; actions.hidden = false; };
  cancel.addEventListener("click", hideBox);
  text.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); box.requestSubmit(); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); hideBox(); }
  });
  box.addEventListener("submit", (event) => {
    event.preventDefault();
    const message = text.value.trim();
    if (mode === "reply" && !message) { text.focus(); return; }
    send.disabled = true;
    const work = mode === "reply"
      ? api("/api/control-center/cards/reply", { method: "POST", body: JSON.stringify({ projectId: card.projectId, conversationId: card.conversationId, message }) }).then(() => toast(`Answered “${card.title}”`))
      : pushOn(card, message).then(() => toast(`Told “${card.title}” to go on`));
    work.then(() => { onChange(); dialog.close(); }).catch((error) => { toast.error(error.message); send.disabled = false; });
  });

  const actions = element("div", "need-sheet-actions");
  const button = (label, className, testid, run) => {
    const node = element("button", className, label);
    node.type = "button"; node.dataset.testid = testid;
    node.addEventListener("click", () => run(node));
    return node;
  };
  const guarded = (node, work) => { node.disabled = true; Promise.resolve().then(work).then(onChange).catch((error) => toast.error(error.message)).finally(() => { if (node.isConnected) node.disabled = false; }); };
  if (review) {
    actions.append(
      button("Allow once", "primary", "need-sheet-allow", (node) => guarded(node, async () => { await decideReview(card, review, "allow"); dialog.close(); })),
      button("Block", "soft", "need-sheet-block", (node) => guarded(node, async () => { await decideReview(card, review, "block"); dialog.close(); })),
    );
  } else {
    actions.append(
      button("Answer", "primary", "need-sheet-answer", () => showBox("reply")),
      button("Push it on", "soft", "need-sheet-push", () => showBox("push")),
    );
  }
  actions.append(
    button("Snooze", "ghost", "need-sheet-snooze", (node) => chooseSnooze(card, node, () => dialog.close())),
    button("Done", "ghost", "need-sheet-done", (node) => guarded(node, async () => { await markDone(card); dialog.close(); })),
    button("Open ›", "ghost", "need-sheet-open", (node) => { node.disabled = true; dialog.close(); open().catch((error) => toast.error(error.message)); }),
  );
  foot.append(box, actions);

  dialog.append(grab, head, content, foot);
  close.addEventListener("click", () => dialog.close());
  // A tap on the dimmed area closes it, as the back gesture does.
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener("close", () => { dialog.remove(); if (current?.dialog === dialog) current = null; });
  document.body.append(dialog);
  current = { dialog, close: () => dialog.open && dialog.close() };
  dialog.showModal();

  api(`/api/control-center/cards/detail?${new URLSearchParams({ projectId: card.projectId, conversationId: card.conversationId })}`)
    .then((detail) => {
      if (!dialog.isConnected) return;
      loading.remove();
      if (detail.request) { request.append(element("p", "need-sheet-request-text", detail.request)); request.hidden = false; }
      if (detail.answer) {
        const body = element("div", "need-sheet-markdown markdown");
        body.tabIndex = 0;
        body.setAttribute("aria-label", "The agent's last message");
        renderMarkdown(body, detail.answer);
        if (detail.answerCut) last.append(element("p", "need-sheet-note", "Long message: the start is cut."));
        last.append(body);
        last.hidden = false;
      }
      if (detail.steps?.length) {
        const list = element("ul", "need-sheet-steplist");
        for (const step of detail.steps) {
          const item = element("li", step.failed ? "failed" : "", step.name);
          if (step.target) item.append(" ", element("code", "", step.target));
          list.append(item);
        }
        steps.append(list); steps.hidden = false;
      }
      if (detail.unavailable) content.append(element("p", "need-sheet-note", "The conversation is on another machine, so its last message cannot be shown here. Open it to read it."));
    })
    .catch(() => { loading.textContent = "The conversation could not be read here. Open it to see more."; });
  return dialog;
}

export { openConversation };
