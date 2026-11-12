/**
 * Settings is a page with one shape for every section: its group as a crumb, the title, one
 * sentence, where it applies, and the save line (settings-autosave.js). The list on the left shows
 * every section of every group as a row with its icon; the search box above filters it
 * (settings-search.js). On a phone the list and a section take turns, with a back button.
 */

/** Where a section applies, in the words its own text already uses. */
const SCOPES = {
  machine: { label: "This machine", icon: "M4 5h16v10H4zM9 19h6M12 15v4" },
  machines: { label: "Your machines", icon: "M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4" },
  cluster: { label: "The cluster", icon: "M12 5a2 2 0 1 0 0 .01M5 17a2 2 0 1 0 0 .01M19 17a2 2 0 1 0 0 .01M11 7l-5 8M13 7l5 8M7 17h10" },
  device: { label: "This device", icon: "M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2" },
};

/**
 * kind: "tabs" (a list with tabs), "form" (titled groups of rows) or "list" (a long, paged list).
 * The sentence comes from the section's own text.
 */
export const SECTION_INFO = {
  account: { kind: "form", scope: "machine", text: "How Joint Bob looks and behaves for you, and how you sign in." },
  notifications: { kind: "form", scope: "device", text: "How Joint Bob tells you that a conversation needs you." },
  shortcuts: { kind: "form", scope: "machine", text: "Change the keys for any command in Joint Bob." },
  conversations: { kind: "form", scope: "machine", text: "How new conversations start, and the side chat beside Activity." },
  labels: { kind: "form", scope: "machine", text: "The labels you classify conversations with, and the icon each one shows." },
  "automation-tags": { kind: "list", scope: "machine", text: "Workspace tags, and the runs of scheduled tasks and webhooks." },
  commands: { kind: "form", scope: "machines", text: "Prompts that open and close a conversation, and commands you paste into chat." },
  workspaces: { kind: "list", scope: "machine", text: "Group your projects, and choose the folder Joint Bob keeps them in." },
  git: { kind: "form", scope: "machine", text: "Who reviews Git changes, and how large a pull request may be." },
  story: { kind: "form", scope: "machine", text: "How the Activity overview writes, draws and speaks a change story." },
  engines: { kind: "tabs", scope: "machine", text: "Models for new conversations, and this node's harness paths." },
  connections: { kind: "tabs", scope: "machines", text: "Sign in to your model accounts, group them so one takes over when another runs out, and choose which one each conversation uses." },
  classifiers: { kind: "form", scope: "machine", text: "Send each prompt to a model that suits how hard it is." },
  "system-ai": { kind: "form", scope: "machines", text: "The agents Joint Bob uses for its own work: Bob, summaries, the sync check and dashboards." },
  guardian: { kind: "form", scope: "machine", text: "Checks every tool call and everything sent to the AI, and keeps secrets out of both." },
  secrets: { kind: "list", scope: "machines", text: "Encrypted accounts agents use in a workspace, a project or a single conversation." },
  browser: { kind: "list", scope: "machines", text: "The browser profiles agents sign in with, and where new browsers open." },
  cluster: { kind: "tabs", scope: "cluster", text: "The clusters this machine is in, what it shares with each, and its twins." },
  relay: { kind: "tabs", scope: "machine", text: "Reach your machines, and this one from your phone, from anywhere." },
  webhooks: { kind: "tabs", scope: "machines", text: "Let other services start conversations here, or add messages to one." },
  node: { kind: "form", scope: "machine", text: "Who may open terminals and run work here, and which nodes are blocked." },
  resources: { kind: "tabs", scope: "machine", text: "The skills, MCP servers, tools and plugins agents may load on each node." },
  "file-sync": { kind: "list", scope: "machines", text: "Keep the files of shared projects the same on every machine." },
  users: { kind: "list", scope: "machine", text: "The people on this node and the model subscriptions they share." },
  updates: { kind: "list", scope: "machine", text: "Install the newest release here, update the agent harnesses, and roll out to the cluster." },
  logs: { kind: "form", scope: "device", text: "What this browser tab logged, for reporting a problem." },
  changelog: { kind: "list", scope: "machine", text: "The changes in each release." },
};

/** One line icon per section, drawn like the rest of the app's icons (24 px grid, 1.8 stroke). */
const ICONS = {
  account: "M20 21a8 8 0 0 0-16 0M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  notifications: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0",
  shortcuts: "M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10",
  conversations: "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z",
  labels: "M3 12V4h8l9 9-8 8zM7.5 7.5h.01",
  "automation-tags": "M4 9h16M4 15h16M10 3 8 21M16 3l-2 18",
  commands: "M13 2 4 14h7l-1 8 9-12h-7z",
  workspaces: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  git: "M6 3v12M18 9a3 3 0 1 0 0-.01M6 21a3 3 0 1 0 0-.01M18 12a9 9 0 0 1-9 9",
  story: "M7 4v16l13-8z",
  engines: "M7 7h10v10H7zM9 2v3M15 2v3M9 19v3M15 19v3M19 9h3M19 15h3M2 9h3M2 15h3",
  connections: "M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5",
  classifiers: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
  "system-ai": "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 17l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z",
  guardian: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  secrets: "M15 7a4 4 0 1 0-3.9 4.9L4 19v2h3v-2h2v-2h2l1.9-1.9A4 4 0 0 0 15 7zM16 7h.01",
  browser: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
  cluster: "M12 3a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM5 16a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM19 16a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM10.8 7.6 6.2 16M13.2 7.6l4.6 8.4M7.5 18.5h9",
  relay: "M4.9 19.1a10 10 0 0 1 0-14.2M19.1 4.9a10 10 0 0 1 0 14.2M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4M12 12h.01",
  webhooks: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
  node: "M3 4h18v7H3zM3 13h18v7H3zM7 7.5h.01M7 16.5h.01",
  resources: "M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  "file-sync": "M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  updates: "M12 3v12M7 10l5 5 5-5M5 21h14",
  logs: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h8",
  changelog: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
};

const svg = (path, className = "settings-scope-icon") => {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("aria-hidden", "true"); icon.setAttribute("class", className);
  const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
  line.setAttribute("d", path); icon.append(line);
  return icon;
};

/** The list's emoji tiles become line icons, as in the rest of the Paper look. */
export function drawSectionIcons(tabs) {
  for (const tab of tabs) {
    const path = ICONS[tab.dataset.settingsTab];
    const holder = tab.querySelector(".settings-tab-icon");
    if (path && holder) holder.replaceChildren(svg(path, "settings-tab-svg"));
  }
}

const groupOf = (tab) => tab.closest(".settings-group");
const groupName = (tab) => groupOf(tab)?.querySelector(".settings-group-label")?.textContent.trim() ?? "";
const tabName = (tab) => tab.querySelector(".settings-tab-label")?.textContent.trim() ?? tab.textContent.trim();

/** Puts the same head on top of every section. */
export function buildSectionHeads(tabs) {
  for (const tab of tabs) {
    const name = tab.dataset.settingsTab;
    const panel = document.getElementById(`settingsPanel-${name}`);
    const info = SECTION_INFO[name];
    if (!panel || !info || panel.querySelector(":scope > .settings-section-head")) continue;
    panel.dataset.settingsKind = info.kind;
    const head = document.createElement("header");
    head.className = "settings-section-head";
    head.dataset.testid = `settings-section-head-${name}`;
    const crumb = document.createElement("p"); crumb.className = "settings-crumb"; crumb.textContent = groupName(tab);
    const title = document.createElement("p"); title.className = "settings-section-title"; title.setAttribute("role", "heading"); title.setAttribute("aria-level", "2"); title.textContent = tabName(tab);
    const text = document.createElement("p"); text.className = "settings-section-text"; text.textContent = info.text;
    const facts = document.createElement("div"); facts.className = "settings-facts";
    const scope = SCOPES[info.scope];
    const where = document.createElement("span"); where.className = "settings-scope"; where.dataset.scope = info.scope; where.dataset.testid = "settings-section-scope";
    where.append(svg(scope.icon), scope.label);
    facts.append(where);
    head.append(crumb, title, text, facts);
    panel.prepend(head);
  }
}

/** The open section: its row shows in the list, the phone's bar names it, and the save line moves into its head. */
export function showSection(tab, { title, crumb, saveState, restartMessage }) {
  // The list scrolls on a short window: the open section's row stays in sight, and the first one brings the list's top with it.
  const list = tab.closest(".settings-nav-scroll");
  if (list && tab === list.querySelector(".settings-tab:not([hidden])")) list.scrollTop = 0;
  else tab.scrollIntoView?.({ block: "nearest" });
  title.textContent = tabName(tab);
  crumb.textContent = `Settings · ${groupName(tab)}`;
  const panel = document.getElementById(`settingsPanel-${tab.dataset.settingsTab}`);
  const facts = panel?.querySelector(":scope > .settings-section-head .settings-facts");
  if (facts) facts.append(saveState, restartMessage);
  if (panel) { tidySection(panel); panel.closest("form")?.removeAttribute("data-scrolled"); }
}

/*
 * Help text reads like a settings app's: a section opens on its controls, not on paragraphs.
 * - The paragraphs that open a section (before its first control) move into one collapsed
 *   "About this" note at the end of the section; every sentence stays there.
 * - A long help line under a row shows one line; a tap or Enter opens the rest.
 * Status lines (anything with an id) stay where their code writes them. Sections drawn later by
 * their own module are tidied again when their content changes.
 */
const LONG_HELP = 110;
const INTRO_HOLDERS = ":scope > .engines-card, :scope > .relay-head, :scope > .guardian-settings, :scope > section > .relay-head, :scope > section > .relays-head";
const HELP_LINES = ".settings-hint, .cluster-muted, .engine-defaults, :scope .phase-settings > p, :scope .settings-section-text";

const isIntro = (node) => node instanceof HTMLParagraphElement && !node.id && !node.hidden && node.textContent.trim().length > 0;

function introParagraphs(holder) {
  const found = [];
  for (const child of holder.children) {
    if (child.matches(".settings-section-head, .settings-about, .engines-card-header") || child.hidden) continue;
    if (!isIntro(child)) break;
    found.push(child);
  }
  return found;
}

function aboutNote(panel) {
  let note = panel.querySelector(":scope > details.settings-about");
  if (!note) {
    note = document.createElement("details");
    note.className = "settings-about";
    note.dataset.testid = `settings-about-${panel.id.replace("settingsPanel-", "")}`;
    const summary = document.createElement("summary");
    summary.textContent = "About this section";
    note.append(summary);
  }
  if (note !== panel.lastElementChild) panel.append(note);
  return note;
}

function markLongHelp(panel) {
  for (const line of panel.querySelectorAll(HELP_LINES)) {
    if (line.closest(".settings-about") || line.dataset.help) continue;
    const limit = line.classList.contains("settings-section-text") ? 60 : LONG_HELP;
    const long = line.textContent.trim().length > limit && !line.querySelector("input, select, textarea, button, a, ul, ol");
    if (!long) continue;
    line.dataset.help = "long";
    line.setAttribute("aria-expanded", "false");
    line.tabIndex = 0;
  }
}

let tidying = false;
export function tidySection(panel) {
  if (tidying) return;
  tidying = true;
  try {
    const holders = [panel, ...panel.querySelectorAll(INTRO_HOLDERS)];
    const intro = holders.flatMap(introParagraphs);
    if (intro.length) {
      const note = aboutNote(panel);
      for (const paragraph of intro) { paragraph.dataset.about = "moved"; note.append(paragraph); }
    }
    markLongHelp(panel);
  } finally { tidying = false; }
}

/** Wires the page once: tidying when a section's module redraws it, help lines that open, rows that open their list, the phone bar's title. */
export function installSettingsPage(form) {
  const phone = window.matchMedia("(max-width: 700px)");
  let queued = false;
  new MutationObserver(() => {
    if (tidying || queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const panel = form.querySelector(".settings-panel:not([hidden])");
      if (panel) tidySection(panel);
    });
  }).observe(form, { childList: true, subtree: true });

  installPhoneBack(form, phone);

  const toggle = (line) => line.setAttribute("aria-expanded", String(line.getAttribute("aria-expanded") !== "true"));
  form.addEventListener("click", (event) => {
    const line = event.target.closest?.("[data-help='long']");
    if (line && !window.getSelection()?.toString()) { toggle(line); return; }
    // On a phone a whole row is the button: tapping its words opens the row's list, as the value does.
    if (!phone.matches) return;
    const row = event.target.closest?.(".settings-panel label:not(.checkbox-row)");
    if (!row || event.target.closest("select, input, textarea, button, a, .searchable-select")) return;
    const select = row.querySelector(":scope > select");
    if (!select || select.disabled) return;
    // The label's own click would move focus to the select and close the list that just opened.
    event.preventDefault();
    select.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  });
  form.addEventListener("keydown", (event) => {
    const line = event.target.closest?.("[data-help='long']");
    if (line && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); toggle(line); }
  });
  // The phone bar shows the section's name once its big title has scrolled away.
  form.addEventListener("scroll", (event) => {
    if (!event.target.classList?.contains("settings-panel")) return;
    const scrolled = event.target.scrollTop > 56;
    if ((form.dataset.scrolled === "true") !== scrolled) form.dataset.scrolled = String(scrolled);
  }, true);
}

/*
 * The phone's Back (gesture or button) climbs one level inside Settings: an open list sheet closes,
 * then a section returns to the Settings list, then Settings returns to the app.
 * Settings is a modal <dialog>, so on Android Back is a "close request" that the browser hands to
 * the newest CloseWatcher; without one of ours it closed the whole dialog from inside a section.
 * Each level gets its own watcher, made in the tap that opened it (a watcher made without a tap is
 * grouped with the one below and both close together). Browsers without CloseWatcher (iOS Safari)
 * send Back to history instead: there `closeTopLayer` in layout.js climbs the same levels.
 */
function installPhoneBack(form, phone) {
  if (typeof window.CloseWatcher !== "function") return;
  const dialog = form.closest("dialog");
  let sectionWatcher = null;
  let sheetWatcher = null;
  let sheetScrim = null;
  const drop = (watcher) => { try { watcher?.destroy(); } catch { /* already gone */ } };
  const openSheet = () => [...dialog.querySelectorAll(".choice-scrim")].find((scrim) => !scrim.hidden) ?? null;

  function sync() {
    const inSection = dialog.open && phone.matches && form.dataset.mobileView === "panel";
    if (inSection && !sectionWatcher) {
      const watcher = sectionWatcher = new window.CloseWatcher();
      watcher.onclose = () => { if (sectionWatcher === watcher) sectionWatcher = null; if (dialog.open) form.dataset.mobileView = "menu"; };
    } else if (!inSection && sectionWatcher) { drop(sectionWatcher); sectionWatcher = null; }

    const scrim = dialog.open && phone.matches ? openSheet() : null;
    if (scrim && scrim !== sheetScrim) {
      drop(sheetWatcher);
      const watcher = sheetWatcher = new window.CloseWatcher();
      sheetScrim = scrim;
      // The scrim's own press handler closes the sheet and returns focus to its row.
      watcher.onclose = () => { if (sheetWatcher === watcher) { sheetWatcher = null; sheetScrim = null; } if (!scrim.hidden) scrim.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true })); };
    } else if (!scrim && sheetWatcher) { drop(sheetWatcher); sheetWatcher = null; sheetScrim = null; }
  }
  new MutationObserver(sync).observe(dialog, { attributes: true, attributeFilter: ["data-mobile-view", "hidden", "open"], subtree: true });
  dialog.addEventListener("close", sync);
  phone.addEventListener("change", sync);
}
