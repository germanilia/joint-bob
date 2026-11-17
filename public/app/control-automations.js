// Control center: the Automations tab. Every scheduled task, webhook and Bob report in one table that follows the
// board's project filter and pages instead of scrolling. Toggling and deleting go through /api/control-center/automations.
// Scheduled tasks and webhooks are automations with their own full editor (automation-editor.js); Bob reports keep a compact form here.
import { api } from "./api.js";
import { closeAutomationEditor, mountAutomationEditor, openAutomationEditor } from "./automation-editor.js";
import { isControlCenterOpen, saveControlCenter, refreshControlCenter } from "./control-center.js";
import { createControlViewElement, registerControlView, showControlView } from "./control-views.js";
import { setMobileView } from "./layout.js";
import { createFittedList, makeButton, makeNode, makeTwoStepButton } from "./relay-ui.js";
import { toast } from "./shell.js";
import { state } from "./state.js";

const BASE = "/api/control-center/automations";
const KIND_LABEL = { schedule: "schedule", webhook: "webhook", bob: "Bob" };
const REPORT_TIMES = { morning: "08:00", evening: "19:00" };
const REPORT_NAMES = { morning: "Morning report", evening: "Evening report" };
const LAST_STATES = {
  ok: ["ok", "ok"], failed: ["failed", "bad"], running: ["running now", "ok"], never: ["never", ""], paused: ["paused", ""], skipped: ["skipped", "warn"], refused: ["refused", "bad"],
};

let data = { rows: [], projects: [], errors: [], timezone: "UTC" };
let loading = null;
let filterKey = "";
let liveFilterStale = false;

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const testid = (node, id) => { node.dataset.testid = id; return node; };

function ago(iso) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** A row follows the project filter when it belongs to a chosen project; a Bob report that covers every project always shows. */
function matchesFilter(row, filter) {
  if (!filter.length) return true;
  if (row.kind === "bob" && !row.projectIds.length) return true;
  return row.projectIds.some((id) => filter.includes(id));
}

const visibleRows = () => data.rows.filter((row) => matchesFilter(row, state.controlCenter.filter));

// ── Layout ────────────────────────────────────────────────────────────────────────────────────────────

const root = createControlViewElement("automations");
root.classList.add("automations");
const head = makeNode("div", "automations-head");
const heading = makeNode("div");
heading.append(makeNode("h2", "", "Automations"), makeNode("p", "automations-hint", "Automations in every project, started on a schedule or by a webhook call, and the reports Bob writes. Bob can create and change these from the chat too."));
const headButtons = makeNode("div", "automations-head-buttons");
const newAutomation = makeButton("+ Automation", "automations-new-automation", () => openAutomationEditor({ projectId: state.controlCenter.filter[0] ?? null }), "primary compact");
const newBob = makeButton("+ Bob report", "automations-new-bob", () => openForm(null));
const refresh = makeButton("Refresh", "automations-refresh", () => load().catch((error) => toast.error(error.message)));
headButtons.append(refresh, newBob, newAutomation);
head.append(heading, headButtons);

const bar = makeNode("div", "control-bar");
const filters = testid(makeNode("div", "control-filters"), "control-automations-filters");
filters.setAttribute("aria-label", "Filter by project");
bar.append(filters);

// What could not be read: one line naming the machines or projects, the full messages under Details.
const problems = testid(makeNode("details", "automations-problems"), "automations-problems");
problems.hidden = true;
const problemsLine = testid(makeNode("summary", "automations-problems-line"), "automations-problems-line");
const problemsList = makeNode("ul", "automations-problems-list");
problems.append(problemsLine, problemsList);

/** "Ido's MacBook: Not answering; …" → one line: who could not be read. */
function renderProblems(errors) {
  problems.hidden = !errors.length;
  if (!errors.length) return;
  const sources = [...new Set(errors.map((error) => error.split(": ")[0]))];
  const who = sources.length > 2 ? `${sources.slice(0, 2).join(", ")} and ${sources.length - 2} more` : sources.join(" and ");
  problemsLine.replaceChildren(makeNode("b", "", `${who} could not be read.`), " Some rows show what was last reported. ", makeNode("span", "automations-problems-more", "Details"));
  problemsList.replaceChildren(...errors.map((error) => makeNode("li", "", error)));
}

const table = makeNode("div", "automations-table");
table.setAttribute("role", "table");
const columns = makeNode("div", "automation-columns");
columns.setAttribute("role", "row");
for (const label of ["On", "Name", "Type", "Project", "When / from", "Last run", ""]) {
  const cell = makeNode("span", "", label);
  cell.setAttribute("role", "columnheader");
  columns.append(cell);
}
const list = testid(makeNode("div", "automations-list"), "automations-list");
list.setAttribute("role", "rowgroup");
const pager = testid(makeNode("div", "automations-pager"), "automations-pager");
table.append(columns, list, pager);

const form = testid(makeNode("form", "automations-form"), "automation-form");
form.hidden = true;
root.append(head, bar, problems, table, form);

// ── The table ─────────────────────────────────────────────────────────────────────────────────────────

const fitted = createFittedList({
  list, pager, testPrefix: "automations", initialSize: 8,
  emptyText: "No automations or Bob reports match. Add one with the buttons above, or ask Bob.",
  async fetchPage(page, size) {
    const rows = visibleRows();
    return { total: rows.length, items: rows.slice((page - 1) * size, page * size) };
  },
  renderItem: renderRow,
});

function lastCell(row) {
  const [text, tone] = LAST_STATES[row.last.state] ?? [row.last.state, ""];
  const cell = makeNode("span", `automation-last ${tone}`.trim(), row.last.at && !["running", "never", "paused"].includes(row.last.state) ? `${text} · ${ago(row.last.at)}` : text);
  cell.dataset.testid = "automation-last";
  cell.title = [row.last.detail, row.last.at ? new Date(row.last.at).toLocaleString() : ""].filter(Boolean).join("\n");
  return cell;
}

function renderRow(row) {
  const item = makeNode("div", "automation-row");
  item.setAttribute("role", "row");
  item.dataset.testid = "automation-row";
  item.dataset.kind = row.kind;
  item.dataset.id = row.id;

  const toggle = makeNode("button", "automation-toggle");
  toggle.type = "button";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", String(row.enabled));
  toggle.setAttribute("aria-label", `${row.enabled ? "Pause" : "Turn on"} ${row.name}`);
  toggle.dataset.testid = "automation-toggle";
  toggle.disabled = !row.editable;
  toggle.title = row.editable ? (row.enabled ? "Pause it" : "Turn it on") : "Only the person who made it can change it";
  toggle.addEventListener("click", () => change(toggle, () => api(`${BASE}/${row.kind}/${row.id}/enabled`, { method: "PUT", body: JSON.stringify({ enabled: !row.enabled }) })));

  const name = makeNode("span", "automation-name");
  name.append(testid(makeNode("strong", "", row.name), "automation-name"));
  if (row.detail) name.append(makeNode("small", "", row.detail));

  const project = makeNode("span", "automation-project");
  project.append(makeNode("span", "", row.projectName));
  if (row.nodeId && row.nodeName && row.nodeId !== state.localNodeId) project.append(makeNode("small", "", `on ${row.nodeName}`));

  const actions = makeNode("span", "automation-actions");
  if (row.kind === "bob") actions.append(makeButton("Send now", "automation-send", (event) => sendNow(event.currentTarget, row)));
  const edit = makeButton("Edit", "automation-edit", () => editRow(row));
  edit.disabled = !row.editable;
  if (!row.editable) edit.title = "Only the person who made it can change it";
  actions.append(edit, makeTwoStepButton({ label: "Delete", armedLabel: "Delete?", testid: "automation-delete", onConfirm: () => remove(row) }));

  const meta = makeNode("span", "automation-meta");
  meta.append(testid(makeNode("span", `automation-kind ${row.kind}`, KIND_LABEL[row.kind]), "automation-kind"), project, makeNode("span", "automation-when", row.when), lastCell(row));
  item.append(toggle, name, meta, actions);
  if (row.kind !== "bob" && row.editable) {
    item.classList.add("clickable");
    item.addEventListener("click", (event) => { if (!event.target.closest("button")) editRow(row); });
  }
  return item;
}

async function change(button, work) {
  button.disabled = true;
  try { await work(); await load(); } catch (error) { toast.error(error.message); button.disabled = false; }
}

async function remove(row) {
  try { await api(`${BASE}/${row.kind}/${row.id}`, { method: "DELETE" }); await load(); } catch (error) { toast.error(error.message); }
}

async function sendNow(button, row) {
  button.disabled = true;
  try {
    await api(`${BASE}/bob/${row.id}/send`, { method: "POST", body: "{}" });
    toast(`${row.name} is in Bob's chat`);
    await load();
  } catch (error) { toast.error(error.message); } finally { button.disabled = false; }
}

function renderFilters() {
  const withRows = new Set(data.rows.flatMap((row) => row.projectIds));
  const chosen = state.controlCenter.filter;
  filters.replaceChildren();
  const all = makeNode("button", "control-chip", "All");
  all.type = "button";
  all.dataset.testid = "automations-filter-all";
  all.classList.toggle("active", !chosen.length);
  all.addEventListener("click", () => setFilter([]));
  filters.append(all);
  for (const project of data.projects.filter((item) => withRows.has(item.id) || chosen.includes(item.id))) {
    const chip = makeNode("button", "control-chip", project.name);
    chip.type = "button";
    chip.dataset.testid = `automations-filter-${project.id}`;
    chip.classList.toggle("active", chosen.includes(project.id));
    chip.addEventListener("click", () => setFilter(chosen.includes(project.id) ? chosen.filter((id) => id !== project.id) : [...chosen, project.id]));
    filters.append(chip);
  }
}

function setFilter(next) {
  state.controlCenter.filter = next;
  saveControlCenter();
  liveFilterStale = true;
  paint();
}

/** Draws the table for the current filter. The filter belongs to the whole control center, so the live board catches up when it is shown. */
function paint(page = "first") {
  filterKey = JSON.stringify(state.controlCenter.filter);
  renderFilters();
  renderProblems(data.errors);
  handle.setBadge(visibleRows().length);
  return page === "first" ? fitted.first() : fitted.reload();
}

/** Reads the list again and keeps the page the person is on. */
export function load() {
  if (loading) return loading;
  loading = (async () => {
    data = await api(BASE);
    await paint("same");
  })().finally(() => { loading = null; });
  return loading;
}

// ── Create and edit ───────────────────────────────────────────────────────────────────────────────────

function field(label, control, id, wide = false) {
  const wrapper = makeNode("label", wide ? "automation-field full" : "automation-field");
  wrapper.append(makeNode("span", "", label), control);
  if (id) control.dataset.testid = id;
  return wrapper;
}

function input(type, value = "", attributes = {}) {
  const node = makeNode("input");
  node.type = type;
  node.value = value;
  for (const [key, setting] of Object.entries(attributes)) node[key] = setting;
  return node;
}

function select(options, value) {
  const node = makeNode("select");
  node.append(...options.map(([optionValue, label]) => new Option(label, optionValue)));
  if (value !== undefined) node.value = value;
  return node;
}

function closeForm() {
  form.hidden = true;
  table.hidden = false;
  form.replaceChildren();
}

/** Scheduled tasks and webhooks open in the full editor; the table row only knows the id, so the automation is read from its machine. */
async function openAutomation(row) {
  const nodeId = row.nodeId && row.nodeId !== state.localNodeId ? row.nodeId : "";
  const { automations } = await api(`/api/automations${nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : ""}`);
  await openAutomationEditor({ item: automations.find((automation) => automation.id === row.id), nodeId });
}

function editRow(row) {
  if (row.kind === "bob") return openForm(row);
  return openAutomation(row).catch((error) => toast.error(error.message));
}

/** The compact editor for Bob's reports. */
function openForm(row) {
  const editing = Boolean(row);
  const zone = row?.edit.timezone ?? browserZone();
  const controls = {};
  const body = makeNode("div", "automation-form-fields");
  const error = testid(makeNode("p", "automations-error"), "automation-form-error");

  if (!editing) {
    controls.report = select([["morning", REPORT_NAMES.morning], ["evening", REPORT_NAMES.evening]], "morning");
    body.append(field("Report", controls.report, "automation-form-report"));
  }
  controls.name = input("text", row?.name ?? "", { maxLength: 120, placeholder: REPORT_NAMES.morning });
  body.append(field("Name", controls.name, "automation-form-name", true));
  controls.time = input("time", row?.edit.time ?? REPORT_TIMES.morning, { required: true });
  body.append(field("Every day at", controls.time, "automation-form-time"));
  if (!editing) controls.report.addEventListener("change", () => { controls.time.value = REPORT_TIMES[controls.report.value]; controls.name.placeholder = REPORT_NAMES[controls.report.value]; });
  const chosen = new Set(row?.projectIds ?? []);
  const group = testid(makeNode("div", "automation-projects"), "automation-form-projects");
  controls.projectBoxes = data.projects.map((project) => {
    const box = input("checkbox", project.id, { checked: chosen.has(project.id) });
    box.dataset.testid = `automation-form-project-${project.id}`;
    const label = makeNode("label", "automation-check");
    label.append(box, document.createTextNode(` ${project.name}`));
    group.append(label);
    return box;
  });
  body.append(field("Projects", group, undefined, true), makeNode("p", "automations-hint full", `Leave all unchecked for every project. Bob writes it in his chat in ${zone} time, while he is not paused.`));
  controls.enabled = input("checkbox", "on", { checked: row?.enabled ?? true });
  const enabled = makeNode("label", "automation-check");
  enabled.append(controls.enabled, document.createTextNode(" On"));
  controls.enabled.dataset.testid = "automation-form-enabled";
  body.append(enabled);

  const buttons = makeNode("div", "automation-form-buttons");
  const save = makeNode("button", "primary compact", "Save");
  save.type = "submit";
  save.dataset.testid = "automation-form-save";
  buttons.append(save, makeButton("Cancel", "automation-form-cancel", closeForm));

  form.replaceChildren(makeNode("h3", "", editing ? `Edit ${row.name}` : "New Bob report"), body, error, buttons);
  form.onsubmit = async (event) => {
    event.preventDefault();
    save.disabled = true;
    error.textContent = "";
    try {
      await submit(row, controls, zone);
    } catch (failure) { error.textContent = failure.message; } finally { save.disabled = false; }
  };
  table.hidden = true;
  form.hidden = false;
  controls.name.focus();
}

async function submit(row, controls, zone) {
  const json = (value) => JSON.stringify(value);
  const projectIds = controls.projectBoxes.filter((box) => box.checked).map((box) => box.value);
  const name = controls.name.value.trim();
  const enabled = controls.enabled.checked;
  if (row) await api(`${BASE}/bob/${row.id}`, { method: "PUT", body: json({ ...(name ? { name } : {}), time: controls.time.value, projectIds, enabled }) });
  else await api(`${BASE}/bob`, { method: "POST", body: json({ report: controls.report.value, ...(name ? { name } : {}), time: controls.time.value, timezone: zone, projectIds, enabled }) });
  closeForm();
  await load();
}

// ── The tab ───────────────────────────────────────────────────────────────────────────────────────────

const handle = registerControlView({
  id: "automations", title: "Automations", order: 10, element: root,
  onShow() {
    if (root.classList.contains("editing")) return;
    closeForm();
    load().catch((error) => toast.error(error.message));
  },
});
// The editor takes the place of the table; when it closes the table shows what it changed.
mountAutomationEditor({
  host: root,
  onClose: () => {
    window.dispatchEvent(new CustomEvent("automation-editor-closed"));
    load().catch((error) => toast.error(error.message));
  },
});

/** Shows the Automations tab, filtered to one project. For the project and conversation menus. */
export function openAutomationsFor(projectId) {
  closeAutomationEditor();
  if (!isControlCenterOpen()) setMobileView("control");
  setFilter(projectId ? [projectId] : []);
  showControlView("automations");
}

/** Opens the Automations tab on a new automation for a project; `target` pins where its conversations go (for example a conversation or an assistant). */
export function openNewAutomation({ projectId, nodeId = null, target = null }) {
  openAutomationsFor(projectId);
  return openAutomationEditor({ projectId, nodeId, target });
}

window.addEventListener("automations-changed", () => { load().catch((error) => console.warn("Could not load the automations", error)); });
// The badge shows as soon as the control center opens, not only after the tab is visited.
window.addEventListener("control-center-activated", () => { load().catch((error) => console.warn("Could not load the automations", error)); });
// The filter is shared: the board's chips or the project list may have changed it while this tab was hidden.
window.addEventListener("control-center-rendered", () => {
  if (JSON.stringify(state.controlCenter.filter) !== filterKey) paint().catch((error) => console.warn("Could not redraw the automations", error));
});
window.addEventListener("control-view-changed", (event) => {
  if (event.detail.id === "live" && liveFilterStale) { liveFilterStale = false; refreshControlCenter().catch(() => undefined); }
});
