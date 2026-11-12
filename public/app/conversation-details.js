// The conversation's details column on the desktop workspace: Activity / Files / Git / Tasks as one
// segmented control (the side chat, Story and the Activity overview under More), the two "when it
// stops" switches and links to Browser, Terminal, Share and Schedule. Files, Git and Tasks are
// summaries; their buttons open today's full screens. The column is the activity panel: it opens,
// closes and resizes as that panel always did (activity-panel.js). The phone keeps the panel as it was.

import { api } from "./api.js";
import { elements } from "./elements.js";
import { openGitReview } from "./git-review.js";
import { projectGitUrl } from "./project-git-url.js";
import { openFileAction } from "./project-files.js";
import { toast } from "./shell.js";
import { state } from "./state.js";
import { activeChatSession } from "./terminal.js";
import { formatUsageCost } from "./usage-format.js";

const byId = (id) => document.getElementById(id);
const PANES = { files: byId("detailsFiles"), git: byId("detailsGit"), tasks: byId("detailsTasks") };
const TABS = { files: byId("detailsFilesTab"), git: byId("detailsGitTab"), tasks: byId("detailsTasksTab") };
const activityTab = byId("activityActivityTab");
const chatTab = byId("activityChatTab");
let shown = null;

/** Shows one of the summaries in place of the activity body and the side chat; null gives the activity back. */
function showPane(name) {
  shown = name;
  for (const [key, pane] of Object.entries(PANES)) pane.hidden = key !== name;
  for (const [key, tab] of Object.entries(TABS)) tab.setAttribute("aria-selected", String(key === name));
  if (name) {
    byId("activityBody").hidden = true;
    byId("conversationChat").hidden = true;
    activityTab.setAttribute("aria-selected", "false");
    chatTab.setAttribute("aria-selected", "false");
  }
  elements.activityPanel.dataset.pane = name ?? "activity";
  if (name === "files" || name === "git") void loadStatus();
  if (name === "tasks") syncTasks();
}

for (const [name, tab] of Object.entries(TABS)) tab.addEventListener("click", () => showPane(name));
// The panel's own tabs take the column back; their handlers show their pane.
for (const tab of [activityTab, chatTab]) tab.addEventListener("click", () => showPane(null), true);

/* ---------- Files and Git: one status read serves both ---------- */

let status = null;
let statusKey = "";
let reading = 0;

function target() {
  return { projectId: state.activeConversationProjectId || state.activeProjectId, nodeId: state.activeNodeId, taskId: state.activeTaskId };
}

function changesOf(current) {
  if (!current) return [];
  const seen = new Map();
  for (const [group, label] of [[current.staged, "staged"], [current.unstaged, ""], [current.untracked, "new"]]) {
    for (const change of group ?? []) if (!seen.has(change.path)) seen.set(change.path, { ...change, note: label || change.kind || "" });
  }
  return [...seen.values()];
}

async function loadStatus() {
  const where = target();
  if (!where.projectId || !state.activeSessionId) { status = null; renderStatus("Open a conversation first."); return; }
  const key = JSON.stringify(where);
  const mine = ++reading;
  if (key !== statusKey) { status = null; renderStatus("Reading the working tree…"); }
  try {
    const next = await api(projectGitUrl(where, "status"));
    if (mine !== reading) return;
    status = next;
    statusKey = key;
    renderStatus();
  } catch (error) {
    if (mine !== reading) return;
    // The pane has one short line: the reason alone ("Project is not a Git repository"), not the request it came from.
    renderStatus(error.cause?.message || error.message);
  }
}

function fileRow(change, open) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ws-file";
  button.dataset.testid = "details-file";
  button.title = change.path;
  const name = document.createElement("span");
  name.className = "ws-file-name";
  const slash = change.path.lastIndexOf("/");
  name.textContent = slash >= 0 ? change.path.slice(slash + 1) : change.path;
  const where = document.createElement("small");
  where.textContent = slash >= 0 ? change.path.slice(0, slash) : "";
  const kind = document.createElement("em");
  kind.textContent = change.note;
  button.append(name, where, kind);
  button.addEventListener("click", open);
  item.append(button);
  return item;
}

/** Up to this many rows; the full screens hold the rest. The column never scrolls for them. */
const ROWS = 8;

function renderStatus(message = "") {
  const changes = changesOf(status);
  const filesList = byId("detailsFilesList");
  const gitList = byId("detailsGitList");
  const count = byId("detailsGitCount");
  count.hidden = !status || !changes.length;
  count.textContent = String(changes.length);
  if (!status) {
    filesList.replaceChildren();
    gitList.replaceChildren();
    byId("detailsFilesStatus").textContent = message;
    byId("detailsGitStatus").textContent = message;
    byId("detailsGitBranch").textContent = "";
    return;
  }
  const more = changes.length > ROWS ? ` · ${ROWS} shown` : "";
  byId("detailsFilesStatus").textContent = changes.length ? `${changes.length} changed${more}` : "No changes";
  byId("detailsGitStatus").textContent = status.clean ? "Working tree clean" : `${changes.length} pending${more}`;
  const branch = byId("detailsGitBranch");
  branch.replaceChildren();
  const name = document.createElement("b");
  name.textContent = status.branch || "detached";
  branch.append(name);
  const tracking = [status.upstream && `→ ${status.upstream}`, status.ahead && `↑${status.ahead}`, status.behind && `↓${status.behind}`].filter(Boolean).join(" ");
  if (tracking) branch.append(Object.assign(document.createElement("small"), { textContent: tracking }));
  const shownChanges = changes.slice(0, ROWS);
  filesList.replaceChildren(...shownChanges.map((change) => fileRow(change, () => void openFileAction(change.path, state.activeTaskId))));
  gitList.replaceChildren(...shownChanges.map((change) => fileRow(change, () => {
    const session = activeChatSession();
    void openGitReview(session?.conversationId ?? session?.id ?? null);
  })));
}

/* ---------- Tasks ---------- */

const tasksBadge = byId("backgroundTasksBadge");
function syncTasks() {
  const count = tasksBadge && !tasksBadge.hidden ? tasksBadge.textContent.trim() : "";
  const segmentCount = byId("detailsTasksCount");
  segmentCount.hidden = !count;
  segmentCount.textContent = count;
  byId("detailsTasksStatus").textContent = count ? `${count} running` : "None running";
}
if (tasksBadge) new MutationObserver(syncTasks).observe(tasksBadge, { attributes: true, childList: true, characterData: true, subtree: true });

/* ---------- the two switches and the links ---------- */

const autoSwitch = byId("detailsAutoRespondSwitch");
const notifySwitch = byId("detailsNotifySwitch");
function syncSwitches() {
  autoSwitch.setAttribute("aria-checked", String(elements.autoRespondButton.classList.contains("active")));
  autoSwitch.disabled = elements.autoRespondButton.disabled;
  notifySwitch.setAttribute("aria-checked", String(elements.notifyButton.getAttribute("aria-pressed") === "true"));
  for (const link of document.querySelectorAll("#detailsFoot [data-proxy]")) {
    const source = byId(link.dataset.proxy);
    link.disabled = !source || source.disabled;
    link.hidden = !source || source.hidden;
  }
}
// Auto respond needs instructions, so its switch opens the same dialog its menu item does.
autoSwitch.addEventListener("click", () => elements.autoRespondButton.click());
notifySwitch.addEventListener("click", () => elements.notifyButton.click());
for (const link of document.querySelectorAll("#detailsFoot [data-proxy]")) {
  link.addEventListener("click", () => byId(link.dataset.proxy)?.click());
}
const watch = new MutationObserver(syncSwitches);
for (const id of ["autoRespondButton", "notifyButton", "openBrowserButton", "openTerminalButton", "shareConversationButton", "chatCronButton"]) {
  const source = byId(id);
  if (source) watch.observe(source, { attributes: true, attributeFilter: ["class", "aria-pressed", "disabled", "hidden"] });
}

/* ---------- the header's quiet meta: what the conversation cost ---------- */

function syncCost() {
  const meta = byId("chatCostMeta");
  const session = state.sessions?.find((item) => item.id === state.activeSessionId || item.path === state.activeSessionPath);
  const usage = session?.usage;
  meta.hidden = !usage || usage.apiCostUsd === null || usage.apiCostUsd === undefined;
  meta.textContent = meta.hidden ? "" : formatUsageCost(usage);
  meta.title = meta.hidden ? "" : "API-equivalent token cost of this conversation; not an invoice";
}

/* ---------- a new conversation starts on the activity ---------- */

document.addEventListener("activeConversationChanged", () => {
  status = null;
  statusKey = "";
  renderStatus();
  if (shown === "files" || shown === "git") void loadStatus();
  syncSwitches();
  syncCost();
});
// A turn that ends may have changed files: an open Files or Git summary reads them again.
window.addEventListener("running-refreshed", () => {
  syncCost();
  if ((shown === "files" || shown === "git") && !elements.activityPanel.hidden) void loadStatus().catch((error) => toast.error(error.message));
});

syncSwitches();
syncTasks();
syncCost();
