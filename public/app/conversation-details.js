// The conversation's details column on the desktop workspace:
// Four top-level segments — Activity (unified monitor with live steps & inline running tasks),
// Ask (side chat, renamed from btw), Git (all-on-screen pipelines/PRs/changed files + sub-tabs,
// no separate modal needed), and Story (promoted to top level).
// Files moved out to the conversation top header ⋯ menu; Podcast playback moved to the top bar.
import { fetchBackgroundTaskOutput, stopBackgroundTaskInline, subscribeBackgroundTasks } from "./background-tasks.js";
import { initDetailsGit, refreshDetailsGit, resetDetailsGit, setGitSubtab } from "./details-git.js";
import { initDetailsStory, refreshDetailsStory, resetDetailsStory } from "./details-story.js";
import { elements } from "./elements.js";
import { state } from "./state.js";
import { formatUsageCost } from "./usage-format.js";

const byId = (id) => document.getElementById(id);
const PANES = { git: byId("detailsGit"), story: byId("detailsStory") };
const TABS = { git: byId("detailsGitTab"), story: byId("detailsStoryTab") };
const activityTab = byId("activityActivityTab");
const chatTab = byId("activityChatTab");
let shown = null;

/** Shows one of the desktop detail panes (git | story) in place of Activity/Ask; null returns to Activity/Ask. */
export function showDetailsPane(name) {
  shown = name;
  for (const [key, pane] of Object.entries(PANES)) if (pane) pane.hidden = key !== name;
  for (const [key, tab] of Object.entries(TABS)) if (tab) tab.setAttribute("aria-selected", String(key === name));
  if (name) {
    byId("activityBody").hidden = true;
    byId("conversationChat").hidden = true;
    activityTab.setAttribute("aria-selected", "false");
    chatTab.setAttribute("aria-selected", "false");
  }
  elements.activityPanel.dataset.pane = name ?? "activity";
  if (name === "git") refreshDetailsGit();
  if (name === "story") void refreshDetailsStory();
}

for (const [name, tab] of Object.entries(TABS)) tab?.addEventListener("click", () => showDetailsPane(name));
// Activity and Ask tabs take the column back; their own handlers show their pane.
for (const tab of [activityTab, chatTab]) tab.addEventListener("click", () => showDetailsPane(null), true);
document.addEventListener("activity-show-steps", () => showDetailsPane(null));

// The phone keeps its bottom sheet without the desktop Git/Story tabs.
const desktop = matchMedia("(min-width: 701px)");
desktop.addEventListener("change", () => { if (!desktop.matches && shown) activityTab.click(); });

// ArrowLeft / ArrowRight walk all four top-level segments: Activity → Ask → Git → Story.
const segments = [activityTab, chatTab, TABS.git, TABS.story].filter(Boolean);
for (const tab of segments) tab.addEventListener("keydown", (event) => {
  if ((event.key !== "ArrowLeft" && event.key !== "ArrowRight") || !desktop.matches) return;
  event.preventDefault();
  // Activity's own handler (conversation-chat.js) would toggle only Activity ↔ Ask.
  event.stopImmediatePropagation();
  const next = segments[(segments.indexOf(tab) + (event.key === "ArrowRight" ? 1 : segments.length - 1)) % segments.length];
  next.click();
  next.focus();
}, true);

function askInSideChat(prompt) {
  chatTab.click();
  const input = byId("conversationChatInput");
  if (input && prompt) {
    input.value = prompt;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

initDetailsGit({
  askAi: askInSideChat,
  explainPull: (pullNumber, pullUrl) => {
    showDetailsPane("story");
    void refreshDetailsStory({ force: true, pullNumber, pullUrl });
  },
});

initDetailsStory({
  openFile: () => {
    showDetailsPane("git");
    setGitSubtab("changes");
  },
});

/* ---------- Unified Activity Monitor: Inline Running Tasks ---------- */

const activeTaskStatuses = new Set(["starting", "running", "stopping"]);
const expandedTaskLogs = new Map(); // key -> { open, loading, text, error }

function taskIdentity(task) {
  return `${task.nodeId}:${task.id}`;
}

function taskAgo(value) {
  if (!value) return "";
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

let latestTaskSnapshot = { tasks: [], activeCount: 0, stoppingKey: "", nodes: new Map(), hasScope: false };

function renderInlineTasks() {
  const { tasks, activeCount, stoppingKey, nodes } = latestTaskSnapshot;
  const monitorTasks = byId("activityMonitorTasks");
  if (monitorTasks) monitorTasks.textContent = String(activeCount);

  const liveCount = byId("activityLiveCount");
  if (liveCount) {
    liveCount.hidden = !activeCount;
    liveCount.textContent = String(activeCount);
  }

  const badge = byId("activityTasksBadge");
  if (badge) {
    badge.textContent = activeCount ? `${activeCount} running` : "None running";
    badge.className = `ws-badge ${activeCount ? "is-live" : "is-muted"}`;
  }

  const list = byId("activityTasksList");
  if (!list) return;
  list.replaceChildren();

  const shownTasks = tasks.filter((task) => activeTaskStatuses.has(task.status)).slice(0, 6);
  if (!shownTasks.length) {
    list.hidden = true;
    return;
  }
  list.hidden = false;

  for (const task of shownTasks) {
    const key = taskIdentity(task);
    const logState = expandedTaskLogs.get(key) || { open: false, loading: false, text: "", error: "" };
    const row = document.createElement("div");
    row.className = "ws-task-row";
    row.dataset.testid = "activity-task-row";

    const top = document.createElement("div");
    top.className = "ws-git-row-top";
    const dot = document.createElement("span");
    dot.className = "ws-dot is-live";
    const cmd = document.createElement("span");
    cmd.className = "ws-task-cmd";
    cmd.textContent = task.name;
    cmd.title = task.name;

    const logsBtn = document.createElement("button");
    logsBtn.type = "button";
    logsBtn.className = "ws-btn-sm";
    logsBtn.textContent = logState.open ? "Hide" : "Logs";
    logsBtn.addEventListener("click", async () => {
      const next = { ...(expandedTaskLogs.get(key) || { open: false, loading: false, text: "", error: "" }) };
      next.open = !next.open;
      expandedTaskLogs.set(key, next);
      renderInlineTasks();
      if (next.open && !next.loading) {
        next.loading = true;
        renderInlineTasks();
        try {
          const out = await fetchBackgroundTaskOutput(task, 0);
          next.text = out.text || "No output yet.";
          next.error = "";
        } catch (error) {
          next.error = error.message;
        } finally {
          next.loading = false;
          expandedTaskLogs.set(key, next);
          renderInlineTasks();
        }
      }
    });

    const stopBtn = document.createElement("button");
    stopBtn.type = "button";
    stopBtn.className = "ws-btn-sm is-danger";
    stopBtn.textContent = stoppingKey === key ? "Stopping…" : "Stop";
    stopBtn.disabled = task.status === "stopping" || stoppingKey === key || !nodes.get(task.nodeId)?.available;
    stopBtn.addEventListener("click", () => void stopBackgroundTaskInline(task));

    top.append(dot, cmd, logsBtn, stopBtn);

    const sub = document.createElement("div");
    sub.className = "ws-git-row-sub";
    sub.textContent = [task.nodeName, taskAgo(task.startedAt) && `Started ${taskAgo(task.startedAt)}`].filter(Boolean).join(" · ");

    row.append(top, sub);

    if (logState.open) {
      const detail = document.createElement("div");
      detail.className = "ws-inline-detail";
      if (logState.loading && !logState.text) {
        const note = document.createElement("p");
        note.className = "ws-pane-note";
        note.textContent = "Loading output…";
        detail.append(note);
      } else if (logState.error) {
        const note = document.createElement("p");
        note.className = "ws-pane-note";
        note.textContent = logState.error;
        detail.append(note);
      } else {
        const pre = document.createElement("pre");
        pre.className = "ws-code-block";
        const lines = (logState.text || "No output yet.").split("\n").slice(-24);
        pre.textContent = lines.join("\n");
        detail.append(pre);
      }
      row.append(detail);
    }

    list.append(row);
  }
}

subscribeBackgroundTasks((snap) => {
  latestTaskSnapshot = snap;
  renderInlineTasks();
});

/* ---------- the two switches ---------- */

const autoSwitch = byId("detailsAutoRespondSwitch");
const notifySwitch = byId("detailsNotifySwitch");
function syncSwitches() {
  autoSwitch.setAttribute("aria-checked", String(elements.autoRespondButton.classList.contains("active")));
  autoSwitch.disabled = elements.autoRespondButton.disabled;
  notifySwitch.setAttribute("aria-checked", String(elements.notifyButton.getAttribute("aria-pressed") === "true"));
}
// Auto respond needs instructions, so its switch opens the same dialog its menu item does.
autoSwitch.addEventListener("click", () => elements.autoRespondButton.click());
notifySwitch.addEventListener("click", () => elements.notifyButton.click());
const watch = new MutationObserver(syncSwitches);
for (const id of ["autoRespondButton", "notifyButton"]) {
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

/* ---------- conversation switch & turn refresh ---------- */

let detailsOf = "";
document.addEventListener("activeConversationChanged", () => {
  syncSwitches();
  syncCost();
  const key = `${state.activeConversationProjectId || state.activeProjectId || ""}|${state.activeSessionId || ""}|${state.activeSessionPath || ""}`;
  if (key === detailsOf) return;
  detailsOf = key;
  expandedTaskLogs.clear();
  resetDetailsGit();
  resetDetailsStory();
  if (shown === "git") refreshDetailsGit({ force: true });
  if (shown === "story") void refreshDetailsStory({ force: true });
});

window.addEventListener("running-refreshed", () => {
  syncCost();
  if (shown === "git" && !elements.activityPanel.hidden) refreshDetailsGit();
});

syncSwitches();
syncCost();
