// Bob's page on the desktop (1024 px and wider; below that the control center is Bob's chat, control-phone.js).
// The control center opens as Bob's chat in the middle and, on the right, "What Bob looks after": its tabs (Live agents,
// Project overview, Automations, Memory, Clusters, Assistants, Dashboards, with their counts) as rows that open the tab,
// then Bob himself: his model, "Ask before saving to memory" and "Pause everything Bob does on his own" (today's
// Settings and Monitoring), the team context and all of his settings. A tab opens in the middle as it always has (the
// board or the tab beside Bob's chat, the tab strip on top), with "‹ Bob's chat" to come back. Nothing here leaves the
// control center: only the person does (Exit, Esc twice, the toggle shortcut). Every element keeps its id and test id;
// the tab strip and the team context move into the right column and back, by markers. Styles: public/bob-page.css.
// Mock: mocks/ui-redo "Desktop · Bob".

import { currentControlView } from "./control-views.js";
import { elements } from "./elements.js";
import { currentMobileView } from "./layout.js";

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

/* ---------- the parts this page adds ---------- */

// The head: Bob's hat, his name, what he does and what he watches; in a tab, the way back to his chat.
const avatar = element("span", "bob-head-avatar");
avatar.setAttribute("aria-hidden", "true");
const hat = document.createElement("img");
hat.src = "/icon-mark.svg";
hat.alt = "";
hat.width = 22;
hat.height = 22;
avatar.append(hat);
const tag = element("span", "bob-head-tag", "Acts as you in every project");
tag.dataset.testid = "bob-head-tag";
const watching = element("span", "bob-head-state");
watching.dataset.testid = "bob-head-state";
const back = element("button", "ghost compact bob-chat-back", "‹ Bob's chat");
back.type = "button";
back.title = "Back to Bob's chat";
back.dataset.testid = "bob-chat-back";
header.prepend(back, avatar);
heading.after(tag);
tag.after(watching);

// The right column.
const side = element("aside", "bob-side");
side.id = "bobSide";
side.dataset.testid = "bob-side";
side.setAttribute("aria-label", "What Bob looks after");
const looksAfter = element("div", "bob-side-lab", "What Bob looks after");
const tabsHere = element("div", "bob-side-group bob-side-tabs");
const bobLab = element("div", "bob-side-lab", "Bob");
const bobGroup = element("div", "bob-side-group");

function line(className, testid) {
  const node = element("button", `bob-line ${className}`);
  node.type = "button";
  node.dataset.testid = testid;
  return node;
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

// On a phone Bob's settings are a screen of their own (phone.css): its head says so and goes back to the chat.
const settingsHead = element("div", "bob-settings-head");
const settingsBack = element("button", "ghost compact", "‹");
settingsBack.type = "button";
settingsBack.setAttribute("aria-label", "Back to Bob's chat");
settingsBack.dataset.testid = "bob-settings-back";
settingsBack.addEventListener("click", () => { if (!elements.controlChatSettings.hidden) elements.controlChatSettingsButton.click(); });
settingsHead.append(settingsBack, element("b", "", "Bob's settings"));
elements.controlChatSettings.prepend(settingsHead);

/** Bob's settings open over his chat, where they always were. */
function openSettings() {
  showChat();
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

/* ---------- the tabs as rows ---------- */

const ICONS = {
  live: "M3 12h4l3-8 4 16 3-8h4",
  overview: "M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z",
  automations: "M13 3 5 14h6l-1 7 8-11h-6z",
  memory: "M5 4.5h10.5a3 3 0 0 1 3 3v12H8a3 3 0 0 1-3-3zM5 16.5a3 3 0 0 1 3-3h10.5",
  clusters: "M4 5h16v5H4zM4 14h16v5H4zM8 7.5h.01M8 16.5h.01",
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

/* ---------- chat or a tab ---------- */

/** Where a moved element lives otherwise, so it goes back exactly there. */
const homes = new Map();
function moveInto(node, target, before = null) {
  if (!node || (node.parentElement === target && (!before || node.nextSibling === before))) return;
  if (!homes.has(node)) {
    const marker = document.createComment(`${node.id || node.className} lives here outside Bob's page`);
    node.before(marker);
    homes.set(node, marker);
  }
  target.insertBefore(node, before);
}
function restore() {
  for (const [node, marker] of homes) if (marker.isConnected) marker.replaceWith(node);
  homes.clear();
}

let chatMode = true;

function onPage() {
  return wide.matches && body.classList.contains("ws-desktop") && !body.classList.contains("focus-ui");
}

function apply() {
  const page = onPage();
  const chat = page && chatMode;
  body.classList.toggle("bob-desk", page);
  body.classList.toggle("bob-chat", chat);
  if (chat) {
    moveInto(tabs, tabsHere);
    moveInto(document.querySelector(".team-context-label"), contextHere);
    // The chat's own Monitoring and Settings join the page's head, so the chat starts with its filters.
    // So does the webhook log's bell (control-triggers.js).
    moveInto(document.querySelector('[data-testid="control-triggers-bell"]'), header, elements.controlCenterRefresh);
    moveInto(elements.controlChatMonitor, header, elements.controlCenterRefresh);
    moveInto(elements.controlChatSettingsButton, header, elements.controlCenterRefresh);
  } else restore();
  // The strip marks the open tab; in the column nothing is open while the chat has the middle.
  tabs.classList.toggle("bob-none-open", chat);
  heading.textContent = chat ? "Bob" : "Control center";
}

function showChat() {
  if (chatMode) return;
  chatMode = true;
  apply();
}

// Opening the control center is opening Bob's chat; a tab asked for at the same moment (Automations in the left column)
// opens instead, since its own event follows.
// A tab asked for right as the control center opens (Automations, "Back to Clusters") opens that tab, even the one open last.
let justActivated = false;
window.addEventListener("control-center-activated", () => {
  chatMode = true;
  apply();
  justActivated = true;
  setTimeout(() => { justActivated = false; }, 0);
});
// A tab opens in the middle when the person picks it, or when something asks for another tab (Automations in the left
// column, "Back to Clusters", a dashboard Bob opens). The same tab drawn again (a team context chosen) leaves the chat be.
let lastView = currentControlView();
function openTab() {
  if (currentMobileView() !== "control" || !chatMode) return;
  chatMode = false;
  apply();
}
window.addEventListener("control-view-changed", (event) => {
  const id = event.detail?.id;
  const changed = id !== lastView;
  lastView = id;
  if (changed || justActivated) openTab();
});
tabs.addEventListener("click", (event) => { if (event.target.closest(".control-tab")) openTab(); });
document.getElementById("workspaceAutomationsButton")?.addEventListener("click", () => queueMicrotask(openTab));
back.addEventListener("click", showChat);
// Bob in the left column, pressed on Bob's page, is his chat again.
elements.openControlCenterButton.addEventListener("click", () => { if (currentMobileView() === "control") showChat(); });
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
export { showChat as showBobChat, currentControlView };
