import { api } from "./api.js";
import { createControlViewElement, currentControlView, registerControlView, showControlView } from "./control-views.js";
import { toast } from "./shell.js";

/*
 * The control center's Dashboard view: the other side of the board. The board shows the conversations; this shows one of
 * the person's dashboards over every project and workspace they can see. They keep as many as they like, ask for a new one
 * in their own words, and choose the default the view opens with. A dashboard here is the existing dashboards feature
 * (the dashboard agent, the sandboxed frame, script or AI refresh), only not tied to one project or workspace.
 */

const VIEW = "my-dashboard";
const LIST_POLL_MS = 3000;

let dashboards = [];
let selectedId = null;
let detail = null;
let frameKey = "";
let followTimer = null;
let listTimer = null;
/** What the text box is for: a new dashboard, or a change to the one shown. */
let formMode = "new";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, testid, onClick, className = "ghost compact") {
  const node = el("button", className, label);
  node.type = "button";
  node.dataset.testid = testid;
  node.addEventListener("click", () => Promise.resolve(onClick()).catch((error) => toast.error(error.message)));
  return node;
}

function ago(iso) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

const root = createControlViewElement(VIEW);
root.classList.add("control-dash", "control-mydash");
const picker = el("div", "control-mydash-picker");
picker.dataset.testid = "control-mydash-picker";
const actions = el("div", "control-mydash-actions");
const bar = el("div", "control-mydash-bar");
bar.append(picker, actions);
const form = el("form", "control-dash-ask");
form.hidden = true;
const formText = el("textarea");
formText.rows = 3;
formText.dataset.testid = "control-mydash-text";
const formSend = el("button", "primary compact", "Send to Bob");
formSend.type = "submit";
formSend.dataset.testid = "control-mydash-send";
const formActions = el("div", "control-dash-ask-actions");
formActions.append(button("Cancel", "control-mydash-cancel", () => { form.hidden = true; }), formSend);
form.append(formText, formActions);
const status = el("div", "dashboard-status");
status.dataset.testid = "control-mydash-status";
status.setAttribute("role", "status");
const notices = el("div", "dashboard-notices");
const stage = el("div", "dashboard-view-stage control-mydash-stage");
stage.dataset.testid = "control-mydash-stage";
root.append(bar, form, status, notices, stage);

const selected = () => dashboards.find((dashboard) => dashboard.id === selectedId) ?? null;
const path = (dashboard, suffix = "") => `/api/dashboards/${encodeURIComponent(dashboard.id)}${suffix}`;
const hostQuery = (dashboard) => `projectId=${encodeURIComponent(dashboard.hostProjectId)}`;

function openForm(mode) {
  formMode = mode;
  formText.placeholder = mode === "new"
    ? "What should the dashboard show, across all your projects? For example: what needs my attention, running agents per project, and spend this week."
    : "What should change?";
  formText.value = "";
  form.hidden = false;
  formText.focus();
}

function renderPicker() {
  const chips = dashboards.map((dashboard) => {
    const chip = button(`${dashboard.isDefault ? "★ " : ""}${dashboard.title}`, "control-mydash-chip", () => select(dashboard.id), "control-chip");
    chip.dataset.id = dashboard.id;
    chip.dataset.status = dashboard.status;
    chip.classList.toggle("active", dashboard.id === selectedId);
    chip.setAttribute("aria-pressed", String(dashboard.id === selectedId));
    chip.title = dashboard.isDefault ? "Your default dashboard" : dashboard.status === "building" ? "Bob is building it" : dashboard.title;
    return chip;
  });
  picker.replaceChildren(...chips, button("+ New dashboard", "control-mydash-new", () => openForm("new")));
}

function renderActions() {
  const dashboard = selected();
  if (!dashboard || dashboard.status !== "ready" || !detail) { actions.replaceChildren(); return; }
  const running = Boolean(detail.running);
  const ai = detail.refreshMethod === "ai";
  const refresh = button(ai ? "Refresh with AI" : "Refresh", "control-mydash-refresh", startRefresh, "primary compact");
  refresh.title = ai ? "Runs the dashboard agent once. This uses AI and costs tokens." : "Runs the dashboard's script. No AI is used.";
  refresh.disabled = running || !detail.approved;
  const change = button("Ask Bob to change it", "control-mydash-change", () => openForm("change"));
  change.disabled = running || dashboard.changing;
  const makeDefault = button(dashboard.isDefault ? "Default" : "Make default", "control-mydash-default", setDefault);
  makeDefault.disabled = dashboard.isDefault;
  makeDefault.title = "The Dashboard view opens with your default dashboard";
  const remove = button("Delete", "control-mydash-delete", removeSelected);
  remove.disabled = running || dashboard.changing;
  actions.replaceChildren(refresh, change, makeDefault, remove);
}

function renderStatus() {
  const dashboard = selected();
  notices.replaceChildren();
  if (!dashboard) { status.replaceChildren(); return; }
  const pill = el("span", "dashboard-pill");
  if (dashboard.status === "building" || dashboard.changing || detail?.running) {
    pill.classList.add("busy");
    pill.append(el("span", "dashboard-spinner"), document.createTextNode(dashboard.status === "building" ? "Bob is building it" : dashboard.changing ? "Bob is changing it" : "Refreshing"));
  } else if (dashboard.status === "draft") {
    pill.classList.add("bad");
    pill.append(el("span", "dashboard-dot"), document.createTextNode("Not finished"));
  } else {
    const last = detail?.lastRefresh;
    pill.classList.add(!last ? "idle" : last.ok ? "good" : "bad");
    pill.append(el("span", "dashboard-dot"), document.createTextNode(last ? `${last.ok ? "Refreshed" : "Refresh failed"} ${ago(last.at)}` : "Not refreshed yet"));
  }
  const method = detail?.refreshMethod ? el("span", "dashboard-method", detail.refreshMethod === "ai" ? "AI refresh · costs AI" : "Script, no AI") : "";
  status.replaceChildren(pill, method);
  if (detail?.lastRefresh && !detail.lastRefresh.ok) notices.append(el("p", "dashboard-error", `The last refresh failed: ${detail.lastRefresh.error}. The data shown is from the last good refresh.`));
}

function message(text, testid) {
  const note = el("p", "control-empty", text);
  note.dataset.testid = testid;
  stage.replaceChildren(note);
  frameKey = "";
}

/** The frame reloads only when the page or its data changed. */
function renderStage() {
  const dashboard = selected();
  if (!dashboard) return message("No dashboard yet. Press “+ New dashboard” and say what you want to see across all your projects and workspaces; Bob builds it and tells you in the chat when it is ready.", "control-mydash-empty");
  if (dashboard.status === "building") return message("Bob is building this dashboard. It shows here when it is ready.", "control-mydash-building");
  if (dashboard.status === "draft") return message("Bob could not finish this dashboard; his message in the chat says why. Delete it, or ask for a new one.", "control-mydash-draft");
  if (!detail) return;
  const key = `${dashboard.id}:${detail.definitionDigest}:${detail.lastRefresh?.at ?? ""}:${detail.approved}`;
  if (key === frameKey && stage.querySelector("iframe")) return;
  frameKey = key;
  const frame = el("iframe", "dashboard-frame");
  frame.dataset.testid = "control-mydash-frame";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.title = dashboard.title;
  const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  frame.src = `${path(dashboard, "/frame")}?${hostQuery(dashboard)}&theme=${theme}&v=${Date.now()}`;
  stage.replaceChildren(frame);
}

function render() {
  renderPicker();
  renderActions();
  renderStatus();
  renderStage();
}

async function loadDetail() {
  const dashboard = selected();
  detail = dashboard && dashboard.status === "ready" ? (await api(`${path(dashboard)}?${hostQuery(dashboard)}`)).dashboard : null;
  render();
}

/** While a refresh runs the view follows it, and shows the new data when it ends. */
async function follow() {
  clearTimeout(followTimer);
  const opened = selectedId;
  while (selectedId === opened && detail?.running && currentControlView() === VIEW) {
    await new Promise((resolve) => { followTimer = setTimeout(resolve, 1000); });
    if (selectedId !== opened) return;
    await loadDetail();
  }
}

/** While Bob builds or changes one, the list is read again until he is done. */
function watchBuilds() {
  clearTimeout(listTimer);
  if (currentControlView() !== VIEW || !dashboards.some((dashboard) => dashboard.status === "building" || dashboard.changing)) return;
  listTimer = setTimeout(() => { void load().catch((error) => console.warn("Could not list the control center dashboards", error)); }, LIST_POLL_MS);
}

async function load() {
  dashboards = (await api("/api/control-center/dashboards/overview")).dashboards;
  if (!selected()) selectedId = (dashboards.find((dashboard) => dashboard.isDefault) ?? dashboards.find((dashboard) => dashboard.status === "ready") ?? dashboards[0])?.id ?? null;
  await loadDetail();
  watchBuilds();
  await follow();
}

async function select(id) {
  selectedId = id;
  detail = null;
  frameKey = "";
  form.hidden = true;
  stage.replaceChildren(el("p", "dashboard-note", "Loading…"));
  await loadDetail();
  await follow();
}

async function startRefresh() {
  const dashboard = selected();
  await api(path(dashboard, "/refresh"), { method: "POST", body: JSON.stringify({ target: "live", projectId: dashboard.hostProjectId }) });
  await loadDetail();
  await follow();
}

async function setDefault() {
  const dashboard = selected();
  await api(path(dashboard, "/activate"), { method: "POST", body: JSON.stringify({ projectId: dashboard.hostProjectId }) });
  await load();
}

async function removeSelected() {
  const dashboard = selected();
  if (!window.confirm(`Delete the dashboard "${dashboard.title}"?`)) return;
  await api(`${path(dashboard)}?${hostQuery(dashboard)}`, { method: "DELETE" });
  selectedId = null;
  await load();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = formText.value.trim();
  if (!text) { toast(formMode === "new" ? "Write what the dashboard should show" : "Write what should change"); return; }
  formSend.disabled = true;
  const sending = formMode === "new"
    ? api("/api/control-center/dashboards/overview", { method: "POST", body: JSON.stringify({ text }) }).then((made) => { selectedId = made.id; })
    : api(`/api/control-center/dashboards/${encodeURIComponent(selectedId)}/ask-bob`, { method: "POST", body: JSON.stringify({ text }) });
  sending.then(() => {
    form.hidden = true;
    toast(formMode === "new" ? "Bob is building the dashboard. He will say so in the chat when it is done." : "Bob is changing the dashboard. He will say so in the chat when it is done.");
    // The request and Bob's answer are already in his timeline: the chat reloads it.
    window.dispatchEvent(new CustomEvent("control-center-changed"));
    return load();
  }).catch((error) => toast.error(error.message)).finally(() => { formSend.disabled = false; });
});

registerControlView({ id: VIEW, title: "Dashboard", order: 1, element: root, onShow: () => { void load().catch((error) => toast.error(error.message)); } });

// Bob's message that a dashboard is ready arrives the same way as any message from him.
window.addEventListener("control-center-changed", () => {
  if (document.body.classList.contains("view-control") && currentControlView() === VIEW) void load().catch((error) => console.warn("Could not list the control center dashboards", error));
});
// "Open dashboards" on Bob's message about one of these shows it here, not in the Dashboards tab.
window.addEventListener("control-bob-action", (event) => {
  const id = event.detail.actionId === "dashboards.open" ? event.detail.data?.dashboardId : null;
  if (!id) return;
  api("/api/control-center/dashboards/overview").then(({ dashboards: mine }) => {
    if (!mine.some((dashboard) => dashboard.id === id)) return;
    selectedId = id;
    showControlView(VIEW);
  }).catch((error) => console.warn("Could not open the control center dashboard", error));
});
