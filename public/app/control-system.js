// System messages: what the system found wrong with itself (a missing key, a harness nobody signed in, a machine that does
// not answer; src/control-center/system-messages.ts). They are the first rows of the control center's list, in colour, in
// every scope and order, and cannot be dismissed: one leaves when its cause is gone, which "Check again" looks for.
// Each says what it means and how to fix it, with a button to the screen that holds the fix.

import { api } from "./api.js";

let messages = [];
let readAt = 0;
let loading = null;
const FRESH_MS = 30_000;

export const systemList = () => messages;

/** Reads the messages when they are older than half a minute (or when forced). Resolves true when they changed. */
export function loadSystem({ force = false } = {}) {
  if (loading) return loading;
  if (!force && Date.now() - readAt < FRESH_MS) return Promise.resolve(false);
  loading = api("/api/control-center/system")
    .then(({ messages: next }) => {
      const changed = JSON.stringify(next) !== JSON.stringify(messages);
      messages = next;
      readAt = Date.now();
      return changed;
    })
    .finally(() => { loading = null; });
  return loading;
}

const settingsTab = (tab) => () => import("./settings.js").then(({ openSettings }) => openSettings(tab));
const OPENERS = {
  "bob-settings": () => window.dispatchEvent(new CustomEvent("bob-settings-wanted")),
  "settings-guardian": settingsTab("guardian"),
  "settings-cluster": settingsTab("cluster"),
  "settings-harnesses": settingsTab("engines"),
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Text with `code` spans, built from nodes. */
function withCode(node, text) {
  text.split("`").forEach((part, index) => node.append(index % 2 ? element("code", "", part) : part));
  return node;
}

/** The panel of one message: what it means, the steps, the button to the fix, and Check again. */
export function systemPanel(message, { checkAgain }) {
  const kind = message.severity === "error" ? "Not working" : "Needs a look";
  const top = element("div", "control-list-pv-top");
  top.append(element("span", "control-sys-icon big", "!"), element("span", `control-sys-pill ${message.severity}`, kind), element("span", "control-sys-pill system", "System"));
  const meta = element("p", "control-list-meta", message.where);
  const why = element("div", "control-sys-why");
  why.append(element("b", "", "What this means"), element("p", "", message.why));
  const steps = element("ol", "control-sys-steps");
  steps.dataset.testid = "control-sys-steps";
  for (const step of message.steps) steps.append(withCode(element("li"), step));
  const how = element("section", "control-list-section");
  how.append(element("h4", "", "How to fix"), steps);
  const actions = element("div", "control-sys-actions");
  if (message.action) {
    const open = element("button", "primary", message.action.label);
    open.type = "button";
    open.dataset.testid = "control-sys-action";
    open.addEventListener("click", () => OPENERS[message.action.open]());
    actions.append(open);
  }
  const again = element("button", "ghost", "Check again");
  again.type = "button";
  again.dataset.testid = "control-sys-check";
  again.addEventListener("click", () => { again.disabled = true; checkAgain().finally(() => { again.disabled = false; }); });
  actions.append(again, element("span", "control-sys-hint", "It goes away by itself once it works"));
  return [top, element("h2", "control-list-heading", message.title), meta, why, how, actions];
}
