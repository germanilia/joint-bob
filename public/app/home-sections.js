// Option C Desktop Home modules:
//   - Live Glance Strip (4 status tiles for Activity, Automations, Clusters, Dashboards)
//   - Focus Tabs (All selected | Activity | Automations | Clusters | Dashboards)
//   - Customize Home popover (choose which sections appear in "All selected")
//   - Editable Dashboards wired directly into Joint Bob's Dashboard Creator/Editor (`openDashboardMode`)
// Selections are persisted per browser in localStorage (`joint-bob-home-sections`, `joint-bob-home-tab`).

import { api } from "./api.js";
import { openDashboardCard } from "./control-dashboards.js";
import { showControlView } from "./control-views.js";
import { openDashboardMode } from "./dashboards.js";
import { setMobileView } from "./layout.js";
import { isNodeAdmin } from "./node-admin.js";
import { displayNodeUrl } from "./relay-ui.js";
import { confirmAction, toast } from "./shell.js";
import { state } from "./state.js";

const SECTIONS_KEY = "joint-bob-home-sections";
const TAB_KEY = "joint-bob-home-tab";
const FRESH_MS = 30_000;
const DASHBOARD_POLL_MS = 2_500;

export const HOME_SECTIONS = [
  {
    id: "activity",
    label: "Activity",
    title: "Activity",
    description: "Needs you, Running & Review",
  },
  {
    id: "automations",
    label: "Automations",
    title: "Automation statuses",
    description: "Schedules, webhooks & reports",
  },
  {
    id: "clusters",
    label: "Clusters",
    title: "Connected clusters",
    description: "Clusters, twins & relays",
  },
  {
    id: "dashboard",
    label: "Dashboards",
    title: "Dashboard features",
    description: "Editable overview & project dashboards",
  },
];

const VALID_IDS = new Set(HOME_SECTIONS.map((section) => section.id));
const VALID_TABS = new Set(["all", ...VALID_IDS]);
const DEFAULT_SELECTION = ["activity"];

const byId = (id) => document.getElementById(id);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function chevronIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "m9 18 6-6-6-6");
  svg.append(path);
  return svg;
}

function ago(iso) {
  if (!iso) return "";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/* ---------- selection & focus tab persistence ---------- */

function readSelection() {
  try {
    const raw = localStorage.getItem(SECTIONS_KEY);
    if (raw === null) return new Set(DEFAULT_SELECTION);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set(DEFAULT_SELECTION);
    return new Set(parsed.filter((id) => typeof id === "string" && VALID_IDS.has(id)));
  } catch {
    return new Set(DEFAULT_SELECTION);
  }
}

function readFocusTab() {
  try {
    const raw = localStorage.getItem(TAB_KEY);
    return raw && VALID_TABS.has(raw) ? raw : "all";
  } catch {
    return "all";
  }
}

let enabled = readSelection();
let focusTab = readFocusTab();
let homeVisible = false;
let customizeOpen = false;
let notifySelectionChange = () => {};

const activitySummary = { loaded: false, need: 0, running: 0, review: 0 };

function saveSelection() {
  const ordered = HOME_SECTIONS.map((section) => section.id).filter((id) => enabled.has(id));
  try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(ordered)); } catch { /* private mode */ }
}

function saveFocusTab() {
  try { localStorage.setItem(TAB_KEY, focusTab); } catch { /* private mode */ }
}

function visibleSectionIds() {
  if (focusTab !== "all") return [focusTab];
  return HOME_SECTIONS.map((section) => section.id).filter((id) => enabled.has(id));
}

export function isSectionVisible(id) {
  return focusTab === "all" ? enabled.has(id) : focusTab === id;
}

export function isActivityVisible() {
  return isSectionVisible("activity");
}

/** True when Home shows multiple sections or any non-Activity module (uses inner vertical scroll). */
export function isCustomLayout() {
  const shown = visibleSectionIds();
  return shown.length !== 1 || shown[0] !== "activity";
}

export function homeViewStateKey() {
  return `${focusTab}|${HOME_SECTIONS.map((section) => section.id).filter((id) => enabled.has(id)).join(",")}`;
}

export function updateActivitySummary(cards, loaded) {
  const next = {
    loaded: Boolean(loaded),
    need: cards.filter((card) => card.column === "needs-you").length,
    running: cards.filter((card) => card.column === "running").length,
    review: cards.filter((card) => card.column === "review").length,
  };
  if (
    next.loaded === activitySummary.loaded
    && next.need === activitySummary.need
    && next.running === activitySummary.running
    && next.review === activitySummary.review
  ) return;
  Object.assign(activitySummary, next);
  renderGlanceStrip();
}

function setFocusTab(nextTab) {
  if (!VALID_TABS.has(nextTab) || focusTab === nextTab) return;
  focusTab = nextTab;
  saveFocusTab();
  renderGlanceStrip();
  renderFocusTabs();
  applySectionVisibility();
  if (homeVisible) ensureVisibleSectionsRenderedAndLoaded();
  notifySelectionChange();
}

function setCustomizeOpen(open) {
  customizeOpen = Boolean(open);
  const pop = byId("homeCustomizePopover");
  const btn = byId("homeCustomizeButton");
  if (pop) pop.hidden = !customizeOpen;
  if (btn) {
    btn.setAttribute("aria-expanded", String(customizeOpen));
    btn.classList.toggle("on", customizeOpen);
  }
}

export function closeCustomizePopover() {
  if (!customizeOpen) return false;
  setCustomizeOpen(false);
  return true;
}

function toggleSection(id, force) {
  if (!VALID_IDS.has(id)) return;
  const next = force === undefined ? !enabled.has(id) : Boolean(force);
  if (next) enabled.add(id);
  else enabled.delete(id);
  saveSelection();
  // Customizing sections applies to "All selected", so show that view immediately.
  if (focusTab !== "all") {
    focusTab = "all";
    saveFocusTab();
  }
  renderCustomizePopover();
  renderGlanceStrip();
  renderFocusTabs();
  applySectionVisibility();
  if (homeVisible) ensureVisibleSectionsRenderedAndLoaded();
  notifySelectionChange();
}

/* ---------- Customize Home popover, Glance Strip & Focus Tabs ---------- */

function renderCustomizePopover() {
  const pop = byId("homeCustomizePopover");
  if (!pop) return;
  const heading = element("h4", "ws-home-customize-head", "Show on Home");
  const rows = HOME_SECTIONS.map((section) => {
    const label = element("label", "ws-home-check-row");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = enabled.has(section.id);
    input.dataset.section = section.id;
    input.dataset.testid = `home-toggle-${section.id}`;
    input.addEventListener("change", () => toggleSection(section.id, input.checked));
    const copy = element("span", "ws-home-check-copy");
    copy.append(element("b", "", section.title), element("small", "", section.description));
    label.append(input, copy);
    return label;
  });
  pop.replaceChildren(heading, ...rows);
}

function glanceMetrics() {
  // 1. Activity
  let actMain = "Loading…";
  let actSub = "Checking inbox";
  let actDot = "muted";
  if (activitySummary.loaded) {
    actMain = activitySummary.need > 0
      ? `${activitySummary.need} need${activitySummary.need === 1 ? "s" : ""} you`
      : activitySummary.running > 0
        ? `${activitySummary.running} running`
        : "All clear";
    actSub = `${activitySummary.running} running · ${activitySummary.review} to review`;
    actDot = activitySummary.need > 0 ? "need" : activitySummary.running > 0 ? "online" : "muted";
  }

  // 2. Automations
  let autoMain = "Loading…";
  let autoSub = "Schedules & webhooks";
  let autoDot = "muted";
  if (automationsState.loaded) {
    const rows = automationsState.rows;
    const running = rows.filter((row) => row.last?.state === "running").length;
    const failed = rows.filter((row) => row.last?.state === "failed" || row.last?.state === "refused").length;
    const active = rows.filter((row) => row.enabled).length;
    const paused = rows.length - active;
    if (!rows.length) {
      autoMain = "No automations";
      autoSub = "Create schedules or hooks";
      autoDot = "muted";
    } else if (failed && running) {
      autoMain = `${failed} failed · ${running} live`;
      autoSub = `${active} active · ${paused} paused`;
      autoDot = "offline";
    } else if (failed) {
      autoMain = `${failed} failed`;
      autoSub = `${active} active · ${paused} paused`;
      autoDot = "offline";
    } else if (running) {
      autoMain = `${running} running now`;
      autoSub = `${active} active · ${paused} paused`;
      autoDot = "online";
    } else {
      autoMain = `${active} active`;
      autoSub = paused ? `${paused} paused` : "All healthy";
      autoDot = active > 0 ? "online" : "muted";
    }
  } else if (automationsState.error) {
    autoMain = "Unavailable";
    autoSub = "Open to retry";
    autoDot = "offline";
  }

  // 3. Clusters
  let clusMain = "Loading…";
  let clusSub = "Checking nodes";
  let clusDot = "muted";
  if (clustersState.loaded) {
    const clusters = clustersState.clusters;
    const twins = clustersState.twins;
    const relays = clustersState.relays;
    const localRelay = clustersState.localRelay;
    const memberIds = new Set(clusters.flatMap((cluster) => (cluster.members || []).map((member) => member.nodeId)));
    const connectedRelays = relays.filter((relay) => relay.connected).length + (localRelay ? 1 : 0);
    const syncing = clusters.some((cluster) => Number(cluster.pendingDeliveries || 0) > 0);
    const offlineTwin = Boolean(clustersState.inventory) && twins.some((item) => peerReachability(item.peer?.nodeId) === "offline");
    if (!clusters.length && !twins.length && !relays.length && !localRelay) {
      clusMain = "This node only";
      clusSub = clustersState.node?.name || "Standalone machine";
      clusDot = "muted";
    } else {
      clusMain = clusters.length
        ? `${clusters.length} cluster${clusters.length === 1 ? "" : "s"}`
        : twins.length
          ? `${twins.length} twin${twins.length === 1 ? "" : "s"}`
          : `${connectedRelays} relay${connectedRelays === 1 ? "" : "s"}`;
      const parts = [];
      if (memberIds.size) parts.push(`${memberIds.size} machine${memberIds.size === 1 ? "" : "s"}`);
      if (twins.length) parts.push(`${twins.length} twin${twins.length === 1 ? "" : "s"}`);
      if (relays.length || localRelay) parts.push(`${connectedRelays} relay${connectedRelays === 1 ? "" : "s"}`);
      clusSub = parts.join(" · ") || "Connected";
      clusDot = offlineTwin || syncing ? "need" : "online";
    }
  } else if (clustersState.error) {
    clusMain = "Unavailable";
    clusSub = "Open to retry";
    clusDot = "offline";
  }

  // 4. Dashboards
  let dashMain = "Loading…";
  let dashSub = "Overview & projects";
  let dashDot = "muted";
  if (dashboardState.loaded) {
    const active = selectedOverview();
    const cardCount = dashboardState.cards.length;
    if (active) {
      dashMain = active.title || "Overview";
      const detail = dashboardState.detail;
      const statusText = active.status === "building" || active.changing
        ? "Building…"
        : detail?.lastRefresh
          ? `${detail.lastRefresh.ok ? "Refreshed" : "Failed"} ${ago(detail.lastRefresh.at)}`
          : active.status === "ready"
            ? "Ready"
            : "Draft";
      dashSub = cardCount ? `${statusText} · ${cardCount} card${cardCount === 1 ? "" : "s"}` : statusText;
      dashDot = active.status === "building" || active.changing ? "need" : detail?.lastRefresh && !detail.lastRefresh.ok ? "offline" : "rev";
    } else if (cardCount) {
      dashMain = `${cardCount} dashboard${cardCount === 1 ? "" : "s"}`;
      dashSub = "Click to view or edit";
      dashDot = "rev";
    } else {
      dashMain = "No dashboards";
      dashSub = "Create with Dashboard Editor";
      dashDot = "muted";
    }
  } else if (dashboardState.error) {
    dashMain = "Unavailable";
    dashSub = "Open to retry";
    dashDot = "offline";
  }

  return [
    { id: "activity", label: "Activity", main: actMain, sub: actSub, dot: actDot },
    { id: "automations", label: "Automations", main: autoMain, sub: autoSub, dot: autoDot },
    { id: "clusters", label: "Clusters", main: clusMain, sub: clusSub, dot: clusDot },
    { id: "dashboard", label: "Dashboards", main: dashMain, sub: dashSub, dot: dashDot },
  ];
}

function renderGlanceStrip() {
  const host = byId("homeGlanceStrip");
  if (!host) return;
  const items = glanceMetrics().map((item) => {
    const active = focusTab === item.id;
    const card = element("button", `ws-home-glance${active ? " active" : ""}`);
    card.type = "button";
    card.dataset.section = item.id;
    card.dataset.testid = `home-glance-${item.id}`;
    card.setAttribute("aria-pressed", String(active));
    card.title = active ? "Back to All selected" : `Focus on ${item.label}`;
    const top = element("span", "ws-home-glance-top");
    top.append(element("span", "", item.label), element("i", `ws-home-dot ${item.dot}`));
    card.append(top, element("strong", "", item.main), element("small", "", item.sub));
    card.addEventListener("click", () => setFocusTab(focusTab === item.id ? "all" : item.id));
    return card;
  });
  host.replaceChildren(...items);
}

function renderFocusTabs() {
  const host = byId("homeFocusTabs");
  if (!host) return;
  const tabs = [
    { id: "all", label: "All selected" },
    ...HOME_SECTIONS.map((section) => ({ id: section.id, label: section.label })),
  ];
  const nodes = tabs.map((tab) => {
    const active = focusTab === tab.id;
    const button = element("button", `ws-home-ftab${active ? " on" : ""}`, tab.label);
    button.type = "button";
    button.role = "tab";
    button.dataset.tab = tab.id;
    button.dataset.testid = `home-tab-${tab.id}`;
    button.setAttribute("aria-selected", String(active));
    button.addEventListener("click", () => setFocusTab(tab.id));
    return button;
  });
  host.replaceChildren(...nodes);
}

function renderEmptySelection() {
  const host = byId("homeEmptySelection");
  if (!host) return;
  const empty = focusTab === "all" && enabled.size === 0;
  host.hidden = !empty;
  if (!empty) return;
  const heading = element("h2", "", "Choose what to see on Home");
  const hint = element("p", "ws-empty", "Use Customize Home above, pick a focus tab, or turn sections back on here.");
  const actions = element("div", "ws-home-empty-actions");
  for (const section of HOME_SECTIONS) {
    const button = element("button", "ghost compact", `Show ${section.label}`);
    button.type = "button";
    button.dataset.testid = `home-empty-enable-${section.id}`;
    button.addEventListener("click", () => toggleSection(section.id, true));
    actions.append(button);
  }
  const all = element("button", "primary compact", "Show everything");
  all.type = "button";
  all.dataset.testid = "home-empty-enable-all";
  all.addEventListener("click", () => {
    for (const section of HOME_SECTIONS) enabled.add(section.id);
    saveSelection();
    renderCustomizePopover();
    renderGlanceStrip();
    renderFocusTabs();
    applySectionVisibility();
    if (homeVisible) ensureVisibleSectionsRenderedAndLoaded();
    notifySelectionChange();
  });
  actions.append(all);
  host.replaceChildren(heading, hint, actions);
}

function applySectionVisibility() {
  const activity = byId("homeActivitySection");
  const automations = byId("homeAutomationsSection");
  const clusters = byId("homeClustersSection");
  const dashboard = byId("homeDashboardSection");
  if (activity) activity.hidden = !isSectionVisible("activity");
  if (automations) automations.hidden = !isSectionVisible("automations");
  if (clusters) clusters.hidden = !isSectionVisible("clusters");
  if (dashboard) dashboard.hidden = !isSectionVisible("dashboard");
  renderEmptySelection();
}

/* ---------- shared section chrome ---------- */

function openControlTab(viewId) {
  state.controlCenter.view = viewId;
  setMobileView("control");
  showControlView(viewId);
}

function sectionHeader({ id, title, countText, summaryNodes = [], onRefresh, refreshing = false, links = [], extraButtons = [] }) {
  const head = element("div", "ws-home-sechead ws-home-panel-head");
  const titleNode = element("h2", "", title);
  titleNode.id = id;
  head.append(titleNode);
  if (countText !== undefined && countText !== "") {
    head.append(element("span", "ws-home-count", countText));
  }
  if (summaryNodes.length) {
    const pills = element("div", "ws-home-pills");
    pills.append(...summaryNodes);
    head.append(pills);
  }
  head.append(element("span", "ws-home-spacer"));
  const actions = element("div", "ws-home-head-actions");
  for (const button of extraButtons) actions.append(button);
  if (onRefresh) {
    const refresh = element("button", "ghost ws-home-all", refreshing ? "Refreshing…" : "Refresh");
    refresh.type = "button";
    refresh.disabled = refreshing;
    refresh.dataset.testid = `${id}-refresh`;
    refresh.addEventListener("click", onRefresh);
    actions.append(refresh);
  }
  for (const link of links) {
    const button = element("button", "ghost ws-home-all", link.label);
    button.type = "button";
    button.dataset.testid = link.testid;
    button.append(chevronIcon());
    button.addEventListener("click", link.onClick);
    actions.append(button);
  }
  head.append(actions);
  return head;
}

/* ---------- section 2: Automation statuses ---------- */

const AUTOMATION_STATES = {
  running: { label: "Running now", tone: "ok", rank: 0 },
  failed: { label: "Failed", tone: "bad", rank: 1 },
  refused: { label: "Refused", tone: "bad", rank: 1 },
  skipped: { label: "Skipped", tone: "warn", rank: 2 },
  ok: { label: "OK", tone: "ok", rank: 3 },
  never: { label: "Never run", tone: "muted", rank: 4 },
  paused: { label: "Paused", tone: "muted", rank: 5 },
};
const AUTOMATION_KIND_LABEL = { schedule: "Schedule", webhook: "Webhook", bob: "Bob report" };

const automationsState = {
  loaded: false,
  loading: false,
  fetchedAt: 0,
  error: "",
  rows: [],
  errors: [],
};

function sortAutomations(rows) {
  return [...rows].sort((left, right) => {
    const leftRank = AUTOMATION_STATES[left.last?.state]?.rank ?? (left.enabled ? 3 : 5);
    const rightRank = AUTOMATION_STATES[right.last?.state]?.rank ?? (right.enabled ? 3 : 5);
    if (leftRank !== rightRank) return leftRank - rightRank;
    if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
    const leftTime = left.last?.at ? Date.parse(left.last.at) : 0;
    const rightTime = right.last?.at ? Date.parse(right.last.at) : 0;
    if (leftTime !== rightTime) return rightTime - leftTime;
    return String(left.name || "").localeCompare(String(right.name || ""));
  });
}

async function loadAutomations(force = false) {
  if (!state.authenticated || automationsState.loading) return;
  if (!force && automationsState.loaded && Date.now() - automationsState.fetchedAt < FRESH_MS) return;
  automationsState.loading = true;
  automationsState.error = "";
  if (isSectionVisible("automations")) renderAutomations();
  try {
    const payload = await api("/api/control-center/automations", { signal: AbortSignal.timeout(20_000) });
    automationsState.rows = Array.isArray(payload?.rows) ? payload.rows : [];
    automationsState.errors = Array.isArray(payload?.errors) ? payload.errors : [];
    automationsState.loaded = true;
    automationsState.fetchedAt = Date.now();
  } catch (error) {
    automationsState.error = error instanceof Error ? error.message : "Could not load automations";
  } finally {
    automationsState.loading = false;
    renderGlanceStrip();
    if (isSectionVisible("automations")) renderAutomations();
  }
}

async function toggleAutomation(row, switchButton) {
  switchButton.disabled = true;
  try {
    await api(`/api/control-center/automations/${encodeURIComponent(row.kind)}/${encodeURIComponent(row.id)}/enabled`, {
      method: "PUT",
      body: JSON.stringify({ enabled: !row.enabled }),
    });
    await loadAutomations(true);
    window.dispatchEvent(new CustomEvent("control-center-changed"));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Could not update automation");
    switchButton.disabled = false;
  }
}

function renderAutomations() {
  const host = byId("homeAutomationsSection");
  if (!host || host.hidden) return;

  const rows = sortAutomations(automationsState.rows);
  const runningCount = rows.filter((row) => row.last?.state === "running").length;
  const failedCount = rows.filter((row) => row.last?.state === "failed" || row.last?.state === "refused").length;
  const activeCount = rows.filter((row) => row.enabled).length;
  const pausedCount = rows.length - activeCount;

  const summaryNodes = [];
  if (automationsState.loaded) {
    if (runningCount) summaryNodes.push(element("span", "ws-home-pill ok", `${runningCount} running`));
    if (failedCount) summaryNodes.push(element("span", "ws-home-pill bad", `${failedCount} failed`));
    if (activeCount) summaryNodes.push(element("span", "ws-home-pill", `${activeCount} on`));
    if (pausedCount) summaryNodes.push(element("span", "ws-home-pill muted", `${pausedCount} paused`));
  }

  const head = sectionHeader({
    id: "homeAutomationsTitle",
    title: "Automation statuses",
    countText: automationsState.loaded ? String(rows.length) : "…",
    summaryNodes,
    refreshing: automationsState.loading,
    onRefresh: () => void loadAutomations(true),
    links: [{
      label: "Open Automations",
      testid: "home-automations-open",
      onClick: () => byId("workspaceAutomationsButton")?.click(),
    }],
  });

  const nodes = [head];

  if (automationsState.error && !automationsState.loaded) {
    const err = element("div", "ws-home-notice bad");
    err.append(element("span", "", `Could not load automations: ${automationsState.error}`));
    const retry = element("button", "ghost compact", "Retry");
    retry.type = "button";
    retry.addEventListener("click", () => void loadAutomations(true));
    err.append(retry);
    nodes.push(err);
    host.replaceChildren(...nodes);
    return;
  }

  if (automationsState.errors.length) {
    const warn = element("div", "ws-home-notice warn");
    warn.dataset.testid = "home-automations-warnings";
    const sources = [...new Set(automationsState.errors.map((message) => message.split(": ")[0]))];
    warn.textContent = `Some nodes could not be read: ${sources.join(", ")}.`;
    warn.title = automationsState.errors.join("\n");
    nodes.push(warn);
  }

  if (!automationsState.loaded) {
    nodes.push(element("p", "ws-empty", "Loading automation statuses…"));
    host.replaceChildren(...nodes);
    return;
  }

  if (!rows.length) {
    const empty = element("div", "ws-home-empty-card");
    empty.append(element("p", "ws-empty", "No automations configured yet."));
    const open = element("button", "ghost compact", "Open Automations");
    open.type = "button";
    open.addEventListener("click", () => byId("workspaceAutomationsButton")?.click());
    empty.append(open);
    nodes.push(empty);
    host.replaceChildren(...nodes);
    return;
  }

  const list = element("div", "ws-home-table ws-home-auto-list");
  list.dataset.testid = "home-automations-list";
  for (const row of rows) {
    const item = element("div", "ws-home-row ws-home-auto-row");
    item.dataset.testid = "home-automation-row";
    item.dataset.kind = row.kind;
    item.dataset.id = row.id;
    item.dataset.state = row.last?.state || (row.enabled ? "ok" : "paused");

    const toggle = element("button", "ws-home-switch");
    toggle.type = "button";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(Boolean(row.enabled)));
    toggle.setAttribute("aria-label", `${row.enabled ? "Pause" : "Turn on"} ${row.name}`);
    toggle.dataset.testid = "home-automation-toggle";
    toggle.disabled = !row.editable;
    toggle.title = row.editable ? (row.enabled ? "Pause automation" : "Turn on automation") : "Only the creator can change this automation";
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      void toggleAutomation(row, toggle);
    });

    const main = element("button", "ws-home-row-main");
    main.type = "button";
    main.addEventListener("click", () => byId("workspaceAutomationsButton")?.click());

    const copy = element("span", "ws-home-row-copy");
    const titleLine = element("span", "ws-home-auto-title");
    titleLine.append(
      element("b", "", row.name || "Automation"),
      element("span", `ws-home-tag kind-${row.kind}`, AUTOMATION_KIND_LABEL[row.kind] || row.kind),
    );
    const metaParts = [row.projectName];
    if (row.nodeId && row.nodeName && row.nodeId !== state.localNodeId) metaParts.push(`on ${row.nodeName}`);
    if (row.when) metaParts.push(row.when);
    copy.append(titleLine, element("small", "", metaParts.filter(Boolean).join(" · ")));
    main.append(copy);

    const stateInfo = AUTOMATION_STATES[row.last?.state] ?? { label: row.last?.state || "Unknown", tone: "muted" };
    const statusText = row.last?.at && !["running", "never", "paused"].includes(row.last.state)
      ? `${stateInfo.label} · ${ago(row.last.at)}`
      : stateInfo.label;
    const badge = element("span", `ws-home-pill ${stateInfo.tone}`, statusText);
    badge.dataset.testid = "home-automation-status";
    badge.title = [row.last?.detail, row.last?.at ? new Date(row.last.at).toLocaleString() : ""].filter(Boolean).join("\n");

    item.append(toggle, main, badge);
    list.append(item);
  }

  nodes.push(list);
  host.replaceChildren(...nodes);
}

/* ---------- section 3: Connected clusters ---------- */

const clustersState = {
  loaded: false,
  loading: false,
  fetchedAt: 0,
  error: "",
  node: null,
  clusters: [],
  twins: [],
  relays: [],
  localRelay: null,
  inventory: null,
  inventoryLoading: false,
};

function openClusterSettings() {
  void import("./settings.js").then(({ openSettings }) => openSettings("cluster")).catch((error) => toast.error(error.message));
}

function peerReachability(nodeId) {
  if (!clustersState.inventory) return clustersState.inventoryLoading ? "checking" : "unknown";
  const match = clustersState.inventory.remote?.find((item) => item.peerId === nodeId);
  if (!match) return "unknown";
  return match.reachable ? "online" : "offline";
}

function projectCountsForCluster(clusterId, twinIds) {
  const projects = Array.isArray(state.projects) ? state.projects : [];
  const inCluster = projects.filter((project) => project.clusterIds?.includes(clusterId));
  const shared = inCluster.filter((project) => project.locallyOwned !== false || twinIds.has(project.ownerNodeId)).length;
  return { shared, received: inCluster.length - shared };
}

async function loadClusters(force = false) {
  if (!state.authenticated || clustersState.loading) return;
  if (!force && clustersState.loaded && Date.now() - clustersState.fetchedAt < FRESH_MS) return;
  clustersState.loading = true;
  clustersState.error = "";
  if (isSectionVisible("clusters")) renderClusters();
  try {
    const [nodeResult, clustersResult, twinsResult, relaysResult] = await Promise.allSettled([
      api("/api/cluster/node", { signal: AbortSignal.timeout(15_000) }),
      api("/api/clusters", { signal: AbortSignal.timeout(15_000) }),
      isNodeAdmin() ? api("/api/twins", { signal: AbortSignal.timeout(15_000) }) : Promise.resolve({ relationships: [] }),
      state.isRemoteLogin ? Promise.resolve({ relays: [], local: null }) : api("/api/relays", { signal: AbortSignal.timeout(15_000) }),
    ]);

    if (nodeResult.status === "rejected" && clustersResult.status === "rejected") {
      throw clustersResult.reason || nodeResult.reason;
    }

    if (nodeResult.status === "fulfilled") clustersState.node = nodeResult.value?.node ?? null;
    if (clustersResult.status === "fulfilled") clustersState.clusters = Array.isArray(clustersResult.value?.clusters) ? clustersResult.value.clusters : [];
    if (twinsResult.status === "fulfilled") {
      clustersState.twins = (twinsResult.value?.relationships ?? []).filter((item) => item.status === "active");
    }
    if (relaysResult.status === "fulfilled") {
      clustersState.relays = Array.isArray(relaysResult.value?.relays) ? relaysResult.value.relays : [];
      clustersState.localRelay = relaysResult.value?.local ?? null;
    }

    clustersState.loaded = true;
    clustersState.fetchedAt = Date.now();
  } catch (error) {
    clustersState.error = error instanceof Error ? error.message : "Could not load clusters";
  } finally {
    clustersState.loading = false;
    renderGlanceStrip();
    if (isSectionVisible("clusters")) renderClusters();
  }

  // Load live peer reachability progressively so offline nodes never stall the initial render.
  if (clustersState.loaded && !state.isRemoteLogin && (clustersState.clusters.length || clustersState.twins.length)) {
    clustersState.inventoryLoading = true;
    if (isSectionVisible("clusters")) renderClusters();
    try {
      clustersState.inventory = await api("/api/cluster/inventory", { signal: AbortSignal.timeout(15_000) });
    } catch {
      // Best-effort reachability.
    } finally {
      clustersState.inventoryLoading = false;
      renderGlanceStrip();
      if (isSectionVisible("clusters")) renderClusters();
    }
  }
}

function renderClusters() {
  const host = byId("homeClustersSection");
  if (!host || host.hidden) return;

  const clusters = [...clustersState.clusters].sort((left, right) => String(left.name || "").localeCompare(String(right.name || "")));
  const twins = clustersState.twins;
  const relays = clustersState.relays;
  const localRelay = clustersState.localRelay;
  const localId = clustersState.node?.id || state.localNodeId;
  const twinIds = new Set(twins.map((item) => item.peer?.nodeId).filter(Boolean));
  const connectedRelays = relays.filter((relay) => relay.connected).length + (localRelay ? 1 : 0);

  const summaryNodes = [];
  if (clustersState.loaded) {
    if (clusters.length) summaryNodes.push(element("span", "ws-home-pill ok", `${clusters.length} cluster${clusters.length === 1 ? "" : "s"}`));
    if (twins.length) {
      const onlineTwins = twins.filter((item) => peerReachability(item.peer?.nodeId) === "online").length;
      const twinText = clustersState.inventory ? `${onlineTwins}/${twins.length} twins online` : `${twins.length} twin${twins.length === 1 ? "" : "s"}`;
      summaryNodes.push(element("span", `ws-home-pill${clustersState.inventory && onlineTwins === twins.length ? " ok" : ""}`, twinText));
    }
    if (relays.length || localRelay) {
      summaryNodes.push(element("span", `ws-home-pill${connectedRelays ? " ok" : " warn"}`, `${connectedRelays} relay${connectedRelays === 1 ? "" : "s"} connected`));
    }
  }

  const head = sectionHeader({
    id: "homeClustersTitle",
    title: "Connected clusters",
    countText: clustersState.loaded ? String(clusters.length) : "…",
    summaryNodes,
    refreshing: clustersState.loading,
    onRefresh: () => void loadClusters(true),
    links: state.isRemoteLogin ? [] : [{
      label: "Manage clusters",
      testid: "home-clusters-manage",
      onClick: openClusterSettings,
    }],
  });

  const nodes = [head];

  if (clustersState.error && !clustersState.loaded) {
    const err = element("div", "ws-home-notice bad");
    err.append(element("span", "", `Could not load clusters: ${clustersState.error}`));
    const retry = element("button", "ghost compact", "Retry");
    retry.type = "button";
    retry.addEventListener("click", () => void loadClusters(true));
    err.append(retry);
    nodes.push(err);
    host.replaceChildren(...nodes);
    return;
  }

  if (!clustersState.loaded) {
    nodes.push(element("p", "ws-empty", "Loading connected clusters…"));
    host.replaceChildren(...nodes);
    return;
  }

  if (clustersState.node) {
    const localBar = element("div", "ws-home-cluster-local");
    localBar.dataset.testid = "home-cluster-local";
    localBar.append(
      element("span", "ws-home-dot online"),
      element("b", "", clustersState.node.name || "This machine"),
      element("span", "ws-home-tag", "This node"),
    );
    const url = displayNodeUrl(clustersState.node.url);
    if (url) localBar.append(element("small", "ws-home-cluster-url", url));
    nodes.push(localBar);
  }

  const nothingConnected = !clusters.length && !twins.length && !relays.length && !localRelay;
  if (nothingConnected) {
    const empty = element("div", "ws-home-empty-card");
    empty.append(element("p", "ws-empty", "This machine isn't connected to any clusters, twins, or relays yet."));
    if (!state.isRemoteLogin) {
      const manage = element("button", "ghost compact", "Open Cluster settings");
      manage.type = "button";
      manage.addEventListener("click", openClusterSettings);
      empty.append(manage);
    }
    nodes.push(empty);
    host.replaceChildren(...nodes);
    return;
  }

  if (clusters.length) {
    const grid = element("div", "ws-home-cluster-grid");
    grid.dataset.testid = "home-clusters-grid";
    for (const cluster of clusters) {
      const card = element("article", "ws-home-cluster-card");
      card.dataset.testid = "home-cluster-card";
      card.dataset.clusterId = cluster.id;
      if (!state.isRemoteLogin) {
        card.tabIndex = 0;
        card.setAttribute("role", "button");
        card.title = `Open ${cluster.name} in Cluster settings`;
        card.addEventListener("click", openClusterSettings);
        card.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openClusterSettings(); }
        });
      }

      const top = element("div", "ws-home-cluster-top");
      top.append(element("b", "ws-home-cluster-name", cluster.name || "Cluster"));
      const pending = Number(cluster.pendingDeliveries || 0);
      top.append(element("span", `ws-home-pill ${pending > 0 ? "warn" : "ok"}`, pending > 0 ? `${pending} syncing` : "Connected"));

      const counts = projectCountsForCluster(cluster.id, twinIds);
      const members = Array.isArray(cluster.members) ? cluster.members : [];
      const metaParts = [`${members.length} machine${members.length === 1 ? "" : "s"}`];
      if (counts.shared) metaParts.push(`${counts.shared} shared`);
      if (counts.received) metaParts.push(`${counts.received} received`);
      if (cluster.subscriptionPool?.name) metaParts.push(`Pool: ${cluster.subscriptionPool.name}`);
      const meta = element("p", "ws-home-cluster-meta", metaParts.join(" · "));

      const memberList = element("div", "ws-home-cluster-members");
      for (const member of members) {
        const isLocal = member.nodeId === localId;
        const isManager = member.nodeId === cluster.managerNodeId;
        const isTwin = twinIds.has(member.nodeId);
        const reach = isLocal ? "online" : peerReachability(member.nodeId);
        const chip = element("span", `ws-home-member ${reach}`);
        chip.dataset.testid = "home-cluster-member";
        chip.append(element("i", `ws-home-dot ${reach}`), element("span", "", member.name || member.nodeId));
        if (isLocal) chip.append(element("em", "", "You"));
        else if (isTwin) chip.append(element("em", "", "Twin"));
        if (isManager) chip.append(element("em", "manager", "★"));
        const memberUrl = displayNodeUrl(member.url);
        chip.title = [member.name || member.nodeId, memberUrl, reach === "online" ? "Online" : reach === "offline" ? "Offline" : ""].filter(Boolean).join(" · ");
        memberList.append(chip);
      }

      card.append(top, meta, memberList);
      grid.append(card);
    }
    nodes.push(grid);
  }

  if (twins.length || relays.length || localRelay) {
    const strip = element("div", "ws-home-cluster-links");
    strip.dataset.testid = "home-cluster-links";

    for (const relationship of twins) {
      const peerId = relationship.peer?.nodeId;
      const reach = peerReachability(peerId);
      const row = element("div", "ws-home-cluster-link");
      row.dataset.testid = "home-cluster-twin";
      const label = reach === "online" ? "Online" : reach === "offline" ? "Offline" : "Checking…";
      const tone = reach === "online" ? "ok" : reach === "offline" ? "bad" : "muted";
      row.append(
        element("i", `ws-home-dot ${reach}`),
        element("b", "", relationship.peer?.name || peerId || "Twin"),
        element("span", "ws-home-tag", "Twin"),
        element("span", "ws-home-spacer"),
        element("span", `ws-home-pill ${tone}`, label),
      );
      strip.append(row);
    }

    if (localRelay) {
      const row = element("div", "ws-home-cluster-link");
      row.dataset.testid = "home-cluster-relay";
      const peersText = `${localRelay.onlinePeers ?? 0} online`;
      row.append(
        element("i", "ws-home-dot online"),
        element("b", "", localRelay.name || localRelay.origin || "Local relay"),
        element("span", "ws-home-tag", "Serving relay"),
        element("span", "ws-home-spacer"),
        element("span", "ws-home-pill ok", `Serving · ${peersText}`),
      );
      strip.append(row);
    }

    for (const relay of relays) {
      const row = element("div", "ws-home-cluster-link");
      row.dataset.testid = "home-cluster-relay";
      const online = Boolean(relay.connected);
      const pillText = online
        ? `Connected · ${relay.onlinePeers ?? 0} online`
        : relay.status === "pending"
          ? "Pending approval"
          : "Offline";
      row.append(
        element("i", `ws-home-dot ${online ? "online" : "offline"}`),
        element("b", "", relay.name || relay.origin || "Relay"),
        element("span", "ws-home-tag", "Relay"),
        element("span", "ws-home-spacer"),
        element("span", `ws-home-pill ${online ? "ok" : "warn"}`, pillText),
      );
      if (relay.lastError && !online) row.title = relay.lastError;
      strip.append(row);
    }

    nodes.push(strip);
  }

  host.replaceChildren(...nodes);
}

/* ---------- section 4: Editable Dashboard features ---------- */

const MADE_BY = { bob: "made by Bob", you: "yours", shared: "shared with you" };

const dashboardState = {
  loaded: false,
  loading: false,
  fetchedAt: 0,
  error: "",
  accountId: null,
  overview: [],
  selectedId: null,
  detail: null,
  cards: [],
  frameKey: "",
  /** null | "new" | "change" */
  formMode: null,
  submitting: false,
  pollTimer: null,
};

function selectedOverview() {
  return dashboardState.overview.find((item) => item.id === dashboardState.selectedId) ?? null;
}

function dashboardPath(dashboard, suffix = "") {
  return `/api/dashboards/${encodeURIComponent(dashboard.id)}${suffix}`;
}

function hostQuery(dashboard) {
  return `projectId=${encodeURIComponent(dashboard.hostProjectId)}`;
}

function cardStatusLine(card) {
  if (card.status === "building") return { text: "Bob is building it…", tone: "warn" };
  if (card.status === "draft") return { text: "Not finished", tone: "bad" };
  if (card.changing) return { text: "Bob is changing it…", tone: "warn" };
  if (card.origin === "received" && !card.approved) return { text: "Waiting for approval", tone: "warn" };
  if (card.lastRefresh && !card.lastRefresh.ok) return { text: `Refresh failed ${ago(card.lastRefresh.at)}`, tone: "bad" };
  const refreshedAt = card.publishedAt ?? card.lastRefresh?.at;
  return { text: refreshedAt ? `Refreshed ${ago(refreshedAt)}` : "Not refreshed yet", tone: refreshedAt ? "ok" : "muted" };
}

function scheduleDashboardPoll() {
  clearTimeout(dashboardState.pollTimer);
  if (!homeVisible) return;
  const active = selectedOverview();
  const busy = Boolean(
    dashboardState.detail?.running
    || active?.status === "building"
    || active?.changing
    || dashboardState.overview.some((item) => item.status === "building" || item.changing)
    || dashboardState.cards.some((item) => item.status === "building" || item.changing),
  );
  if (!busy) return;
  dashboardState.pollTimer = setTimeout(() => { void loadDashboards(true); }, DASHBOARD_POLL_MS);
}

async function loadSelectedDetail() {
  const active = selectedOverview();
  if (!active || active.status !== "ready") {
    dashboardState.detail = null;
    return;
  }
  try {
    const response = await api(`${dashboardPath(active)}?${hostQuery(active)}`, { signal: AbortSignal.timeout(15_000) });
    if (dashboardState.selectedId === active.id) {
      dashboardState.detail = response?.dashboard ?? null;
      if (dashboardState.detail?.entity?.kind === "account" && dashboardState.detail.entity.id) {
        dashboardState.accountId = dashboardState.detail.entity.id;
      }
    }
  } catch {
    if (dashboardState.selectedId === active.id) dashboardState.detail = null;
  }
}

async function loadDashboards(force = false) {
  if (!state.authenticated || dashboardState.loading) return;
  if (!force && dashboardState.loaded && Date.now() - dashboardState.fetchedAt < FRESH_MS) return;
  dashboardState.loading = true;
  dashboardState.error = "";
  if (isSectionVisible("dashboard")) renderDashboards();
  try {
    const [overviewResult, cardsResult] = await Promise.allSettled([
      api("/api/control-center/dashboards/overview", { signal: AbortSignal.timeout(15_000) }),
      api("/api/control-center/dashboards", { signal: AbortSignal.timeout(15_000) }),
    ]);

    if (overviewResult.status === "rejected" && cardsResult.status === "rejected") {
      throw overviewResult.reason || cardsResult.reason;
    }

    if (overviewResult.status === "fulfilled") {
      dashboardState.overview = Array.isArray(overviewResult.value?.dashboards) ? overviewResult.value.dashboards : [];
      if (overviewResult.value?.accountId) dashboardState.accountId = overviewResult.value.accountId;
    }
    if (cardsResult.status === "fulfilled") {
      dashboardState.cards = Array.isArray(cardsResult.value?.dashboards) ? cardsResult.value.dashboards : [];
    }

    if (!selectedOverview()) {
      dashboardState.selectedId = (
        dashboardState.overview.find((item) => item.isDefault)
        ?? dashboardState.overview.find((item) => item.status === "ready")
        ?? dashboardState.overview[0]
      )?.id ?? null;
      dashboardState.frameKey = "";
    }

    await loadSelectedDetail();
    dashboardState.loaded = true;
    dashboardState.fetchedAt = Date.now();
  } catch (error) {
    dashboardState.error = error instanceof Error ? error.message : "Could not load dashboards";
  } finally {
    dashboardState.loading = false;
    renderGlanceStrip();
    if (isSectionVisible("dashboard")) renderDashboards();
    scheduleDashboardPoll();
  }
}

async function selectOverviewDashboard(id) {
  dashboardState.selectedId = id;
  dashboardState.detail = null;
  dashboardState.frameKey = "";
  dashboardState.formMode = null;
  renderDashboards();
  await loadSelectedDetail();
  renderGlanceStrip();
  renderDashboards();
  scheduleDashboardPoll();
}

async function refreshSelectedDashboard(button) {
  const active = selectedOverview();
  if (!active) return;
  button.disabled = true;
  try {
    await api(dashboardPath(active, "/refresh"), {
      method: "POST",
      body: JSON.stringify({ target: "live", projectId: active.hostProjectId }),
    });
    await loadSelectedDetail();
    renderGlanceStrip();
    renderDashboards();
    scheduleDashboardPoll();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Could not refresh dashboard");
    button.disabled = false;
  }
}

async function setSelectedAsDefault(button) {
  const active = selectedOverview();
  if (!active) return;
  button.disabled = true;
  try {
    await api(dashboardPath(active, "/activate"), {
      method: "POST",
      body: JSON.stringify({ projectId: active.hostProjectId }),
    });
    await loadDashboards(true);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Could not set default dashboard");
    button.disabled = false;
  }
}

async function deleteSelectedDashboard(button) {
  const active = selectedOverview();
  if (!active) return;
  if (!await confirmAction({ title: `Delete "${active.title}"?`, message: "The dashboard and its data are removed.", confirmLabel: "Delete", destructive: true })) return;
  button.disabled = true;
  try {
    await api(`${dashboardPath(active)}?${hostQuery(active)}`, { method: "DELETE" });
    dashboardState.selectedId = null;
    dashboardState.detail = null;
    dashboardState.frameKey = "";
    await loadDashboards(true);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Could not delete dashboard");
    button.disabled = false;
  }
}

/** Opens Joint Bob's full interactive Dashboard Creator/Editor for the selected overview dashboard. */
function editSelectedOverviewDashboard() {
  const active = selectedOverview();
  if (!active) return;
  const entity = dashboardState.detail?.entity ?? (dashboardState.accountId ? { kind: "account", id: dashboardState.accountId } : null);
  if (!entity) {
    // Fallback if entity wasn't loaded yet: open inline Ask Bob form.
    dashboardState.formMode = "change";
    renderDashboards();
    byId("homeDashboardSection")?.querySelector('[data-testid="home-dashboard-form-input"]')?.focus();
    return;
  }
  openDashboardMode({
    kind: entity.kind,
    id: entity.id,
    projectId: active.hostProjectId,
    dashboardId: active.id,
    initialMode: "creator",
  }).catch((error) => toast.error(error.message));
}

/** Opens Joint Bob's full Dashboard Creator to build a new overview dashboard, falling back to Bob prompt when needed. */
function startNewOverviewDashboard() {
  const hostProjectId = selectedOverview()?.hostProjectId || state.projects?.[0]?.id || null;
  if (dashboardState.accountId && hostProjectId) {
    openDashboardMode({
      kind: "account",
      id: dashboardState.accountId,
      projectId: hostProjectId,
      initialMode: "empty",
    }).catch((error) => toast.error(error.message));
    return;
  }
  dashboardState.formMode = dashboardState.formMode === "new" ? null : "new";
  renderDashboards();
  if (dashboardState.formMode) byId("homeDashboardSection")?.querySelector('[data-testid="home-dashboard-form-input"]')?.focus();
}

function editProjectOrWorkspaceCard(card) {
  openDashboardMode({
    kind: card.entity.kind,
    id: card.entity.id,
    projectId: card.hostProjectId,
    dashboardId: card.id,
    initialMode: "creator",
  }).catch((error) => toast.error(error.message));
}

function renderDashboards() {
  const host = byId("homeDashboardSection");
  if (!host || host.hidden) return;

  const totalCount = dashboardState.overview.length + dashboardState.cards.length;
  const newButton = element("button", "ghost ws-home-all", "+ New dashboard");
  newButton.type = "button";
  newButton.dataset.testid = "home-dashboard-new";
  newButton.addEventListener("click", startNewOverviewDashboard);

  const head = sectionHeader({
    id: "homeDashboardTitle",
    title: "Dashboards",
    countText: dashboardState.loaded ? String(totalCount) : "…",
    refreshing: dashboardState.loading,
    onRefresh: () => void loadDashboards(true),
    extraButtons: [newButton],
    links: [
      { label: "Dashboard", testid: "home-dashboard-open-overview", onClick: () => openControlTab("my-dashboard") },
      { label: "All dashboards", testid: "home-dashboard-open-all", onClick: () => openControlTab("dashboards") },
    ],
  });

  const existingFrame = host.querySelector('[data-testid="home-dashboard-frame"]');
  const nodes = [head];

  if (dashboardState.formMode) {
    const isChange = dashboardState.formMode === "change";
    const form = element("form", "ws-home-dash-form");
    form.dataset.testid = "home-dashboard-form";
    const textarea = element("textarea");
    textarea.rows = 2;
    textarea.placeholder = isChange
      ? `What should change in "${selectedOverview()?.title || "this dashboard"}"?`
      : "What should the dashboard show across your projects? (e.g. running agents, open reviews, and weekly spend)";
    textarea.dataset.testid = "home-dashboard-form-input";
    textarea.setAttribute("aria-label", isChange ? "Dashboard change request" : "New dashboard description");
    const row = element("div", "ws-home-dash-form-actions");
    const cancel = element("button", "ghost compact", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => { dashboardState.formMode = null; renderDashboards(); });
    const send = element("button", "primary compact", dashboardState.submitting ? "Sending…" : "Send to Bob");
    send.type = "submit";
    send.disabled = dashboardState.submitting;
    send.dataset.testid = "home-dashboard-form-send";
    row.append(cancel, send);
    form.append(textarea, row);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = textarea.value.trim();
      if (!text) { toast(isChange ? "Write what should change" : "Write what the dashboard should show"); return; }
      dashboardState.submitting = true;
      send.disabled = true;
      const sending = isChange
        ? api(`/api/control-center/dashboards/${encodeURIComponent(dashboardState.selectedId)}/ask-bob`, { method: "POST", body: JSON.stringify({ text }) })
        : api("/api/control-center/dashboards/overview", { method: "POST", body: JSON.stringify({ text }) }).then((made) => {
          if (made?.id) dashboardState.selectedId = made.id;
        });
      sending
        .then(() => {
          dashboardState.formMode = null;
          toast(isChange ? "Bob is changing the dashboard. It will update here when done." : "Bob is building the dashboard. It will appear here when ready.");
          window.dispatchEvent(new CustomEvent("control-center-changed"));
          return loadDashboards(true);
        })
        .catch((error) => toast.error(error instanceof Error ? error.message : "Could not update dashboard"))
        .finally(() => { dashboardState.submitting = false; renderDashboards(); });
    });
    nodes.push(form);
  }

  if (dashboardState.error && !dashboardState.loaded) {
    const err = element("div", "ws-home-notice bad");
    err.append(element("span", "", `Could not load dashboards: ${dashboardState.error}`));
    const retry = element("button", "ghost compact", "Retry");
    retry.type = "button";
    retry.addEventListener("click", () => void loadDashboards(true));
    err.append(retry);
    nodes.push(err);
    host.replaceChildren(...nodes);
    return;
  }

  if (!dashboardState.loaded) {
    nodes.push(element("p", "ws-empty", "Loading dashboards…"));
    host.replaceChildren(...nodes);
    return;
  }

  if (!totalCount) {
    const empty = element("div", "ws-home-empty-card");
    empty.append(element("p", "ws-empty", "No dashboards yet. Create an interactive dashboard across all your projects using the Dashboard Editor."));
    const create = element("button", "primary compact", "+ New dashboard");
    create.type = "button";
    create.dataset.testid = "home-dashboard-empty-new";
    create.addEventListener("click", startNewOverviewDashboard);
    empty.append(create);
    nodes.push(empty);
    host.replaceChildren(...nodes);
    return;
  }

  if (dashboardState.overview.length) {
    const overviewBox = element("div", "ws-home-dash-overview");
    overviewBox.dataset.testid = "home-dashboard-overview";

    const bar = element("div", "ws-home-dash-bar");
    const chips = element("div", "ws-home-dash-chips");
    for (const item of dashboardState.overview) {
      const active = item.id === dashboardState.selectedId;
      const chip = element("button", `ws-home-pick${active ? " on" : ""}`, `${item.isDefault ? "★ " : ""}${item.title}`);
      chip.type = "button";
      chip.dataset.testid = "home-dashboard-overview-chip";
      chip.dataset.id = item.id;
      chip.setAttribute("aria-pressed", String(active));
      chip.addEventListener("click", () => void selectOverviewDashboard(item.id));
      chips.append(chip);
    }
    bar.append(chips);

    const active = selectedOverview();
    const detail = dashboardState.detail;
    const controls = element("div", "ws-home-dash-controls");
    if (active) {
      let statusLabel = "Loading…";
      let statusTone = "muted";
      if (active.status === "building") { statusLabel = "Bob is building it"; statusTone = "warn"; }
      else if (active.changing) { statusLabel = "Bob is changing it"; statusTone = "warn"; }
      else if (active.status === "draft") { statusLabel = "Draft"; statusTone = "warn"; }
      else if (detail?.running) { statusLabel = "Refreshing…"; statusTone = "warn"; }
      else if (detail) {
        const last = detail.lastRefresh;
        statusLabel = last ? `${last.ok ? "Refreshed" : "Refresh failed"} ${ago(last.at)}` : "Not refreshed yet";
        statusTone = !last ? "muted" : last.ok ? "ok" : "bad";
      }
      controls.append(element("span", `ws-home-pill ${statusTone}`, statusLabel));

      const running = Boolean(detail?.running || active.changing);
      if (active.status === "ready" && detail) {
        const ai = detail.refreshMethod === "ai";
        const refresh = element("button", "compact soft", ai ? "Refresh with AI" : "Refresh");
        refresh.type = "button";
        refresh.dataset.testid = "home-dashboard-overview-refresh";
        refresh.disabled = running || !detail.approved;
        refresh.title = ai ? "Runs the dashboard agent once (uses AI)" : "Runs the dashboard script (no AI)";
        refresh.addEventListener("click", () => void refreshSelectedDashboard(refresh));
        controls.append(refresh);
      }

      // Edit directly using Joint Bob's interactive Dashboard Creator/Editor.
      const edit = element("button", "ghost compact ws-home-dash-btn", "Edit");
      edit.type = "button";
      edit.dataset.testid = "home-dashboard-edit";
      edit.disabled = active.changing;
      edit.title = "Open this dashboard in the Dashboard Editor to change layout, data, or code";
      edit.addEventListener("click", editSelectedOverviewDashboard);
      controls.append(edit);

      if (active.status === "ready") {
        const ask = element("button", "ghost compact ws-home-dash-btn", "Ask Bob");
        ask.type = "button";
        ask.dataset.testid = "home-dashboard-ask-bob";
        ask.disabled = running;
        ask.title = "Ask Bob to change this dashboard in the background";
        ask.addEventListener("click", () => {
          dashboardState.formMode = dashboardState.formMode === "change" ? null : "change";
          renderDashboards();
          if (dashboardState.formMode) host.querySelector('[data-testid="home-dashboard-form-input"]')?.focus();
        });
        controls.append(ask);

        if (!active.isDefault) {
          const def = element("button", "ghost compact ws-home-dash-btn", "Make default");
          def.type = "button";
          def.dataset.testid = "home-dashboard-default";
          def.addEventListener("click", () => void setSelectedAsDefault(def));
          controls.append(def);
        }
      }

      const del = element("button", "ghost compact ws-home-dash-btn danger", "Delete");
      del.type = "button";
      del.dataset.testid = "home-dashboard-delete";
      del.disabled = running;
      del.addEventListener("click", () => void deleteSelectedDashboard(del));
      controls.append(del);
    }
    bar.append(controls);
    overviewBox.append(bar);

    const stage = element("div", "ws-home-dash-stage");
    stage.dataset.testid = "home-dashboard-stage";
    if (active?.status === "building") {
      stage.append(element("p", "ws-empty", "Bob is building this dashboard. It will appear here when ready, or press Edit to follow it in the Dashboard Editor."));
      dashboardState.frameKey = "";
    } else if (active?.status === "draft") {
      stage.append(element("p", "ws-empty", "This dashboard is still a draft. Press Edit to continue building and saving it in the Dashboard Editor."));
      dashboardState.frameKey = "";
    } else if (active && detail) {
      const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
      const key = `${active.id}:${detail.definitionDigest}:${detail.lastRefresh?.at ?? ""}:${detail.approved}:${theme}`;
      if (key === dashboardState.frameKey && existingFrame) {
        stage.append(existingFrame);
      } else {
        dashboardState.frameKey = key;
        const frame = element("iframe", "ws-home-dash-frame");
        frame.dataset.testid = "home-dashboard-frame";
        frame.setAttribute("sandbox", "allow-scripts");
        frame.setAttribute("referrerpolicy", "no-referrer");
        frame.title = active.title || "Overview dashboard";
        frame.src = `${dashboardPath(active, "/frame")}?${hostQuery(active)}&theme=${theme}&v=${Date.now()}`;
        stage.append(frame);
      }
    } else if (active) {
      stage.append(element("p", "ws-empty", "Loading dashboard…"));
    }
    overviewBox.append(stage);
    nodes.push(overviewBox);
  }

  if (dashboardState.cards.length) {
    if (dashboardState.overview.length) {
      nodes.push(element("h3", "ws-home-subhead", `Project & workspace dashboards · ${dashboardState.cards.length}`));
    }
    const grid = element("div", "ws-home-dash-grid");
    grid.dataset.testid = "home-dashboard-cards";
    for (const card of dashboardState.cards) {
      const item = element("article", "ws-home-dash-card");
      item.dataset.testid = "home-dashboard-card";
      item.dataset.id = card.id;
      item.tabIndex = 0;
      item.setAttribute("role", "button");
      const open = () => openDashboardCard(card).catch((error) => toast.error(error.message));
      item.addEventListener("click", (event) => {
        if (!event.target.closest("button")) open();
      });
      item.addEventListener("keydown", (event) => {
        if (event.target === item && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); open(); }
      });

      const top = element("div", "ws-home-dash-card-top");
      top.append(
        element("span", "ws-home-dash-where", card.group === "project" ? card.projectName : `Workspace · ${card.workspaceLabel}`),
        element("span", "ws-home-tag", MADE_BY[card.madeBy] || card.madeBy || ""),
      );
      const status = cardStatusLine(card);
      const foot = element("div", "ws-home-dash-card-foot");
      foot.append(element("span", `ws-home-pill ${status.tone}`, status.text));
      const right = element("div", "ws-home-dash-card-actions");
      if (card.refreshMethod) right.append(element("small", "", card.refreshMethod === "ai" ? "AI" : "Script"));
      if (card.origin === "own" || card.canChange) {
        const editBtn = element("button", "ghost compact ws-home-dash-btn", "Edit");
        editBtn.type = "button";
        editBtn.dataset.testid = "home-dashboard-card-edit";
        editBtn.title = `Edit ${card.title} in the Dashboard Editor`;
        editBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          editProjectOrWorkspaceCard(card);
        });
        right.append(editBtn);
      }
      foot.append(right);
      item.append(top, element("b", "ws-home-dash-card-title", card.title || "Dashboard"), foot);
      grid.append(item);
    }
    nodes.push(grid);
  }

  host.replaceChildren(...nodes);
}

/* ---------- lifecycle ---------- */

function ensureVisibleSectionsRenderedAndLoaded() {
  if (isSectionVisible("automations") && !byId("homeAutomationsSection")?.childElementCount) renderAutomations();
  if (isSectionVisible("clusters") && !byId("homeClustersSection")?.childElementCount) renderClusters();
  if (isSectionVisible("dashboard") && !byId("homeDashboardSection")?.childElementCount) renderDashboards();
  // Quietly load all 3 non-activity sources (respecting 30s cache) so the Glance Strip stays live too.
  void loadAutomations();
  void loadClusters();
  void loadDashboards();
}

export function initHomeSections({ onSelectionChange } = {}) {
  if (typeof onSelectionChange === "function") notifySelectionChange = onSelectionChange;
  renderCustomizePopover();
  renderGlanceStrip();
  renderFocusTabs();
  applySectionVisibility();

  byId("homeCustomizeButton")?.addEventListener("click", (event) => {
    event.stopPropagation();
    setCustomizeOpen(!customizeOpen);
  });
  document.addEventListener("click", (event) => {
    if (customizeOpen && !event.target.closest?.("#homeCustomizeWrap")) setCustomizeOpen(false);
  });

  // Keep embedded overview dashboard theme in sync when light/dark theme changes.
  new MutationObserver(() => {
    if (homeVisible && isSectionVisible("dashboard") && dashboardState.overview.length) renderDashboards();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  window.addEventListener("control-center-changed", () => {
    if (!homeVisible) return;
    void loadAutomations(true);
    void loadDashboards(true);
  });

  window.addEventListener("dashboards-changed", () => {
    if (!homeVisible) return;
    dashboardState.frameKey = "";
    void loadDashboards(true);
  });

  window.addEventListener("cluster-filters-changed", () => {
    if (homeVisible) void loadClusters(true);
  });
}

export function syncHomeSections({ visible }) {
  homeVisible = Boolean(visible);
  applySectionVisibility();
  if (!homeVisible) {
    setCustomizeOpen(false);
    clearTimeout(dashboardState.pollTimer);
    return;
  }
  ensureVisibleSectionsRenderedAndLoaded();
}
