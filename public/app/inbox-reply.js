import { api } from "./api.js";
import { sendCardReply } from "./card-reply.js";
import { toast } from "./shell.js";
import { renderMarkdown } from "../markdown.js";

const element = (tag, className, text) => Object.assign(document.createElement(tag), { className, textContent: text ?? "" });

export function openInboxReply(card, { open, onSent }) {
  const title = element("h2", "", card.title || "Conversation");
  title.id = "inboxReplyTitle";
  const meta = element("p", "need-sheet-meta", `Quick reply · ${card.projectName}`);
  const heading = element("div", "need-sheet-heading");
  heading.append(meta, title);
  const close = element("button", "ghost need-sheet-close", "×");
  close.setAttribute("aria-label", "Close");
  const head = element("header", "need-sheet-head");
  head.append(heading, close);
  const body = element("div", "need-sheet-body inbox-reply-history");
  body.tabIndex = 0;
  body.setAttribute("role", "region");
  body.setAttribute("aria-label", "Recent messages");
  const form = element("form", "need-sheet-foot");
  const input = element("textarea", "inbox-reply-input");
  Object.assign(input, { ariaLabel: "Reply", placeholder: "Write a reply…", rows: 3, maxLength: 8000, required: true, autofocus: true });
  const error = element("p", "need-sheet-note inbox-reply-error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  const actions = element("div", "need-sheet-actions inbox-reply-actions");
  const openButton = element("button", "ghost", "Open");
  openButton.type = "button";
  const send = element("button", "primary", "Send reply");
  send.type = "submit";
  send.disabled = true;
  actions.append(openButton, send);
  form.append(input, error, actions);

  const dialog = element("dialog", "need-sheet inbox-reply");
  dialog.setAttribute("aria-labelledby", title.id);
  dialog.append(head, body, form);
  close.addEventListener("click", () => dialog.close());
  openButton.addEventListener("click", () => { dialog.close(); open(); });
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener("close", () => dialog.remove());
  const ref = { projectId: card.projectId, conversationId: card.conversationId };
  wireSend({ form, input, error, send, dialog, ref, onSent });
  document.body.append(dialog);
  dialog.showModal();
  void loadRecentMessages(body, card, ref);
}

function wireSend({ form, input, error, send, dialog, ref, onSent }) {
  let sending = false;
  const update = () => { send.disabled = sending || !input.value.trim(); };
  input.addEventListener("input", update);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!send.disabled) form.requestSubmit();
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = input.value.trim();
    if (sending || !message) return;
    sending = true;
    update();
    input.readOnly = true;
    error.hidden = true;
    send.textContent = "Sending…";
    try {
      if (!await sendCardReply(ref, message, dialog)) return;
    } catch (failure) {
      error.textContent = failure.cause?.message || failure.message;
      if (!failure.status || failure.status === 408 || failure.status === 504) error.textContent = failure.message;
      error.hidden = false;
      if (!dialog.open) toast.error(failure.message);
      return;
    } finally {
      input.readOnly = false;
      sending = false;
      send.textContent = "Send reply";
      update();
    }
    dialog.close();
    toast("Reply sent");
    onSent();
  });
}

async function loadRecentMessages(body, card, ref) {
  const status = element("p", "need-sheet-note", "Loading recent messages…");
  status.setAttribute("role", "status");
  body.append(status);
  try {
    const detail = await api(`/api/control-center/cards/detail?${new URLSearchParams(ref)}`);
    if (!body.isConnected) return;
    if (detail.unavailable) status.textContent = "The preview is unavailable. Open the conversation to read it.";
    else if (!detail.recentMessages.length) status.textContent = "No messages yet.";
    else {
      body.replaceChildren(...detail.recentMessages.map((message) => {
        const entry = element("section", "need-sheet-section");
        entry.dataset.testid = "inbox-reply-message";
        const author = message.role === "user" ? "You" : card.agentLabel || "Agent";
        const text = element("div", "need-sheet-markdown inbox-reply-text markdown");
        renderMarkdown(text, message.text);
        entry.append(element("h3", "", message.cut ? `${author} · beginning omitted` : author), text);
        return entry;
      }));
    }
  } catch (failure) {
    status.textContent = `Could not load recent messages. ${failure.cause?.message || failure.message}`;
  }
}
