// Control center: the webhook log. Every call a webhook receives is listed here, newest first, with how the conversation it
// started ended (settled, in hand, needs you), a page at a time; none of it goes to Bob's chat. A button in Bob's header
// opens it. The server tells open pages when a call arrives or its conversation ends.
import { api } from "./api.js";
import { openConversation } from "./control-center.js";
import { elements } from "./elements.js";
import { createFittedList, makeButton, makeNode } from "./relay-ui.js";
import { toast } from "./shell.js";
import { openProjectWebhooks } from "./webhooks.js";

const BASE = "/api/control-center/triggers";

const testid = (node, id) => { node.dataset.testid = id; return node; };

function ago(iso) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

// ── The button and its panel ─────────────────────────────────────────────────────────────────────────────

/** A list with lines: a log, not a bell, since nothing here asks for attention. */
function logIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({ viewBox: "0 0 24 24", width: "15", height: "15", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(name, value);
  for (const d of ["M8 6h13", "M8 12h13", "M8 18h13", "M3 6h.01", "M3 12h.01", "M3 18h.01"]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

const bell = testid(makeNode("button", "ghost compact control-bell"), "control-triggers-bell");
bell.type = "button";
bell.title = "Webhook log: every call your webhooks received, and how it ended";
bell.setAttribute("aria-label", "Webhook log");
bell.setAttribute("aria-haspopup", "true");
bell.setAttribute("aria-expanded", "false");
bell.append(logIcon());
elements.controlChatMonitor.before(bell);

const panel = testid(makeNode("section", "control-triggers"), "control-triggers-panel");
panel.hidden = true;
panel.setAttribute("aria-label", "Webhook log");
const dismissAll = makeButton("Clear log", "control-triggers-dismiss-all", () => dismissEvery());
const head = makeNode("div", "control-triggers-head");
head.append(makeNode("b", "", "Webhook log"), makeNode("span", "control-spacer"), dismissAll);
const list = testid(makeNode("div", "control-triggers-list"), "control-triggers-list");
const pager = testid(makeNode("div", "control-triggers-pager"), "control-triggers-pager");
const hint = testid(makeNode("p", "control-triggers-hint", "Every call your webhooks receive, newest first, with how the conversation it started ended. Nothing here goes to Bob's chat."), "control-triggers-hint");
panel.append(head, list, pager, hint);
elements.controlChat.append(panel);

const isOpen = () => !panel.hidden;

function closePanel() {
  if (!isOpen()) return;
  panel.hidden = true;
  bell.setAttribute("aria-expanded", "false");
}

function openPanel() {
  panel.hidden = false;
  bell.setAttribute("aria-expanded", "true");
  fitted.first().catch((error) => toast.error(error.message));
}

bell.addEventListener("click", (event) => {
  event.stopPropagation();
  if (isOpen()) closePanel(); else openPanel();
});
document.addEventListener("click", (event) => {
  if (isOpen() && !panel.contains(event.target) && !bell.contains(event.target)) closePanel();
});
// Esc closes the panel first; the control center's own Esc handler leaves a default-prevented key alone.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !isOpen()) return;
  event.preventDefault();
  event.stopPropagation();
  closePanel();
  bell.focus();
}, true);

// ── The list ─────────────────────────────────────────────────────────────────────────────────────────────

const fitted = createFittedList({
  list, pager, testPrefix: "control-triggers", initialSize: 4, maxSize: 20,
  emptyText: "No webhook calls yet.",
  async fetchPage(page, size) {
    const body = await api(`${BASE}?page=${page}&size=${size}`);
    dismissAll.disabled = body.total === 0;
    return { total: body.total, items: body.triggers };
  },
  renderItem: renderTrigger,
});

/** How the call ended, as far as Bob knows: what its conversation came to, or that he is still waiting for one. */
function outcomeText(trigger) {
  if (trigger.outcome.label) return trigger.conversation ? `${trigger.outcome.label}: “${trigger.conversation.title}”` : trigger.outcome.label;
  return "no conversation known yet";
}

function renderTrigger(trigger) {
  const row = testid(makeNode("div", "control-trigger"), "control-trigger");
  row.dataset.id = trigger.id;
  row.dataset.outcome = trigger.outcome.label || "unknown";
  const title = testid(makeNode("b", "control-trigger-title", trigger.title), "control-trigger-title");
  title.append(makeNode("span", "control-trigger-project", ` · ${trigger.projectName}`));
  row.append(title);
  if (trigger.summary) row.append(testid(makeNode("span", "control-trigger-summary", trigger.summary), "control-trigger-summary"));
  const meta = testid(makeNode("small", "control-trigger-meta", `webhook ${trigger.webhookName} · ${ago(trigger.receivedAt)} · ${outcomeText(trigger)}`), "control-trigger-meta");
  meta.title = [new Date(trigger.receivedAt).toLocaleString(), trigger.outcome.reason].filter(Boolean).join("\n");
  row.append(meta);
  const actions = makeNode("div", "control-trigger-actions");
  if (trigger.conversation) actions.append(makeButton("Open conversation", "control-trigger-conversation", () => openCall(trigger), "primary compact"));
  actions.append(
    makeButton("Webhook", "control-trigger-open", () => openWebhook(trigger)),
    makeButton("Ask Bob", "control-trigger-triage", (event) => triage(trigger, event.currentTarget)),
    makeButton("Clear", "control-trigger-dismiss", (event) => dismiss(trigger, event.currentTarget)),
  );
  row.append(actions);
  return row;
}

// ── What each button does ────────────────────────────────────────────────────────────────────────────────

/** The conversation that worked on the call, over the board as a card opens. */
function openCall(trigger) {
  closePanel();
  openConversation({ projectId: trigger.projectId, conversationId: trigger.conversation.id, title: trigger.conversation.title }).catch((error) => toast.error(error.message));
}

/** The webhook lives in its project's Webhooks screen, which is also where the Automations tab sends the person. */
function openWebhook(trigger) {
  closePanel();
  openProjectWebhooks({ id: trigger.projectId, name: trigger.projectName }).catch((error) => toast.error(error.message));
}

/**
 * Says the triage question in Bob's chat the way the person would type it: it goes through the chat's own form, so it
 * shows as their message, Bob answers below it, and the same route and labels apply. What they had typed stays.
 */
function sayToBob(message, projectId) {
  window.dispatchEvent(new CustomEvent("bob-chat-wanted"));
  const input = elements.controlChatInput;
  const project = elements.controlChatProject;
  const draft = input.value;
  const chosen = project.value;
  input.value = message;
  if ([...project.options].some((option) => option.value === projectId)) project.value = projectId;
  // The payload came from outside: Bob answers it and starts nothing.
  elements.controlChatForm.dataset.answerOnly = "1";
  elements.controlChatForm.requestSubmit();
  // The form read the text and cleared the box before this line.
  input.value = draft;
  project.value = chosen;
}

async function triage(trigger, button) {
  button.disabled = true;
  try {
    const { message, projectId } = await api(`${BASE}/${encodeURIComponent(trigger.id)}/triage`);
    closePanel();
    sayToBob(message, projectId);
  } catch (error) {
    toast.error(error.message);
    button.disabled = false;
  }
}

async function dismiss(trigger, button) {
  button.disabled = true;
  try {
    await api(`${BASE}/dismiss`, { method: "POST", body: JSON.stringify({ ids: [trigger.id] }) });
    await fitted.reload();
  } catch (error) {
    toast.error(error.message);
    button.disabled = false;
  }
}

async function dismissEvery() {
  dismissAll.disabled = true;
  try {
    await api(`${BASE}/dismiss`, { method: "POST", body: JSON.stringify({ all: true }) });
    await fitted.first();
  } catch (error) {
    toast.error(error.message);
    dismissAll.disabled = false;
  }
}

// ── Staying current ──────────────────────────────────────────────────────────────────────────────────────

// The server says when a call arrives or its conversation ends; an open log reads its page again.
window.addEventListener("control-center-changed", () => {
  if (isOpen()) fitted.reload().catch((error) => console.warn("Could not read the webhook log", error));
});
