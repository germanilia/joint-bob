// Bob's page on the desktop (1024 px and wider; below that the control center is Bob's chat, control-phone.js).
// Version A of 12 Nov: a head with Bob's hat, what he does, the team context, what he watches, "Bob is on" (pause
// everything he does on his own), "Bob's settings", Refresh and Exit; below it Bob's chat and the stage, whose tabs are
// the control center's views (Live agents, Dashboard, Automations, Memory, Dashboards, Assistants) with their counts.
// The view opened last opens again, on every browser (state.controlCenter.view). Bob's chat folds into the "Ask Bob"
// button (state.controlCenter.collapsed). Nothing here leaves the control center: only the person does (Exit, Esc
// twice, the toggle shortcut). The tab strip and the team context move into the page and back, by markers.
// Styles: public/bob-page.css.

import { saveControlCenter, toggleFolded } from "./control-center.js";
import { currentControlView, showControlView } from "./control-views.js";
import { elements } from "./elements.js";
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
const contextHere = element("span", "bob-head-context");
const watching = element("span", "bob-head-state");
watching.dataset.testid = "bob-head-state";

const pause = button("bob-head-pause", "bob-head-pause");
pause.setAttribute("role", "switch");
pause.setAttribute("aria-checked", "true");
pause.title = "Bob acts on his own: he answers agents for you and keeps work going. Off pauses all of it; agents keep running and questions wait for you";
pause.append(element("span", "", "Bob is on"), element("i", "bob-switch-knob"));
pause.addEventListener("click", () => elements.controlChatMonitor.click());

const settingsButton = button("ghost compact bob-head-settings", "bob-head-settings", "Bob's settings");
settingsButton.title = "Bob's agent, model, decision model, auto respond, unfinished work, system control, memory, Guardian and Telegram";
settingsButton.addEventListener("click", () => openSettings());

header.prepend(avatar);
heading.after(tag, contextHere, watching, pause, settingsButton);

/* ---------- folding: Bob's chat folds into the "Ask Bob" button ---------- */

const chatFold = button("ghost compact bob-fold", "control-chat-fold", "–");
chatFold.title = "Fold Bob's chat into a button";
elements.controlChatSide.after(chatFold);
const chatFab = button("bob-fab bob-fab-chat", "bob-fab-chat");
chatFab.title = "Open Bob's chat";
const fabCount = element("span", "bob-fab-count");
fabCount.dataset.testid = "bob-fab-count";
chatFab.append(element("i", "bob-fab-hat"), element("span", "", "Ask Bob"), fabCount);
panel.append(chatFab);

function applyFolds() {
  body.classList.toggle("bob-chat-folded", state.controlCenter.collapsed.includes("chat"));
}
function fold(id) {
  toggleFolded(id);
  applyFolds();
}
chatFold.addEventListener("click", () => fold("chat"));
chatFab.addEventListener("click", () => fold("chat"));

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

window.addEventListener("control-bob-settings", (event) => {
  const on = event.detail?.monitoring !== false;
  pause.setAttribute("aria-checked", String(on));
  pause.firstElementChild.textContent = on ? "Bob is on" : "Bob is paused";
  tag.textContent = on ? "Acts as you in every project" : "Paused · agents wait for you";
});

/* ---------- the views as tabs ---------- */

const ICONS = {
  live: "M3 12h4l3-8 4 16 3-8h4",
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
function moveInto(node, target, { first = false } = {}) {
  if (!node || node.parentElement === target) return;
  if (!homes.has(node)) {
    const marker = document.createComment(`${node.id || node.className} lives here outside Bob's page`);
    node.before(marker);
    homes.set(node, marker);
  }
  if (first) target.prepend(node);
  else target.append(node);
}
function restore() {
  for (const [node, marker] of homes) if (marker.isConnected) marker.replaceWith(node);
  homes.clear();
}

function onPage() {
  return wide.matches && body.classList.contains("ws-desktop") && !body.classList.contains("focus-ui");
}

let updatesFolded = false;
function apply() {
  const page = onPage();
  body.classList.toggle("bob-desk", page);
  if (page) {
    moveInto(tabs, stage, { first: true });
    moveInto(document.querySelector(".team-context-label"), contextHere);
    if (giveBack.parentElement !== popupBar) moveInto(giveBack, popupBar);
    popupBar.append(document.getElementById("controlPopupClose"));
    placePopup();
    // Background updates start folded at the top of the chat, once; the person opens them from their count.
    if (!updatesFolded) {
      document.querySelector('[data-testid="control-chat-updates"]').open = false;
      updatesFolded = true;
    }
  } else restore();
  heading.textContent = page ? "Bob" : "Control center";
}

// The view opened last opens again; a view asked for right as the control center opens (Automations in the left column,
// a dashboard Bob opens) follows this and wins. Any wide window keeps it (the page's own classes may come later); a
// phone always starts at the chat (control-phone.js), so it neither restores nor saves the view.
window.addEventListener("control-center-activated", () => {
  apply();
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
function placePopup() {
  if (!body.classList.contains("bob-desk")) return;
  const box = stage.getBoundingClientRect();
  for (const [name, value] of [["x", box.left], ["y", box.top], ["w", box.width], ["h", box.height]]) body.style.setProperty(`--bob-pop-${name}`, `${Math.round(value)}px`);
}
new ResizeObserver(placePopup).observe(stage);
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
  fabCount.textContent = waiting ? String(waiting) : "";
});

apply();
applyFolds();
