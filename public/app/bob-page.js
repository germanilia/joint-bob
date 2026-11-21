import { api } from "./api.js";
// Bob's page on the desktop (1024 px and wider; below that the control center is Bob's chat, control-phone.js).
// Version A of 12 Nov: a head with Bob's hat, what he does, the team context, what he watches, "Bob is on" (pause
// everything he does on his own), "Bob's settings", Refresh and Exit; below it Bob's chat and the stage, whose tabs are
// the control center's views (Bob himself, Dashboard, Automations, Memory, Dashboards, Assistants) with their counts; the views
// are Bob's sub-menu in the left column, which stays beside the page.
// The view opened last opens again, on every browser (state.controlCenter.view). Bob's chat starts folded
// on other pages (state.controlCenter.collapsed). Nothing here leaves the control center: only
// the person does (Exit, Esc twice, the toggle shortcut). The tab strip and the team context move into the page and back, by markers.
// Styles: public/bob-page.css.

import { closeConversationPopup, saveControlCenter, toggleFolded } from "./control-center.js";
import { currentControlView, showControlView } from "./control-views.js";
import { initFloatingChat } from "./bob-float.js";
import { elements } from "./elements.js";
import { setMobileView } from "./layout.js";
import { state } from "./state.js";

const wide = matchMedia("(min-width: 1024px)");
const body = document.body;
const panel = document.getElementById("controlCenterPanel");
const header = panel.querySelector(":scope > .panel-bar");
const heading = header.querySelector("h1");
const tabs = document.getElementById("controlTabs");
const stage = document.getElementById("controlViews");

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(className, testid, text) {
  const node = element("button", className, text);
  node.type = "button";
  node.dataset.testid = testid;
  return node;
}

/* ---------- the head ---------- */

const avatar = element("span", "bob-head-avatar");
avatar.setAttribute("aria-hidden", "true");
const hat = document.createElement("img");
hat.src = "/icon-mark.svg";
hat.alt = "";
hat.width = 26;
hat.height = 26;
avatar.append(hat);
const tag = element("span", "bob-head-tag", "Acts as you in every project");
tag.dataset.testid = "bob-head-tag";
const watching = element("span", "bob-head-state");
watching.dataset.testid = "bob-head-state";

const pause = button("bob-head-pause", "bob-head-pause");
pause.setAttribute("role", "switch");
pause.setAttribute("aria-checked", "true");
pause.title = "Bob acts on his own: he answers agents for you and keeps work going. Off pauses all of it; agents keep running and questions wait for you";
pause.append(element("span", "", "Bob is on"), element("i", "bob-switch-knob"));
pause.addEventListener("click", () => elements.controlChatMonitor.click());

// The top bar's icon buttons. Each keeps its text for narrow screens; on this page only the icon shows (bob-page.css).
// Theme and Settings stay in the workspace footer, so the top bar does not repeat them.
const HEAD_ICONS = {
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  exit: "M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 8l-4 4 4 4M6 12h10",
};
function headIcon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "bob-head-icon");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", HEAD_ICONS[name]);
  svg.append(path);
  return svg;
}
elements.controlCenterRefresh.prepend(headIcon("refresh"));
elements.controlCenterRefresh.title = "Refresh";
elements.controlCenterRefresh.setAttribute("aria-label", "Refresh");
elements.controlCenterCloseButton.prepend(headIcon("exit"));
elements.controlCenterCloseButton.setAttribute("aria-label", "Exit the control center");

// Bob's settings live in Bob's chat header (#controlChatSettingsButton); the team context selector moves there too.
const chatHead = elements.controlChat.querySelector(".control-chat-head");

header.prepend(avatar);
heading.after(tag, watching, pause);

/* ---------- folding: hide Bob's floating chat ---------- */

const chatFold = button("ghost compact bob-fold", "control-chat-fold", "–");
chatFold.title = "Close Bob's chat window";
elements.controlChatSide.after(chatFold);

function applyFolds() {
  body.classList.toggle("bob-chat-folded", state.controlCenter.collapsed.includes("chat"));
  float.sync();
}
function fold(id) {
  toggleFolded(id);
  applyFolds();
}
chatFold.addEventListener("click", () => fold("chat"));
const float = initFloatingChat({ panel, chat: elements.controlChat });
// Code that writes into Bob's chat (Spotlight's "Ask Bob", "Ask Bob for a dashboard", a trigger's triage) opens it first.
window.addEventListener("bob-chat-wanted", () => { if (state.controlCenter.collapsed.includes("chat")) fold("chat"); });

// On a phone Bob's settings are a screen of their own (phone.css): its head says so and goes back to the chat.
const settingsHead = element("div", "bob-settings-head");
const settingsBack = element("button", "ghost compact", "‹");
settingsBack.type = "button";
settingsBack.setAttribute("aria-label", "Back to Bob's chat");
settingsBack.dataset.testid = "bob-settings-back";
settingsBack.addEventListener("click", () => { if (!elements.controlChatSettings.hidden) elements.controlChatSettingsButton.click(); });
settingsHead.append(settingsBack, element("b", "", "Bob's settings"));
elements.controlChatSettings.prepend(settingsHead);

/** Bob's settings open over his chat, where they always were; a folded chat opens first. Pressed again, they close. */
function openSettings() {
  if (state.controlCenter.collapsed.includes("chat")) fold("chat");
  elements.controlChatSettingsButton.click();
  if (!elements.controlChatSettings.hidden) elements.controlChatSettings.scrollIntoView?.({ block: "nearest" });
}

// A system message's button to Bob's settings.
window.addEventListener("bob-settings-wanted", () => openSettings());

window.addEventListener("control-bob-settings", (event) => {
  const on = event.detail?.monitoring !== false;
  pause.setAttribute("aria-checked", String(on));
  pause.firstElementChild.textContent = on ? "Bob is on" : "Bob is paused";
  tag.textContent = on ? "Acts as you in every project" : "Paused · agents wait for you";
});

/* ---------- the views as tabs ---------- */

const ICONS = {
  live: "M4 5h16v11H9l-5 4z",
  "my-dashboard": "M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-3H4zM14 7h6V4h-6z",
  automations: "M13 3 5 14h6l-1 7 8-11h-6z",
  memory: "M5 4.5h10.5a3 3 0 0 1 3 3v12H8a3 3 0 0 1-3-3zM5 16.5a3 3 0 0 1 3-3h10.5",
  assistants: "M12 3v3M4.5 9a3 3 0 0 1 3-3h9a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-9a3 3 0 0 1-3-3zM9 12h.01M15 12h.01M9 16h6",
  dashboards: "M4 4h16v16H4zM10 4v16M16 4v16",
  team: "M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 19a5 5 0 0 1 10 0M11 19a5 5 0 0 1 10 0",
};
function icon(view) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "bob-tab-icon");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[view] ?? "M5 12h14");
  svg.append(path);
  return svg;
}
/** The tab strip is drawn anew whenever a count changes; each tab gets its icon (only shown on Bob's page). */
function decorateTabs() {
  for (const tab of tabs.querySelectorAll(".control-tab")) {
    if (!tab.querySelector(".bob-tab-icon")) tab.prepend(icon(tab.dataset.view));
  }
}
new MutationObserver(decorateTabs).observe(tabs, { childList: true });
decorateTabs();

/* ---------- the page around the control center ---------- */

/** Where a moved element lives otherwise, so it goes back exactly there. */
const homes = new Map();
function moveInto(node, target, { first = false, before = null } = {}) {
  if (!node || node.parentElement === target) return;
  if (!homes.has(node)) {
    const marker = document.createComment(`${node.id || node.className} lives here outside Bob's page`);
    node.before(marker);
    homes.set(node, marker);
  }
  if (before) before.before(node);
  else if (first) target.prepend(node);
  else target.append(node);
}
function restore() {
  for (const [node, marker] of homes) if (marker.isConnected) marker.replaceWith(node);
  homes.clear();
}

// Bob's memory is opened from his chat (it is his, not a place of the app); pressing Bob in the column comes back to the chat.
const memoryButton = element("button", "ghost compact bob-memory-button", "Memory");
memoryButton.type = "button";
memoryButton.title = "What Bob remembers: topics, and what he changed";
memoryButton.dataset.testid = "bob-memory-button";
memoryButton.addEventListener("click", () => showControlView("memory"));

// A page of his pressed from outside the control center opens it on that page (the tab's own handler then shows the view).
tabs.addEventListener("click", (event) => {
  const tab = event.target.closest(".control-tab");
  if (!tab || body.classList.contains("view-control") || !body.classList.contains("bob-desk")) return;
  state.controlCenter.view = tab.dataset.view;
  setMobileView("control");
}, { capture: true });

// A place chosen in the column while a conversation is open over his page closes it: the place is what was asked for.
document.getElementById("workspaceSide").addEventListener("click", (event) => {
  if (!body.classList.contains("control-popup") || !event.target.closest(".ws-place, .control-tab")) return;
  closeConversationPopup();
}, { capture: true });

function onPage() {
  return wide.matches && body.classList.contains("ws-desktop") && !body.classList.contains("focus-ui");
}

function apply() {
  const page = onPage();
  const changed = body.classList.contains("bob-desk") !== page;
  body.classList.toggle("bob-desk", page);
  if (changed) window.dispatchEvent(new CustomEvent("bob-desk-changed"));
  if (page) {
    // His pages are places of their own, after Automations; Bob himself is the first conversation of the column's list.
    moveInto(tabs, document.querySelector(".ws-places"), { before: document.querySelector(".ws-places > [data-usage-open]") });
    moveInto(elements.openControlCenterButton, document.getElementById("workspaceSide"));
    if (!memoryButton.isConnected) elements.controlChatSettingsButton.before(memoryButton);
    moveInto(document.querySelector(".team-context-label"), chatHead, { before: elements.controlChatSettingsButton });
    if (giveBack.parentElement !== popupBar) moveInto(giveBack, popupBar);
    popupBar.append(document.getElementById("controlPopupClose"));
    placePopup();
  } else restore();
  float.sync();
  nameHead();
}

// The view opened last opens again; a view asked for right as the control center opens (Automations in the left column,
// a dashboard Bob opens) follows this and wins. Any wide window keeps it (the page's own classes may come later); a
// phone always starts at the chat (control-phone.js), so it neither restores nor saves the view.
// The page opens at its full width: Bob's chat starts folded. Only entering folds it: the control
// center is activated again while it is open (a conversation closing, a search), and that must not close a chat the person opened.
let entered = false;
/** The column's list before Bob's page showed the Inbox in it: leaving puts it back. */
let columnBefore = null;
window.addEventListener("app-view-changed", () => {
  if (body.classList.contains("view-control")) return;
  entered = false;
  if (columnBefore === "projects") window.dispatchEvent(new CustomEvent("workspace-place", { detail: { place: "projects" } }));
  columnBefore = null;
});
window.addEventListener("control-center-activated", () => {
  apply();
  // Bob and the Inbox are one place: entering his page shows the Inbox (what he watches) as the column's list, and leaving it
  // gives the column back as it was.
  if (wide.matches && !entered) {
    columnBefore = body.classList.contains("ws-column-projects") ? "projects" : null;
    window.dispatchEvent(new CustomEvent("workspace-place", { detail: { place: "inbox" } }));
  }
  if (wide.matches && !entered && !state.controlCenter.collapsed.includes("chat")) toggleFolded("chat");
  entered = true;
  applyFolds();
  if (wide.matches && state.controlCenter.view !== currentControlView()) showControlView(state.controlCenter.view);
});
window.addEventListener("control-view-changed", (event) => {
  const id = event.detail.id;
  if (!wide.matches || !body.classList.contains("view-control") || state.controlCenter.view === id) return;
  state.controlCenter.view = id;
  saveControlCenter();
});
wide.addEventListener("change", apply);
new MutationObserver(() => { if (body.classList.contains("bob-desk") !== onPage()) apply(); }).observe(body, { attributes: true, attributeFilter: ["class"] });

/* ---------- a conversation opened from the page ---------- */

// It opens over the stage, beside Bob's chat, instead of over the whole page: its frame follows the stage's box. The
// lease banner's "Give back to Bob" joins the popup bar, so the bar is the one line that says who is in control.
const popupBar = document.getElementById("controlPopupBar");
const giveBack = document.getElementById("controlLeaseGiveBack");
// It covers the page's whole working area (the stage, or Bob's chat when his own view is open), never the left column.
const workArea = stage.parentElement;
function placePopup() {
  if (!body.classList.contains("bob-desk")) return;
  const box = workArea.getBoundingClientRect();
  for (const [name, value] of [["x", box.left], ["y", box.top], ["w", box.width], ["h", box.height]]) body.style.setProperty(`--bob-pop-${name}`, `${Math.round(value)}px`);
}
new ResizeObserver(placePopup).observe(workArea);
window.addEventListener("resize", placePopup);
window.addEventListener("control-popup-opened", placePopup);

/* ---------- what Bob watches ---------- */

function pill(text, className) {
  const node = element("span", `bob-state-pill ${className}`, text);
  node.dataset.testid = `bob-head-${className.split(" ")[0]}`;
  return node;
}
window.addEventListener("control-center-rendered", (event) => {
  const cards = event.detail?.cards ?? [];
  const running = cards.filter((card) => card.column === "running").length;
  const waiting = cards.filter((card) => card.column === "needs-you").length;
  watching.replaceChildren(
    running ? pill(`Watching ${running} running`, "running live") : pill("Nothing running", "running"),
    ...(waiting ? [pill(`${waiting} need${waiting === 1 ? "s" : ""} you`, "waiting")] : []),
  );
});

apply();
applyFolds();

/* ---------- the head names the page ---------- */

// His own view is "Bob" with what he does; his other pages are named in the head, as a conversation or Costs names itself.
function nameHead() {
  // Read when called: apply() runs while this module is still loading.
  const PAGE_NAMES = { "my-dashboard": "Dashboard", automations: "Automations", memory: "Bob's memory", dashboards: "Dashboards", assistants: "Assistants" };
  if (!body.classList.contains("bob-desk")) { heading.textContent = "Control center"; return; }
  const view = currentControlView();
  heading.textContent = PAGE_NAMES[view] ?? "Bob";
  tag.hidden = view !== "live";
}
window.addEventListener("control-view-changed", nameHead);

/* ---------- Bob's own view: his chat alone, in the middle, like a conversation ---------- */

// "Bob" in the left column always opens his chat. It runs before the button's own handler (layout.js opens the control
// center), so the view the opening restores is his.
elements.openControlCenterButton.addEventListener("click", () => {
  state.controlCenter.view = "live";
  if (!body.classList.contains("view-control")) return;
  showControlView("live");
  // Pressed on his page after Projects filled the column: Bob is the Inbox again (its own place is hidden in the column).
  if (wide.matches) window.dispatchEvent(new CustomEvent("workspace-place", { detail: { place: "inbox" } }));
}, { capture: true });

// The "live" view is Bob himself (control-center.js registers it as "Bob"): the stage steps aside and the chat takes the page
// (bob-page.css, body.bob-chat-page). It opens unfolded, and goes back to the folded "Ask Bob" button when another view is opened.
let unfoldedByView = false;
function syncBobChatPage() {
  const on = !body.classList.contains("focus-ui") && body.classList.contains("view-control") && currentControlView() === "live";
  body.classList.toggle("bob-chat-page", on);
  const folded = state.controlCenter.collapsed.includes("chat");
  if (on && folded) { unfoldedByView = true; toggleFolded("chat"); applyFolds(); }
  else if (!on && unfoldedByView && !folded) { unfoldedByView = false; toggleFolded("chat"); applyFolds(); }
}
window.addEventListener("control-view-changed", syncBobChatPage);
window.addEventListener("control-center-activated", syncBobChatPage);
window.addEventListener("app-view-changed", syncBobChatPage);
