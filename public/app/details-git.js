// Full inline Git hub inside the desktop details panel: All (default overview of running pipelines,
// open PRs and changed files) + focused sub-tabs (Changes, PRs, Pipelines, History, Reviews).
// Everything expands inline (diffs, job logs, PR details, commit diffs, review notes) without
// needing a separate modal screen.
import { api } from "./api.js";
import { projectGitUrl } from "./project-git-url.js";
import { toast } from "./shell.js";
import { state } from "./state.js";
import { activeChatSession } from "./terminal.js";

const byId = (id) => document.getElementById(id);

let onAskAi = null;
let onExplainPull = null;

const store = {
  key: "",
  subtab: "all",
  generation: 0,
  status: null,
  statusError: "",
  scopePaths: null,
  fileScope: "all", // "chat" | "all"
  fileFilter: "",
  pulls: [],
  pullsLoaded: false,
  pullsError: "",
  pullState: "open",
  pullFilter: "",
  runs: [],
  runsLoaded: false,
  runsError: "",
  runFilter: "all", // "all" | "running" | "failed"
  commits: null,
  commitsError: "",
  reviews: null,
  reviewsError: "",
  guide: null,
  // Inline expansion caches keyed by id/path
  expandedFiles: new Set(),
  diffs: new Map(), // key -> { loading, data, error }
  expandedRuns: new Set(),
  runDetails: new Map(), // runId -> { loading, data, error }
  jobLogs: new Map(), // jobId -> { loading, data, error }
  expandedPulls: new Set(),
  pullDetails: new Map(), // number -> { loading, data, error }
  expandedCommits: new Set(),
  commitDetails: new Map(), // hash -> { loading, data, error }
};

function currentTarget() {
  return {
    projectId: state.activeConversationProjectId || state.activeProjectId,
    nodeId: state.activeNodeId,
  };
}

function currentConversationId() {
  const session = activeChatSession();
  return session?.conversationId ?? session?.id ?? state.activeConversationId ?? null;
}

function gitUrl(route, params = {}) {
  return projectGitUrl(currentTarget(), route, params);
}

function el(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

function ago(value) {
  if (!value) return "";
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return seconds < 86400 * 30 ? `${Math.floor(seconds / 86400)}d ago` : new Date(value).toLocaleDateString();
}

function runTone(run) {
  if (run.status && run.status !== "completed") return "amber";
  if (run.conclusion === "success") return "live";
  if (run.conclusion === "failure" || run.conclusion === "timed_out") return "danger";
  return "muted";
}

function runStatusText(run) {
  if (run.status && run.status !== "completed") return `${(run.status || "running").replaceAll("_", " ")} · ${ago(run.run_started_at || run.created_at)}`;
  const label = run.conclusion === "success" ? "Passed" : run.conclusion === "failure" ? "Failed" : (run.conclusion || "Done");
  return `${label} · ${ago(run.updated_at || run.created_at)}`;
}

function changesOf(current) {
  if (!current) return [];
  const seen = new Map();
  for (const [group, staged, note] of [
    [current.staged, true, "staged"],
    [current.unstaged, false, ""],
    [current.untracked, false, "new"],
  ]) {
    for (const change of group ?? []) {
      const key = `${staged ? "s" : "u"}:${change.path}`;
      if (!seen.has(key)) {
        seen.set(key, { ...change, staged, key, note: note || change.kind || "modified" });
      }
    }
  }
  return [...seen.values()];
}

function filteredChanges() {
  let list = changesOf(store.status);
  if (store.fileScope === "chat" && Array.isArray(store.scopePaths) && store.scopePaths.length) {
    const allowed = new Set(store.scopePaths);
    list = list.filter((change) => allowed.has(change.path));
  }
  const q = store.fileFilter.trim().toLowerCase();
  if (q) list = list.filter((change) => change.path.toLowerCase().includes(q));
  return list;
}

function renderPatchBlock(diff) {
  const pre = el("pre", "ws-code-block");
  if (!diff) {
    pre.append(el("span", "ws-code-line", "Loading diff…"));
    return pre;
  }
  if (diff.binary) {
    pre.append(el("span", "ws-code-line", "Binary file — no textual diff."));
    return pre;
  }
  if (!diff.patch) {
    pre.append(el("span", "ws-code-line", "No textual diff available."));
    return pre;
  }
  const lines = diff.patch.split("\n");
  const maxLines = 180;
  for (const line of lines.slice(0, maxLines)) {
    const cls = line.startsWith("+") && !line.startsWith("+++")
      ? "ws-code-line is-add"
      : line.startsWith("-") && !line.startsWith("---")
        ? "ws-code-line is-del"
        : line.startsWith("@@")
          ? "ws-code-line is-hunk"
          : "ws-code-line";
    pre.append(el("span", cls, line));
  }
  if (lines.length > maxLines || diff.truncated) {
    pre.append(el("span", "ws-code-line is-hunk", "… diff truncated for inline preview"));
  }
  return pre;
}

function renderLogBlock(logData) {
  const pre = el("pre", "ws-code-block");
  if (!logData) {
    pre.append(el("span", "ws-code-line", "Loading job log…"));
    return pre;
  }
  if (logData.unavailable) {
    pre.append(el("span", "ws-code-line", logData.unavailable));
    return pre;
  }
  const failedSteps = (logData.job?.steps || []).filter((step) => step.conclusion === "failure" || step.conclusion === "timed_out");
  const targetStep = failedSteps[0] || (logData.steps || []).at(-1);
  const text = targetStep
    ? (logData.steps || []).find((entry) => entry.number === targetStep.number)?.text
    : (logData.steps || []).map((entry) => entry.text).filter(Boolean).join("\n");
  if (!text) {
    pre.append(el("span", "ws-code-line", "No log output captured yet."));
    return pre;
  }
  const rawLines = text.split("\n").filter((l) => l.trim().length > 0);
  const errorIdx = rawLines.findIndex((raw) => /(^|\W)(error|failed|fail|fatal|assertionerror|✕|✖)(\W|$)|##\[error\]|^\s*not ok\b/i.test(raw));
  const slice = errorIdx >= 0
    ? rawLines.slice(Math.max(0, errorIdx - 4), errorIdx + 24)
    : rawLines.slice(-28);
  for (const raw of slice) {
    const clean = raw.replace(/\u001b\[[0-9;]*m/g, "").replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "");
    const isErr = /(^|\W)(error|failed|fail|fatal|assertionerror|✕|✖)(\W|$)|##\[error\]|^\s*not ok\b/i.test(clean);
    pre.append(el("span", isErr ? "ws-code-line is-err" : "ws-code-line", clean));
  }
  return pre;
}

function updateHeaderCounts() {
  const changes = changesOf(store.status);
  const runningRuns = store.runs.filter((r) => r.status && r.status !== "completed");
  const failedRuns = store.runs.filter((r) => r.status === "completed" && (r.conclusion === "failure" || r.conclusion === "timed_out"));

  const tabCount = byId("detailsGitCount");
  if (tabCount) {
    tabCount.hidden = !store.status || !changes.length;
    tabCount.textContent = String(changes.length);
  }

  const subChanges = byId("detailsGitSubChangesCount");
  if (subChanges) { subChanges.hidden = !changes.length; subChanges.textContent = String(changes.length); }
  const subPrs = byId("detailsGitSubPrsCount");
  if (subPrs) { subPrs.hidden = !store.pulls.length; subPrs.textContent = String(store.pulls.length); }
  const subPipes = byId("detailsGitSubPipelinesCount");
  if (subPipes) {
    const count = runningRuns.length || store.runs.length;
    subPipes.hidden = !count;
    subPipes.textContent = String(runningRuns.length || store.runs.length);
  }

  const ciBadge = byId("detailsGitCiBadge");
  if (ciBadge) {
    if (runningRuns.length) {
      ciBadge.hidden = false;
      ciBadge.className = "ws-badge is-amber";
      ciBadge.textContent = `${runningRuns.length} CI running`;
    } else if (failedRuns.length && store.runs[0]?.id === failedRuns[0]?.id) {
      ciBadge.hidden = false;
      ciBadge.className = "ws-badge is-danger";
      ciBadge.textContent = "CI failed";
    } else if (store.runs[0]?.conclusion === "success") {
      ciBadge.hidden = false;
      ciBadge.className = "ws-badge is-live";
      ciBadge.textContent = "CI passing";
    } else {
      ciBadge.hidden = true;
    }
  }

  const statusEl = byId("detailsGitStatus");
  if (statusEl) {
    if (store.statusError) {
      statusEl.textContent = store.statusError;
    } else if (!store.status) {
      statusEl.textContent = currentTarget().projectId ? "Reading working tree…" : "Open a conversation first.";
    } else {
      const parts = [];
      if (runningRuns.length) parts.push(`${runningRuns.length} running`);
      if (store.pulls.length) parts.push(`${store.pulls.length} PR${store.pulls.length === 1 ? "" : "s"}`);
      parts.push(store.status.clean ? "Clean" : `${changes.length} pending`);
      statusEl.textContent = parts.join(" · ");
    }
  }

  const branch = byId("detailsGitBranch");
  if (branch) {
    branch.replaceChildren();
    if (store.status) {
      const name = el("b", "", store.status.branch || "detached");
      branch.append(name);
      const tracking = [
        store.status.upstream && `→ ${store.status.upstream}`,
        store.status.ahead && `↑${store.status.ahead}`,
        store.status.behind && `↓${store.status.behind}`,
      ].filter(Boolean).join(" ");
      if (tracking) branch.append(el("small", "", tracking));
    }
  }
}

async function ensureDiff(change) {
  if (store.diffs.has(change.key) && !store.diffs.get(change.key).error) return;
  const gen = store.generation;
  store.diffs.set(change.key, { loading: true, data: null, error: "" });
  render();
  try {
    const data = await api(gitUrl("diff", {
      path: change.path,
      staged: change.staged ? "1" : undefined,
      untracked: change.kind === "untracked" ? "1" : undefined,
    }));
    if (gen !== store.generation) return;
    store.diffs.set(change.key, { loading: false, data, error: "" });
  } catch (error) {
    if (gen !== store.generation) return;
    store.diffs.set(change.key, { loading: false, data: null, error: error.message });
  }
  render();
}

async function ensureRunDetail(run) {
  if (store.runDetails.has(run.id) && !store.runDetails.get(run.id).error) return;
  const gen = store.generation;
  store.runDetails.set(run.id, { loading: true, data: null, error: "" });
  render();
  try {
    const data = await api(gitUrl("github", { op: "run", id: run.id }));
    if (gen !== store.generation) return;
    store.runDetails.set(run.id, { loading: false, data, error: "" });
    const failedJob = (data.jobs || []).find((job) => job.conclusion === "failure" || job.conclusion === "timed_out");
    if (failedJob) void ensureJobLog(failedJob.id);
  } catch (error) {
    if (gen !== store.generation) return;
    store.runDetails.set(run.id, { loading: false, data: null, error: error.message });
  }
  render();
}

async function ensureJobLog(jobId) {
  if (store.jobLogs.has(jobId) && !store.jobLogs.get(jobId).error) return;
  const gen = store.generation;
  store.jobLogs.set(jobId, { loading: true, data: null, error: "" });
  render();
  try {
    const data = await api(gitUrl("github", { op: "log", id: jobId }));
    if (gen !== store.generation) return;
    store.jobLogs.set(jobId, { loading: false, data, error: "" });
  } catch (error) {
    if (gen !== store.generation) return;
    store.jobLogs.set(jobId, { loading: false, data: null, error: error.message });
  }
  render();
}

async function ensurePullDetail(pull) {
  if (store.pullDetails.has(pull.number) && !store.pullDetails.get(pull.number).error) return;
  const gen = store.generation;
  store.pullDetails.set(pull.number, { loading: true, data: null, error: "" });
  render();
  try {
    const data = await api(gitUrl("github", { op: "pull", id: pull.number }));
    if (gen !== store.generation) return;
    store.pullDetails.set(pull.number, { loading: false, data, error: "" });
  } catch (error) {
    if (gen !== store.generation) return;
    store.pullDetails.set(pull.number, { loading: false, data: null, error: error.message });
  }
  render();
}

async function ensureCommitDetail(commit) {
  if (store.commitDetails.has(commit.hash) && !store.commitDetails.get(commit.hash).error) return;
  const gen = store.generation;
  store.commitDetails.set(commit.hash, { loading: true, data: null, error: "" });
  render();
  try {
    const data = await api(gitUrl("commit", { revision: commit.hash }));
    if (gen !== store.generation) return;
    store.commitDetails.set(commit.hash, { loading: false, data, error: "" });
  } catch (error) {
    if (gen !== store.generation) return;
    store.commitDetails.set(commit.hash, { loading: false, data: null, error: error.message });
  }
  render();
}

function renderFileRow(change) {
  const wrap = el("div", "ws-git-row-wrap");
  const open = store.expandedFiles.has(change.key);
  const btn = el("button", `ws-git-row${open ? " is-open" : ""}`);
  btn.type = "button";
  btn.dataset.testid = "details-file";
  btn.title = change.path;

  const slash = change.path.lastIndexOf("/");
  const name = slash >= 0 ? change.path.slice(slash + 1) : change.path;
  const dir = slash >= 0 ? change.path.slice(0, slash) : "";

  const top = el("div", "ws-git-row-top");
  top.append(
    el("span", "ws-git-row-title", name),
    el("span", `ws-badge ${change.staged ? "is-live" : "is-muted"}`, change.note),
  );
  btn.append(top);
  if (dir) btn.append(el("div", "ws-git-row-sub", dir));
  btn.addEventListener("click", () => {
    if (store.expandedFiles.has(change.key)) {
      store.expandedFiles.delete(change.key);
      render();
    } else {
      store.expandedFiles.add(change.key);
      void ensureDiff(change);
    }
  });
  wrap.append(btn);

  if (open) {
    const detail = el("div", "ws-inline-detail");
    detail.dataset.testid = "details-inline-diff";
    const bar = el("div", "ws-inline-toolbar");
    bar.append(el("span", "ws-inline-path", change.path));
    if (onAskAi) {
      const askBtn = el("button", "ws-btn-sm", "Ask AI");
      askBtn.type = "button";
      askBtn.addEventListener("click", () => {
        onAskAi(`Explain the pending changes in \`${change.path}\` and check for any edge cases or issues.`);
      });
      bar.append(askBtn);
    }
    detail.append(bar);
    const cached = store.diffs.get(change.key);
    if (cached?.error) detail.append(el("p", "ws-pane-note", cached.error));
    else detail.append(renderPatchBlock(cached?.data));
    wrap.append(detail);
  }
  return wrap;
}

function renderRunRow(run) {
  const wrap = el("div", "ws-git-row-wrap");
  const open = store.expandedRuns.has(run.id);
  const tone = runTone(run);
  const btn = el("button", `ws-git-row${open ? " is-open" : ""}`);
  btn.type = "button";
  btn.dataset.testid = "details-git-run";

  const top = el("div", "ws-git-row-top");
  top.append(
    el("span", `ws-dot is-${tone}`),
    el("span", "ws-git-row-title", run.name || run.display_title || `Run #${run.run_number || run.id}`),
    el("span", `ws-badge is-${tone}`, runStatusText(run)),
  );
  const sub = el("div", "ws-git-row-sub");
  const meta = [run.head_branch, run.head_sha?.slice(0, 7), run.event].filter(Boolean).join(" · ");
  sub.textContent = meta || "Click to inspect jobs";
  btn.append(top, sub);
  btn.addEventListener("click", () => {
    if (store.expandedRuns.has(run.id)) {
      store.expandedRuns.delete(run.id);
      render();
    } else {
      store.expandedRuns.add(run.id);
      void ensureRunDetail(run);
    }
  });
  wrap.append(btn);

  if (open) {
    const detail = el("div", "ws-inline-detail");
    const cached = store.runDetails.get(run.id);
    if (!cached || cached.loading) {
      detail.append(el("p", "ws-pane-note", "Loading pipeline jobs…"));
    } else if (cached.error) {
      detail.append(el("p", "ws-pane-note", cached.error));
    } else {
      const jobs = cached.data?.jobs || [];
      if (jobs.length) {
        const pills = el("div", "ws-job-pills");
        for (const job of jobs) {
          const jTone = runTone(job);
          const mark = job.status !== "completed" ? "◌" : job.conclusion === "failure" ? "✕" : job.conclusion === "skipped" ? "–" : "✓";
          const pill = el("button", `ws-job-pill is-${jTone}`, `${mark} ${job.name}`);
          pill.type = "button";
          pill.addEventListener("click", () => void ensureJobLog(job.id));
          pills.append(pill);
        }
        detail.append(pills);
        const failedJob = jobs.find((j) => j.conclusion === "failure" || j.conclusion === "timed_out") || jobs.find((j) => store.jobLogs.has(j.id));
        if (failedJob && store.jobLogs.has(failedJob.id)) {
          const logEntry = store.jobLogs.get(failedJob.id);
          if (logEntry.error) detail.append(el("p", "ws-pane-note", logEntry.error));
          else detail.append(renderLogBlock(logEntry.data));
        }
      }
      const bar = el("div", "ws-inline-toolbar");
      if (onAskAi) {
        const askBtn = el("button", "ws-btn-sm", "Ask AI");
        askBtn.type = "button";
        askBtn.addEventListener("click", () => {
          onAskAi(`Inspect GitHub Actions run "${run.name}" (#${run.run_number || run.id}, status: ${run.conclusion || run.status}) on branch ${run.head_branch || ""} and explain what happened.`);
        });
        bar.append(askBtn);
      }
      if (run.html_url?.startsWith("https://github.com/")) {
        const link = el("a", "ws-btn-sm", "GitHub ↗");
        link.href = run.html_url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        bar.append(link);
      }
      detail.append(bar);
    }
    wrap.append(detail);
  }
  return wrap;
}

function renderPullRow(pull) {
  const wrap = el("div", "ws-git-row-wrap");
  const open = store.expandedPulls.has(pull.number);
  const btn = el("button", `ws-git-row${open ? " is-open" : ""}`);
  btn.type = "button";
  btn.dataset.testid = "details-git-pr";

  const top = el("div", "ws-git-row-top");
  top.append(
    el("span", "ws-git-row-title", `#${pull.number} ${pull.title}`),
    el("span", `ws-badge ${pull.draft ? "is-muted" : pull.merged_at ? "is-indigo" : pull.state === "open" ? "is-live" : "is-muted"}`, pull.draft ? "Draft" : pull.merged_at ? "Merged" : pull.state === "open" ? "Open" : "Closed"),
  );
  const sub = el("div", "ws-git-row-sub");
  const head = pull.head?.ref && pull.base?.ref ? `${pull.head.ref} → ${pull.base.ref}` : "";
  sub.textContent = [head, pull.user?.login, ago(pull.updated_at)].filter(Boolean).join(" · ");
  btn.append(top, sub);
  btn.addEventListener("click", () => {
    if (store.expandedPulls.has(pull.number)) {
      store.expandedPulls.delete(pull.number);
      render();
    } else {
      store.expandedPulls.add(pull.number);
      void ensurePullDetail(pull);
    }
  });
  wrap.append(btn);

  if (open) {
    const detail = el("div", "ws-inline-detail");
    const cached = store.pullDetails.get(pull.number);
    if (!cached || cached.loading) {
      detail.append(el("p", "ws-pane-note", "Loading pull request…"));
    } else if (cached.error) {
      detail.append(el("p", "ws-pane-note", cached.error));
    } else {
      const full = cached.data?.pull || pull;
      const checks = cached.data?.checks?.check_runs || [];
      if (full.body) {
        const summary = el("p", "ws-pane-note", full.body.slice(0, 260) + (full.body.length > 260 ? "…" : ""));
        detail.append(summary);
      }
      if (checks.length) {
        const pills = el("div", "ws-job-pills");
        for (const check of checks.slice(0, 8)) {
          const tone = runTone(check);
          const mark = check.status !== "completed" ? "◌" : check.conclusion === "failure" ? "✕" : "✓";
          pills.append(el("span", `ws-job-pill is-${tone}`, `${mark} ${check.name}`));
        }
        detail.append(pills);
      }
      const bar = el("div", "ws-inline-toolbar");
      if (onExplainPull) {
        const storyBtn = el("button", "ws-btn-sm is-primary", "Explain in Story");
        storyBtn.type = "button";
        storyBtn.addEventListener("click", () => onExplainPull(pull.number, pull.html_url || null));
        bar.append(storyBtn);
      }
      if (onAskAi) {
        const askBtn = el("button", "ws-btn-sm", "Ask AI");
        askBtn.type = "button";
        askBtn.addEventListener("click", () => onAskAi(`Summarize PR #${pull.number} ("${pull.title}") and highlight any risks or failing checks.`));
        bar.append(askBtn);
      }
      if (pull.html_url?.startsWith("https://github.com/")) {
        const link = el("a", "ws-btn-sm", "GitHub ↗");
        link.href = pull.html_url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        bar.append(link);
      }
      detail.append(bar);
    }
    wrap.append(detail);
  }
  return wrap;
}

function renderPipelinesCard(limit = 3) {
  const card = el("div", "ws-card");
  card.dataset.testid = "details-git-pipelines-card";
  const head = el("div", "ws-card-head");
  head.append(el("span", "ws-card-title", "Pipelines"));
  const running = store.runs.filter((r) => r.status && r.status !== "completed").length;
  if (running) head.append(el("span", "ws-badge is-amber", `${running} running`));
  else if (store.runsLoaded && store.runs.length) head.append(el("span", "ws-badge is-muted", `${store.runs.length} recent`));
  if (limit < Infinity) {
    const allLink = el("button", "ws-card-link", "All runs →");
    allLink.type = "button";
    allLink.addEventListener("click", () => setGitSubtab("pipelines"));
    head.append(allLink);
  }
  card.append(head);

  if (!store.runsLoaded && !store.runsError) {
    card.append(el("p", "ws-card-empty", "Checking pipelines…"));
    return card;
  }
  if (store.runsError) {
    card.append(el("p", "ws-card-empty", store.runsError));
    return card;
  }
  let list = store.runs;
  if (limit === Infinity) {
    if (store.runFilter === "running") list = list.filter((r) => r.status && r.status !== "completed");
    else if (store.runFilter === "failed") list = list.filter((r) => r.conclusion === "failure" || r.conclusion === "timed_out");
  }
  if (!list.length) {
    card.append(el("p", "ws-card-empty", "No pipeline runs found."));
    return card;
  }
  const rows = el("div", "ws-card-rows");
  for (const run of list.slice(0, limit)) rows.append(renderRunRow(run));
  card.append(rows);
  return card;
}

function renderPullsCard(limit = 3) {
  const card = el("div", "ws-card");
  card.dataset.testid = "details-git-prs-card";
  const head = el("div", "ws-card-head");
  head.append(el("span", "ws-card-title", "Pull requests"));
  if (store.pullsLoaded) head.append(el("span", "ws-badge is-muted", `${store.pulls.length} ${store.pullState}`));
  if (limit < Infinity) {
    const allLink = el("button", "ws-card-link", "All PRs →");
    allLink.type = "button";
    allLink.addEventListener("click", () => setGitSubtab("prs"));
    head.append(allLink);
  }
  card.append(head);

  if (!store.pullsLoaded && !store.pullsError) {
    card.append(el("p", "ws-card-empty", "Checking pull requests…"));
    return card;
  }
  if (store.pullsError) {
    card.append(el("p", "ws-card-empty", store.pullsError));
    return card;
  }
  const q = store.pullFilter.trim().toLowerCase();
  const list = q ? store.pulls.filter((p) => `${p.number} ${p.title} ${p.head?.ref || ""}`.toLowerCase().includes(q)) : store.pulls;
  if (!list.length) {
    card.append(el("p", "ws-card-empty", `No ${store.pullState} pull requests.`));
    return card;
  }
  const rows = el("div", "ws-card-rows");
  for (const pull of list.slice(0, limit)) rows.append(renderPullRow(pull));
  card.append(rows);
  return card;
}

function renderChangesCard(limit = 12) {
  const card = el("div", "ws-card");
  card.dataset.testid = "details-git-changes-card";
  const allChanges = changesOf(store.status);
  const visible = filteredChanges();

  const head = el("div", "ws-card-head");
  head.append(el("span", "ws-card-title", "Changed files"));
  head.append(el("span", "ws-badge is-muted", String(allChanges.length)));
  if (limit < Infinity && allChanges.length > limit) {
    const allLink = el("button", "ws-card-link", `All ${allChanges.length} →`);
    allLink.type = "button";
    allLink.addEventListener("click", () => setGitSubtab("changes"));
    head.append(allLink);
  }
  card.append(head);

  if (store.statusError) {
    card.append(el("p", "ws-card-empty", store.statusError));
    return card;
  }
  if (!store.status) {
    card.append(el("p", "ws-card-empty", currentTarget().projectId ? "Reading working tree…" : "Open a conversation first."));
    return card;
  }

  if (allChanges.length) {
    const filterBar = el("div", "ws-filter-bar");
    if (Array.isArray(store.scopePaths) && store.scopePaths.length) {
      const pills = el("div", "ws-scope-pills");
      for (const [id, label] of [["chat", `This chat (${store.scopePaths.length})`], ["all", `All (${allChanges.length})`]]) {
        const pill = el("button", "ws-scope-pill", label);
        pill.type = "button";
        pill.setAttribute("aria-pressed", String(store.fileScope === id));
        pill.addEventListener("click", () => { store.fileScope = id; render(); });
        pills.append(pill);
      }
      filterBar.append(pills);
    }
    const search = el("input", "ws-search-mini");
    search.type = "search";
    search.placeholder = "Filter files…";
    search.value = store.fileFilter;
    search.setAttribute("aria-label", "Filter changed files");
    search.addEventListener("input", () => {
      store.fileFilter = search.value;
      const pos = search.selectionStart;
      render();
      const next = byId("detailsGitContent")?.querySelector(".ws-search-mini");
      if (next) { next.focus(); if (pos !== null) next.setSelectionRange(pos, pos); }
    });
    filterBar.append(search);
    card.append(filterBar);
  }

  if (!visible.length) {
    card.append(el("p", "ws-card-empty", allChanges.length ? "No files match your filter." : "Working tree clean."));
    return card;
  }

  const rows = el("div", "ws-card-rows");
  for (const change of visible.slice(0, limit)) rows.append(renderFileRow(change));
  card.append(rows);
  return card;
}

function renderHistoryPane() {
  const card = el("div", "ws-card");
  const head = el("div", "ws-card-head");
  head.append(el("span", "ws-card-title", "Recent commits"));
  if (Array.isArray(store.commits)) head.append(el("span", "ws-badge is-muted", String(store.commits.length)));
  card.append(head);

  if (store.commitsError) { card.append(el("p", "ws-card-empty", store.commitsError)); return card; }
  if (!store.commits) { card.append(el("p", "ws-card-empty", "Loading commits…")); return card; }
  if (!store.commits.length) { card.append(el("p", "ws-card-empty", "No commits yet.")); return card; }

  const rows = el("div", "ws-card-rows");
  for (const commit of store.commits) {
    const wrap = el("div", "ws-git-row-wrap");
    const open = store.expandedCommits.has(commit.hash);
    const btn = el("button", `ws-git-row${open ? " is-open" : ""}`);
    btn.type = "button";
    btn.dataset.testid = "details-git-commit";
    const top = el("div", "ws-git-row-top");
    top.append(el("span", "ws-git-row-title", commit.subject), el("span", "ws-badge is-muted", commit.shortHash));
    const sub = el("div", "ws-git-row-sub", `${commit.author} · ${ago(commit.date)}`);
    btn.append(top, sub);
    btn.addEventListener("click", () => {
      if (store.expandedCommits.has(commit.hash)) {
        store.expandedCommits.delete(commit.hash);
        render();
      } else {
        store.expandedCommits.add(commit.hash);
        void ensureCommitDetail(commit);
      }
    });
    wrap.append(btn);
    if (open) {
      const detail = el("div", "ws-inline-detail");
      const cached = store.commitDetails.get(commit.hash);
      if (!cached || cached.loading) detail.append(el("p", "ws-pane-note", "Loading commit diff…"));
      else if (cached.error) detail.append(el("p", "ws-pane-note", cached.error));
      else detail.append(renderPatchBlock(cached.data?.diff));
      wrap.append(detail);
    }
    rows.append(wrap);
  }
  card.append(rows);
  return card;
}

function renderReviewsPane() {
  const frag = document.createDocumentFragment();
  if (store.guide?.guide) {
    const card = el("div", "ws-card");
    const head = el("div", "ws-card-head");
    head.append(el("span", "ws-card-title", "Review guide"), el("span", "ws-badge is-live", "Saved"));
    card.append(head);
    const items = store.guide.guide.items || store.guide.guide.steps || [];
    if (items.length) {
      const rows = el("div", "ws-card-rows");
      for (const item of items) {
        const row = el("div", "ws-git-row");
        const top = el("div", "ws-git-row-top");
        top.append(el("span", "ws-git-row-title", item.title || item.path || "Note"));
        if (item.priority) top.append(el("span", `ws-badge ${item.priority === "high" ? "is-danger" : "is-amber"}`, item.priority));
        row.append(top);
        if (item.summary || item.reason || item.note) row.append(el("div", "ws-git-row-sub", item.summary || item.reason || item.note));
        rows.append(row);
      }
      card.append(rows);
    }
    frag.append(card);
  }

  const card = el("div", "ws-card");
  const head = el("div", "ws-card-head");
  head.append(el("span", "ws-card-title", "Saved review threads"));
  if (Array.isArray(store.reviews)) head.append(el("span", "ws-badge is-muted", String(store.reviews.length)));
  card.append(head);

  if (store.reviewsError) { card.append(el("p", "ws-card-empty", store.reviewsError)); }
  else if (!store.reviews) { card.append(el("p", "ws-card-empty", "Loading reviews…")); }
  else if (!store.reviews.length) { card.append(el("p", "ws-card-empty", "No saved review threads yet. Use Ask AI on any file, or open Full review to generate a full guide.")); }
  else {
    const rows = el("div", "ws-card-rows");
    for (const thread of store.reviews) {
      const row = el("div", "ws-git-row");
      const top = el("div", "ws-git-row-top");
      top.append(el("span", "ws-git-row-title", thread.question || thread.filePath || "Review thread"));
      row.append(top, el("div", "ws-git-row-sub", [thread.filePath, ago(thread.updatedAt || thread.createdAt)].filter(Boolean).join(" · ")));
      rows.append(row);
    }
    card.append(rows);
  }
  frag.append(card);
  return frag;
}

function render() {
  updateHeaderCounts();
  const host = byId("detailsGitContent");
  if (!host) return;
  host.replaceChildren();

  if (store.subtab === "all") {
    host.append(renderPipelinesCard(3), renderPullsCard(3), renderChangesCard(12));
    return;
  }
  if (store.subtab === "changes") {
    host.append(renderChangesCard(Infinity));
    return;
  }
  if (store.subtab === "prs") {
    const bar = el("div", "ws-filter-bar ws-filter-bar-plain");
    const pills = el("div", "ws-scope-pills");
    for (const [val, label] of [["open", "Open"], ["closed", "Closed"]]) {
      const pill = el("button", "ws-scope-pill", label);
      pill.type = "button";
      pill.setAttribute("aria-pressed", String(store.pullState === val));
      pill.addEventListener("click", () => {
        if (store.pullState === val) return;
        store.pullState = val;
        store.pullsLoaded = false;
        void loadPulls();
      });
      pills.append(pill);
    }
    bar.append(pills);
    host.append(bar, renderPullsCard(Infinity));
    return;
  }
  if (store.subtab === "pipelines") {
    const bar = el("div", "ws-filter-bar ws-filter-bar-plain");
    const pills = el("div", "ws-scope-pills");
    for (const [val, label] of [["all", "All"], ["running", "Running"], ["failed", "Failed"]]) {
      const pill = el("button", "ws-scope-pill", label);
      pill.type = "button";
      pill.setAttribute("aria-pressed", String(store.runFilter === val));
      pill.addEventListener("click", () => { store.runFilter = val; render(); });
      pills.append(pill);
    }
    bar.append(pills);
    host.append(bar, renderPipelinesCard(Infinity));
    return;
  }
  if (store.subtab === "history") {
    host.append(renderHistoryPane());
    return;
  }
  if (store.subtab === "reviews") {
    host.append(renderReviewsPane());
  }
}

async function loadStatus() {
  const where = currentTarget();
  if (!where.projectId || !state.activeSessionId) {
    store.status = null;
    store.statusError = "Open a conversation first.";
    render();
    return;
  }
  const gen = store.generation;
  try {
    const next = await api(gitUrl("status"));
    if (gen !== store.generation) return;
    store.status = next;
    store.statusError = "";
    render();
  } catch (error) {
    if (gen !== store.generation) return;
    store.status = null;
    store.statusError = error.cause?.message || error.message;
    render();
  }
}

async function loadScope() {
  const conversationId = currentConversationId();
  if (!conversationId || !currentTarget().projectId) return;
  const gen = store.generation;
  try {
    const scope = await api(gitUrl("scope", { conversationId }));
    if (gen !== store.generation) return;
    store.scopePaths = Array.isArray(scope.paths) ? scope.paths : [];
    if (store.scopePaths.length) store.fileScope = "chat";
    render();
  } catch {
    // Scope is optional; fall back silently to all pending changes.
  }
}

async function loadRuns() {
  if (!currentTarget().projectId || !state.activeSessionId) return;
  const gen = store.generation;
  try {
    const response = await api(gitUrl("github", { op: "runs", page: 1 }));
    if (gen !== store.generation) return;
    store.runs = response.runs?.workflow_runs || [];
    store.runsLoaded = true;
    store.runsError = "";
  } catch (error) {
    if (gen !== store.generation) return;
    store.runs = [];
    store.runsLoaded = true;
    store.runsError = error.cause?.message || error.message;
  }
  render();
}

async function loadPulls() {
  if (!currentTarget().projectId || !state.activeSessionId) return;
  const gen = store.generation;
  try {
    const response = await api(gitUrl("github", { op: "pulls", state: store.pullState, page: 1 }));
    if (gen !== store.generation) return;
    store.pulls = response.pulls || [];
    store.pullsLoaded = true;
    store.pullsError = "";
  } catch (error) {
    if (gen !== store.generation) return;
    store.pulls = [];
    store.pullsLoaded = true;
    store.pullsError = error.cause?.message || error.message;
  }
  render();
}

async function loadHistory() {
  if (!currentTarget().projectId) return;
  const gen = store.generation;
  try {
    const body = await api(gitUrl("history", { limit: 40 }));
    if (gen !== store.generation) return;
    store.commits = body.commits || [];
    store.commitsError = "";
  } catch (error) {
    if (gen !== store.generation) return;
    store.commits = [];
    store.commitsError = error.cause?.message || error.message;
  }
  render();
}

async function loadReviews() {
  if (!currentTarget().projectId) return;
  const gen = store.generation;
  const conversationId = currentConversationId();
  try {
    const [threadsBody, guideBody] = await Promise.all([
      api(gitUrl("reviews", conversationId ? { conversationId } : {})),
      api(gitUrl("guide-latest", { conversationId })).catch(() => ({ guide: null })),
    ]);
    if (gen !== store.generation) return;
    store.reviews = threadsBody.threads || [];
    store.guide = guideBody?.guide ? guideBody : null;
    store.reviewsError = "";
  } catch (error) {
    if (gen !== store.generation) return;
    store.reviews = [];
    store.reviewsError = error.cause?.message || error.message;
  }
  render();
}

export function setGitSubtab(name) {
  store.subtab = name;
  for (const button of document.querySelectorAll("#detailsGitSubtabs .ws-subtab")) {
    button.setAttribute("aria-selected", String(button.dataset.gitSub === name));
  }
  render();
  if (name === "history" && !store.commits) void loadHistory();
  if (name === "reviews" && !store.reviews) void loadReviews();
  if (name === "prs" && !store.pullsLoaded) void loadPulls();
  if (name === "pipelines" && !store.runsLoaded) void loadRuns();
}

export async function refreshDetailsGit({ force = false } = {}) {
  const where = currentTarget();
  const nextKey = `${where.projectId || ""}|${where.nodeId || ""}|${currentConversationId() || ""}`;
  if (force || nextKey !== store.key) {
    store.key = nextKey;
    store.generation += 1;
    store.status = null;
    store.statusError = "";
    store.scopePaths = null;
    store.fileScope = "all";
    store.pulls = [];
    store.pullsLoaded = false;
    store.pullsError = "";
    store.runs = [];
    store.runsLoaded = false;
    store.runsError = "";
    store.commits = null;
    store.commitsError = "";
    store.reviews = null;
    store.reviewsError = "";
    store.guide = null;
    store.expandedFiles.clear();
    store.diffs.clear();
    store.expandedRuns.clear();
    store.runDetails.clear();
    store.jobLogs.clear();
    store.expandedPulls.clear();
    store.pullDetails.clear();
    store.expandedCommits.clear();
    store.commitDetails.clear();
  }
  const gen = store.generation;
  render();
  await loadStatus();
  if (gen !== store.generation || !store.status) {
    store.runsLoaded = true;
    store.pullsLoaded = true;
    store.runsError = store.statusError || "Not a Git repository.";
    store.pullsError = store.statusError || "Not a Git repository.";
    render();
    return;
  }
  void loadScope();
  void loadRuns();
  void loadPulls();
  if (store.subtab === "history") void loadHistory();
  if (store.subtab === "reviews") void loadReviews();
}

export function resetDetailsGit() {
  store.key = "";
  store.generation += 1;
  store.status = null;
  store.statusError = "";
  store.pulls = [];
  store.pullsLoaded = false;
  store.runs = [];
  store.runsLoaded = false;
  updateHeaderCounts();
}

export function initDetailsGit({ askAi, explainPull } = {}) {
  onAskAi = askAi ?? null;
  onExplainPull = explainPull ?? null;
  for (const button of document.querySelectorAll("#detailsGitSubtabs .ws-subtab")) {
    button.addEventListener("click", () => setGitSubtab(button.dataset.gitSub));
  }
  const refreshBtn = byId("detailsGitRefresh");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      refreshDetailsGit({ force: true });
      toast("Refreshing Git, PRs and pipelines…");
    });
  }
}
