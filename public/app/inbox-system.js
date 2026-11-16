// The system messages in the left column: what the system found wrong with itself (a missing key, a harness nobody signed in,
// a machine that does not answer; src/control-center/system-messages.ts). They are one coloured line under the places, above
// the Inbox (the column keeps its room for the conversations): the message itself when there is one, "N things to fix" when
// there are more. They cannot be dismissed: one leaves when its cause is gone. The line opens every message with what it means
// and how to fix it (control-system.js `systemPanel`), its button to the fix, and "Check again".

import { loadSystem, systemList, systemPanel } from "./control-system.js";
import { toast } from "./shell.js";

/** How often the messages are read again while the page is in view. */
const EVERY_MS = 60_000;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The lines, placed under the column's places by workspace.js. */
export const systemStrip = element("div", "inbox-system");
systemStrip.dataset.testid = "inbox-system";
systemStrip.setAttribute("aria-label", "System messages");
systemStrip.hidden = true;

const dialog = element("dialog", "inbox-system-dialog");
dialog.dataset.testid = "inbox-system-dialog";
const body = element("div", "inbox-system-body");
const close = element("button", "ghost compact inbox-system-close", "Close");
close.type = "button";
close.dataset.testid = "inbox-system-close";
close.addEventListener("click", () => dialog.close());
dialog.append(close, body);
// The fix opens a screen of its own (Settings, Bob's settings): the dialog makes way for it.
body.addEventListener("click", (event) => { if (event.target.closest("[data-testid='control-sys-action']")) dialog.close(); });
document.body.append(dialog);

function drawPanels() {
  const messages = systemList();
  if (!messages.length) { dialog.close(); return; }
  body.replaceChildren(...messages.map((message) => {
    const section = element("section", `inbox-system-message ${message.severity}`);
    section.dataset.testid = "inbox-system-message";
    section.append(...systemPanel(message, { checkAgain }));
    return section;
  }));
}

function drawStrip() {
  const messages = systemList();
  systemStrip.hidden = !messages.length;
  if (!messages.length) { systemStrip.replaceChildren(); dialog.close(); return; }
  const worst = messages.find((message) => message.severity === "error") ?? messages[0];
  const line = element("button", `inbox-system-line ${worst.severity}`);
  line.type = "button";
  line.dataset.testid = "inbox-system-line";
  const words = messages.length === 1 ? worst.title : `${messages.length} things to fix`;
  line.title = messages.map((message) => message.title).join("\n");
  line.append(element("span", "control-sys-icon", "!"), element("b", "", words), element("span", "inbox-system-fix", worst.severity === "error" ? "Fix" : "Check"));
  line.addEventListener("click", () => {
    drawPanels();
    dialog.showModal();
  });
  systemStrip.replaceChildren(line);
  if (dialog.open) drawPanels();
}

function checkAgain() {
  return loadSystem({ force: true }).then(drawStrip).catch((error) => toast.error(error.message));
}

/** Reads the messages again (`force` skips the half-minute freshness) and redraws the lines. */
export function refreshSystemStrip(force = false) {
  return loadSystem({ force }).then(drawStrip).catch((error) => console.warn("Could not read the system messages", error));
}

setInterval(() => { if (!document.hidden) void refreshSystemStrip(true); }, EVERY_MS);
// A setting changed elsewhere (a key saved, a harness signed in) can clear a message: the board's signals read them again.
window.addEventListener("control-center-changed", () => { void refreshSystemStrip(true); });
window.addEventListener("running-refreshed", () => { void refreshSystemStrip(); });
