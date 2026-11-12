// The phone (≤ 700 px, body.focus-ui): Home, the four tabs and the New button. Home is the projects view with the
// workspace column on Inbox (the desktop's own choice, workspace.js): a greeting with what waits, the search that also
// asks Bob, then the same three groups as the desktop's left column. The tabs are Inbox, Bob (the control center),
// Projects (the project list, then a project's conversations) and Settings; Costs is in every screen's ⋯ sheet.
// Spec: "Layout › Phone" in docs/superpowers/specs/2026-11-10-ui-redo-paper-design.md. Styles: public/phone.css.

import { openAppearance } from "./appearance.js";
import { currentMobileView, setMobileView } from "./layout.js";
import { openSpotlight } from "./spotlight.js";
import { toast } from "./shell.js";
import { state } from "./state.js";
import { mobileFocusViewport } from "./focus-project-controls.js";

const byId = (id) => document.getElementById(id);
const body = document.body;
const tabs = byId("phoneTabs");
const tabsHome = document.createComment("The phone's tabs live here outside Settings");
const settingsDialog = byId("settingsDialog");
let counts = null;
let openSettingsPage = null;

/* ---------- the greeting ---------- */

function greetingWord(hour = new Date().getHours()) {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 18) return "Good afternoon";
  return "Good evening";
}

function displayName() {
  const name = (state.username || "").trim();
  return name ? name[0].toUpperCase() + name.slice(1) : "";
}

function syncGreeting() {
  const name = displayName();
  byId("phoneGreeting").textContent = name ? `${greetingWord()}, ${name}` : greetingWord();
  byId("phoneAvatar").textContent = name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join("") || "·";
  const line = byId("phoneCounts");
  if (!counts) { line.textContent = ""; return; }
  const need = counts["needs-you"] ?? 0;
  const needs = document.createElement(need ? "b" : "span");
  needs.textContent = `${need} need${need === 1 ? "s" : ""} you`;
  line.replaceChildren(needs, ` · ${counts.running ?? 0} running · ${counts.review ?? 0} to review`);
  const badge = byId("phoneInboxBadge");
  badge.hidden = !need;
  badge.textContent = need ? String(need) : "";
}

window.addEventListener("workspace-groups-counted", (event) => { counts = event.detail; syncGreeting(); });
window.addEventListener("running-refreshed", syncGreeting);
// The greeting follows the time of day while the app stays open.
setInterval(syncGreeting, 10 * 60_000);

/* ---------- search: the workspace search, which also asks Bob ---------- */

const search = byId("phoneSearchInput");
search.addEventListener("input", () => {
  const typed = search.value;
  search.value = "";
  openSpotlight(typed);
});
search.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  openSpotlight(search.value);
});
// A tap opens the search dialog at once; its own box takes the keyboard there.
search.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  openSpotlight("");
});

/* ---------- the tabs ---------- */

function activeTab() {
  if (settingsDialog.open) return "settings";
  const view = currentMobileView();
  if (view === "control") return "bob";
  if (view === "sessions") return "projects";
  if (view === "projects") return body.classList.contains("ws-column-inbox") ? "inbox" : "projects";
  return "";
}

function syncTabs() {
  const active = activeTab();
  for (const button of tabs.querySelectorAll("[data-tab]")) {
    const on = button.dataset.tab === active;
    button.classList.toggle("on", on);
    if (on) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  body.classList.toggle("ph-home-view", active === "inbox");
}

function go(tab) {
  if (tab === "settings") {
    if (!settingsDialog.open) openSettingsPage?.().catch((error) => toast.error(error.message));
    return;
  }
  // Leaving Settings saves what waits, as its own back button does.
  if (settingsDialog.open) byId("cancelSettingsButton").click();
  if (tab === "bob") { setMobileView("control"); syncTabs(); return; }
  window.dispatchEvent(new CustomEvent("workspace-place", { detail: { place: tab } }));
  if (currentMobileView() !== "projects") setMobileView("projects");
  syncTabs();
}

for (const button of tabs.querySelectorAll("[data-tab]")) button.addEventListener("click", () => go(button.dataset.tab));

/** Settings is a page over the app, so on the phone its section list carries the tabs too. */
function syncSettingsTabs() {
  const inside = settingsDialog.open && mobileFocusViewport.matches;
  if (inside && tabs.parentElement !== settingsDialog) {
    if (!tabsHome.isConnected) tabs.before(tabsHome);
    settingsDialog.append(tabs);
  } else if (!inside && tabsHome.isConnected) {
    tabsHome.replaceWith(tabs);
  }
  syncTabs();
}
new MutationObserver(syncSettingsTabs).observe(settingsDialog, { attributes: true, attributeFilter: ["open"] });

/* ---------- Back from a conversation opened on Home goes Home ---------- */

function markFromHome(event) {
  if (event.target.closest?.(".ws-row")) state.chatFromHome = mobileFocusViewport.matches;
}
byId("workspaceGroups").addEventListener("click", markFromHome, true);
byId("workspaceGroupPage").addEventListener("click", markFromHome, true);
byId("sessionList").addEventListener("click", () => { state.chatFromHome = false; }, true);

window.addEventListener("app-view-changed", () => {
  if (["projects", "control", "board"].includes(currentMobileView())) state.chatFromHome = false;
  syncTabs();
});
window.addEventListener("workspace-column-changed", syncTabs);

/* ---------- start ---------- */

export function initializePhoneUi({ openSettings }) {
  // The Settings tab opens the same page as everywhere else.
  openSettingsPage = openSettings;
  // Bob's tab wears his hat, the same glyph as his place in the desktop column.
  const hat = byId("openControlCenterButton")?.querySelector("svg")?.cloneNode(true);
  if (hat) byId("phoneTabBob").prepend(hat);
  byId("phoneThemeButton").addEventListener("click", () => openAppearance());
  byId("phoneAvatar").addEventListener("click", () => openSettings("account").catch((error) => toast.error(error.message)));
  mobileFocusViewport.addEventListener("change", syncSettingsTabs);
  syncGreeting();
  syncTabs();
}
