// Bob's page on the desktop (1024 px and wider; below that the control center is Bob's chat, control-phone.js).
// The page is the stage, Bob's chat beside it, and on the right, always there, "What Bob looks after": the control
// center's views (Live agents, Dashboard, Automations, Memory, Dashboards, Assistants, with their counts) as rows that
// open the view on the stage, then Bob himself: his model, "Ask before saving to memory", "Pause everything Bob does",
// the team context and all of his settings. The head toggles the stage between Live conversations and the Dashboard.
// The view opened last opens again, on every browser (state.controlCenter.view). Bob's chat and the right column each
// fold into a round button and open from it again (state.controlCenter.collapsed). Nothing here leaves the control
// center: only the person does (Exit, Esc twice, the toggle shortcut). The tab strip and the team context move into the
// right column and back, by markers. Styles: public/bob-page.css.

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
function hatImage(size) {
  const hat = document.createElement("img");
  hat.src = "/icon-mark.svg";
  hat.alt = "";
  hat.width = size;
  hat.height = size;
  return hat;
}

/* ---------- the head: Bob's hat, his name, the stage toggle and what he watches ---------- */

const avatar = element("span", "bob-head-avatar");
avatar.setAttribute("aria-hidden", "true");
avatar.append(hatImage(22));
const tag = element("span", "bob-head-tag", "Acts as you in every project");
tag.dataset.testid = "bob-head-tag";
const watching = element("span", "bob-head-state");
watching.dataset.testid = "bob-head-state";
header.prepend(avatar);
heading.after(tag);

/** The stage shows the live conversations or the Dashboard; another view opened from the right column presses neither. */
const STAGE_VIEWS = [["live", "Live conversations"], ["my-dashboard", "Dashboard"]];
const toggle = element("div", "bob-stage-toggle");
toggle.setAttribute("role", "group");
toggle.setAttribute("aria-label", "What the stage shows");
toggle.dataset.testid = "bob-stage-toggle";
for (const [view, label] of STAGE_VIEWS) {
  const choice = button("bob-stage-choice", `bob-stage-${view}`, label);
  choice.dataset.view = view;
  choice.addEventListener("click", () => showControlView(view));
  toggle.append(choice);
}
tag.after(toggle, watching);
function markToggle() {
  for (const choice of toggle.children) choice.setAttribute("aria-pressed", String(choice.dataset.view === currentControlView()));
}

/* ---------- the right column ---------- */

const side = element("aside", "bob-side");
side.id = "bobSide";
side.dataset.testid = "bob-side";
side.setAttribute("aria-label", "What Bob looks after");
const sideFold = button("ghost compact bob-fold", "bob-side-fold", "»");
sideFold.title = "Fold this column into a button";
const looksAfter = element("div", "bob-side-lab bob-side-top");
looksAfter.append(element("span", "", "What Bob looks after"), sideFold);
const tabsHere = element("div", "bob-side-group bob-side-tabs");
const bobLab = element("div", "bob-side-lab", "Bob");
const bobGroup = element("div", "bob-side-group");

function line(className, testid) {
  return button(`bob-line ${className}`, testid);
}
function chevron() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "bob-chev");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "m9 18 6-6-6-6");
  svg.append(path);
  return svg;
}

const model = line("bob-model", "bob-side-model");
const modelValue = element("em", "", "Bob's agent");
model.append(element("span", "", "Model"), modelValue, chevron());
model.title = "Bob's agent, model and effort";
model.addEventListener("click", () => openSettings());

function switchLine(label, testid, title) {
  const node = line("bob-switch", testid);
  node.setAttribute("role", "switch");
  node.setAttribute("aria-checked", "false");
  node.title = title;
  node.append(element("span", "", label), element("i", "bob-switch-knob"));
  return node;
}
const ask = switchLine("Ask before saving to memory", "bob-side-ask", "Bob asks you before he saves anything to his memory");
ask.addEventListener("click", () => {
  elements.controlBobAsk.checked = !elements.controlBobAsk.checked;
  elements.controlBobAsk.dispatchEvent(new Event("change", { bubbles: true }));
  ask.setAttribute("aria-checked", String(elements.controlBobAsk.checked));
});
const pause = switchLine("Pause everything Bob does", "bob-side-pause", "Pause everything Bob does on his own (Monitoring): agents keep running, nobody answers for them, and questions wait for you");
pause.addEventListener("click", () => elements.controlChatMonitor.click());
const allSettings = line("bob-all", "bob-side-settings");
allSettings.append(element("span", "", "All of Bob's settings"), chevron());
allSettings.title = "Decision model, confidence, auto respond, unfinished work, system control and standing instructions";
allSettings.addEventListener("click", () => openSettings());
const contextHere = element("div", "bob-side-context");
bobGroup.append(model, ask, pause, contextHere, allSettings);
side.append(looksAfter, tabsHere, bobLab, bobGroup);
panel.append(side);

/* ---------- folding: Bob's chat and the right column fold into round buttons ---------- */

const chatFold = button("ghost compact bob-fold", "control-chat-fold", "–");
chatFold.title = "Fold Bob's chat into a button";
elements.controlChatSide.after(chatFold);
const chatFab = button("bob-fab bob-fab-chat", "bob-fab-chat");
chatFab.title = "Open Bob's chat";
chatFab.append(hatImage(24));
const sideFab = button("bob-fab bob-fab-side", "bob-fab-side", "«");
sideFab.title = "Open What Bob looks after";
panel.append(chatFab, sideFab);

function applyFolds() {
  body.classList.toggle("bob-chat-folded", state.controlCenter.collapsed.includes("chat"));
  body.classList.toggle("bob-side-folded", state.controlCenter.collapsed.includes("side"));
}
function fold(id) {
  toggleFolded(id);
  applyFolds();
}
chatFold.addEventListener("click", () => fold("chat"));
chatFab.addEventListener("click", () => fold("chat"));
sideFold.addEventListener("click", () => fold("side"));
sideFab.addEventListener("click", () => fold("side"));

// On a phone Bob's settings are a screen of their own (phone.css): its head says so and goes back to the chat.
const settingsHead = element("div", "bob-settings-head");
const settingsBack = element("button", "ghost compact", "‹");
settingsBack.type = "button";
settingsBack.setAttribute("aria-label", "Back to Bob's chat");
settingsBack.dataset.testid = "bob-settings-back";
settingsBack.addEventListener("click", () => { if (!elements.controlChatSettings.hidden) elements.controlChatSettingsButton.click(); });
settingsHead.append(settingsBack, element("b", "", "Bob's settings"));
elements.controlChatSettings.prepend(settingsHead);

/** Bob's settings open over his chat, where they always were; a folded chat opens first. */
function openSettings() {
  if (state.controlCenter.collapsed.includes("chat")) fold("chat");
  if (elements.controlChatSettings.hidden) elements.controlChatSettingsButton.click();
  elements.controlChatSettings.scrollIntoView?.({ block: "nearest" });
}

window.addEventListener("control-bob-settings", (event) => {
  const settings = event.detail ?? {};
  const harness = settings.harnessId ? `${settings.harnessId[0].toUpperCase()}${settings.harnessId.slice(1)}` : "";
  modelValue.textContent = harness ? [harness, settings.modelId].filter(Boolean).join(" · ") : "Bob's agent";
  ask.setAttribute("aria-checked", String(Boolean(settings.askBeforeSaving)));
  pause.setAttribute("aria-checked", String(settings.monitoring === false));
  tag.textContent = settings.monitoring === false ? "Paused · agents wait for you" : "Acts as you in every project";
});

/* ---------- the views as rows ---------- */

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
/** The tab strip is drawn anew whenever a count changes; each tab gets its icon and chevron (only used in the column). */
function decorateTabs() {
  for (const tab of tabs.querySelectorAll(".control-tab")) {
    if (tab.querySelector(".bob-tab-icon")) continue;
    tab.prepend(icon(tab.dataset.view));
    tab.append(chevron());
  }
}
new MutationObserver(decorateTabs).observe(tabs, { childList: true });
decorateTabs();

/* ---------- the page around the control center ---------- */

/** Where a moved element lives otherwise, so it goes back exactly there. */
const homes = new Map();
function moveInto(node, target) {
  if (!node || node.parentElement === target) return;
  if (!homes.has(node)) {
    const marker = document.createComment(`${node.id || node.className} lives here outside Bob's page`);
    node.before(marker);
    homes.set(node, marker);
  }
  target.append(node);
}
function restore() {
  for (const [node, marker] of homes) if (marker.isConnected) marker.replaceWith(node);
  homes.clear();
}

function onPage() {
  return wide.matches && body.classList.contains("ws-desktop") && !body.classList.contains("focus-ui");
}

function apply() {
  const page = onPage();
  body.classList.toggle("bob-desk", page);
  if (page) {
    moveInto(tabs, tabsHere);
    moveInto(document.querySelector(".team-context-label"), contextHere);
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
  markToggle();
  const id = event.detail.id;
  if (!wide.matches || !body.classList.contains("view-control") || state.controlCenter.view === id) return;
  state.controlCenter.view = id;
  saveControlCenter();
});
wide.addEventListener("change", apply);
new MutationObserver(() => { if (body.classList.contains("bob-desk") !== onPage()) apply(); }).observe(body, { attributes: true, attributeFilter: ["class"] });

/* ---------- what Bob watches ---------- */

window.addEventListener("control-center-rendered", (event) => {
  const cards = event.detail?.cards ?? [];
  const running = cards.filter((card) => card.column === "running").length;
  const waiting = cards.filter((card) => card.column === "needs-you").length;
  watching.textContent = [running ? `Watching ${running} running` : "Nothing running", waiting ? `${waiting} need${waiting === 1 ? "s" : ""} you` : ""].filter(Boolean).join(" · ");
  watching.classList.toggle("live", running > 0);
});

apply();
applyFolds();
markToggle();
